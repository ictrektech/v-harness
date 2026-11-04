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
 * The gateway as a tenant sees it from inside its namespace.
 *
 * pasta maps this address onto the gateway's loopback, which is how a tenant
 * reaches services the gateway keeps on `127.0.0.1` — the scheduler endpoint
 * behind every model call is the one that matters.
 */
export const GATEWAY_IP = process.env.VH_GATEWAY_IP ?? '10.0.2.2';

/**
 * The namespace `bin/vh-jail` creates for one account.
 * @param {string} account - tenant account name.
 * @returns {string}
 */
export function netnsName(account) {
  return `vh-${account}`;
}
