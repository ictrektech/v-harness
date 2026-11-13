---
description: "Tenant capability transport: serves v-harness capability sockets inside the tenant's own dsh and forwards every request back through the gateway's capability egress."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-vh-capabilities

English | [中文](README.zh.md)

## Summary

In v-harness each dsh runs as its own Linux account, and the gateway owns the capability sockets the office, album, photocraft, image-studio and weknora skills call. This package moves those sockets into the tenant's process without changing a path or wire format: the gateway keeps the authoritative contract in root-only state, writes a delivery copy to `DSH_HOME/capabilities.json`, and this plugin listens only for the names that copy lists. Every request returns through `/__vh/egress/*`, where the gateway applies its route table and injects the tenant's VOS token. Without a contract the plugin binds nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row in the v-harness carrier bundle; nothing else is required. The gateway is the only writer of the contract. It writes one only when staging this plugin into a tenant profile succeeded, and always before dsh starts; a failed stage keeps the gateway's own sockets instead of delegating to a listener that may not exist, and a launch that never produced a tenant process removes the contract again. A profile that mounts the row without a contract is valid and inert — that is the state of every tenant the gateway has not migrated yet, and of a deployment that deliberately keeps the capability sockets on the gateway. When a delegated socket stops answering while its tenant is running, the gateway takes that capability back and serves it itself.

The plugin reads three settings. `dshHome` picks the directory that holds the contract and the sockets; it overrides `DSH_HOME` and falls back to `$HOME/.dsh`, because `skills/*/scripts` dial `$HOME/.dsh/<name>.sock` and that path must not change. `gatewayUrl` overrides the loopback gateway origin, which otherwise comes from `VH_GATEWAY_PORT` and defaults to `http://127.0.0.1:8080`, the one port a confined tenant may reach. `timeoutMs` bounds the idle time of one forwarded request (ten minutes by default); it is a stall detector, not a total duration, because skill upstreams stream.

### What the contract contains

The file this process reads is JSON with a `version`, a per-tenant `key`, and the `capabilities` this process must listen for. It is `0600`, owned by the tenant, and written atomically; the key is preserved across launches so restarting a gateway does not invalidate a plugin that survived in an adopted dsh.

This is the **delivery copy**. The gateway keeps the authoritative copy under its own state directory (`0700 root`, file `0600`) and rebuilds its key index and socket ownership only from that copy. Rewriting `DSH_HOME/capabilities.json` can therefore make this tenant's own listeners wrong, but cannot mint a key the gateway accepts or widen what the key may reach.

Reading refuses anything it cannot vouch for: the file is opened with `O_NOFOLLOW` and `O_NONBLOCK` and must be a regular `0600` file owned by this process, at most 64 KiB. A symlink, FIFO, device, group- or world-readable file, foreign owner, malformed key, or empty capability list is treated as no contract. Rotating the key means deleting both copies and restarting the tenant.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Ownership of a capability socket is decided from disk, never from memory, because a gateway restart must be able to pick up a dsh and its plugin that both started before it. The contract is the single source: the gateway skips binding the capability names it lists that the rollout still allows, the plugin binds exactly the listed names, and both re-derive the same answer after a restart. Ownership therefore changes only across a tenant restart, a rollout change, or a failed liveness probe, and each of those also replaces or retires the plugin, so two processes never intentionally hold one path.

A contract records what should be owned, not that the plugin is listening. Before the gateway skips a socket it checks the path: the file must be a socket owned by the tenant, and a connection must be accepted, retried for about a second to absorb dsh start-up. A stale inode left by a killed process, a foreign owner, and a socket nobody accepts all fail. When the check fails and the tenant is running, the gateway removes both copies, clears the key, drops its cached listeners for that subject, and binds the capability itself, so a skill never dials a socket with no reader. A tenant that is not running keeps its contract, because a stopped dsh cannot answer and will read the same contract at its next launch. The rollout is read once per gateway process, so a rollback changes ownership at the next gateway restart rather than per request.

A restart can still race: both sides can try to bind during the same window. The gateway always wins it. It removes a stale path and retries a lost bind a bounded number of times; this plugin only replaces a socket its own uid left behind, and leaves a socket owned by another uid alone. Anything else at the path — a directory, a regular file, a symlink, a FIFO — is not removed, so a tenant cannot plant a path that this process would then unlink. On close the path is moved aside before `server.close` (which would otherwise unlink whatever is there), deleted only when it is still this plugin's stale socket, and hard-linked back when the gateway rebound it in the meantime; connections are torn down first and the wait is capped, because an SSE stream or an upload must not hang plugin unload.

The plugin is a transport, not a service. It adds no routing, no upstream knowledge and no credentials: `forwardCapability` replays the method, path, query and body, presents the tenant key in `x-vh-capability-key`, and replays only response headers a skill consumes. It also refuses what no capability call uses: methods outside `GET`/`HEAD`/`POST`/`PUT`/`PATCH`/`DELETE`, and targets that resolve a dot segment, a backslash, or a NUL — raw or percent-encoded — out of the capability prefix. A forwarded request has an idle timeout, and losing the gateway tears the upstream down. The gateway's egress route then rejects browser-shaped requests and non-loopback sources before it looks at the key, so the publicly reachable `/__vh` prefix never becomes a session-free proxy.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis row: reads the contract, owns the listeners as an effect |
| [`src/contract.ts`](src/contract.ts) | Contract validation and the capability-to-socket table |
| [`src/servers.ts`](src/servers.ts) | One unix listener per delegated capability, owned gateway-first and released without deleting another process's socket |
| [`src/forward.ts`](src/forward.ts) | Request and response replay to `/__vh/egress/*` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Gateway capability egress](../../../gateway/egress.mjs) — the other half of the transport and the authorization rules it enforces.
- [Tenant capability registry](../../../gateway/capability-registry.mjs) — contract format, rollout, and the key index.
- [Gateway migration plan](../../../GATEWAY-PLAN.md) — why the sockets move and where this package sits in the rollout.

-----

<a id="model-experience"></a>
## Model Experience

None, as the transport registers no prompt, tool, or session event.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **`vh-services` stays on the gateway** — the capability is not delegable: the rollout drops it even when listed, the plugin never binds it, and its egress route answers 403. The registry, docker proxy and `/__vh/svc` forwarding remain in the gateway because no test yet proves one tenant cannot reach another tenant's containers.
- **Restart to rotate** — the key is read once at boot, so a rotated file takes effect when the tenant restarts, not while it runs.
- **One writer** — only the v-harness gateway writes the contract; mounting the row in another deployment is inert rather than configurable.
- **Same-uid reader** — the delivery copy is `0600` for the tenant, so any other process running as that uid can read the key and impersonate the plugin. The key still only reaches the tenant's own delegated capabilities, and it is revoked on sign-out, account switch, and rollback.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run `npx vitest run packages/host/vh-capabilities` for this package. The gateway-side contract and dual-track cases live in `gateway/capability-contract.test.mjs` and run with `node --test gateway/*.test.mjs`.

</details>

VOS administrators can confirm a stop of an eligible old container by its full ID from a Full access (VOS operations) conversation. Refresh inventory to check the result before restarting the current app.

For VOS operations, use the application ID from inventory for status or restart. A repair proposal awaits confirmation and reports `executed: false`. If a proposal already exists, HTTP 409 `confirmation-pending` includes its `action`, `id` and remaining `expiresIn` in seconds. Confirm or cancel in the conversation. An expired or consumed confirmation returns 409 `confirmation-unavailable`. A Docker ID sent to application status returns 400 `app-id-required`; use inventory for container state or logs for its output.

### Host management

A VOS system administrator opens a conversation, selects **Host management**, and confirms **Enable host management**. The Agent can then list host Docker containers, read their recent logs and propose starting, stopping, restarting or removing a container by full ID. Review each proposed target in the conversation before confirming. Removal requires a stopped container and preserves volumes. Select **Turn off host management** to end access early. The grant expires after 30 minutes and is checked against the administrator role and the VOS browser session on each call. See Settings → API documentation.

### Batch cleanup

Ask the Agent to collect all cleanup targets in one proposal. The confirmation window follows the VOS interface language and lists every target. Select **Confirm this operation** or **Skip** once for the batch. The result shows which objects were removed. VOS operations accepts recognized retired containers in `created` or `exited` state. The API reference describes batch limits and errors.
