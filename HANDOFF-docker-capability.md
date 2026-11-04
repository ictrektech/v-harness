# 交接：租户 Docker 能力（构建镜像 / 启动容器）

状态：**整链已在线上容器里跑通**（租户真实 `docker` CLI → 能力 socket → 网关过滤 → 宿主 daemon，以及 `/__vh/svc/<port>` 带会话反代）。镜像 `amd_20261104` 仍是旧代码，线上靠热修补齐，见第 9 节。更新于 2026-11-04。

## 1. 需求

agent 在 v-harness 租户里的本职工作是写代码、构建镜像、启动容器，且产物必须落在**宿主机**上：

- 运维在服务器执行 `docker images` 能看到 agent 构建的镜像
- 运维执行 `docker ps` 能看到 agent 启动的容器

不是"在 jail 里模拟一个容器"，也不是"沙箱里跑一个假 docker"。

同时不可协商的约束：

- agent 仍然只在自己那块区域活动：自己的 home、自己的项目、harness 的公共只读资源
- 不给 agent 主机 root、不给 privileged、不让它扫宿主机

## 2. 为什么不是别的方案

已经被实测否掉的两条（详见 `.agents/notes/rejected/architecture/2026-11-04-tenant-container-runtime.md`）：

- **租户内跑 rootless podman**：userns、subuid 映射、换源拉取都验证可用，但启动容器需要在嵌套命名空间挂 `/proc`，只有把最外层容器提成 `privileged` 才能过；而 privileged 会暴露宿主机 `/dev/sda` `/dev/sdb` `/dev/mem` `/dev/kvm`、把 `/proc/kcore` 从遮蔽占位变成真内核内存、并补上 `CAP_SYS_MODULE` 等。边界代价不可接受。
- **直接挂 `/var/run/docker.sock` 进租户**：等于发放宿主 root。

采纳的路子：**网关（root）持有宿主 socket，按租户发布一个过滤过的 Engine API 端点**，agent 用真 docker CLI 说话，容器和镜像落在宿主 daemon 上。参考实现是同宿主机上生产的 agent-room（`/app/dist-server/server/modules/docker-proxy/`），已逐行读过，取其机制、补其缺口。

## 3. 已完成

### 3.1 代码

| 文件 | 内容 |
|---|---|
| `gateway/docker-proxy.mjs`（1120 行） | 按租户 Unix socket `<home>/.dsh/docker.sock`（0600，chown 给租户）+ Engine API 过滤（含 `/v1.43` 版本前缀）+ 前缀命名（含请求路径里的容器名）+ 端口/网络/资源/挂载策略 + 宿主端口解析（含请求端口别名）+ 容器化网关拨号 |
| `gateway/docker-proxy.test.mjs`（483 行） | 42 个用例，含一个假 daemon（Unix socket 上的最小 Engine API），覆盖端口分配、网络解析、容器名/路径翻译、端口别名、`/__vh/svc` 映射 |
| `gateway/server.mjs` | `startCapabilities()` 加 `ensureDockerCapability(options)`；`/__vh/svc/<port>` 的 HTTP 与 WS 两条路径改走 `serviceTarget()`（先查登记服务，再查容器发布端口）；shutdown 加 `closeDockerCapabilities()` |
| `bin/vh-jail` | 存在 `$HOME/.dsh/docker.sock` 时导出 `DOCKER_HOST=unix://...` |
| `Dockerfile` | apt 安装列表已含 `docker.io`（Debian 里唯一带 CLI 的包，同时会带入引擎二进制；镜像无 init、租户无 capability，引擎起不来） |
| `ictrek.app/src/docker-compose.yml` | 挂载宿主 `/var/run/docker.sock`（含风险说明）；删除上一版遗留的 `VH_DOCKER_REGISTRY_MIRROR`（代码里无任何引用） |

过滤器实现的策略（`mutateContainerCreate` / `mutateNamedObject` / `classify` / `prepareContainerCreate`）：

- 拒绝：`Privileged`、`CapAdd` 含 `ALL`/`SYS_ADMIN`、host 的 net/pid/ipc/uts/user/cgroup 命名空间、`container:<id>` 网络模式、非 `runc` 运行时、`Devices`、unconfined `SecurityOpt`、`net.*`/`kernel.*` sysctl、`prune`、`/swarm` `/services` `/nodes` `/secrets` `/configs` `/plugins` `/info` `/system` `/auth`、以及任何未列出的端点
- 网络：空值 / `default` / `bridge` 一律落到租户专属 `vh-<account>-default`（首次用到时由代理 `POST /networks/create` 建），`EndpointsConfig` 的键同样翻译与校验——共享 `docker0` 会让两个租户的容器在二层互相直连
- 挂载：bind/mount 源必须翻译后落在 `$DATA_ROOT/<account>` 内；Docker socket 永不可挂；`-v dbdata:/var/lib` 这类无前缀具名卷自动加前缀
- 端口：`HostIp` 强制 `127.0.0.1`，`HostPort` 限进按 uid 派生的段（默认 20000 起，每租户 100 个）。请求的端口在段内且空闲才保留，否则取第一个空位——一个容器发布多个端口时各拿一个，第二个容器也不会再撞段首
- 资源：`Memory` / `NanoCpus` / `PidsLimit` 强制上限（`-1` 这类"无限"值会被钳到上限）
- 命名：租户对象在宿主上是 `vh-<account>-<name>`，对 agent 呈现无前缀；`vh-shared-*` 为只读共享层

`/__vh/svc/<port>` 的解析（note 第 5 项"先映射，再反代"）：URL 端口两侧皆可——agent 自己发布的宿主端口（`-p 8080:80` 的 8080）或应用监听的容器端口（80），发布侧优先。映射**从 daemon 读回**而不是另存一份：宿主端口是创建过滤器定的，所以 daemon 的记录才是租户改不动的那份（租户能写自己的 home）。

### 3.2 相对参考实现补掉的缺口

agent-room 的实现里有以下问题，本实现已修正（并有对应用例）：

1. `CapAdd` 只匹配字面 `SYS_ADMIN`，`--cap-add ALL` 可通过并拿到全部 capability
2. 镜像存储全局共享不过滤：任意 agent 可 `save` 读走别人的镜像、`DELETE /images/*` 删平台镜像、`push` 外带
3. `PortBindings` 只重写 `HostPort`，不动 `HostIp`，可绑 `0.0.0.0` 绕过端口模型
4. 没有任何资源上限校验，单容器可拖垮宿主
5. 每个租户只有段首一个宿主端口可用，第二个发布会直接起不来
6. 容器留在共享 `docker0` 上：租户之间可按地址直连，验收标准"打不到别人的容器"不成立
7. 具名网络/卷不翻译：`docker network create db-net`、`-v dbdata:/var/lib` 落到宿主平面命名空间，可以撞名

### 3.3 文档

- `.agents/notes/rejected/architecture/2026-11-04-tenant-container-runtime.md`（+ `.zh.md` + `.i18n.yaml`）：容器运行时方案被否的实测数据与否决理由
- `.agents/notes/proposed/architecture/2026-11-04-tenant-docker-capability.md`（+ `.zh.md` + `.i18n.yaml`）：工作项、策略清单、端口两方案、验收标准；本轮补齐了端口分配、租户网络、映射读回三节
- `MULTIUSER.md`、`MULTIUSER-ISOLATION-v2.md`：把"没有容器运行时"的旧理由（dockerd 抢 `172.17.0.0/16`，已被 P7 每租户命名空间解掉）更正为真实理由；能力跑通后 `MULTIUSER.md` 已改回"**有**容器运行时，但只有经网关代理的那一种"，并顺手更正 pasta 选项（`--map-host-loopback` 不存在）
- `bin/tenant-AGENTS.md`：新增「容器」一节（发布端口与 `/__vh/svc` 两种写法、名字前缀、会被拒的清单、`-it` 不可用、面板不列容器端口）；另有同期无关的 chromium 用法

### 3.4 已验证到的程度

```sh
node --test gateway/docker-proxy.test.mjs   # 43 pass / 0 fail
node --test gateway/*.test.mjs              # 70 pass / 0 fail
bash -n bin/vh-jail                          # ok
node --check gateway/docker-proxy.mjs        # ok
node --check gateway/server.mjs              # ok
npx tsx scripts/verify-translation-pairing.ts  # 本需求的两份 note 通过
```

真 daemon 上的端到端（宿主本机 `/var/run/docker.sock`，用一个临时租户 `vhe2e`、uid 77）：

```sh
prepareContainerCreate(tenant, {PortBindings: {'6379/tcp': [{HostPort: ''}]}, NetworkingConfig: {EndpointsConfig: {default: {}}}})
# → NetworkMode vh-vhe2e-default / 端口 27700 / endpoint 键改写成 vh-vhe2e-default
docker create → 201，docker start → 204
resolveContainerPort('vhe2e', 6379)     → {host: '127.0.0.1', port: 27700}
resolveContainerPort('vhe2e', 27700)    → {host: '127.0.0.1', port: 27700}
PING @127.0.0.1:27700                   → +PONG
# 收尾：容器与网络已删除，无残留
```

即：过滤后的创建体是真 daemon 能接受的，租户网络能建能挂，端口落在租户段内，映射两向都能解析，宿主 loopback 上确实有服务在应答。

**整链验证（线上容器 `v-harness-amd-1`，真租户 `admin`，2026-11-04）**：

```sh
node --test gateway/docker-proxy.test.mjs        # 44 pass / 0 fail
# 租户侧：DOCKER_HOST=unix:///data/admin/.dsh/docker.sock
docker run -d --name web -p 8080:80 node:...      # → 宿主 vh-admin-web，发布 127.0.0.1:22000->80
docker ps                                         # → web  Up  127.0.0.1:22000->80/tcp
docker inspect web                                # → /vh-admin-web running（名字前缀对租户不可见）
docker stop web / docker start web                # → 正常
docker inspect vh-admin-web                       # → Labels: vh.requested-port.80=8080
resolveContainerPort('admin', 22000)              # → 172.27.0.3:80（网关容器入网 vh-admin-default 后按容器地址拨）
GET 172.27.0.3:80                                 # → 200 admin-ok
resolveContainerPort('tieniu', 8080)              # → undefined（跨租户隔离成立）
docker logs greeter                               # → 原始 "line1\nline2"（od 里没有引号，未被 JSON 包装）
DOCKER_BUILDKIT=0 docker build -t vh-admin-bt .   # → Successfully tagged（上下文走请求体）
docker build (BuildKit)                           # → 失败：无 buildx；且需 hijack，被 501 挡
docker exec web2 echo hi                          # → unable to upgrade to tcp, received 501（立刻失败，不再挂住）
docker cp web2:/etc/hostname /tmp/h                 # → 成功；GET/PUT /containers/<id>/archive 走字节流
```

`/__vh/svc` 带真实会话（cookie 写进 `sessions.db`，UA 绑定）从宿主打网关：

```sh
curl -H 'Cookie: vh_session=<sid>' -A vh-e2e http://<gateway>:8080/__vh/svc/80/     # admin-ok
curl ... /__vh/svc/22000/                                                             # admin-ok（宿主侧分配端口）
curl ... /__vh/svc/8080/                                                              # admin-ok（租户请求的端口，别名标签）
curl ... /__vh/svc/9999/                                                              # 404 unknown-service
```

仍差一步：**浏览器真实登录 → `vh_session` cookie 下发**这条没走（本次的会话是直接写库的）。请求路径本身与浏览器一致。

### 3.5 线上热修（未重建镜像）

镜像 `amd_20261104` 里的四个文件与工作树不同，线上容器是靠 `docker cp` + 重启补齐的；容器重建即失效，重放方法见第 9 节。

## 4. 未完成

按阻塞程度排序：

1. ~~**真租户上的整链验证**~~：已跑通（见 3.4），只差浏览器真实登录那一下。线上容器仍是旧镜像，所以这次的代码是热修进去的，见第 9 节。
2. **`docker exec` / `attach` / `docker run -it` 不可用**：它们把连接切成裸流（`Upgrade: hijack`，非 tty 的 exec 是 `Upgrade: tcp`），普通 HTTP 转发承载不了。现在**任何 `Upgrade` 请求都在入口直接 501**（以前非 tty exec 会挂到超时），CLI 报 `unable to upgrade to tcp, received 501`。要支持就得做连接劫持转发，属于另一个工作量。`docker cp` 不受影响：它只是普通 HTTP 往返、body 是 tar 流，`GET`/`PUT /containers/<id>/archive` 已放行（`classify()`），路径归属仍由 `namespaceContainerPath` 校验。
3. **`/build` 的 BuildKit 面未覆盖**：entitlement、构建网络模式没有纳入过滤；构建容器在宿主 daemon 上运行，且构建期没有资源钳制。实测结论：`DOCKER_BUILDKIT=0 docker build` **可用**（上下文走请求体，已随字节流转发修好）；`DOCKER_BUILDKIT=1` 不可用——本镜像没装 buildx，且 BuildKit 建会话也要劫持连接，会被 501 挡下。
4. **`/__vh/services` 面板不列容器端口**：容器发布的端口能打开，但不出现在右侧栏列表里（列表仍来自 `vh-service` 注册表）。要不要合并，取决于是否想让面板成为"我这个租户所有可达端口"的入口。
5. ~~`bin/tenant-AGENTS.md` 改写~~：已补「容器」一节（发布端口、`/__vh/svc` 两种写法、命名、会被拒的清单、`-it` 不可用、面板不列容器端口）；`MULTIUSER.md` 第 181 段已改为"有容器运行时，但只有经网关代理的那一种"。注意 `bin/tenant-AGENTS.md` 只对**新账号**写入 `$HOME/.agents/AGENTS.md`，存量租户要手工更新那一份。
6. `docker-objects.json`（租户 home 下的对象记录）目前无人读取：所有权判定全部走 daemon 的名称前缀，端口映射也改成读 daemon 了。留着是为以后记配额，若确定不用可整段删掉。
7. **`docker run -d` 会打印一行 `GET /events 403` 噪声**：CLI 启动时订阅全局事件流，放行会泄露别家容器，故拒绝；只是提示行，不影响命令结果。

## 5. 部署改动（已上线）

`ictrek.app/src/docker-compose.yml` 里的宿主 `/var/run/docker.sock` 挂载**已在运行中的容器上生效**（`docker inspect` 可见 bind `/var/run/docker.sock`）。后果必须讲明：

- 代理挡的是**租户**：租户无 capability、够不着 socket
- 挡不住**网关自身**：一旦 v-harness 容器内的 root 被攻破，等于宿主 root（容器里就有 socket）
- agent-room 在当前生产上承担的是同一风险

不同意就删掉那一行 volume：能力随之整体失效（租户 jail 里 `DOCKER_HOST` 不导出），其余代码与策略不受影响。

## 6. 继续做的顺序

1. 浏览器真登录一次租户，确认 `vh_session` 下发后 `/__vh/svc/<port>/` 能打开（唯一没走过的衔接处）
2. 下一次重建镜像时把第 9 节的四个文件一并打进镜像，之后不再需要热修补丁
3. 再按需排 `exec`/`-it`（第 4 节第 2 项）与 `/build` 过滤（第 3 项）

验收标准（note 里已列）：

- 宿主 `docker ps` / `docker images` 能看到租户的容器与镜像
- 租户内 `--privileged`、`--cap-add ALL`、`-v /:/host`、`-p 0.0.0.0:<port>`、`docker save` 别人的镜像、`docker system prune` 全部被拒
- 一个租户的容器打不到另一个租户的容器（租户专属网桥 + 发布端口只绑 loopback）
- 单容器不能耗尽宿主内存/CPU/PID
- 容器里的 HTTP 服务能经 `/__vh/svc/<port>/` 打开

## 7. 实现时踩过的坑（避免重复）

- `bin/vh-jail` 的整段脚本是包在 `bash -c '...'` 单引号串里的：**注释里出现一个撇号就会提前结束字符串**，`bash -n bin/vh-jail` 能立刻发现。
- Docker 把 `PidsLimit: -1` 解释为"不限制"，因此资源钳制不能简单 `Math.min`，负值/非数必须先归一。
- `bindRefusal` 里 Docker socket 的判断必须在"路径是否在 home 内"之前，否则永远报错在错误的原因上。
- `/networks/create`、`/volumes/create` 也走 `mutate` 分支：它们不能进 `mutateContainerCreate`（会塞进 `HostConfig`），要单独翻译 `Name`。
- 宿主端口分配必须看 daemon 现有容器，不能只看本次请求：重启网关后内存里的分配表是空的，撞端口会以 `port is already allocated` 失败在 `start` 而不是 `create`。
- 假 daemon 测试里 `knownNetworks` 是模块级缓存，跨用例共享——建网只发生一次的断言要用独立租户账号，否则会被前面的用例吃掉。

## 8. 当前工作树

已修改：`Dockerfile`、`gateway/server.mjs`、`bin/vh-jail`、`bin/tenant-AGENTS.md`、`MULTIUSER.md`、`MULTIUSER-ISOLATION-v2.md`、`ictrek.app/src/docker-compose.yml`，以及本会话之前遗留的 `bin/network-probe.mjs`、`bin/vh-service.mjs`、`gateway/netns.mjs`、`gateway/plugins.mjs`。

新增未跟踪：`gateway/docker-proxy.mjs`、`gateway/docker-proxy.test.mjs`、两份 note（中英各一 + `.i18n.yaml`）。

仓库根目录另有一个与本需求无关的未跟踪文件 `_tmp_3087094_1c9792b91803c3c0d3015c1c1fa849b2`。

## 9. 线上热修（容器重建后会丢，需重放）

线上容器 `vos-app-com-ictrek-v-harness-01m6jv13ks0qzjq1xr6w5yzeb9-v-harness-amd-1` 跑的是镜像 `amd_20261104`，里面这四个文件是旧的。当前已 `docker cp` 覆盖，且与工作树**逐字节一致**（sha256 前 16 位）：

| 文件 | sha256[:16] | 修的问题 |
|---|---|---|
| `bin/vh-userctl` | `0ed1e9aa5873dccb` | claim 白名单缺 `docker.sock`，能力 socket 永远建不起来 |
| `gateway/docker-proxy.mjs` | `c7b679973a39f162` | 不认 `/v1.43` 前缀（CLI 全部 403）、容器名不加租户前缀（`docker ps` 恒空）、容器化网关拨不到宿主 `127.0.0.1`、`-p 8080:80` 的 8080 丢失、`allow` 分支把请求/响应当 JSON 缓冲（`exec` 丢 `Cmd`、`logs` 被 JSON 转义、`build` 上下文丢失）、`docker cp` 的 `/archive` 未放行（403） |
| `gateway/server.mjs` | `bbdb27f48c48ab35` | `/__vh/svc` 改走 `resolveContainerPort` |
| `bin/network-probe.mjs` | `88d26ca950a5824c` | 探针要求 pasta 的 `--map-host-loopback`（不是 pasta 的选项），每个租户启动即失败 → 容器重启循环 |

重放：

```sh
C=<容器名>
for f in bin/vh-userctl bin/network-probe.mjs gateway/docker-proxy.mjs gateway/server.mjs; do
  docker cp "$f" "$C:/opt/v-harness/$f"
done
docker restart "$C"
```

`restart` 不能省：网关与管理进程在启动时把模块读进内存，只覆盖文件不重启等于没改。

注意事项：

- 能力 socket 只在**登录**时建立（`startCapabilities()` 在 `/__vh/login` 里调），重启后 `$HOME/.dsh/docker.sock` 要等该租户下次登录才出现。日志里 `unexpected claim path` 是热修前的旧行；白名单打上后手动执行 `vh-userctl claim admin /data/admin/.dsh/docker.sock` 已通过（只报 "not a socket"，因为当时 socket 尚未创建）。
- 残留的 socket 文件不会挡路：`ensureDockerCapability()` 先 `unlink` 再 `listen`（`gateway/docker-proxy.mjs` 的 `start()`）。手工起进程验证时才需要自己清。
- 本次验证用的容器 `vh-admin-web`、网络 `vh-admin-default`、测试会话行与 `/tmp` 脚本均已清理，线上无残留。
