# Agent Note: Tenant loopback isolation

Status: implemented

English | [中文](2026-11-05-tenant-loopback-isolation.zh.md)

## Problem

Tenants shared the container's network namespace. Instances listened on the container loopback, allocated per tenant, and `/__vh/svc` only proxied registered services — but the loopback itself was one shared table: any tenant process could reach another tenant's instance port and every unregistered listener (a dev server is the tenant's home files, served over HTTP), two tenants picking the same port meant one of them lost, and the private ranges (other tenants' container bridges, the host-facing docker gateway `172.17.0.1`) were wide open. The per-tenant netns + pasta design had been removed as operationally fragile (see the deprecation at the top of [MULTIUSER-ISOLATION-v2.md](../../../MULTIUSER-ISOLATION-v2.md)), so isolation had to come back without a per-tenant namespace.

## Proposal

Give every tenant one private loopback address and gate it with per-uid iptables rules — no namespace, no user-space forwarder:

- The kernel treats all of `127.0.0.0/8` as local, so an address per tenant needs no configuration: `tenantLoopback(uid)` (`gateway/addressing.mjs`) encodes the never-reused uid as `127.<uid/256%256>.<uid%256>.1` (uid 20000 → `127.78.32.1`), and the shell arithmetic in `bin/vh-jail` computes the same value. The uid allocator refuses past 65536, loudly.
- The instance binds `--host <tenant address>`; dsh's cookie authority stays `127.0.0.1:<port>` because the launch passes `--trusted-host` for it, so no forwarding path learns the tenant address.
- `net_isolate()` in `bin/vh-jail` installs a per-uid OUTPUT chain while still root: ACCEPT established, own address, the resolvers from `resolv.conf` (port 53), the gateway port (`VH_GATEWAY_PORT`), and `VH_NET_ALLOW_CIDRS`; DROP the rest of `127/8`, `172.16/12`, `192.168/16`, `10/8`; DROP `::1`.
- `gateway/docker-proxy.mjs` (`syncNetworkIsolation`) inserts an ACCEPT for the tenant's real container subnet ahead of the chain — the tenant keeps direct access to its own containers — and adds INPUT rules that let tenant containers open only the gateway port on this container, so one tenant's container cannot walk into another tenant's `0.0.0.0`-bound services via the joined bridges.
- Consequences that are contracts: tenant services bind `$VH_TENANT_IP` (exported by the jail) or `0.0.0.0` — a listener pinned to `127.0.0.1` is unreachable by the gateway and by the tenant itself, and `vh-service run` refuses the registration; self-testing uses `$VH_TENANT_IP`, not `localhost`. Same port across tenants no longer collides.
- Requires `CAP_NET_ADMIN` (the compose file asks for it again). Every rule failure is a warning: a deployment without the capability runs without this layer rather than refusing to start. `VH_NET_ALLOW_CIDRS` is the escape hatch for a deployment with internal services tenants genuinely need.

## What the measurements say

Measured on the shipped image (`amd_20261105`) in a `--cap-add NET_ADMIN` container, running the extracted `net_isolate()` for two fake tenants (uid 20000 / 20001):

- The chain installs silently, is idempotent across relaunches, and orders correctly (established → own address → resolvers → gateway → drops).
- Own address: instance and `0.0.0.0` services reachable, the real gateway answers (401 unauthenticated — the container booted its own entrypoint), DNS resolves through the allowed resolvers.
- Cross-tenant: the other uid's instance port, its `0.0.0.0` services, and `127.0.0.1` listeners all time out (DROP, not REJECT — a scan cannot distinguish "absent" from "blocked"); `172.17.0.1` times out.
- Without `CAP_NET_ADMIN`, every iptables call fails with permission denied and the jail continues — the silent degradation is why an earlier attempt (P5) "did not test out": the capability had been dropped from the compose file when the pasta design was removed.
- Same port on two tenants' addresses binds simultaneously and each tenant reaches only its own.

## Alternatives considered

**Bring back per-tenant netns + pasta.** Rejected again: the removal commit (`aa7b26b6`) names three fail-closed paths (a pasta option missing from shipped images, a forward range coupled to the gateway port, an unverified in-namespace DNAT), each of which restarted healthy containers. The loopback-address design keeps the isolation and drops the moving parts: no daemon, no forwarder, no probe that can fail the container.

**Per-uid rules on the shared loopback only (revive P5's reserved-range drop).** Rejected: it closes the instance ports but leaves unregistered services visible across tenants and keeps the port-collision problem — both were the actual gaps. Destination-based rules cannot tell whose service owns a shared `127.0.0.1` port.

**Registered-port allow-list on the shared loopback.** Rejected: it would make an agent's own ad-hoc dev server unreachable by the agent until registered, breaking the ordinary test-then-register loop, and needs dynamic rule updates from the registry.

**No isolation, rely on dsh auth.** Rejected: the cookie fence protects the instance, but nothing protects an unregistered listener serving the tenant's home files.

## Revisit condition

If a deployment needs tenants to reach internal services in the private ranges beyond `VH_NET_ALLOW_CIDRS`, extend the allow-list rather than weakening the drops. If the uid space approaches 65536, the allocator fails loudly first — that is the signal to move to real per-tenant namespaces, and the pasta design should be re-evaluated against whatever runtime the image ships then, not restored from history.
