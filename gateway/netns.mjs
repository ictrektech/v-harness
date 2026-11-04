/**
 * The two addresses that join a tenant's network namespace to the gateway.
 *
 * Every tenant runs in its own namespace, so its `127.0.0.1` belongs to that
 * tenant alone and the gateway has no route to it. `bin/vh-jail` asks pasta to
 * publish the namespace on one host address per tenant (gateway → tenant), and
 * to map one fixed address onto the gateway's loopback (tenant → gateway).
 * Both ends must agree on these values, so they live here and nowhere else.
 *
 * @module v-harness/gateway/netns
 */

import { spawnSync } from 'node:child_process';

/**
 * The host address one tenant's namespace is published on.
 *
 * The whole of `127/8` is loopback, so an address here is local without being
 * the gateway's own `127.0.0.1`, and two tenants may listen on the same port.
 * The second octet skips `0`, which keeps every address out of the range an
 * application is most likely to hardcode (`127.0.0.x`).
 * @param {number} uid - tenant uid; allocated once, so the address is stable.
 * @returns {string}
 */
export function previewIp(uid) {
  const second = (Math.floor(uid / 256) % 254) + 1;
  return `127.${String(second)}.${String(uid % 256)}.1`;
}

/**
 * The address pasta configures as a namespace's gateway.
 *
 * `--config-net` copies the host's interface, so the only address a tenant can
 * dial and have pasta map onto the gateway's loopback is the host's own default
 * route gateway. `10.0.2.2` is passt's built-in default, not pasta's, and a
 * namespace that dials it gets `ENETUNREACH` instead of the gateway.
 * @returns {string}
 */
function hostDefaultGateway() {
  const route = spawnSync('ip', ['-4', 'route', 'show', 'default'], { encoding: 'utf8' });
  return /^default via (\S+)/m.exec(route.stdout ?? '')?.[1] ?? '10.0.2.2';
}

/**
 * The gateway as a tenant sees it from inside its namespace.
 *
 * pasta maps this address onto the gateway's loopback, which is how a tenant
 * reaches services the gateway keeps on `127.0.0.1` — the scheduler endpoint
 * behind every model call is the one that matters.
 */
export const GATEWAY_IP = process.env.VH_GATEWAY_IP ?? hostDefaultGateway();

/**
 * The namespace `bin/vh-jail` creates for one account.
 * @param {string} account - tenant account name.
 * @returns {string}
 */
export function netnsName(account) {
  return `vh-${account}`;
}
