# Agent Note: Tenant Docker capability

Status: proposed

English | [中文](2026-11-04-tenant-docker-capability.zh.md)

## Problem

The agent's job is to write code, build images and start containers. Inside a v-harness tenant it cannot: the image carries no Docker CLI, no socket is reachable from the jail, and a container started by an agent would therefore never appear where the operator looks for it — `docker ps` and `docker images` on the host.

Nothing about the isolation model forbids this. The jail draws the area an agent may read and write; it says nothing about what the agent may cause the platform to run. The missing piece is a capability, not a permission: the host daemon is right there, and the platform — not the tenant — is the one that should hold it.

A rejected note records the alternative that was measured and refused: [tenant container runtime](../../rejected/architecture/2026-11-04-tenant-container-runtime.md). Running a runtime *inside* the tenant needs the outermost container to be privileged. Holding the daemon at the platform layer and filtering calls does not.

## Proposal

The gateway (root) keeps the host socket. For every tenant it listens on a private Unix socket inside that tenant's own home, and forwards a filtered subset of the Docker Engine API. The jail exports `DOCKER_HOST` pointing at that socket, so the agent runs a real `docker` CLI while the daemon, the images and the containers stay on the host where the operator can see them.

The reference implementation is agent-room's `docker-proxy` module, already in production on this host. It is a reference, not a template: reading it surfaced four holes that must be closed rather than copied.

## Work items

**1. Client only.** `Dockerfile` installs `docker.io` — the only Debian package that carries the CLI. It also drops the engine binaries, and nothing here ever starts them: the image has no init, and a tenant cannot start one because the jail drops every capability. The gateway talks to the host daemon, never to an engine inside this image.

**2. Per-tenant proxy socket.** A new `gateway/docker-proxy.mjs` listens on `<tenant home>/.dsh/docker.sock` (owner: tenant uid, mode 0600) and forwards to `/var/run/docker.sock`. Objects the tenant creates are force-prefixed internally and presented unprefixed, so the agent works in its own namespace. The proxy is the only path: the jail never mounts the host socket.

**3. Jail wiring.** `bin/vh-jail` exports `DOCKER_HOST=unix://$HOME/.dsh/docker.sock` next to the existing environment. The socket path is inside the tenant home, which the jail already binds, so no new mount is needed.

**4. Policy.** The deny list, including the four holes found in the reference:

- `HostConfig.Privileged` — denied.
- `HostConfig.CapAdd` — denied when it contains `SYS_ADMIN` **or `ALL`** (the reference only matches the literal `SYS_ADMIN`, so `--cap-add ALL` passes there and yields every capability).
- Host namespaces (`NetworkMode: host`, `PidMode`, `IpcMode`, `UTSMode`, `UsernsMode`, `CgroupnsMode`) — denied.
- `NetworkMode` and `NetworkingConfig.EndpointsConfig` — the shared `bridge` is never joined. An empty mode, `default` and `bridge` all resolve to a per-tenant bridge (`vh-<account>-default`) that the proxy creates on first use; `container:<id>` is denied, and a named network or endpoint is prefixed or refused exactly like every other object. Without this, containers of two tenants share one Layer-2 segment and reach each other by address even though their published ports are on loopback.
- `Runtime` other than `runc`, `Devices`, unconfined `SecurityOpt`, `net.*`/`kernel.*` sysctls — denied.
- `Binds` and `Mounts` — the host-side source must resolve inside the tenant's own home; the Docker socket itself is never mountable.
- Images — the reference shares one image store platform-wide. Here: `GET /images/json` lists only own-prefixed images plus a read-only shared set; `DELETE`, `push` and `get` (save) are restricted to own images; `POST /build` tags its output with the tenant prefix. A tenant must not be able to read or delete another tenant's image.
- `PortBindings` — `HostIp` is forced to `127.0.0.1` **and** `HostPort` into the tenant's allocated range. The reference rewrites only `HostPort`, which lets an agent bind `0.0.0.0` and bypass the port model. A requested port is kept only when it already lies inside the range and is free; anything else (`80`, an empty host port from `-p 8080`) takes the first free slot, so a second container no longer collides with the first on the range's first port.
- Network and volume names — `POST /networks/create` and `POST /volumes/create` are prefixed, and an unprefixed named volume in `Binds`/`Mounts` is prefixed on the way through, so `-v dbdata:/var/lib` reaches `vh-<account>-dbdata`. A name already carrying another tenant's prefix is refused instead of attached.
- Resources — `Memory`, `NanoCpus` and `PidsLimit` are forced to configured maxima. The reference validates none of them, so one container can starve the host.
- `prune`, swarm endpoints and unknown top-level paths — denied.

**5. Ports and reachability.** A published container port lives on the host, not in the tenant's namespace, so the existing `/__vh/svc/<port>` path does not reach it by itself. Two shapes were considered; the first is proposed.

- *Map, then proxy (proposed).* The Docker proxy rewrites the container port onto a tenant-owned host port (`127.0.0.1:<allocated>`), and the gateway resolves `/__vh/svc/<port>` through that mapping. pasta keeps carrying tenant processes only, and the container port no longer has to equal the public port. The mapping is read back from the daemon, not stored beside the tenant: the host port is what the create filter put there, so the daemon's record is the one a tenant cannot forge by editing a file in its own home. The URL port may name either side — the published host port (`-p 8080:80`, the side the agent chose) or the container port the app listens on.
- *Extend the pasta list.* Add the allocated host ports to pasta's forwarded list. Rejected as the default: that list is a fixed contract checked at startup by `bin/network-probe.mjs`, and widening it per tenant turns a static invariant into runtime state.

**6. Path translation.** The tenant sees `/home/<account>`; the host path is `$DATA_ROOT/<account>`. Bind and mount validation must run against the host path, translated, never against the container-visible one. `$DATA_ROOT` itself, `/`, `/var/run/docker.sock` and any path outside the tenant home are refused.

## Acceptance criteria

- `docker ps` on the host lists a container the tenant started, and `docker images` lists an image it built.
- From inside the tenant, each of these is refused with a readable error: `--privileged`, `--cap-add ALL`, `-v /:/host`, `-p 0.0.0.0:<port>`, `docker save` of another tenant's image, `docker system prune`.
- A container started by one tenant cannot reach another tenant's containers over the Docker bridge.
- One tenant's container cannot exhaust host memory, CPU or PIDs.
- A container's HTTP service opens through `/__vh/svc/<port>/` in the browser.

## Risks

The proxy becomes the highest-value attack surface in the deployment: every denied shape is a rule someone must keep correct, and one miss is host access. Docker API version drift can add new fields the filter does not know about, so the posture must be "unknown field or unknown endpoint is denied", not "denied shape list".

`POST /build` runs build containers on the host daemon; BuildKit entitlements and build network mode need the same treatment as runtime containers, and are not covered by the container-create filter.

`docker exec` hijacks its connection, and a plain HTTP filter cannot forward that: the endpoint answers 501 for hijacked requests instead of half-implementing an interactive path. `docker run -it` is therefore also unavailable until a hijack-aware forwarder exists.

## Alternatives considered

**Mount `/var/run/docker.sock` into the tenant.** Rejected: the socket is host root by another name — `docker run -v /:/host` reads and writes the whole host, `docker exec` enters other tenants' containers.

**Run a container runtime inside the tenant.** Rejected after measurement: rootless podman needs the outermost container to be privileged to mount `/proc` inside a nested namespace, and privileged exposes the host's disks, `/dev/mem`, `/proc/kcore` and kernel-module loading to container root ([measurements](../../rejected/architecture/2026-11-04-tenant-container-runtime.md)).

**Keep process-only deployment.** Rejected: it leaves the product unable to do the work an agent exists to do, and forces every image-shaped dependency into the shared read-only layer instead.
