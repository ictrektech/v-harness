/**
 * Stateless HMAC session cookie for v-harness.
 *
 * The cookie never carries a VOS access token: it only names the platform
 * subject and its derived namespace. Revocation is expiry-based; bumping
 * `SESSION_VERSION` invalidates every outstanding cookie.
 *
 * @module v-harness/gateway/session
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'vh_session';
export const CSRF_COOKIE = 'vh_csrf';
export const CSRF_HEADER = 'x-vh-csrf';

const COOKIE_VERSION = 1;

/**
 * @typedef {object} SessionPayload
 * @property {string} subject - VOS immutable subject.
 * @property {string} namespace - directory/uid namespace derived from subject.
 * @property {string} username - display name at sign-in time.
 * @property {number} expiresAt - epoch milliseconds.
 */

/**
 * Load the signing secret, generating one when the file is absent.
 * @param {string} path - absolute secret file path.
 * @param {import('node:fs/promises').FileHandle | undefined} [handle]
 * @returns {Promise<Buffer>}
 */
export async function loadSecret(path) {
  const { readFile, writeFile } = await import('node:fs/promises');
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (text) return Buffer.from(text, 'base64url');
  } catch {
    // Absent on first boot; fall through to creation. Any other read error
    // surfaces on the write below rather than being swallowed here.
  }
  const generated = randomBytes(32);
  await writeFile(path, `${generated.toString('base64url')}\n`, { mode: 0o600, flag: 'wx' })
    .catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
  const text = (await readFile(path, 'utf8')).trim();
  return Buffer.from(text, 'base64url');
}

/**
 * Sign one session payload.
 * @param {SessionPayload} payload
 * @param {Buffer} secret
 * @returns {string} `v1.<body>.<signature>`
 */
export function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify({ v: COOKIE_VERSION, ...payload }), 'utf8')
    .toString('base64url');
  return `v${COOKIE_VERSION}.${body}.${signature(secret, body)}`;
}

/**
 * Verify one session cookie.
 * @param {string | undefined} value
 * @param {Buffer} secret
 * @param {number} [now] - epoch milliseconds, injectable for tests.
 * @returns {SessionPayload | undefined}
 */
export function verifySession(value, secret, now = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  const [version, body, encoded] = parts;
  if (version !== `v${COOKIE_VERSION}` || !body || !encoded) return undefined;

  const expected = signature(secret, body);
  const actual = Buffer.from(encoded, 'base64url');
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    return undefined;
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!decoded || typeof decoded !== 'object' || decoded.v !== COOKIE_VERSION) return undefined;
  const { subject, namespace, username, expiresAt } = decoded;
  if (typeof subject !== 'string' || !subject
    || typeof namespace !== 'string' || !namespace
    || typeof username !== 'string'
    || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return undefined;
  if (expiresAt <= now) return undefined;
  return { subject, namespace, username, expiresAt };
}

/**
 * Serialize a Set-Cookie value with the fixed session attributes.
 * @param {string} name
 * @param {string} value - empty string clears the cookie.
 * @param {{ maxAgeSeconds?: number, secure?: boolean }} options
 * @returns {string}
 */
export function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(options.maxAgeSeconds)}`);
  if (options.secure) parts.push('Secure');
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

/**
 * @param {Buffer} secret
 * @param {string} body
 * @returns {string}
 */
function signature(secret, body) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}
