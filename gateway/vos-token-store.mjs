/**
 * Durable VOS credentials for the gateway's capability endpoints.
 *
 * A gateway restart used to drop every tenant's token: the capability sockets
 * answered 401 until each browser replayed its own PKCE exchange. The tokens
 * now live in the gateway's private state directory (root-owned, 0600), never
 * in a tenant home and never in a browser response. The in-memory map stays
 * the read path, so every capability endpoint keeps its synchronous lookup;
 * only writes (sign-in, refresh, sign-out) touch the file.
 *
 * A VOS token is a full platform identity. This module never hands one to a
 * tenant process: callers use it to sign upstream requests on the tenant's
 * behalf, which is the same trust boundary the in-memory map had.
 *
 * @module v-harness/gateway/vos-token-store
 */

import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1_000;
const TOKEN_EXPIRY_MARGIN_MS = 30 * 1_000;
// VOS accepts a public-client refresh grant (no secret) against this endpoint,
// which is what keeps the capability alive past the access token's TTL without
// asking the user to sign in again.
const VOS_TOKEN_URL = process.env.VOS_TOKEN_URL ?? 'http://172.17.0.1:8105/v1000/oauth2/token';
const VOS_CLIENT_ID = process.env.VOS_OIDC_CLIENT_ID ?? 'com.ictrek.v-harness';
const REFRESH_TIMEOUT_MS = 8_000;

/**
 * @typedef {object} TokenSet
 * @property {string} access
 * @property {string} [refresh]
 * @property {number} expiresAt - epoch milliseconds.
 */

/** @type {Map<string, TokenSet>} */
const tokens = new Map();

/** Per-namespace refresh in flight, so a burst of calls refreshes once.
 * @type {Map<string, Promise<TokenSet | undefined>>}
 */
const refreshing = new Map();

/** The durable path, set by `initTokenStore` at startup. An uninitialized
 * store is memory-only, which is what standalone capability tests need.
 * @type {string | undefined}
 */
let storePath;

/**
 * Read the `exp` claim of a JWT without verifying it. The token is only ever
 * forwarded to VOS, which is the authority; this is a local freshness check.
 * @param {string} token
 * @returns {number | undefined} epoch milliseconds.
 */
function jwtExpiry(token) {
  const encoded = token.split('.')[1];
  if (!encoded) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return typeof claims.exp === 'number' ? claims.exp * 1_000 : undefined;
  } catch {
    // Opaque tokens are legal; the caller falls back to expires_in/default.
    return undefined;
  }
}

/**
 * Compute when one access token stops being usable.
 * @param {string} accessToken
 * @param {number} [expiresInSeconds]
 * @returns {number} epoch milliseconds.
 */
export function expiryFromToken(accessToken, expiresInSeconds) {
  if (typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    return Date.now() + expiresInSeconds * 1_000;
  }
  return jwtExpiry(accessToken) ?? Date.now() + DEFAULT_TOKEN_TTL_MS;
}

/**
 * Whether a restored entry is both well formed and still usable. An expired
 * access token with a refresh token can be renewed; one without either is
 * dead weight at rest and is dropped.
 * @param {unknown} value
 * @param {number} now
 * @returns {value is TokenSet}
 */
function isUsableEntry(value, now) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = /** @type {Record<string, unknown>} */ (value);
  if (typeof entry.access !== 'string' || entry.access === '') return false;
  if (entry.refresh !== undefined && typeof entry.refresh !== 'string') return false;
  if (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) return false;
  return entry.expiresAt > now || Boolean(entry.refresh);
}

/**
 * Write the whole map atomically. Writes are rare (sign-in, refresh, sign-out)
 * and small, so a synchronous rename is both simpler and stronger than leaving
 * a window where a crash loses the credential the user just exchanged.
 * @returns {void}
 */
function persist() {
  if (storePath === undefined) return;
  const temporary = `${storePath}.tmp-${String(process.pid)}`;
  // `mode` only applies when the temp file is new; chmod also covers the case
  // where a crashed process left a temp file behind with looser permissions.
  writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(tokens), null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, storePath);
}

/**
 * Recover the credentials a previous gateway left and make this path the
 * durable home of every later write. Called once at startup.
 *
 * A missing or damaged file is an empty store, never a startup failure: the
 * browser's own PKCE replay is the fallback. A file readable beyond its owner
 * is ignored rather than trusted, and the next write replaces it with 0600.
 * @param {string} path
 * @returns {void}
 */
export function initTokenStore(path) {
  storePath = path;
  tokens.clear();
  refreshing.clear();
  let text;
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      console.warn(`vos token store ${path} is readable beyond its owner; ignoring it`);
      return;
    }
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('vos token store unreadable; starting empty:', error);
    }
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn(`vos token store ${path} is damaged; starting empty`);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const now = Date.now();
  let dropped = 0;
  for (const [namespace, entry] of Object.entries(parsed)) {
    if (isUsableEntry(entry, now)) {
      tokens.set(namespace, {
        access: entry.access,
        ...entry.refresh === undefined ? {} : { refresh: entry.refresh },
        expiresAt: entry.expiresAt,
      });
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) persist();
}

/**
 * Remember one user's token, both for this process and the next gateway boot.
 * @param {string} namespace
 * @param {{ access: string, refresh?: string, expiresAt: number }} tokenSet
 * @returns {void}
 */
export function rememberTokens(namespace, tokenSet) {
  tokens.set(namespace, tokenSet);
  persist();
}

/**
 * Drop one user's credentials: sign-out, a refused refresh, or a VOS revocation.
 * @param {string} namespace
 * @returns {void}
 */
export function forgetTokens(namespace) {
  if (tokens.delete(namespace)) persist();
}

/**
 * Whether one user still has a token the capability endpoints can use.
 *
 * The access token may have expired; a refresh token keeps the capability
 * alive, so either counts as ready.
 * @param {string} namespace
 * @returns {boolean}
 */
export function hasUsableTokens(namespace) {
  const entry = tokens.get(namespace);
  if (!entry) return false;
  return entry.expiresAt > Date.now() || Boolean(entry.refresh);
}

/**
 * Exchange the stored refresh token for a new access token.
 * @param {string} namespace
 * @param {TokenSet} entry
 * @returns {Promise<TokenSet | undefined>}
 */
async function refreshTokenSet(namespace, entry) {
  if (!entry.refresh) return undefined;
  try {
    const response = await fetch(VOS_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: entry.refresh,
        client_id: VOS_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) {
      // invalid_grant means the user's VOS session was revoked or expired.
      const detail = await response.text().catch(() => '');
      console.warn(`v-office token refresh rejected for ${namespace}: HTTP ${String(response.status)} ${detail.slice(0, 200)}`);
      return undefined;
    }
    const payload = await response.json();
    if (typeof payload?.access_token !== 'string' || !payload.access_token) {
      console.warn(`v-office token refresh returned no access_token for ${namespace}`);
      return undefined;
    }
    const next = {
      access: payload.access_token,
      ...typeof payload.refresh_token === 'string' && payload.refresh_token
        ? { refresh: payload.refresh_token }
        : { refresh: entry.refresh },
      expiresAt: expiryFromToken(payload.access_token, Number(payload.expires_in)),
    };
    rememberTokens(namespace, next);
    return next;
  } catch (error) {
    console.warn(`v-office token refresh failed for ${namespace}:`, error);
    return undefined;
  }
}

/**
 * Current usable access token, refreshing it first when it is near expiry.
 *
 * Exported because every capability endpoint authenticates upstream calls with
 * the same VOS token.
 * @param {string} namespace
 * @returns {Promise<string | undefined>}
 */
export async function accessTokenFor(namespace) {
  const entry = tokens.get(namespace);
  if (!entry) return undefined;
  if (entry.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) return entry.access;

  const pending = refreshing.get(namespace);
  if (pending) {
    const settled = await pending;
    return settled?.access;
  }
  const attempt = refreshTokenSet(namespace, entry);
  refreshing.set(namespace, attempt);
  try {
    const next = await attempt;
    // A refused refresh means VOS revoked the session. Keeping the entry makes
    // `hasUsableTokens` keep answering "ready" while this function keeps
    // returning nothing, and every navigation then bounces between the app and
    // the bootstrap page — two requests every few hundred milliseconds, with no
    // re-login ever offered. Dropping it lets the page ask for one.
    if (next === undefined) forgetTokens(namespace);
    return next?.access;
  } finally {
    refreshing.delete(namespace);
  }
}
