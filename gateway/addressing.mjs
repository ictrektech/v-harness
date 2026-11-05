/**
 * Where the gateway reaches an instance, and where an instance reaches the
 * gateway.
 *
 * Tenants share the container network: an instance listens on the container's
 * loopback and the gateway dials it there. These addresses used to be a
 * per-tenant host address published by pasta, so the call sites still read as
 * "an address the gateway has to translate"; this module is that translation,
 * and today it is the identity function. Keep the indirection: if a deployment
 * ever needs the instance on another address again, one file changes.
 *
 * @module v-harness/gateway/addressing
 */

/**
 * The address one tenant's instance is reachable on, as seen by the gateway.
 * @returns {string}
 */
export function instanceAddress() {
  return '127.0.0.1';
}

/** The gateway as an instance dials it (model calls, scheduled follow-ups). */
export const GATEWAY_IP = '127.0.0.1';
