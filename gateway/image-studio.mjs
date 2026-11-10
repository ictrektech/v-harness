/**
 * Per-tenant Image Studio capability endpoint.
 *
 * The service has no authentication of its own (`/api/v1/me` answers
 * `authenticated: false` and issues a fixed anonymous `user_key`), so unlike
 * `album.mjs` there is nothing to exchange here: the endpoint is a route-scoped
 * reverse proxy and nothing more. What it buys is the network: the skill used to
 * dial `http://image-studio-backend:5000` from inside the tenant namespace,
 * which forced the egress policy to keep one platform address open. Over a unix
 * socket the tenant needs no route to the platform network at all.
 *
 * The route table is the skill's own command surface; every other path is
 * refused locally so the socket cannot be used to reach the rest of the API.
 *
 * @module v-harness/gateway/image-studio
 */

import { createServer, request as httpRequest } from 'node:http';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { runUserHelper } from './instances.mjs';
import { listenOnSocket } from './socket-path.mjs';

const DEFAULT_IMAGE_STUDIO_URL = 'http://image-studio-backend:5000';
const IMAGE_STUDIO_URL = (process.env.VH_IMAGE_STUDIO_URL ?? DEFAULT_IMAGE_STUDIO_URL).replace(/\/+$/, '');
export const SOCKET_NAME = 'image-studio.sock';
/** Generous: a video job download can legitimately run for minutes. */
const UPSTREAM_TIMEOUT_MS = 600_000;

/** Routes the capability exposes; everything else is refused locally. */
export const ROUTES = [
  { method: 'GET', path: /^\/health$/ },
  { method: 'GET', path: /^\/api\/v1\/about$/ },
  { method: 'GET', path: /^\/api\/v1\/me$/ },
  { method: 'GET', path: /^\/api\/v1\/models$/ },
  { method: 'GET', path: /^\/api\/v1\/models\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/v1\/models\/[^/]+\/(pull|stop|sync)$/ },
  { method: 'POST', path: /^\/api\/v1\/inputs$/ },
  { method: 'POST', path: /^\/api\/v1\/generate$/ },
  { method: 'GET', path: /^\/api\/v1\/jobs$/ },
  { method: 'GET', path: /^\/api\/v1\/jobs\/[^/]+$/ },
  { method: 'DELETE', path: /^\/api\/v1\/jobs\/[^/]+$/ },
  { method: 'GET', path: /^\/api\/v1\/outputs\/[^/]+\/[^/]+$/ },
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
 * Proxy one capability request to the Image Studio backend.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function forward(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (!isAllowed(method, path)) {
    json(res, 403, { error: 'route-not-allowed', message: '该路径不在 Image Studio 能力范围内' });
    return;
  }

  const upstreamUrl = new URL(IMAGE_STUDIO_URL);
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
    upstream.destroy(new Error('Image Studio 请求超时'));
  });
  upstream.on('error', (error) => {
    console.error(`image-studio upstream failed (${method} ${path}):`, error.message);
    if (!res.headersSent) json(res, 502, { error: 'image-studio-unreachable' });
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
 * Serve one request that arrived through `/__vh/egress/image-studio`.
 *
 * The route table and upstream are the same as the gateway socket's: the
 * plugin owns the socket, not the semantics.
 * @param {string} _namespace unused; Image Studio is per-deployment, not per-tenant.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function handleImageStudioEgress(_namespace, req, res) {
  await forward(req, res);
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
    void forward(req, res).catch((error) => {
      console.error(`image-studio capability failed (${options.namespace}):`, error);
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
 * Make sure this tenant's Image Studio capability endpoint exists.
 * @param {{ subject: string, namespace: string, linuxName: string, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
export async function ensureImageStudioCapability(options) {
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
export async function forgetImageStudioCapability(subject) {
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
 * Close every Image Studio capability socket; called on gateway shutdown.
 * @returns {Promise<void>}
 */
export async function closeImageStudioCapabilities() {
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
