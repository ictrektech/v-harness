/**
 * Per-tenant V-Office capability endpoint.
 *
 * The agent runs as the tenant's dsh process and cannot hold a VOS access
 * token: dsh scrubs credential-shaped variables from every child process, and
 * dropping the token into the tenant's home would hand a full platform
 * identity to a sandboxed agent. So the gateway keeps the token in memory and
 * listens on a Unix socket inside that tenant's own 0700 directory. Kernel
 * permissions decide who may call it, and the only thing reachable through it
 * is that user's own V-Office document directory.
 *
 * The socket speaks the same paths as the storage service (`/api/v1/...`); the
 * gateway adds `Authorization` and nothing else. Token expiry is reported as a
 * 401 with a stable error code so the skill can tell the user to sign in again
 * instead of retrying.
 *
 * @module v-harness/gateway/office
 */

import { createServer, request as httpRequest } from 'node:http';
import { chmodSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';

import { runUserHelper } from './instances.mjs';

const DEFAULT_BASE = 'http://10.144.144.232:1182/api/com.ictrek.v-office';
const OFFICE_BASE = new URL((process.env.VH_OFFICE_BASE ?? DEFAULT_BASE).replace(/\/+$/, ''));
const OFFICE_PREFIX = OFFICE_BASE.pathname.replace(/\/+$/, '');
const SOCKET_NAME = 'voffice.sock';
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1_000;
const TOKEN_EXPIRY_MARGIN_MS = 30 * 1_000;
const UPSTREAM_TIMEOUT_MS = 300_000;
/** Collabora cold starts answer slowly; a session request must not hang a tab. */
const SESSION_TIMEOUT_MS = 30_000;
// VOS accepts a public-client refresh grant (no secret) against this endpoint,
// which is what keeps the capability alive past the access token's TTL without
// asking the user to sign in again.
const VOS_TOKEN_URL = process.env.VOS_TOKEN_URL ?? 'http://172.17.0.1:8105/v1000/oauth2/token';
const VOS_CLIENT_ID = process.env.VOS_OIDC_CLIENT_ID ?? 'com.ictrek.v-harness';
const REFRESH_TIMEOUT_MS = 8_000;

/** Routes the capability exposes; everything else is refused locally. */
const ROUTES = [
  { method: 'GET', pattern: /^\/api\/v1\/health$/ },
  { method: 'GET', pattern: /^\/api\/v1\/me$/ },
  { method: 'GET', pattern: /^\/api\/v1\/files$/ },
  { method: 'GET', pattern: /^\/api\/v1\/files\/[^/]+$/ },
  { method: 'PUT', pattern: /^\/api\/v1\/files\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/api\/v1\/files\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/api\/v1\/files\/[^/]+$/ },
];

/** Response headers worth replaying to the caller. */
const RESPONSE_HEADERS = new Set([
  'content-type', 'content-length', 'content-disposition',
  'last-modified', 'etag', 'x-voffice-token',
]);

/**
 * @typedef {object} TokenSet
 * @property {string} access
 * @property {string} [refresh]
 * @property {number} expiresAt - epoch milliseconds.
 */

/** @type {Map<string, TokenSet>} */
const tokens = new Map();

/**
 * The origin the browser used to reach the portal, learned from its own
 * requests. A link handed to the user has to be absolute (the chat renderer
 * refuses relative hrefs), and the agent has no other way to learn the host.
 */
let publicOrigin = '';

/**
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function firstHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw?.split(',')[0]?.trim();
  return first === undefined || first === '' ? undefined : first;
}

/**
 * Remember the origin of the last browser request.
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
export function rememberOrigin(headers) {
  const host = firstHeader(headers['x-forwarded-host']) ?? firstHeader(headers.host);
  if (host === undefined) return;
  publicOrigin = `${firstHeader(headers['x-forwarded-proto']) ?? 'http'}://${host}`;
}

/** @type {Map<string, Promise<import('node:http').Server>>} */
const capabilities = new Map();

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
 * Remember one user's token. Kept in memory only: a gateway restart drops it
 * and the next page load replays it, so no platform identity is ever at rest.
 * @param {string} namespace
 * @param {{ access: string, refresh?: string, expiresAt: number }} tokenSet
 */
export function rememberTokens(namespace, tokenSet) {
  tokens.set(namespace, tokenSet);
}

/**
 * Per-namespace refresh in flight, so a burst of calls refreshes once.
 * @type {Map<string, Promise<TokenSet | undefined>>}
 */
const refreshing = new Map();

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
    tokens.set(namespace, next);
    return next;
  } catch (error) {
    console.warn(`v-office token refresh failed for ${namespace}:`, error);
    return undefined;
  }
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
 * Current usable access token, refreshing it first when it is near expiry.
 *
 * Exported because every capability endpoint authenticates upstream calls with
 * the same VOS token; `weknora.mjs` forwards it unchanged.
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
    return next?.access;
  } finally {
    refreshing.delete(namespace);
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @returns {boolean} whether the capability serves this route.
 */
function isAllowed(method, path) {
  return ROUTES.some((route) => route.method === method && route.pattern.test(path));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} payload
 */
function json(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength) });
  res.end(body);
}

/**
 * Count bytes so a chunked upload cannot exceed the upstream limit.
 * @param {number} limit
 * @returns {Transform}
 */
function byteLimiter(limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) {
        callback(new Error('file-too-large'));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Proxy one capability request to the storage service.
 * @param {string} namespace
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function forward(namespace, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  if (!isAllowed(method, url.pathname)) {
    json(res, 403, { error: 'route-not-allowed', message: '该路径不在 V-Office 能力范围内' });
    return;
  }

  const token = await accessTokenFor(namespace);
  if (!token && url.pathname !== '/api/v1/health') {
    json(res, 401, {
      error: 'vos-token-unavailable',
      message: 'VOS 登录令牌缺失或已过期，请在 v-harness 页面刷新后重试',
    });
    return;
  }

  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' };
  if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
  if (req.headers['content-length']) headers['content-length'] = String(req.headers['content-length']);
  if (token) headers.authorization = `Bearer ${token}`;

  await new Promise((resolve) => {
    const upstream = httpRequest({
      protocol: OFFICE_BASE.protocol,
      hostname: OFFICE_BASE.hostname,
      port: OFFICE_BASE.port || undefined,
      method,
      path: `${OFFICE_PREFIX}${url.pathname}`,
      headers,
    }, (upstreamRes) => {
      /** @type {Record<string, string>} */
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || !RESPONSE_HEADERS.has(name)) continue;
        responseHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('end', resolve);
      upstreamRes.on('error', resolve);
    });

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error('V-Office 请求超时'));
    });
    upstream.on('error', (error) => {
      console.error(`v-office upstream failed (${method} ${url.pathname}):`, error.message);
      if (!res.headersSent) json(res, 502, { error: 'v-office-unreachable' });
      else res.destroy();
      resolve();
    });
    res.on('close', () => { upstream.destroy(); resolve(); });

    if (method === 'GET' || method === 'DELETE') {
      req.resume();
      upstream.end();
      return;
    }

    const limiter = byteLimiter(MAX_UPLOAD_BYTES);
    limiter.on('error', () => {
      if (!res.headersSent) {
        json(res, 413, { error: 'file-too-large', message: '文件超过 100 MB 上限' });
      }
      upstream.destroy();
      req.destroy();
      resolve();
    });
    req.pipe(limiter).pipe(upstream);
  });
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {Error & { status: number, code: string }}
 */
function officeError(status, code, message) {
  const error = /** @type {Error & { status: number, code: string }} */ (new Error(message));
  error.status = status;
  error.code = code;
  return error;
}

/**
 * Exchange one document for a Collabora editor URL as the tenant's own user.
 *
 * This is the only piece the browser-side surfaces need: the storage service
 * signs the WOPI token, Collabora loads the document straight from it, and no
 * credential ever crosses into the page.
 * @param {string} namespace
 * @param {{ name: string, edit?: boolean, lang?: string, version?: number }} options
 * @returns {Promise<{ editorUrl: string, name: string, canWrite: boolean }>}
 */
export async function editorUrlFor(namespace, options) {
  const token = await accessTokenFor(namespace);
  if (token === undefined) {
    throw officeError(401, 'vos-token-unavailable', 'VOS 登录令牌缺失或已过期，请刷新 v-harness 页面后重试');
  }

  const query = new URLSearchParams({
    name: options.name,
    edit: options.edit === false ? '0' : '1',
    version: String(options.version ?? 0),
  });
  if (options.lang) query.set('lang', options.lang);

  // The storage service now signs an absolute Collabora URL at
  // /documents/editor-link. Deployments that have not upgraded yet only have
  // /wopi/session, so a 404 there falls through to the legacy call instead of
  // failing the whole flow.
  const link = await fetch(
    `${OFFICE_BASE.origin}${OFFICE_PREFIX}/api/v1/documents/editor-link?${query.toString()}`,
    {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    },
  ).catch(() => undefined);

  if (link?.ok) {
    const body = await link.json().catch(() => undefined);
    if (typeof body?.url !== 'string' || body.url === '') {
      throw officeError(502, 'editor-link-failed', 'V-Office 没有返回编辑器地址');
    }
    return {
      editorUrl: body.url,
      name: typeof body.name === 'string' ? body.name : options.name,
      canWrite: body.canWrite !== false,
    };
  }
  if (link !== undefined && link.status !== 404) {
    const body = await link.json().catch(() => undefined);
    const status = link.status === 401 ? 401 : 502;
    const code = link.status === 401 ? 'vos-token-unavailable' : 'editor-link-failed';
    const detail = typeof body?.detail === 'string' ? body.detail : `V-Office 返回 HTTP ${String(link.status)}`;
    throw officeError(status, code, detail);
  }

  const response = await fetch(
    `${OFFICE_BASE.origin}${OFFICE_PREFIX}/api/v1/wopi/session?${query.toString()}`,
    {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    },
  ).catch(() => undefined);
  if (response === undefined) {
    throw officeError(502, 'v-office-unreachable', 'V-Office 服务不可达');
  }

  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const status = response.status === 404 ? 404 : response.status === 401 ? 401 : 502;
    const code = response.status === 404 ? 'document-not-found'
      : response.status === 401 ? 'vos-token-unavailable'
        : 'wopi-session-failed';
    const detail = typeof body?.detail === 'string' ? body.detail : `V-Office 返回 HTTP ${String(response.status)}`;
    throw officeError(status, code, detail);
  }
  if (typeof body?.editorUrl !== 'string' || body.editorUrl === '') {
    throw officeError(502, 'wopi-session-failed', 'V-Office 没有返回编辑器地址');
  }

  return {
    editorUrl: body.editorUrl,
    name: typeof body.name === 'string' ? body.name : options.name,
    canWrite: body.canWrite !== false,
  };
}

/**
 * Start (once) the listening socket for one tenant.
 * @param {{ namespace: string, linuxName: string, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
async function start(options) {
  const { namespace, linuxName, home, userHelper } = options;
  const socketPath = join(home, '.dsh', SOCKET_NAME);
  await unlink(socketPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });

  const server = createServer((req, res) => {
    // Local-only route: the portal origin, so the agent can hand the user an
    // absolute link. It never leaves this socket and carries no document data.
    if (req.url === '/__vh/origin') {
      json(res, 200, { origin: publicOrigin });
      return;
    }
    void forward(namespace, req, res).catch((error) => {
      console.error(`v-office capability failed (${namespace}):`, error);
      if (!res.headersSent) json(res, 500, { error: 'capability-failed' });
      else res.destroy();
    });
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      // Shut the door before handing the key over: until `claim` runs, the
      // socket belongs to root, and nobody may call the capability.
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });

  // The account owner must be the only caller: 0600 on the socket itself plus
  // the 0700 `.dsh` directory. The helper owns every user-owned chmod/chown.
  await runUserHelper(userHelper, ['claim', linuxName, socketPath]);
}

/**
 * Make sure this tenant's capability endpoint exists.
 * @param {{ namespace: string, linuxName: string, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
export async function ensureOfficeCapability(options) {
  const existing = capabilities.get(options.namespace);
  if (existing) {
    await existing;
    return;
  }
  const starting = start(options);
  capabilities.set(options.namespace, starting);
  try {
    await starting;
  } catch (error) {
    capabilities.delete(options.namespace);
    throw error;
  }
}

/**
 * Close every capability socket; called on gateway shutdown. Socket files are
 * removed so a restart does not inherit a stale inode.
 * @returns {Promise<void>}
 */
export async function closeOfficeCapabilities() {
  const entries = [...capabilities.entries()];
  capabilities.clear();
  refreshing.clear();
  await Promise.all(entries.map(async ([namespace, starting]) => {
    try {
      const server = await starting;
      await new Promise((resolve) => { server.close(() => { resolve(); }); });
    } catch {
      // A capability that never started owns no socket; nothing to close.
    }
    tokens.delete(namespace);
  }));
}
