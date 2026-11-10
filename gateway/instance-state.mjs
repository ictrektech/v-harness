/**
 * Persistent instance registry and adoption probes.
 *
 * A dsh process outlives the gateway that launched it: its signing key lives
 * in the tenant's `.credentials.yaml`, its authority is the fixed port, and
 * the jail is the init of its own pid namespace. This module holds the state
 * that lets a fresh gateway adopt that process instead of spawning a new one
 * and reclaiming its port from a healthy listener.
 *
 * @module v-harness/gateway/instance-state
 */

import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { instanceAddress } from './addressing.mjs';

/** dsh signs its browser cookie for 30 days; the key, not the process, expires. */
export const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

/** One loopback round trip; a tenant that does not answer is not adoptable. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * @typedef {object} InstanceState
 * @property {string} [cookie] - dsh `dsh-auth-*` value.
 * @property {number} [cookieExpiresAt]
 * @property {number} [port] - fixed port from `users.json`.
 * @property {number} [uid] - tenant uid, source of its loopback address.
 * @property {number} [bootedAt] - real process start time, stable across gateway boots.
 * @property {number} [pid] - host-side pid of the jail, for stopping an adopted instance.
 * @property {string} [schedulerKey] - capability key baked into that process's env.
 * @property {string} [mcphubKey] - capability key baked into that process's env.
 */

/**
 * @param {string} path
 * @returns {Promise<Record<string, InstanceState>>}
 */
export async function readRegistry(path) {
  let text;
  try {
    // The registry holds every tenant's dsh session cookie and capability
    // keys: credentials at rest, with the same discipline as the VOS token
    // store. A file readable beyond its owner is not trusted.
    if (((await stat(path)).mode & 0o077) !== 0) {
      console.warn(`instance registry ${path} is readable beyond its owner; ignoring it`);
      return {};
    }
    text = await readFile(path, 'utf8');
  } catch (error) {
    // A missing or damaged registry means there is nothing to adopt; launch
    // writes a fresh one. Both cases are recoverable, so neither is fatal.
    void error;
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * @param {string} path
 * @param {Record<string, InstanceState>} registry
 * @returns {Promise<void>}
 */
export async function writeRegistry(path, registry) {
  const temporary = `${path}.tmp-${String(process.pid)}`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the temp file is new; a crashed process may have
  // left one behind with looser permissions, so pin it explicitly.
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/**
 * Whether a registry entry describes an instance worth probing.
 *
 * The port and uid must match the user table: a stale record from an older
 * layout must never adopt a listener belonging to a different tenant.
 * @param {import('./users.mjs').UserRecord} record
 * @param {InstanceState | undefined} entry
 * @param {number} [now]
 * @returns {boolean}
 */
export function adoptable(record, entry, now = Date.now()) {
  if (entry === undefined || typeof entry.cookie !== 'string' || entry.cookie === '') return false;
  if (!(entry.cookieExpiresAt > now)) return false;
  if (entry.port !== record.port || entry.uid !== record.uid) return false;
  if (!(entry.bootedAt > 0) || entry.bootedAt > now) return false;
  return true;
}

/**
 * Ask the tenant's own loopback whether the recorded cookie still opens it.
 *
 * The Host header stays the cookie's authority, exactly as every forwarded
 * request does; only 200 proves both that the process is alive and that its
 * signing key has not been replaced.
 * @param {{
 *   uid: number,
 *   port: number,
 *   cookie: string,
 *   host?: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<boolean>}
 */
export async function probeInstance(options) {
  const { uid, port, cookie, host, timeoutMs = PROBE_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    const upstream = httpRequest({
      host: host ?? instanceAddress(uid),
      port,
      method: 'GET',
      path: '/',
      headers: {
        host: `127.0.0.1:${String(port)}`,
        cookie,
        accept: 'text/html',
        'accept-encoding': 'identity',
      },
    }, (reply) => {
      const status = reply.statusCode ?? 0;
      reply.resume();
      resolve(status === 200);
    });
    upstream.setTimeout(timeoutMs, () => {
      upstream.destroy();
      resolve(false);
    });
    upstream.on('error', () => { resolve(false); });
    upstream.end();
  });
}

/**
 * Give entries written by the cookie-only layout the fields adoption needs.
 *
 * `bootedAt` is derived from the cookie's 30-day lifetime, which is the only
 * timestamp that layout recorded. It is stable across boots, so the injected
 * boot watcher does not reload a tab whose process never changed.
 * @param {Record<string, InstanceState>} registry
 * @param {import('./users.mjs').UserRecord[]} users
 * @returns {boolean} whether anything changed.
 */
export function backfillInstanceState(registry, users) {
  let changed = false;
  for (const record of users) {
    const entry = registry[record.subject];
    if (entry === undefined) continue;
    if (entry.port === undefined) { entry.port = record.port; changed = true; }
    if (entry.uid === undefined) { entry.uid = record.uid; changed = true; }
    if (!(entry.bootedAt > 0)) {
      entry.bootedAt = Math.max(1, (entry.cookieExpiresAt ?? Date.now()) - COOKIE_MAX_AGE_MS);
      changed = true;
    }
  }
  return changed;
}
