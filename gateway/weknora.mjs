/**
 * Per-tenant WeKnora (HybRAG) capability endpoint.
 *
 * Same trust model as `office.mjs`: the agent never holds a VOS access token.
 * The gateway keeps the token in memory, listens on a Unix socket inside the
 * tenant's own 0700 directory, and adds `Authorization` itself.
 *
 * No token exchange is involved. WeKnora verifies a VOS bearer against the same
 * OIDC userinfo endpoint the gateway refreshes from
 * (`internal/middleware/auth.go`, `authenticateVOSBearerUser`), so the tenant's
 * access token is forwarded unchanged.
 *
 * Only retrieval and chat are exposed. Knowledge-base and document management
 * stay unreachable from an agent.
 *
 * @module v-harness/gateway/weknora
 */

import { createServer, request as httpRequest } from 'node:http';
import { chmodSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { runUserHelper } from './instances.mjs';
import { accessTokenFor } from './office.mjs';

const SOCKET_NAME = 'weknora.sock';
const UPSTREAM_TIMEOUT_MS = 300_000;

/**
 * Where WeKnora listens. Explicit configuration wins; otherwise the two
 * addresses that are reachable from this deployment: the host port mapping and
 * the container address on the shared docker network.
 */
const CANDIDATES = [
  process.env.WEKNORA_URL,
  'http://127.0.0.1:29081',
  'http://192.168.64.27:8080',
]
  .filter((value) => typeof value === 'string' && value.length > 0)
  .map((value) => value.replace(/\/+$/, ''));

/** Routes the capability serves; everything else is refused locally. */
const ROUTES = [
  { method: 'GET', pattern: /^\/health$/ },
  { method: 'GET', pattern: /^\/api\/v1\/knowledge-bases$/ },
  { method: 'POST', pattern: /^\/api\/v1\/knowledge-search$/ },
  { method: 'GET', pattern: /^\/api\/v1\/knowledge\/[^/]+$/ },
  { method: 'GET', pattern: /^\/api\/v1\/chunks\/[^/]+$/ },
  { method: 'GET', pattern: /^\/api\/v1\/chunks\/by-id\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/v1\/sessions$/ },
  { method: 'POST', pattern: /^\/api\/v1\/knowledge-chat\/[^/]+$/ },
];

/** @type {Map<string, Promise<import('node:http').Server>>} */
const capabilities = new Map();

/** Resolved upstream, cached after the first successful probe. */
let base;
/** In-flight probe, shared so a burst of calls probes once. */
let probing;

/**
 * First candidate whose `/health` answers. A miss stays a miss until the next
 * call, so a WeKnora that starts after the gateway is picked up without a
 * restart.
 * @returns {Promise<string | undefined>}
 */
async function probe() {
  for (const candidate of CANDIDATES) {
    const reachable = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (reachable) return candidate;
  }
  return undefined;
}

/**
 * @returns {Promise<string | undefined>} the upstream base, if any is reachable.
 */
async function upstream() {
  if (base) return base;
  probing ??= probe();
  base = await probing;
  probing = undefined;
  return base;
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
 * Proxy one capability request to WeKnora, adding the caller's bearer.
 * @param {string} namespace
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} [path] - upstream path; defaults to the incoming request path.
 * @returns {Promise<void>}
 */
async function forward(namespace, req, res, path = new URL(req.url ?? '/', 'http://localhost').pathname) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  if (!isAllowed(method, path)) {
    json(res, 403, { error: 'route-not-allowed', message: '该路径不在知识库能力范围内' });
    return;
  }

  const target = await upstream();
  if (!target) {
    json(res, 503, {
      error: 'weknora-unreachable',
      message: '没有可用的知识库服务，请联系管理员',
    });
    return;
  }

  const token = await accessTokenFor(namespace);
  if (!token && path !== '/health') {
    json(res, 401, {
      error: 'vos-token-unavailable',
      message: 'VOS 登录令牌缺失或已过期，请在 v-harness 页面刷新后重试',
    });
    return;
  }

  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' };
  if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
  if (token) headers.authorization = `Bearer ${token}`;

  await new Promise((resolve) => {
    const outgoing = httpRequest(
      new URL(`${target}${path}${url.search}`),
      { method, headers },
      (incoming) => {
        // Streaming through unchanged keeps knowledge-chat's SSE incremental.
        res.writeHead(incoming.statusCode ?? 502, {
          'content-type': incoming.headers['content-type'] ?? 'application/json',
          'cache-control': 'no-store',
        });
        incoming.pipe(res);
        incoming.on('end', resolve);
        incoming.on('error', resolve);
      },
    );

    outgoing.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      outgoing.destroy(new Error('知识库请求超时'));
    });
    outgoing.on('error', (error) => {
      console.error(`weknora upstream failed (${method} ${url.pathname}):`, error.message);
      if (!res.headersSent) json(res, 502, { error: 'weknora-unreachable' });
      else res.destroy();
      resolve();
    });
    res.on('close', () => { outgoing.destroy(); resolve(); });
    req.pipe(outgoing);
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
      console.error(`weknora capability failed (${namespace}):`, error);
      if (!res.headersSent) json(res, 500, { error: 'capability-failed' });
      else res.destroy();
    });
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      // The socket belongs to root until `claim` hands it to the tenant.
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });

  await runUserHelper(userHelper, ['claim', linuxName, socketPath]);
}

/**
 * Serve one `/__vh/weknora/<rest>` browser request.
 *
 * The browser authenticates with its own v-harness cookie and cannot open the
 * tenant socket, so the client-side pieces (the `@` library menu, the evidence
 * drawer) reach the same upstream through this path.
 * @param {string} namespace
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rest - path after `/__vh/weknora`, e.g. `/api/v1/knowledge-bases`.
 * @returns {Promise<void>}
 */
export async function handleWeknoraControl(namespace, req, res, rest) {
  await forward(namespace, req, res, rest);
}

/**
 * Make sure this tenant's capability endpoint exists.
 * @param {{ namespace: string, linuxName: string, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
export async function ensureWeknoraCapability(options) {
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
 * Close every capability socket; called on gateway shutdown.
 * @returns {Promise<void>}
 */
export async function closeWeknoraCapabilities() {
  const entries = [...capabilities.entries()];
  capabilities.clear();
  base = undefined;
  probing = undefined;
  await Promise.all(entries.map(async ([, starting]) => {
    const server = await starting.catch(() => undefined);
    if (!server) return;
    await new Promise((resolve) => { server.close(() => { resolve(); }); });
  }));
}
