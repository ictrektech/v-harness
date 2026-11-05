/**
 * Tenant addressing, now that tenants share the container network.
 *
 * Every tenant used to run in its own network namespace, published by pasta on
 * one host address per uid. That layer needed a matching pasta option, a
 * per-version capability check and a forward for every port a tenant might use,
 * and each of those was a way for an otherwise healthy container to fail
 * closed. The names below are kept so callers do not have to change, but they
 * all resolve to the loopback the gateway and the instances genuinely share:
 * two tenants can listen on the same port only through the per-tenant port
 * allocation, which the gateway already enforces.
 *
 * @module v-harness/gateway/netns
 */

/**
 * The address one tenant's instance is reachable on, as seen by the gateway.
 * @param {number} [_uid] - retained for callers that still pass it.
 * @returns {string}
 */
export function previewIp(_uid) {
  return '127.0.0.1';
}

/**
 * The gateway as an instance dials it (model calls, scheduled follow-ups).
 * Both sides run in the container network, so this is plain loopback.
 */
export const GATEWAY_IP = '127.0.0.1';

/**
 * The name the namespace used to have. Nothing creates it any more; the helper
 * stays only so a leftover import keeps compiling.
 * @param {string} account - tenant account name.
 * @returns {string}
 */
export function netnsName(account) {
  return `vh-${account}`;
}
