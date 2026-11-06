/**
 * Server-side sessions for v-harness, persisted in SQLite.
 *
 * The cookie is only an index: it carries a random session id and nothing
 * else, so no secret lives in the browser and revocation is one UPDATE away.
 * Sessions bind to the browser's User-Agent hash — a copied cookie from
 * another browser is refused. The cost is explicit: a browser upgrade or an
 * agent that rewrites the UA signs the user out; that trade is accepted and
 * reversible by relaxing `loadSession`.
 *
 * Requires `node:sqlite` (stable from Node 24, flag-gated on 22 —
 * `bin/entrypoint` probes and adds `--experimental-sqlite` when needed).
 *
 * @module v-harness/gateway/session
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SESSION_COOKIE = 'vh_session';
export const CSRF_COOKIE = 'vh_csrf';
export const CSRF_HEADER = 'x-vh-csrf';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  account    TEXT NOT NULL,
  ua_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_subject ON sessions(subject);
`;

/** Sessions refresh their sliding window at most this often. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

/**
 * @typedef {object} Session
 * @property {string} sid - random 32-byte id, base64url.
 * @property {string} subject - VOS immutable subject.
 * @property {string} account - tenant account name at sign-in time.
 * @property {number} expiresAt - epoch milliseconds (sliding window).
 */

/**
 * Open (creating when absent) the session database.
 * @param {string} path - absolute SQLite file path.
 * @param {{ ttlMs: number }} options - sliding session window.
 * @returns {Promise<{
 *   createSession: (identity: { subject: string, account: string, userAgent: string }, now?: number) => string,
 *   loadSession: (sid: string | undefined, userAgent: string, now?: number) => Session | undefined,
 *   revokeSession: (sid: string) => void,
 *   revokeSubject: (subject: string) => void,
 *   close: () => void,
 * }>}
 */
export async function openSessionStore(path, { ttlMs }) {
  const { DatabaseSync } = await import('node:sqlite');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  // The data volume is shared storage, where WAL locks arrive late and in
  // bursts; without a busy timeout one unlucky touch kills a login or a
  // socket upgrade outright.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const insert = db.prepare(
    'INSERT INTO sessions (sid, subject, account, ua_hash, created_at, last_seen, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
  );
  const bySid = db.prepare(
    'SELECT sid, subject, account, ua_hash, last_seen, expires_at, revoked FROM sessions WHERE sid = ?',
  );
  const touch = db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE sid = ? AND revoked = 0');
  const revokeOne = db.prepare('UPDATE sessions SET revoked = 1 WHERE sid = ?');
  const revokeSubject = db.prepare('UPDATE sessions SET revoked = 1 WHERE subject = ?');
  const prune = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

  /**
   * Mint one session and store it.
   * @param {{ subject: string, account: string, userAgent: string }} identity
   * @param {number} [now]
   * @returns {string} the session id to set as the cookie value.
   */
  function createSession(identity, now = Date.now()) {
    prune.run(now);
    const sid = randomBytes(32).toString('base64url');
    insert.run(
      sid, identity.subject, identity.account,
      userAgentHash(identity.userAgent), now, now, now + ttlMs,
    );
    return sid;
  }

  /**
   * Load one live session.
   * @param {string | undefined} sid
   * @param {string} userAgent
   * @param {number} [now]
   * @returns {Session | undefined}
   */
  function loadSession(sid, userAgent, now = Date.now()) {
    if (typeof sid !== 'string' || sid === '') return undefined;
    const row = bySid.get(sid);
    if (!row || row.revoked || row.expires_at <= now) return undefined;
    // Strict UA binding: the hash must match the presenting browser. See the
    // module comment for the accepted cost.
    if (row.ua_hash !== userAgentHash(userAgent)) return undefined;
    // Slide the window, throttled so a chatty client is not one write per
    // request.
    if (now - Number(row.last_seen) > LAST_SEEN_WRITE_INTERVAL_MS) {
      touch.run(now, now + ttlMs, sid);
    }
    return { sid: row.sid, subject: row.subject, account: row.account, expiresAt: Number(row.expires_at) };
  }

  return {
    createSession,
    loadSession,
    revokeSession: (sid) => { revokeOne.run(sid); },
    revokeSubject: (subject) => { revokeSubject.run(subject); },
    close: () => { db.close(); },
  };
}

/**
 * @param {string} userAgent
 * @returns {string}
 */
function userAgentHash(userAgent) {
  return createHash('sha256').update(userAgent).digest('hex');
}

/**
 * Serialize a Set-Cookie value.
 *
 * `SameSite` is a parameter, not a constant: the app is rendered inside the
 * platform's iframe, and when that frame is a different site a `Lax` cookie is
 * never attached (Lax rides top-level navigations only). `None` is the only
 * value that survives there, and browsers reject `None` without `Secure`;
 * CHIPS (`Partitioned`) keeps it stored where third-party cookies are blocked.
 *
 * @param {string} name
 * @param {string} value - empty string clears the cookie.
 * @param {{ maxAgeSeconds?: number, secure?: boolean, partitioned?: boolean, sameSite?: 'Lax' | 'Strict' | 'None' }} options
 * @returns {string}
 */
export function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${options.sameSite ?? 'Lax'}`];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(options.maxAgeSeconds)}`);
  if (options.secure) {
    parts.push('Secure');
    // A Partitioned cookie is only accepted together with Secure; emitting it
    // on its own makes the browser drop the whole cookie.
    if (options.partitioned) parts.push('Partitioned');
  }
  return parts.join('; ');
}

/**
 * Parse a Cookie header into a name → value map.
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=');
    if (at <= 0) continue;
    const name = segment.slice(0, at).trim();
    const raw = segment.slice(at + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/**
 * Mint a CSRF token for the double-submit check.
 * @returns {string}
 */
export function newCsrfToken() {
  return randomBytes(24).toString('base64url');
}

/**
 * Constant-time comparison for CSRF tokens.
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
export function csrfMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
