/**
 * Detect capability sockets that stopped answering.
 *
 * The gateway binds one socket per tenant and capability, then keeps the
 * listener in a per-subject cache. Nothing revisits the path afterwards, so a
 * path that disappears underneath that cache — a volume remount, a second
 * writer replacing it, a bind that never landed — leaves the tenant with a CLI
 * that dials a path nobody serves. The failure is silent: the cache still says
 * "published", and only a restart clears it.
 *
 * This module answers one question only: which expected sockets are gone. The
 * caller owns rebinding because it already has the binder and forget tables;
 * keeping that here would make this module the second owner of socket policy.
 * @module v-harness/gateway/capability-reconciler
 */

import { join } from 'node:path';

import { capabilitySocketAnswers } from './capability-ownership.mjs';
import { CAPABILITIES } from './capability-registry.mjs';
import { SOCKET_NAME as DOCKER_SOCKET } from './docker-proxy.mjs';

/**
 * Capability name → socket file name, including the one capability the gateway
 * always owns and therefore keeps out of the delegable registry.
 */
export const CAPABILITY_SOCKET_FILES = Object.freeze({
  ...Object.fromEntries(CAPABILITIES.map((entry) => [entry.name, entry.socket])),
  docker: DOCKER_SOCKET,
});

/** Every socket the gateway expects to be answering per tenant. */
export const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITY_SOCKET_FILES));

/**
 * Sockets missing for one tenant.
 *
 * A socket counts as present only when something the tenant's uid owns accepts
 * a connection: a leftover inode from a killed process fails the dial, and a
 * socket planted by another uid fails the ownership check.
 * @param {{ home: string, uid: number }} tenant tenant home and uid
 * @param {readonly string[]} [names] capability names to probe
 * @returns {Promise<{ name: string, socketPath: string }[]>} missing sockets
 */
export async function missingTenantSockets(tenant, names = CAPABILITY_NAMES) {
  const missing = [];
  for (const name of names) {
    const socketPath = join(tenant.home, '.dsh', CAPABILITY_SOCKET_FILES[name]);
    if (!(await capabilitySocketAnswers(socketPath, tenant.uid))) {
      missing.push({ name, socketPath });
    }
  }
  return missing;
}
