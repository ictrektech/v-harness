/**
 * Per-tenant PhotoCraft capability endpoint.
 *
 * Same trust model as `office.mjs` and `album.mjs`: the agent never holds a
 * credential. The gateway keeps the tenant's VOS access token in memory (via
 * `accessTokenFor`) and adds `Authorization` to everything it forwards to the
 * PhotoCraft app's storage service, which verifies the token through
 * `VOS_OIDC_USERINFO_URL` and pins every request to that user's own granted
 * directory.
 *
 * Two things are specific to this capability:
 *
 * * **Streaming.** `/mcp` is MCP over Streamable HTTP, so a reply may be an SSE
 *   stream that stays open across a whole agent turn. The proxy therefore
 *   pipes both directions without buffering (no body parsing, no
 *   `content-length` synthesis), and passes `mcp-session-id` both ways — the
 *   session id is what keeps one agent conversation's documents alive between
 *   calls.
 * * **No key exchange.** Unlike the album capability, the token PhotoCraft
 *   needs *is* the VOS token; there is nothing to trade it for.
 *
 * @module v-harness/gateway/photocraft
 */

import { createServer, request as httpRequest } from 'node:http';
import { chmodSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { accessTokenFor } from './office.mjs';
import { runUserHelper } from './instances.mjs';

const DEFAULT_PHOTOCRAFT_URL = 'http://172.17.0.1:1182/app/com.ictrek.photocraft/storage';
const PHOTOCRAFT_URL = (process.env.VH_PHOTOCRAFT_URL ?? DEFAULT_PHOTOCRAFT_URL).replace(/\/+$/, '');
const SOCKET_NAME = 'photocraft.sock';
const UPSTREAM_TIMEOUT_MS = 300_000;

/** Whether this deployment exposes the capability at all. */
export const PHOTOCRAFT_ENABLED = (process.env.VH_PHOTOCRAFT ?? '1') !== '0';

/**
 * Routes the capability exposes; everything else is refused locally. `/mcp` is
 * one endpoint for POST/GET/DELETE, because that is how Streamable HTTP works.
 */
const ROUTES = [
  { method: 'GET', path: /^\/volumes$/ },
  { method: 'GET', path: /^\/index$/ },
  { method: 'GET', path: /^\/download$/ },
  { method: 'POST', path: /^\/upload$/ },
  { method: 'POST', path: /^\/new_folder$/ },
  { method: 'POST', path: /^\/mcp(?:\/|$)/ },
  { method: 'GET', path: /^\/mcp(?:\/|$)/ },
  { method: 'DELETE', path: /^\/mcp(?:\/|$)/ },
];

/** Response headers worth replaying; anything else is the proxy's own. */
const RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'content-disposition',
  'mcp-session-id',
  'mcp-protocol-version',
]);

/** Request headers worth replaying; the rest (host, authorization, connection) are ours. */
const REQUEST_HEADERS = new Set([
  'accept',
  'content-type',
  'content-length',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

/** @type {Map<string, Promise<import('node:http').Server>>} */
const capabilities = new Map();

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
 * Build the upstream request headers from the caller's, keeping only what the
 * service reads and adding the tenant's own credential.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} token
 * @returns {import('node:http').OutgoingHttpHeaders}
 */
function headersFor(req, token) {
  /** @type {import('node:http').OutgoingHttpHeaders} */
  const headers = { authorization: `Bearer ${token}` };
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || !REQUEST_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  // MCP Streamable HTTP refuses a client that does not accept both encodings.
  const accept = String(headers.accept ?? '');
  if (!accept.includes('text/event-stream')) {
    headers.accept = accept === '' ? 'application/json, text/event-stream' : `${accept}, text/event-stream`;
  }
  return headers;
}

/**
 * Proxy one capability request to the PhotoCraft storage service.
 *
 * Exported so tests can mount it on a TCP listener: the socket is the
 * transport, not the contract.
 * @param {string} namespace
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function handlePhotocraft(namespace, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  if (!isAllowed(method, url.pathname)) {
    json(res, 403, { error: 'route-not-allowed', message: '该路径不在 PhotoCraft 能力范围内' });
    return;
  }

  const token = await accessTokenFor(namespace);
  if (!token) {
    json(res, 401, {
      error: 'vos-token-unavailable',
      message: 'VOS 登录令牌缺失或已过期，请在 v-harness 页面刷新后重试',
    });
    return;
  }

  const upstream = new URL(PHOTOCRAFT_URL);

  await new Promise((resolve) => {
    const call = httpRequest({
      // Node requires the colon form ('http:' / 'https:') or request() throws ERR_INVALID_PROTOCOL.
      protocol: upstream.protocol === 'https:' ? 'https:' : 'http:',
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method,
      // Query strings carry the adapter id, the path and the search text.
      path: `${upstream.pathname}${url.pathname}${url.search}`,
      headers: headersFor(req, token),
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      if (status === 401) {
        // The service checked the token and rejected it. There is nothing to
        // retry with: the tenant has to sign in again.
        upstreamRes.resume();
        json(res, 401, { error: 'vos-token-rejected', message: 'PhotoCraft 拒绝了当前登录令牌，请刷新页面重新登录' });
        resolve();
        return;
      }

      /** @type {import('node:http').OutgoingHttpHeaders} */
      const headers = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || !RESPONSE_HEADERS.has(name)) continue;
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      res.writeHead(status, headers);
      // SSE keeps one reply open for a whole turn; the idle timeout must not
      // cut a stream that is merely waiting for the next agent call.
      call.setTimeout(0);
      upstreamRes.pipe(res);
      upstreamRes.on('end', resolve);
      upstreamRes.on('error', resolve);
    });

    call.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      call.destroy(new Error('PhotoCraft 请求超时'));
    });
    call.on('error', (error) => {
      console.error(`photocraft upstream failed (${method} ${url.pathname}):`, error.message);
      if (!res.headersSent) json(res, 502, { error: 'photocraft-unreachable', message: 'PhotoCraft 服务不可达' });
      else res.destroy();
      resolve();
    });
    res.on('close', () => { call.destroy(); resolve(); });

    if (method === 'GET' || method === 'DELETE') {
      req.resume();
      call.end();
      return;
    }
    req.pipe(call);
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
    void handlePhotocraft(namespace, req, res).catch((error) => {
      console.error(`photocraft capability failed (${namespace}):`, error);
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

  // Root-owned until the helper chowns it to the tenant user, exactly like the
  // office and album capabilities.
  await runUserHelper(userHelper, ['claim', linuxName, socketPath]);
}

/**
 * Make sure this tenant's PhotoCraft capability endpoint exists.
 * @param {{ namespace: string, linuxName: string, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
export async function ensurePhotocraftCapability(options) {
  if (!PHOTOCRAFT_ENABLED) return;
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
 * Close every PhotoCraft capability socket; called on gateway shutdown.
 * @returns {Promise<void>}
 */
export async function closePhotocraftCapabilities() {
  const entries = [...capabilities.entries()];
  capabilities.clear();
  await Promise.all(entries.map(async ([, starting]) => {
    try {
      const server = await starting;
      await new Promise((resolve) => { server.close(() => { resolve(); }); });
    } catch {
      // A capability that never started owns no socket; nothing to close.
    }
  }));
}
