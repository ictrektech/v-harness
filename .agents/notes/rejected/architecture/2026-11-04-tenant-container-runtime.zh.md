# Agent Note: Tenant container runtime

Status: rejected — running containers needs the host container to be privileged

[English](2026-11-04-tenant-container-runtime.md) | 中文

## Problem

租户里的 agent 会回答"这台机器没有容器运行时"，`bin/tenant-AGENTS.md` 也这么写。用户随即问：能不能让它自己构建镜像、自己起容器。

当初记录的理由已经不成立。`MULTIUSER.md` 把"没有容器运行时"解释为 `dockerd` 与网关共享网络命名空间：`docker network create` 会从默认池拿走 `172.17.0.0/16`，而那正是网关访问平台用的地址，登录会失败。P7 给每个租户独立网络命名空间之后，这个网段不再共享。所以这件事需要重新回答，而不是继续引用旧结论。

## Proposal

给每个租户一套 rootless podman——没有 daemon，存储在租户自己的 home 下——agent 就能 `podman build`、`podman run --network=host`，端口仍由现有 `/__vh/svc/<port>/` 反代暴露。

## 实测结果

在线上镜像、线上权能（`SYS_ADMIN`+`NET_ADMIN`+`SYS_PTRACE`，seccomp 与 apparmor 关闭）的一次性容器里测得：

- `podman 4.3.1` 与 `crun`、`conmon`、`uidmap` 安装正常。
- rootless 用户命名空间可用：`podman unshare` 通过，在 `setpriv --no-new-privs`（即 jail 的 bwrap 所设）下同样通过。得到的 `uid_map` 是 `0 1500 1` 加 `1 165536 65536`——完整 subuid 段，没有退化成单 uid 映射。
- 拉取只能走镜像加速：`registry-1.docker.io` 解析到被污染的地址、443 超时，而 `docker.m.daocloud.io` 实际拉取成功。`swr`、`aliyun`、`ghcr`、`quay` 的 `/v2/` 返回 401，说明可达但需要认证。
- 启动容器失败：`crun: mount proc to proc: Operation not permitted`。最小复现是 `unshare -Urpm --mount-proc true` 失败、而 `unshare -Ur true` 成功，所以缺口是嵌套命名空间挂载 `/proc` 所需的权限，与 podman 无关。
- 同一镜像换成 `--privileged` 外层容器后，容器一次就起来了。

也就是说：这个功能能不能存在，只取决于最外层容器是否提成 privileged，与打包或配置无关。

## Alternatives considered

**把最外层容器提成 `privileged`。** 否决：实测 privileged 会让容器看见宿主机的 `/dev/sda`、`/dev/sda1`、`/dev/sda2`、`/dev/sdb`、`/dev/sg0-2`、`/dev/nvme*`、`/dev/mem`、`/dev/kvm`、`/dev/vfio`、`/dev/nvidia*`；把 `/proc/kcore` 从被遮蔽的 `/dev/null` 占位（size 0）变成真实内核内存视图（140737471590400 字节）；并补上当前没有的 `CAP_SYS_MODULE`、`CAP_SYS_RAWIO`、`CAP_SYS_TIME`、`CAP_BPF`。一旦容器内 root 被拿到，就能直接读写宿主机磁盘与内存，而宿主机上还跑着别的应用——jail"租户走不出自己那一界"的承诺随之作废。这个代价与功能收益不成比例。

**沿用 P6 的私有 `dockerd`。** 否决：它以 jail-root 运行，需要 cgroup2 旁路挂载和每租户 daemon 保活，要求的能力不低于 privileged，同样过不了这道权限门槛，还多一个常驻攻击面。

**只允许预拉好的镜像。** 既未采纳也未验证：容器仍然要在嵌套命名空间里挂 `/proc`，非 privileged 下预期以同样方式失败。在实测通过之前不能把它当作方案承诺。

**维持现状：租户只以进程方式部署。** 采纳。镜像构建留在平台侧 `build_image.sh`；租户接触不到容器运行时，`bin/tenant-AGENTS.md` 继续要求 agent 用 `vh-service` 以进程方式托管服务。

这是沿用既有边界，而不是绕过它：租户活在一块划好的区域里——自己的 home、自己的网络命名空间、自己的 `/dev` 与进程视图——外加 harness 的共享只读层（`/usr`、`/opt/v-harness/skills`）。镜像要提供的是**内容**，而内容进入这块区域的方式跟 chromium 一样：平台在构建期放进共享只读层。容器运行时提供的是对内核命名空间的支配权，那正是这块区域有意不给的东西。

## Revisit condition

如果将来出现"无需 privileged 就能在嵌套命名空间挂载 `/proc`"的路径（内核或运行时层面放开），本结论必须重估。重估时先跑上面那个最小复现，而不是假设门槛已经移动。
