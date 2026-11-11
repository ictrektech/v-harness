/**
 * Where the gateway reaches an instance, and where an instance reaches the
 * gateway.
 *
 * Tenants share the container network namespace, but not the loopback: every
 * tenant binds its own address out of the 127/8 range (the kernel treats the
 * whole range as local, no per-tenant namespace or forwarder needed). A
 * per-tenant iptables owner rule lets the tenant uid reach only its own
 * address there, so the loopback stops being a shared table: another tenant's
 * instance, services, and ad-hoc listeners are unreachable, and two tenants
 * can use the same port without colliding.
 *
 * The gateway never speaks dsh's auth protocol itself and the cookie authority
 * stays `127.0.0.1:<port>` — dsh accepts it through `--trusted-host`, so
 * nothing in the forwarding paths has to learn the tenant address.
 *
 * @module v-harness/gateway/addressing
 */

/** uid above this cannot map to 127.x.y.z; the allocator refuses before that. */
const UID_ADDRESS_LIMIT = 65_536;

/**
 * The private loopback address of one tenant.
 *
 * Encoded from the uid, which is allocated once and never reused, so the
 * address is stable for the tenant's life: uid 20000 binds `127.78.32.1`.
 * Mirrors the shell arithmetic in `bin/vh-jail` (`net_isolate`), which keys
 * the iptables rules to the same address — keep the two in sync.
 * @param {number} uid
 * @returns {string}
 */
export function tenantLoopback(uid) {
  const n = Number(uid);
  if (!Number.isInteger(n) || n <= 0 || n >= UID_ADDRESS_LIMIT) {
    throw new Error(`tenant uid ${String(uid)} cannot map to a private loopback address (needs 1-${String(UID_ADDRESS_LIMIT - 1)})`);
  }
  return `127.${String(Math.floor(n / 256) % 256)}.${String(n % 256)}.1`;
}

/**
 * The address one tenant's instance is reachable on, as seen by the gateway.
 * @param {number} uid - tenant uid; selects its private loopback address.
 * @returns {string}
 */
export function instanceAddress(uid) {
  return tenantLoopback(uid);
}

/** The gateway as an instance dials it (model calls, scheduled follow-ups). */
export const GATEWAY_IP = '127.0.0.1';

/**
 * Bit 30 keeps this mark clear of the ones docker puts on bridge traffic.
 *
 * The jail stamps every packet this uid emits with it (nft `meta skuid`, which
 * needs no kernel module) and the gateway's iptables rules match the mark. That
 * indirection exists because `-m owner --uid-owner` needs `xt_owner`, and the
 * deployment kernel does not always ship it: without the stamp the chain built
 * from an owner match could never load, and the tenant boundary silently did
 * nothing.
 */
const TENANT_MARK_BASE = 0x40000000;

/**
 * The packet mark shared by `bin/vh-jail` and the gateway's network rules.
 *
 * Mirrors the shell arithmetic in `bin/vh-jail` (`net_isolate`); a value that
 * disagrees with it turns the tenant boundary into a no-op, so the two are kept
 * in lockstep by a test.
 * @param {number} uid - tenant uid; selects its mark.
 * @returns {string} the mark as `0x`-prefixed hex, the form iptables accepts.
 */
export function tenantPacketMark(uid) {
  const n = Number(uid);
  if (!Number.isInteger(n) || n <= 0 || n >= UID_ADDRESS_LIMIT) {
    throw new Error(`tenant uid ${String(uid)} has no packet mark (needs 1-${String(UID_ADDRESS_LIMIT - 1)})`);
  }
  return `0x${(TENANT_MARK_BASE + n).toString(16)}`;
}
