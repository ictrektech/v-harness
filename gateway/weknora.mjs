/**
 * Per-tenant WeKnora (HybRAG) capability endpoint.
 *
 * Same trust model as `office.mjs`: the agent never holds a VOS access token.
 * The gateway keeps the token in memory, listens on a Unix socket inside the
 * tenant's own 0700 directory, and adds `Authorization` itself.
 *
 * HybRAG's API only accepts a bearer it issued, so the VOS token is exchanged
 * once at `/api/v1/auth/vos-token-exchange` (`internal/handler/auth.go`,
 * `LoginWithVOSSSO`) and the result is cached per tenant until it is near
 * expiry. The agent never sees either token.
 *
 * Only reads are exposed: knowledge bases, their documents, chunks, retrieval
 * and the native RAG chat. Ingestion, downloads and management stay
 * unreachable from an agent — `/knowledge/:id/download` in particular must
 * never pass, because it hands out the original file.
 *
 * @module v-harness/gateway/weknora
 */

import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { runUserHelper } from './instances.mjs';
import { accessTokenFor } from './office.mjs';

const SOCKET_NAME = 'weknora.sock';
const UPSTREAM_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 2_000;
/** Consecutive upstream failures before the resolved address is re-probed. */
const RETRY_AFTER_FAILURES = 3;
const EXCHANGE_TIMEOUT_MS = 15_000;
/**
 * How long an exchanged bearer is reused. HybRAG issues hour-long tokens and
 * VOS access tokens last the same, so refreshing well inside that window keeps
 * a request from racing the expiry.
 */
const EXCHANGE_TTL_MS = 45 * 60_000;

/**
 * Where a deployment can name the knowledge-base address without its env.
 *
 * The container is created by a scheduler that owns its environment, so an
 * address added later cannot reach it without recreating the container. A file
 * on the data volume survives restarts and lets an operator point the gateway
 * at a service that moved.
 */
const ADDRESS_FILE = join(process.env.DATA_ROOT ?? '/data', 'weknora-url');

/**
 * The configured upstream, if any.
 * @returns {string} the address, or an empty string when nothing configured one.
 */
function configuredAddress() {
  const fromEnv = process.env.WEKNORA_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    return readFileSync(ADDRESS_FILE, 'utf8').trim();
  } catch (error) {
    // No address file is the normal case; anything else is worth reporting once.
    if (error?.code !== 'ENOENT') console.warn(`weknora address file unreadable: ${error.message}`);
    return '';
  }
}

/**
 * The one address this deployment configured, without a trailing slash.
 *
 * There is deliberately no built-in fallback: a hardcoded private address in
 * the image is a deployment choice made in the wrong place, and probing it
 * turns "not configured" into a misleading 503 about a service that was never
 * meant to be there.
 * @returns {string[]} the candidate base URLs.
 */
function candidates() {
  const configured = configuredAddress().replace(/\/+$/, '');
  return configured === '' ? [] : [configured];
}

/** Routes the capability serves; everything else is refused locally. */
const ROUTES = [
  { method: 'GET', pattern: /^\/health$/ },
  { method: 'GET', pattern: /^\/api\/v1\/knowledge-bases$/ },
  { method: 'GET', pattern: /^\/api\/v1\/knowledge-bases\/[^/]+$/ },
  { method: 'GET', pattern: /^\/api\/v1\/knowledge-bases\/[^/]+\/knowledge$/ },
  { method: 'GET', pattern: /^\/api\/v1\/knowledge-bases\/[^/]+\/knowledge\/folders$/ },
  { method: 'GET', pattern: /^\/api\/v1\/knowledge\/[^/]+$/ },
  { method: 'GET', pattern: /^\/api\/v1\/knowledge\/[^/]+\/preview$/ },
  { method: 'GET', pattern: /^\/api\/v1\/chunks\/[^/]+$/ },
  { method: 'GET', pattern: /^\/api\/v1\/models$/ },
  { method: 'POST', pattern: /^\/api\/v1\/knowledge-search$/ },
  { method: 'POST', pattern: /^\/api\/v1\/sessions$/ },
  { method: 'POST', pattern: /^\/api\/v1\/knowledge-chat\/[^/]+$/ },
];

/** @type {Map<string, Promise<import('node:http').Server>>} */
const capabilities = new Map();

/** Resolved upstream, cached after the first successful probe. */
let base;
/** In-flight probe, shared so a burst of calls probes once. */
let probing;
/** Consecutive upstream failures since the last successful request. */
let failures = 0;

/** @type {Map<string, { vosToken: string, token: string, expiresAt: number }>} */
const exchanges = new Map();
/** @type {Map<string, Promise<string | undefined>>} */
const exchanging = new Map();

/**
 * First candidate whose `/health` answers. A miss stays a miss until the next
 * call, so a WeKnora that starts after the gateway is picked up without a
 * restart.
 * @returns {Promise<string | undefined>}
 */
async function probe() {
  for (const candidate of candidates()) {
    const reachable = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      .then((response) => response.ok)
      .catch(() => false);
    if (reachable) return candidate;
  }
  return undefined;
}

/**
 * The upstream base, re-probed once a service that answered stops answering.
 * @returns {Promise<string | undefined>}
 */
async function upstream() {
  if (base !== undefined && failures < RETRY_AFTER_FAILURES) return base;
  probing ??= probe();
  const found = await probing;
  probing = undefined;
  base = found;
  failures = 0;
  return base;
}

/**
 * Record one failed attempt; enough of them forget the cached address so a
 * service that moved is picked up without restarting the gateway.
 * @returns {void}
 */
function upstreamFailed() {
  failures += 1;
  if (failures >= RETRY_AFTER_FAILURES) base = undefined;
}

/**
 * A HybRAG bearer for this tenant, exchanged from its VOS access token.
 *
 * The exchange is the one place the gateway turns one credential into another;
 * the result is cached until shortly before expiry, keyed by the VOS token it
 * came from so a refreshed login is never served a stale bearer. Concurrent
 * requests share one in-flight exchange.
 * @param {string} namespace
 * @param {string} target - upstream base URL.
 * @returns {Promise<string | undefined>} the bearer, or undefined when the
 *   tenant is not signed in or HybRAG refuses the exchange.
 */
async function hybragTokenFor(namespace, target) {
  const vosToken = await accessTokenFor(namespace);
  if (!vosToken) return undefined;

  const cached = exchanges.get(namespace);
  if (cached !== undefined && cached.vosToken === vosToken && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const pending = exchanging.get(namespace);
  if (pending !== undefined) return pending;

  const attempt = (async () => {
    try {
      const response = await fetch(`${target}/api/v1/auth/vos-token-exchange`, {
        method: 'POST',
        headers: { authorization: `Bearer ${vosToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error(`weknora token exchange failed (${namespace}): HTTP ${response.status}`);
        return undefined;
      }
      const body = await response.json();
      const token = typeof body?.token === 'string' && body.token !== '' ? body.token : undefined;
      if (token === undefined) {
        console.error(`weknora token exchange returned no token (${namespace})`);
        return undefined;
      }
      exchanges.set(namespace, { vosToken, token, expiresAt: Date.now() + EXCHANGE_TTL_MS });
      return token;
    } catch (error) {
      console.error(`weknora token exchange error (${namespace}):`, error.message);
      return undefined;
    } finally {
      exchanging.delete(namespace);
    }
  })();

  exchanging.set(namespace, attempt);
  return attempt;
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
    // Name what was probed: without it the admin cannot tell a wrong address
    // from a service that is simply down.
    const configured = candidates();
    json(res, 503, {
      error: 'weknora-unreachable',
      message: configured.length === 0
        ? `没有配置知识库服务地址；请设置 WEKNORA_URL 或写入 ${ADDRESS_FILE}`
        : `知识库服务不可达（已尝试 ${configured.join('、')}）；请检查地址或服务状态`,
    });
    return;
  }

  const token = path === '/health' ? undefined : await hybragTokenFor(namespace, target);
  if (token === undefined && path !== '/health') {
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
        // The two catalogue calls decide whether the UI can offer a scope or a
        // model at all, and their failures are silent on the client (an empty
        // list looks like "you have nothing"), so name them here.
        if (path === '/api/v1/models' || path === '/api/v1/knowledge-bases') {
          console.log(
            `weknora ${method} ${path} -> ${String(incoming.statusCode ?? 0)}`
              + ` len=${String(incoming.headers['content-length'] ?? '?')}`,
          );
        }
        // Streaming through unchanged keeps knowledge-chat's SSE incremental.
        res.writeHead(incoming.statusCode ?? 502, {
          'content-type': incoming.headers['content-type'] ?? 'application/json',
          'cache-control': 'no-store',
        });
        incoming.pipe(res);
        incoming.on('end', () => { failures = 0; resolve(); });
        incoming.on('error', resolve);
      },
    );

    outgoing.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      outgoing.destroy(new Error('知识库请求超时'));
    });
    outgoing.on('error', (error) => {
      console.error(`weknora upstream failed (${method} ${url.pathname}):`, error.message);
      upstreamFailed();
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
 * @returns {Promise<import('node:http').Server>}
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
  return server;
}

/**
 * Serve one `/__vh/weknora/<rest>` browser request.
 *
 * The browser authenticates with its own v-harness cookie and cannot open the
 * tenant socket, so the client-side pieces reach the same upstream through this
 * path.
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
  exchanges.clear();
  exchanging.clear();
  base = undefined;
  probing = undefined;
  failures = 0;
  await Promise.all(entries.map(async ([, starting]) => {
    const server = await starting.catch(() => undefined);
    if (!server) return;
    await new Promise((resolve) => { server.close(() => { resolve(); }); });
  }));
}
