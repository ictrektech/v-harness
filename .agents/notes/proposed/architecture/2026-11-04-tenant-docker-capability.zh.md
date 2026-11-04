# Agent Note: Tenant Docker capability

Status: proposed

[English](2026-11-04-tenant-docker-capability.md) | 中文

## Problem

agent 的本职是写代码、构建镜像、启动容器。在 v-harness 的租户里它做不到：镜像里没有 Docker CLI，jail 里够不着任何 socket，于是它起的容器永远不会出现在运维真正会看的地方——宿主上的 `docker ps` 和 `docker images`。

隔离模型并没有禁止这件事。jail 划的是 agent 能读写的区域，它没有规定 agent 能让平台跑什么。缺的是一块能力，不是一项权限：宿主 daemon 就在那里，持有它的应该是平台，而不是租户。

另有一份被否决的 note 记录了被实测否掉的另一条路：[租户容器运行时](../../rejected/architecture/2026-11-04-tenant-container-runtime.zh.md)。在租户**内部**跑运行时，需要把最外层容器提成 privileged；把 daemon 留在平台层、只过滤调用，则不需要。

## Proposal

网关（root）持有宿主 socket。为每个租户在它自己的 home 下监听一个私有 Unix socket，转发过滤后的 Docker Engine API 子集。jail 导出 `DOCKER_HOST` 指向该 socket，于是 agent 跑的是真的 `docker` CLI，而 daemon、镜像和容器都留在宿主上，运维看得见。

参考实现是 agent-room 的 `docker-proxy` 模块，已经在这台宿主上生产运行。它是参考，不是模板：读它的时候发现了四个必须补上、不能照抄的缺口。

## Work items

**1. 只要 client。** `Dockerfile` 安装 `docker.io`——Debian 里带 CLI 的就是这个包，它同时会带入引擎二进制。这里没有任何东西会启动它们：镜像没有 init，租户也启动不了（jail 把 capability 全清）。网关只跟宿主 daemon 说话，不跟镜像里的引擎说话。

**2. 每租户代理 socket。** 新增 `gateway/docker-proxy.mjs`，监听 `<租户 home>/.dsh/docker.sock`（属主为租户 uid，模式 0600），转发到 `/var/run/docker.sock`。租户创建的对象在内部强制加前缀、对外呈现无前缀，agent 活在自己的命名空间里。代理是唯一通路：jail 永远不挂宿主 socket。

**3. jail 接线。** `bin/vh-jail` 在现有环境变量旁导出 `DOCKER_HOST=unix://$HOME/.dsh/docker.sock`。socket 路径就在租户 home 里，jail 本来就绑了它，不需要新增挂载。

**4. 策略。** 拒绝清单，含参考实现里那四个缺口：

- `HostConfig.Privileged`——拒绝。
- `HostConfig.CapAdd`——含 `SYS_ADMIN` **或 `ALL`** 时拒绝（参考实现只匹配字面 `SYS_ADMIN`，所以 `--cap-add ALL` 能通过并拿到全部 capability）。
- host 命名空间（`NetworkMode: host`、`PidMode`、`IpcMode`、`UTSMode`、`UsernsMode`、`CgroupnsMode`）——拒绝。
- `NetworkMode` 与 `NetworkingConfig.EndpointsConfig`——绝不接入共享的 `bridge`。空值、`default` 与 `bridge` 一律解析到该租户专属的 `vh-<account>-default` 网桥（首次使用时由代理创建）；`container:<id>` 拒绝；具名网络与 endpoint 和其他对象一样加前缀或直接拒绝。没有这一条，两个租户的容器共用同一段二层网络，即便发布端口都在 loopback 上，也能互按地址直连。
- `runc` 以外的 `Runtime`、`Devices`、unconfined 的 `SecurityOpt`、`net.*`/`kernel.*` sysctl——拒绝。
- `Binds` 与 `Mounts`——宿主机侧源路径必须解析后落在该租户 home 内；Docker socket 本身永不可挂载。
- 镜像——参考实现是全局共享一个镜像库。这里：`GET /images/json` 只列自己的前缀镜像加一组只读共享镜像；`DELETE`、`push`、`get`（save）只允许作用于自己的镜像；`POST /build` 的产物打上租户前缀。租户不得读到或删掉别人的镜像。
- `PortBindings`——把 `HostIp` 强制成 `127.0.0.1`，**并且**把 `HostPort` 限进该租户的分配段。参考实现只重写 `HostPort`，于是 agent 能绑 `0.0.0.0` 绕过端口模型。请求的端口只有本来就落在段内且空闲时才保留；其余情况（`80`、`-p 8080` 那种空宿主端口）取第一个空位，于是第二个容器不会再和第一个撞在段首。
- 网络与卷名——`POST /networks/create` 与 `POST /volumes/create` 加前缀；`Binds`/`Mounts` 里没带前缀的具名卷在转发时加前缀，于是 `-v dbdata:/var/lib` 落到 `vh-<account>-dbdata`。已经带着别的租户前缀的名字直接拒绝，而不是接上去。
- 资源——`Memory`、`NanoCpus`、`PidsLimit` 强制成可配置的上限。参考实现一个都不校验，于是一个容器就能把宿主拖垮。
- `prune`、swarm 接口与未知顶层路径——拒绝。

**5. 端口与可达性。** 容器发布的端口在宿主上，不在租户命名空间里，所以现有 `/__vh/svc/<port>` 这条链路本身到不了它。考虑过两种形态，第一种是建议方案。

- *先映射，再反代（建议）。* Docker 代理把容器端口重写到该租户专属的宿主端口（`127.0.0.1:<分配值>`），网关解析 `/__vh/svc/<port>` 时查这张映射。pasta 继续只承载租户进程，容器端口也不必等于对外端口。映射从 daemon 读回，而不是存在租户旁边：宿主端口是创建过滤器定下的，所以 daemon 的记录才是租户改不动的那份。URL 里的端口两侧皆可——agent 自己选的发布端口（`-p 8080:80` 的 8080）或应用实际监听的容器端口。
- *扩 pasta 转发清单。* 把分配的宿主端口加进 pasta 的转发清单。不作为默认方案：那份清单是启动时由 `bin/network-probe.mjs` 校验的固定契约，按租户动态扩宽会把静态不变量变成运行期状态。

**6. 路径翻译。** 租户看到的是 `/home/<account>`，宿主路径是 `$DATA_ROOT/<account>`。bind 与 mount 的校验必须针对翻译后的宿主路径，绝不能针对容器可见路径。`$DATA_ROOT` 本身、`/`、`/var/run/docker.sock` 以及租户 home 之外的任何路径一律拒绝。

## Acceptance criteria

- 宿主 `docker ps` 能列出租户起的容器，`docker images` 能列出它构建的镜像。
- 租户内以下操作全部被拒，并给出可读原因：`--privileged`、`--cap-add ALL`、`-v /:/host`、`-p 0.0.0.0:<port>`、`docker save` 别人的镜像、`docker system prune`。
- 一个租户的容器无法经 Docker 网桥访问另一个租户的容器。
- 单个租户的容器无法吃满宿主的内存、CPU 或 PID。
- 容器里的 HTTP 服务能经浏览器 `/__vh/svc/<port>/` 打开。

## Risks

代理会成为部署里价值最高的攻击面：每一条拒绝规则都要有人维护正确，漏一条就是宿主访问。Docker API 版本演进会引入过滤器不认识的新字段，所以姿态必须是"不认识的字段或不认识的端点一律拒绝"，而不是"列举拒绝的形状"。

`POST /build` 会在宿主 daemon 上跑构建容器；BuildKit 的 entitlement 与构建网络模式需要与运行期容器同等对待，而容器创建阶段的过滤器覆盖不到它们。

`docker exec` 采用的是连接劫持（hijack），普通 HTTP 过滤器转发不了：遇到劫持请求时该端点返回 501，而不是半实现一条交互通道。因此 `docker run -it` 在出现支持劫持的转发器之前同样不可用。

## Alternatives considered

**把 `/var/run/docker.sock` 挂进租户。** 否决：socket 等于换名字的宿主 root——`docker run -v /:/host` 读写整个宿主，`docker exec` 进入别人的容器。

**在租户内部跑容器运行时。** 实测后否决：rootless podman 要在嵌套命名空间里挂 `/proc`，必须把最外层容器提成 privileged，而那会把宿主磁盘、`/dev/mem`、`/proc/kcore` 与内核模块加载能力交给容器内 root（[实测](../../rejected/architecture/2026-11-04-tenant-container-runtime.zh.md)）。

**维持只能以进程方式部署。** 否决：这让产品干不了 agent 存在的意义所在的工作，并且把每一种"镜像形态"的依赖都逼进共享只读层。
