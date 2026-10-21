/**
 * Per-tenant AI-album (Immich) capability endpoint.
 *
 * Same trust model as `office.mjs`: the agent never holds credentials. The
 * gateway keeps the tenant's VOS access token (via `accessTokenFor`) and
 * exchanges it at Immich's `POST /oauth/vos-exchange` for a per-user API key
 * that only lives in this process's memory. A `401` from Immich means the
 * cached key is stale (Immich redeploys rotate users) — drop it and exchange
 * once more with the same VOS token, exactly like the Image Studio backend.
 *
 * Read endpoints additionally require `asset.read` / `person.read` /
 * `album.read` / `asset.statistics` on the exchanged key, which the ai-album
 * deployment grants through `IMMICH_VOS_PERMISSIONS`; and the VOS token's
 * audience must be listed in Immich's `IMMICH_VOS_AUDIENCE`.
 *
 * @module v-harness/gateway/album
 */

import { createServer, request as httpRequest } from 'node:http';
import { chmodSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { accessTokenFor } from './office.mjs';
import { runUserHelper } from './instances.mjs';

const DEFAULT_ALBUM_URL = 'http://172.17.0.1:1182/app/com.ictrek.ai-album/api';
const ALBUM_URL = (process.env.VH_ALBUM_URL ?? DEFAULT_ALBUM_URL).replace(/\/+$/, '');
const SOCKET_NAME = 'album.sock';
const EXCHANGE_TIMEOUT_MS = 15_000;
const UPSTREAM_TIMEOUT_MS = 300_000;

/** Routes the capability exposes; everything else is refused locally. */
const ROUTES = [
  { method: 'GET', path: /^\/server\/ping$/ },
  { method: 'GET', path: /^\/users\/me$/ },
  { method: 'POST', path: /^\/search\/smart$/ },
  { method: 'POST', path: /^\/search\/metadata$/ },
  { method: 'GET', path: /^\/search\/person$/ },
  { method: 'GET', path: /^\/search\/explore$/ },
  { method: 'GET', path: /^\/search\/cities$/ },
  { method: 'GET', path: /^\/search\/places$/ },
  { method: 'GET', path: /^\/albums$/ },
  { method: 'POST', path: /^\/albums$/ },
  { method: 'GET', path: /^\/albums\/[^/]+$/ },
  { method: 'POST', path: /^\/albums\/[^/]+\/assets$/ },
  { method: 'GET', path: /^\/assets\/[^/]+$/ },
  { method: 'GET', path: /^\/assets\/[^/]+\/thumbnail$/ },
  { method: 'GET', path: /^\/assets\/[^/]+\/original$/ },
  { method: 'POST', path: /^\/assets$/ },
];

/** Client path → Immich path for the two aliases the CLI uses. */
const PATH_MAP = {
  '/health': '/server/ping',
  '/me': '/users/me',
};

/** Response headers worth replaying to the caller. */
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'content-disposition']);

/** @type {Map<string, string>} namespace -> cached Immich API key */
const albumKeys = new Map();

/** @type {Map<string, Promise<import('node:http').Server>>} */
const capabilities = new Map();

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
 * @param {string} method
 * @param {string} path
 * @returns {boolean} whether the capability serves this route.
 */
function isAllowed(method, path) {
  return ROUTES.some((route) => route.method === method && route.path.test(path));
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
 * Exchange the tenant's VOS token for an Immich API key. One key per
 * (VOS app × user): every exchange rotates the previous one away, so the
 * cached key is reused until Immich rejects it.
 * @param {string} namespace
 * @returns {Promise<string | undefined>}
 */
async function exchangeKey(namespace) {
  const vosToken = await accessTokenFor(namespace);
  if (!vosToken) return undefined;
  try {
    const response = await fetch(`${ALBUM_URL}/oauth/vos-exchange`, {
      method: 'POST',
      headers: { authorization: `Bearer ${vosToken}` },
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`album key exchange rejected for ${namespace}: HTTP ${String(response.status)}`);
      return undefined;
    }
    const body = await response.json();
    if (typeof body?.apiKey !== 'string' || body.apiKey === '') return undefined;
    return body.apiKey;
  } catch (error) {
    console.warn(`album key exchange failed for ${namespace}:`, error);
    return undefined;
  }
}

/**
 * Current Immich key for the tenant, exchanging (or re-exchanging) as needed.
 * @param {string} namespace
 * @param {{ fresh?: boolean }} [options] force a re-exchange on stale keys
 * @returns {Promise<string | undefined>}
 */
async function keyFor(namespace, options = {}) {
  if (!options.fresh) {
    const cached = albumKeys.get(namespace);
    if (cached) return cached;
  }
  const key = await exchangeKey(namespace);
  if (key) albumKeys.set(namespace, key);
  return key;
}

/**
 * Proxy one capability request to the ai-album storage service.
 * @param {string} namespace
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function forward(namespace, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const restPath = url.pathname.replace(/^\/api\/v1\/album/, '');
  const upstreamPath = PATH_MAP[restPath] ?? restPath;
  if (!isAllowed(method, restPath)) {
    json(res, 403, { error: 'route-not-allowed', message: '该路径不在 AI 相册能力范围内' });
    return;
  }

  // /server/ping needs no credentials; everything else requires an exchanged key.
  let key;
  if (upstreamPath !== '/server/ping') {
    key = await keyFor(namespace);
    if (!key) {
      json(res, 401, {
        error: 'vos-token-unavailable',
        message: 'VOS 登录令牌缺失或已过期，请在 v-harness 页面刷新后重试',
      });
      return;
    }
  }

  await new Promise((resolve) => {
    const upstream = httpRequest({
      protocol: ALBUM_URL.startsWith('https') ? 'https' : 'http',
      hostname: new URL(ALBUM_URL).hostname,
      port: new URL(ALBUM_URL).port || undefined,
      method,
      // Query strings carry search filters and thumbnail sizes.
      path: `${new URL(ALBUM_URL).pathname}${upstreamPath}${url.search}`,
      headers: {
        accept: req.headers.accept ?? 'application/json',
        ...(req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}),
        ...(req.headers['content-length'] ? { 'content-length': String(req.headers['content-length']) } : {}),
        ...(key ? { 'x-api-key': key } : {}),
      },
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      // A stale cached key (Immich redeploy remaps users) is a retry signal,
      // not a failure: exchange once more and replay the same request. A 403
      // is a permission-configuration problem and must not loop here.
      if (status === 401) {
        upstreamRes.resume();
        void (async () => {
          const fresh = await keyFor(namespace, { fresh: true });
          if (!fresh) {
            json(res, 401, { error: 'album-key-unavailable', message: '相册密钥获取失败，请在 v-harness 页面刷新后重试' });
            resolve();
            return;
          }
          const retry = httpRequest({
            protocol: ALBUM_URL.startsWith('https') ? 'https' : 'http',
            hostname: new URL(ALBUM_URL).hostname,
            port: new URL(ALBUM_URL).port || undefined,
            method,
            path: `${new URL(ALBUM_URL).pathname}${upstreamPath}${url.search}`,
            headers: {
              accept: req.headers.accept ?? 'application/json',
              ...(req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}),
              ...(req.headers['content-length'] ? { 'content-length': String(req.headers['content-length']) } : {}),
              'x-api-key': fresh,
            },
          }, (retryRes) => {
            const headers = {};
            for (const [name, value] of Object.entries(retryRes.headers)) {
              if (value === undefined || !RESPONSE_HEADERS.has(name)) continue;
              headers[name] = Array.isArray(value) ? value.join(', ') : value;
            }
            res.writeHead(retryRes.statusCode ?? 502, headers);
            retryRes.pipe(res);
            retryRes.on('end', resolve);
            retryRes.on('error', resolve);
          });
          retry.setTimeout(UPSTREAM_TIMEOUT_MS, () => retry.destroy(new Error('AI 相册请求超时')));
          retry.on('error', (error) => {
            console.error(`album upstream retry failed (${method} ${restPath}):`, error.message);
            if (!res.headersSent) json(res, 502, { error: 'album-unreachable' });
            else res.destroy();
            resolve();
          });
          if (method === 'GET') retry.end();
          else req.pipe(retry);
        })();
        return;
      }

      const headers = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || !RESPONSE_HEADERS.has(name)) continue;
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      res.writeHead(status, headers);
      upstreamRes.pipe(res);
      upstreamRes.on('end', resolve);
      upstreamRes.on('error', resolve);
    });

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error('AI 相册请求超时'));
    });
    upstream.on('error', (error) => {
      console.error(`album upstream failed (${method} ${restPath}):`, error.message);
      if (!res.headersSent) json(res, 502, { error: 'album-unreachable' });
      else res.destroy();
      resolve();
    });
    res.on('close', () => { upstream.destroy(); resolve(); });

    if (method === 'GET') {
      req.resume();
      upstream.end();
      return;
    }
    req.pipe(upstream);
  });
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
    void forward(namespace, req, res).catch((error) => {
      console.error(`album capability failed (${namespace}):`, error);
      if (!res.headersSent) json(res, 500, { error: 'capability-failed' });
      else res.destroy();
    });
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });

  // Same door-closing sequence as the office capability: root-owned until the
  // helper chowns it to the tenant user.
  await runUserHelper(userHelper, ['claim', linuxName, socketPath]);
}

/**
 * Make sure this tenant's album capability endpoint exists.
 * @param {{ namespace: string, linuxName: string, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
export async function ensureAlbumCapability(options) {
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
 * Close every album capability socket; called on gateway shutdown.
 * @returns {Promise<void>}
 */
export async function closeAlbumCapabilities() {
  const entries = [...capabilities.entries()];
  capabilities.clear();
  albumKeys.clear();
  await Promise.all(entries.map(async ([, starting]) => {
    try {
      const server = await starting;
      await new Promise((resolve) => { server.close(() => { resolve(); }); });
    } catch {
      // A capability that never started owns no socket; nothing to close.
    }
  }));
}
