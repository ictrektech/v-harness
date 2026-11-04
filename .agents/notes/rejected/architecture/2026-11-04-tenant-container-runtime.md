# Agent Note: Tenant container runtime

Status: rejected — running containers needs the host container to be privileged

English | [中文](2026-11-04-tenant-container-runtime.zh.md)

## Problem

A tenant agent answers that this machine has no container runtime, and `bin/tenant-AGENTS.md` says the same. Users then ask whether the agent can build an image and start a container by itself.

The recorded reason no longer holds. `MULTIUSER.md` explains the absence with `dockerd` sharing the gateway's network namespace: `docker network create` would take `172.17.0.0/16` from the default pool, which is the address the gateway uses to reach the platform, and login would fail. Since P7 gave every tenant its own network namespace, that range is no longer shared. The question has to be re-answered instead of re-quoting the old conclusion.

## Proposal

Ship rootless podman per tenant — no daemon, storage under the tenant's own home — so the agent can `podman build` and `podman run --network=host`, with ports still published through the existing `/__vh/svc/<port>/` proxy.

## What the measurements say

Measured in a throwaway container built from the shipped image with the deployed privilege set (`SYS_ADMIN`+`NET_ADMIN`+`SYS_PTRACE`, seccomp and apparmor unconfined):

- `podman 4.3.1` installs cleanly with `crun`, `conmon` and `uidmap`.
- Rootless user namespaces work: `podman unshare` succeeds, and it still succeeds under `setpriv --no-new-privs`, which is what the jail's bwrap sets. The resulting `uid_map` is `0 1500 1` plus `1 165536 65536` — the full subuid range, not a degraded single mapping.
- Pulling works only through a mirror: `registry-1.docker.io` resolves to poisoned addresses and times out on 443, while `docker.m.daocloud.io` pulls an image successfully. `swr`, `aliyun`, `ghcr` and `quay` answer 401 on `/v2/`, so they are reachable and need credentials.
- Starting the container fails with `crun: mount proc to proc: Operation not permitted`. The minimal reproduction is `unshare -Urpm --mount-proc true` failing while `unshare -Ur true` succeeds, so the gap is the permission a nested namespace needs to mount `/proc` — not podman.
- The same image run with a `--privileged` outer container starts the container on the first try.

Whether the feature can exist therefore depends only on whether the outermost container becomes privileged, not on packaging or configuration.

## Alternatives considered

**Make the outermost container `privileged`.** Rejected: measured, privileged exposes the host's `/dev/sda`, `/dev/sda1`, `/dev/sda2`, `/dev/sdb`, `/dev/sg0-2`, `/dev/nvme*`, `/dev/mem`, `/dev/kvm`, `/dev/vfio` and `/dev/nvidia*`; turns `/proc/kcore` from a masked `/dev/null` placeholder (size 0) into a real kernel-memory view (140737471590400 bytes); and adds `CAP_SYS_MODULE`, `CAP_SYS_RAWIO`, `CAP_SYS_TIME` and `CAP_BPF`, which the current set lacks. Container root would then read and write host disks and memory directly, while the host also runs other applications — and the jail's promise that a tenant cannot leave its own world stops being true. That price is out of proportion to the feature.

**Keep P6's private `dockerd`.** Rejected: it runs as jail-root, needs a cgroup2 side mount and a supervised daemon per tenant, so it demands at least the same capability and does not clear the same permission gate; it also adds a resident attack surface.

**Allow only pre-pulled images.** Neither adopted nor verified: the container still has to mount `/proc` inside a nested namespace, so it is expected to fail the same way without privileged. It cannot be promised as a path before that is measured.

**Keep the current state: tenants deploy processes only.** Adopted. Image building stays on the platform side in `build_image.sh`; tenants never reach a container runtime, and `bin/tenant-AGENTS.md` keeps telling the agent to host services as processes through `vh-service`.

This follows the existing boundary rather than working around it: the tenant lives in a drawn area — its own home, its own network namespace, its own `/dev` and process view — plus the harness's shared read-only layer (`/usr`, `/opt/v-harness/skills`). What a container image would supply is a *content* question, and content reaches that area the same way chromium did: the platform puts it in the shared read-only layer at build time. What a container runtime would supply is authority over kernel namespaces, which the area withholds on purpose.

## Revisit condition

If a path appears that mounts `/proc` inside a nested namespace without privileged (a kernel or runtime relaxation), this conclusion has to be re-evaluated. Re-run the minimal reproduction above before deciding, rather than assuming the gate moved.
