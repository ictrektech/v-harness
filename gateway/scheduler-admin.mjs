/** Tenant-scoped access to V-Scheduler's node management API.
 * The gateway supplies the current VOS identity. V-Scheduler validates roles
 * and owns connection credentials, hardware scans and container checks.
 */

import { createServer, request as httpRequest } from 'node:http';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { runUserHelper } from './instances.mjs';
import { listenOnSocket } from './socket-path.mjs';
import { accessTokenFor } from './vos-token-store.mjs';

const DEFAULT_SCHEDULER_ADMIN_URL = 'http://v-scheduler:8080';
const SCHEDULER_ADMIN_URL = (process.env.V_SCHEDULER_URL ?? DEFAULT_SCHEDULER_ADMIN_URL).replace(/\/+$/, '');
export const SOCKET_NAME = 'v-scheduler.sock';
/** SSH verification and the configured container check can take up to two minutes. */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** Routes the capability exposes; everything else is refused locally. */
export const ROUTES = [
  { method: 'POST', path: /^\/scheduler\/api\/v1\/nodes\/[A-Za-z0-9%:._-]{1,128}(?:\/(?:approve|drain|revoke))?$/ },
  { method: 'GET', path: /^\/scheduler\/api\/v1\/(nodes|managed-nodes|backend-deployments)$/ },
  { method: 'POST', path: /^\/scheduler\/api\/v1\/managed-nodes$/ },
  { method: 'PUT', path: /^\/scheduler\/api\/v1\/managed-nodes\/[A-Za-z0-9_.-]{1,128}$/ },
  { method: 'DELETE', path: /^\/scheduler\/api\/v1\/managed-nodes\/[A-Za-z0-9_.-]{1,128}$/ },
  { method: 'POST', path: /^\/scheduler\/api\/v1\/managed-nodes\/[A-Za-z0-9_.-]{1,128}\/(rescan|runtime)$/ },
];

/** Response headers worth replaying to the caller. */
const RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
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
 * Proxy one capability request to the V-Scheduler node management backend.
 * @param {string} namespace
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function forward(namespace, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (!isAllowed(method, path)) {
    json(res, 403, { error: 'route-not-allowed', message: '该路径不在 V-Scheduler node management 能力范围内' });
    return;
  }
  const token = await accessTokenFor(namespace);
  if (!token) {
    json(res, 401, { error: 'vos-token-unavailable' });
    return;
  }

  const upstreamUrl = new URL(SCHEDULER_ADMIN_URL);
  // A bare origin yields `/`, which would turn `/health` into `//health`.
  const basePath = upstreamUrl.pathname.replace(/\/+$/, '');

  const upstream = httpRequest({
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || undefined,
    method,
    // Query strings carry the model variant and pull options.
    path: `${basePath}${path}${url.search}`,
    headers: {
      accept: req.headers.accept ?? 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // Referer and Origin stay behind: the backend does not use them, and
      // forwarding a tenant-supplied origin is the one header office.mjs had to
      // sanitise.
      ...(req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}),
      ...(req.headers['content-length'] ? { 'content-length': String(req.headers['content-length']) } : {}),
    },
  }, (upstreamRes) => {
    const headers = {};
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined || !RESPONSE_HEADERS.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    res.writeHead(upstreamRes.statusCode ?? 502, headers);
    upstreamRes.pipe(res);
    upstreamRes.on('error', () => { res.destroy(); });
  });

  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstream.destroy(new Error('V-Scheduler node management 请求超时'));
  });
  upstream.on('error', (error) => {
    console.error(`v-scheduler upstream failed (${method} ${path}):`, error.message);
    if (!res.headersSent) json(res, 502, { error: 'v-scheduler-unreachable' });
    else res.destroy();
  });
  res.on('close', () => { upstream.destroy(); });

  if (method === 'GET' || method === 'DELETE') {
    req.resume();
    upstream.end();
    return;
  }
  // Multipart uploads and JSON bodies pass through unparsed.
  req.pipe(upstream);
}

/**
 * Serve one request that arrived through `/__vh/egress/v-scheduler`.
 *
 * The route table and upstream are the same as the gateway socket's: the
 * plugin owns the socket, not the semantics.
 * @param {string} namespace
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function handleSchedulerAdminEgress(namespace, req, res) {
  await forward(namespace, req, res);
}

/**
 * Start (once) the listening socket for one tenant.
 * @param {{ namespace: string, linuxName: string, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
async function start(options) {
  const { linuxName, home, userHelper } = options;
  const socketPath = join(home, '.dsh', SOCKET_NAME);

  const server = createServer((req, res) => {
    void forward(options.namespace, req, res).catch((error) => {
      console.error(`v-scheduler capability failed (${options.namespace}):`, error);
      if (!res.headersSent) json(res, 500, { error: 'capability-failed' });
      else res.destroy();
    });
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });

  await listenOnSocket(server, socketPath);
  chmodSync(socketPath, 0o600);

  // Same door-closing sequence as the album capability: root-owned until the
  // helper chowns it to the tenant user.
  await runUserHelper(userHelper, ['claim', linuxName, socketPath]);
  return server;
}

/**
 * Make sure this tenant's V-Scheduler node management capability endpoint exists.
 * @param {{ subject: string, namespace: string, linuxName: string, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
export async function ensureSchedulerAdminCapability(options) {
  const existing = capabilities.get(options.subject);
  if (existing) {
    await existing;
    return;
  }
  const starting = start(options);
  capabilities.set(options.subject, starting);
  try {
    await starting;
  } catch (error) {
    capabilities.delete(options.subject);
    throw error;
  }
}

/**
 * Drop one tenant's cached listener so the next `ensure` binds a fresh inode.
 * @param {string} subject immutable tenant subject
 * @returns {Promise<void>}
 */
export async function forgetSchedulerAdminCapability(subject) {
  const existing = capabilities.get(subject);
  capabilities.delete(subject);
  if (existing === undefined) return;
  try {
    const server = await existing;
    await new Promise((resolve) => { server.close(() => { resolve(); }); });
  } catch {
    // A capability that never started owns no socket.
  }
}

/**
 * Close every V-Scheduler node management capability socket; called on gateway shutdown.
 * @returns {Promise<void>}
 */
export async function closeSchedulerAdminCapabilities() {
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
