/**
 * Capability socket ownership at launch: which delegated sockets answer, and
 * what the gateway does when they do not.
 *
 * The contract is written before dsh starts, so it records an intention rather
 * than a listener. Between that write and the plugin's `ctx.effect` there is a
 * window — profile install, bundle loading, a failing `apply` — in which the
 * only thing at the path is a stale inode or nothing at all. Treating the
 * contract as proof leaves the skill with ECONNREFUSED and no way back, so this
 * module probes the socket the tenant owns and takes the capability back when
 * nobody answers:
 *
 * - a missing listener for a running tenant deletes both contract copies (and
 *   with them the key) and lets the gateway bind its own sockets again;
 * - a tenant that is not running is left alone: nothing can dial its sockets
 *   yet, and deleting the contract would only fight the next launch.
 *
 * @module v-harness/gateway/capability-ownership
 */

import { lstat } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { CAPABILITIES, pluginOwnedCapabilities, removeCapabilityContract } from './capability-registry.mjs';

/** Capability name → socket file name in the tenant's `.dsh` directory. */
const SOCKET_FILES = new Map(CAPABILITIES.map((entry) => [entry.name, entry.socket]));

/**
 * Whether something the tenant's uid owns is accepting connections at one
 * capability socket.
 *
 * `access()` proves only that a path exists: a socket left behind by a killed
 * plugin passes it and then refuses every connection. This check stats the path
 * (must be a socket owned by the tenant) and dials it. Dialing proves a
 * listener is attached to the inode; ownership proves it is not a socket some
 * other uid planted. It cannot prove the listener is this plugin, but a tenant
 * can only ever redirect its own capability calls.
 * @param {string} socketPath absolute socket path
 * @param {number} uid uid expected to own the socket (the tenant's)
 * @returns {Promise<boolean>} whether a connection was accepted
 */
export async function capabilitySocketAnswers(socketPath, uid) {
  const info = await lstat(socketPath).catch(() => undefined);
  if (info === undefined || !info.isSocket() || info.uid !== uid) return false;
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath });
    let settled = false;
    const finish = (answered) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(1_000, () => { finish(false); });
    socket.once('connect', () => { finish(true); });
    socket.once('error', () => { finish(false); });
  });
}

/**
 * Delegated sockets nobody answers, after a bounded wait.
 *
 * The wait absorbs the moment between dsh answering HTTP and its plugin effect
 * running; it cannot cover a first profile install, which is why a miss falls
 * back to the gateway instead of waiting longer.
 * @param {string[]} names capability names to probe
 * @param {{ home: string, uid: number, attempts?: number, delayMs?: number }} options
 *   tenant home, expected socket owner, and probe budget
 * @returns {Promise<{ name: string, socketPath: string }[]>} missing sockets,
 *   in the order the names were given
 */
export async function missingCapabilitySockets(names, options) {
  const { home, uid, attempts = 5, delayMs = 200 } = options;
  const missing = [];
  for (const name of names) {
    const socketPath = join(home, '.dsh', SOCKET_FILES.get(name) ?? `${name}.sock`);
    let answered = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      answered = await capabilitySocketAnswers(socketPath, uid);
      if (answered) break;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => { setTimeout(resolve, delayMs); });
      }
    }
    if (!answered) missing.push({ name, socketPath });
  }
  return missing;
}

/**
 * Give one tenant its capability sockets, taking back any delegated socket the
 * plugin does not actually answer.
 *
 * Idempotent by delegation to the binders, which cache one listener per tenant
 * subject. A failed binder is logged rather than fatal so a broken upstream
 * never blocks sign-in.
 * @param {{
 *   stateRoot: string,
 *   shipped: boolean,
 *   options: Record<string, unknown> & { subject: string, namespace: string, home: string, uid: number },
 *   bind: Record<string, (options: never) => Promise<void>>,
 *   bindDocker: (options: never) => Promise<void>,
 *   forget?: Record<string, (subject: string) => Promise<void> | void>,
 *   tenantRunning?: () => Promise<boolean>,
 *   env?: NodeJS.ProcessEnv,
 *   probe?: { attempts?: number, delayMs?: number },
 *   logger?: Pick<Console, 'error'>,
 * }} launch - one launch's inputs: the tenant options every binder shares,
 *   binder tables keyed by capability name, and the liveness answer used only
 *   when a delegated socket does not respond
 * @returns {Promise<{ delegated: Set<string>, missing: string[], takenBack: boolean }>}
 *   the capabilities still left to the plugin, the sockets that did not answer,
 *   and whether the gateway took the whole set back
 */
export async function startOwnedCapabilities(launch) {
  const {
    stateRoot, shipped, options, bind, bindDocker,
    forget = {}, tenantRunning, env = process.env, probe, logger = console,
  } = launch;
  let delegated = await pluginOwnedCapabilities({
    stateRoot,
    subject: options.subject,
    namespace: options.namespace,
    shipped,
    env,
  });
  const missing = delegated.size === 0
    ? []
    : await missingCapabilitySockets([...delegated].sort(), { home: options.home, uid: options.uid, ...probe });
  let takenBack = false;
  if (missing.length > 0) {
    const sockets = missing.map(({ name, socketPath }) => `${name} (${socketPath})`).join(', ');
    const running = tenantRunning === undefined ? true : await tenantRunning();
    if (!running) {
      logger.error(
        `capability ${options.namespace}: delegated socket has no listener (${sockets}) and the tenant is not running; keeping the contract for its next launch`,
      );
    } else {
      logger.error(
        `capability ${options.namespace}: delegated socket has no listener (${sockets}); taking the capability back from the plugin`,
      );
      await removeCapabilityContract({ stateRoot, home: options.home, subject: options.subject });
      for (const forgetOne of Object.values(forget)) await forgetOne(options.subject);
      delegated = new Set();
      takenBack = true;
    }
  }
  const jobs = [];
  for (const [name, ensure] of Object.entries(bind)) {
    if (!delegated.has(name)) jobs.push(ensure(options));
  }
  jobs.push(bindDocker(options));
  const settled = await Promise.allSettled(jobs);
  for (const result of settled) {
    if (result.status === 'rejected') {
      logger.error(`capability for ${options.namespace} failed:`, result.reason);
    }
  }
  return { delegated, missing: missing.map(({ name }) => name), takenBack };
}
