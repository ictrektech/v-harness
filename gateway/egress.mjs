/**
 * Capability egress: the gateway half of the tenant-owned capability sockets.
 *
 * When a capability socket lives in a tenant's dsh process, the skill still
 * talks to `$HOME/.dsh/<name>.sock`; the plugin forwards that request here.
 * This is the only route a capability caller may reach, and it deliberately
 * bypasses the browser session: the caller is a local plugin process, not a
 * browser, and it proves itself with the tenant capability key instead of a
 * `vh_session` cookie.
 *
 * Loopback is not a trust boundary here: every tenant uid can reach the
 * gateway on 127.0.0.1, so a leaked key would otherwise let any tenant process
 * forge session-free calls. The transport therefore refuses browser-shaped
 * requests, requires a loopback `Host`, and rejects path traversal before the
 * capability module sees the path.
 *
 * @module v-harness/gateway/egress
 */

import { capabilityContractFor, capabilityScopeFor } from './capability-registry.mjs';

/** Prefix of every forwarded capability request. */
export const EGRESS_PREFIX = '/__vh/egress/';
/** Header carrying the tenant capability key. */
export const EGRESS_KEY_HEADER = 'x-vh-capability-key';

const LOOPBACK = /^(?:::ffff:)?127\.\d+\.\d+\.\d+$|^::1$/;
/** The only authorities a local plugin may dial. */
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d{1,5})?$/i;
const BROWSER_HEADERS = ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'];
/** A dot segment, raw or percent-encoded, is never part of a capability path. */
const DOT_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)/;

/**
 * Split an egress path into the capability and the path the capability serves.
 * @param {string} pathname
 * @returns {{ capability: string, path: string } | undefined}
 */
export function parseEgressPath(pathname) {
  if (!pathname.startsWith(EGRESS_PREFIX)) return undefined;
  const rest = pathname.slice(EGRESS_PREFIX.length);
  if (rest === '') return undefined;
  const slash = rest.indexOf('/');
  if (slash === -1) return { capability: rest, path: '/' };
  const capability = rest.slice(0, slash);
  return capability === '' ? undefined : { capability, path: rest.slice(slash) };
}

/**
 * Whether a forwarded path could leave the capability it was addressed to.
 *
 * `new URL` already resolves dot segments, so the raw and decoded forms are
 * both inspected: `%2e%2e` survives parsing and is decoded again upstream.
 * @param {string | undefined} path
 * @returns {boolean}
 */
function unsafePath(path) {
  if (path === undefined) return false;
  if (path.includes('\\') || path.includes('\0')) return true;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  return DOT_SEGMENT.test(path) || DOT_SEGMENT.test(decoded)
    || decoded.includes('\\') || decoded.includes('\0');
}

/**
 * Why this request may not use egress, if it may not.
 *
 * The order is deliberate: browser shape, source address, and authority are
 * checked before the key, so a browser probing the route learns nothing about
 * key validity.
 * @param {object} request
 * @param {import('node:http').IncomingMessage['headers']} request.headers
 * @param {string | undefined} request.remoteAddress
 * @param {string} request.capability
 * @param {string} [request.path] path the capability would serve
 * @returns {{ status: number, error: string } | undefined}
 */
export function egressRefusal({ headers, remoteAddress, capability, path }) {
  if (BROWSER_HEADERS.some((name) => headers[name] !== undefined)) {
    return { status: 403, error: 'browser-forbidden' };
  }
  if (typeof remoteAddress !== 'string' || !LOOPBACK.test(remoteAddress)) {
    return { status: 403, error: 'not-loopback' };
  }
  const host = headers.host;
  if (typeof host !== 'string' || !LOOPBACK_HOST.test(host)) {
    return { status: 403, error: 'host-forbidden' };
  }
  if (capability === '') return { status: 404, error: 'capability-unknown' };
  if (unsafePath(path)) return { status: 400, error: 'path-forbidden' };
  return undefined;
}

/**
 * Serve one `/__vh/egress/*` request.
 *
 * The handler table is injected so this module owns the transport and the
 * capability modules own their upstream semantics; an unknown capability and a
 * capability with no handler are both refused rather than guessed. The key's
 * scope is intersected with the rollout for its own namespace, so a tampered
 * delivery copy cannot enable a capability this deployment stopped delegating.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url parsed request URL
 * @param {Record<string, (namespace: string, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, contract: import('./capability-registry.mjs').CapabilityContractRecord) => Promise<void> | void>} handlers
 * @param {NodeJS.ProcessEnv} [env] deployment environment carrying the rollout
 * @returns {Promise<void>}
 */
export async function handleEgress(req, res, url, handlers, env = process.env) {
  const parsed = parseEgressPath(url.pathname);
  if (parsed === undefined) {
    json(res, 404, { error: 'capability-unknown' });
    return;
  }
  const refusal = egressRefusal({
    headers: req.headers,
    remoteAddress: req.socket.remoteAddress,
    capability: parsed.capability,
    path: parsed.path,
  });
  if (refusal !== undefined) {
    json(res, refusal.status, { error: refusal.error });
    return;
  }
  const presented = req.headers[EGRESS_KEY_HEADER];
  const key = Array.isArray(presented) ? presented[0] : presented;
  if (typeof key !== 'string' || key === '') {
    json(res, 401, { error: 'capability-key-required' });
    return;
  }
  const scope = capabilityScopeFor(key, env);
  if (scope === undefined) {
    json(res, 401, { error: 'capability-key-invalid' });
    return;
  }
  if (!scope.has(parsed.capability)) {
    json(res, 403, { error: 'capability-not-enabled' });
    return;
  }
  const handler = handlers[parsed.capability];
  if (handler === undefined) {
    json(res, 404, { error: 'capability-unknown' });
    return;
  }
  const contract = capabilityContractFor(key);
  if (contract === undefined) {
    json(res, 401, { error: 'capability-key-invalid' });
    return;
  }
  req.url = `${parsed.path}${url.search}`;
  await handler(contract.namespace, req, res, contract);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} payload
 * @returns {void}
 */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  });
  res.end(body);
}
