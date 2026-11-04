# v-harness 多用户

唯一入口文档。其他文档：[多租户隔离设计](MULTIUSER-ISOLATION.md) · [发布流程](ictrek.app/RELEASE.md) · [VOS 应用说明](ictrek.app/README.md)。

## 一句话

**一个容器，每个用户一个 Linux 账号、一个 dsh 进程、一份 `DSH_HOME`。**

隔离由操作系统负责，dsh 内部不做任何租户判断。

## 用户视角

```
VOS 门户 → 打开 v-harness（无登录页）
         → 新建会话，提需求
         → agent 在自己的 workspace 里干活
         → 用户验收产物
```

没有编辑器，没有用户终端，没有注册流程。

## 架构

```
浏览器（VOS iframe）
   │ ① Fastpath 静默换 access_token
   ▼
v-harness gateway
   │ ② 调 VOS userinfo → sub → namespace
   │ ③ 确保该用户的 dsh 实例在跑
   │ ④ 签发 vh_session，之后所有请求转发
   ▼
dsh 实例 × N　（runuser -u vh-xxxxxxxx）
   DSH_HOME=/data/users/<ns>/.dsh
   端口 3101+，只监听 127.0.0.1
```

转发时网关做两件事：`Host` 改写成 `127.0.0.1:<port>`，`Cookie` 换成该实例自己的 dsh cookie。

## 代码地图

| 路径 | 职责 |
|---|---|
| `gateway/server.mjs` | HTTP/WS 入口、SSO 端点、bootstrap 页、反代 |
| `gateway/vos-auth.mjs` | VOS token 验证、身份映射 |
| `gateway/session.mjs` | `vh_session` HMAC cookie、CSRF |
| `gateway/users.mjs` | `users.json`，uid/端口一次性分配 |
| `gateway/instances.mjs` | 启动 dsh、抓 launch token、换 cookie、注入 bundled skill 目录 |
| `gateway/plugins.mjs` | 把镜像内置插件（浏览器 bundle + agent 侧工具插件）同步进租户 profile |
| `gateway/office.mjs` | 按租户的 V-Office 能力端点（Unix socket），保管 VOS 令牌 |
| `gateway/files.mjs` | 文件抽屉后端（list/read/upload） |
| `skills/voffice/` | V-Office 云端文档 skill（`SKILL.md` + 零依赖 CLI） |
| `bin/vh-userctl` | root：建号、目录权限、把能力 socket 交给属主（幂等） |
| `bin/vh-file` | root：校验参数后 `runuser` 降权 |
| `bin/vh-file-impl.mjs` | 用户身份下实际读写，路径锁死 workspace |
| `bin/entrypoint` | 容器启动：探测沙盒 → 重建账号 → 起网关 |
| `Dockerfile` | 镜像定义（根目录，配 `.dockerignore`） |
| `ictrek.app/` | VOS 应用包：manifest、compose、打包、发版 |
| `build_image.sh` | 构建镜像 → 推 SWR → 写飞书 |

`packages/` 和 `apps/` 是 dsh 源码，**一行未改**。

## 五条关键事实

这些是踩过源码确认的，改动前先看：

1. **dsh 的 `/api` 强制要求它自己签的 cookie**。伪装 `Host: 127.0.0.1` 只能过 DNS-rebinding 栅栏，过不了认证。所以网关必须抓 `dsh web: ...?token=` 换一次 `Set-Cookie`。
2. **cookie 的 authority 绑定 Host**。网关转发时必须固定 `127.0.0.1:<port>`，不能透传浏览器域名。
3. **沙盒只防写不防读**。`workspace-write` 下全盘可读（`--ro-bind / /`），agent 能读自己的 `.credentials.yaml`。
4. **终端默认开启且不受沙盒约束**。`ui-sidebar-terminal` 里的命令用系统用户权限，能读 key、改 profile、装插件。必须关。
5. **目录名必须由 `sub` 派生**，不能用用户名：两个 VOS 账号可能解析成同一个显示名。
6. **dsh 会清洗子进程环境**：名字带 `KEY|PASSWORD|SECRET|TOKEN` 的变量和所有 `DSH_*` 都不会进 bash 工具（`scrubbedParentEnv`）。所以令牌不能靠环境变量下发，见下面 V-Office 一节。

## V-Office 文档能力

skill 需要以用户身份调 v-office，但 agent 又不该拿到 VOS access token（那等于全平台身份）。做法是**能力而非凭证**：

- 登录时网关把 VOS `access_token` / `refresh_token` 收在**内存**里（`/__vh/auth`），不落盘。
- 网关在每个租户的 `$HOME/.dsh/voffice.sock` 上起一个只讲 `/api/v1/*` 的端点，socket 由 `vh-userctl claim` 交给该租户（0600，目录 0700）。**只有这个租户能连**，代理补 `Authorization` 后转发。
- skill 只按 `/api/v1/...` 调用这个 socket，拿不到 token；能做的也只有该用户名下的文档。
- 访问令牌临期时网关直接用 refresh_token 向 VOS 续期（public client，无需 secret，已用 `invalid_grant` 探测确认端点接受 grant）。续期也失败（用户被登出/撤销）才返回 401 + 稳定错误码，skill 直接告诉用户重新登录，不空转重试。
- 浏览器侧的「查看文档」不另做页面：下载到 workspace 后调 `present`，dsh 客户端自带交付卡片和右侧预览（docx/pptx 本地转 PDF、xlsx 表格渲染）。

`VH_OFFICE_BASE` 可覆盖上游地址（默认 `http://10.144.144.232:1182/api/com.ictrek.v-office`）。

## 服务插件（租户自建服务的界面入口）

用户在 jail 里起一个 Web 服务（比如 `127.0.0.1:3004`），浏览器摸不到——它监听在容器 loopback 上，iframe 外的人看不见。服务插件把它变成产品能力：**界面上能看到、点一下就打开、关掉还能找回重启**。

```
用户终端   vh-service run --name 我的应用 --port 3004 -- myapp --port 3004
           （CLI 拉起服务 + 经 $HOME/.dsh/vh-services.sock 持续心跳 + 退出即停跳）
网关       gateway/services.mjs 在该 socket 上起端点，登记 {subject, port, name, cmd, lastSeen}
界面       会话侧栏「服务」：名字 / 端口 / 运行中 · 已停止（心跳停 → 已停止）
打开       点一下 → /__vh/svc/3004/** → 网关校验会话 subject = 属主 → 反代到该租户的 127.<n>.<m>.1:3004（改 Host、支持 WS）
重启       已停止的服务点「重启」→ 网关以该租户身份单独跑一次 vh-jail 执行登记的 cmd
```

关键决定：

- **注册与心跳一体，不扫端口**：`vh-service run` 包裹启动，被包裹的命令就是注册信息和重启命令，进程退出心跳即停——状态不用猜。root 扫端口扫得出监听，扫不出"哪个该展示、叫什么、怎么重启"。
- **鉴权绑定 subject**：A 注册的服务 B 列表里没有，URL 直开也 401（反代先比 subject 再转发，不接受任意端口透传）。
- **重启 = 独立 jail**：网关对该租户再跑一次 `vh-jail`（workspace 同源，`/tmp` 与实例各自私有）；实例停了服务也没了，面板重启先拉实例再拉服务，对用户是一步。
- **端口约定**：服务端口避开实例保留段 `3100-3999`，并落在 pasta 已转发的清单里（`3000-3099`、`5173`、`8000-8099`、`9000-9099`，见「已知取舍」）；清单纯的端口面板里能看到，但浏览器打开会连不上。
- **打开形态**：子路径反代要求应用支持 base path；不支持的应用在注册时声明 `basePath`，确实需要再谈子域。
- **命令留痕边界**：`cmd` 只存网关 state（`$STATE_ROOT`），不进租户 home、不进会话日志；注册/重启动作写实例日志。

代码落点（对齐上面代码地图）：

| 文件 | 职责 |
|---|---|
| `gateway/services.mjs` | 注册表（持久化到 `$STATE_ROOT/services.json`）+ 每租户 `$HOME/.dsh/vh-services.sock` 端点（socket 由 `vh-userctl claim` 交租户，同 office.sock）+ 重启用的独立 jail |
| `bin/vh-service.mjs` | 租户 CLI（零依赖，镜像里装在 `/usr/local/bin/vh-service`，jail 内经 `/usr` 只读绑定直接可用）：run（包裹启动 + 心跳）/ list / stop，无需 root |
| `gateway/server.mjs` | `GET /__vh/services`、`POST /__vh/services/<port>/restart|stop`、`/__vh/svc/<port>/**` 反代（HTTP + WS，先比 subject 再转发） |
| `packages/client/ui-services/` | 右侧栏「服务」标签页：列表轮询、打开（新标签）、重启/停止；carrier 补丁挂载行 `ui-services` |

## 镜像内置插件

镜像在构建时编译两类本仓库新增、未发布到 npm 的插件，租户 profile 从 registry 装不到，由网关补齐：

- **浏览器 bundle**（V-Office 卡片等）：构建产物在 `/opt/v-harness/plugins`。
- **agent 侧工具插件**（`dsh-skill-image-studio` / `dsh-skill-photocraft`）：`scripts/stage-agent-plugins.ts` 按发布流程同款构建（tsdown 出 `lib/index.js` 入口，`tsc -b` 按引用自动构建依赖闭包），payload 在 `/opt/v-harness/agent-plugins`。
- **registry 插件**（`dshmarket` / `ds-bot`）：镜像构建时用 `--legacy-peer-deps` 装进同一 payload（版本由 `DSMARKET_VERSION` / `DS_BOT_VERSION` 固定），依赖一并带上但只在 profile 缺包时复制。两者自带 `dsh.bundle.patch`，所以按 bundle 层挂载，而不是插行。

`gateway/plugins.mjs` 在每次 dsh 启动前同步：浏览器 bundle 覆盖发布版（fork 独有的包缺失即创建）；agent 侧插件包覆盖、依赖包缺了才补（peer 依赖由 dsh 安装解析层供给，不打包），并把 carrier bundle（`gateway/agent-plugins/vh-agent-plugins`，声明挂载行）写进 profile 的 `dsh.profile.bundles`。profile 由网关在 dsh 首次启动前预创建，**新租户第一次登录即有全部工具**；已有租户的 profile 在下次启动时补齐缺失的 bundle 条目。完整开发教程（skill / 工具插件 / 交互卡片怎么做、怎么上线）见 [PLUGINS.md](PLUGINS.md)。

## 数据布局

```
/data/users.json                    用户表：subject / namespace / linuxName / uid / port
/data/users/<namespace>/            0700，属主 vh-xxxxxxxx
  .dsh/                             会话、凭据、profile
    voffice.sock                    V-Office 能力端点（0600，属主本人）
  .agents/                          skills
  workspace/日常/                    默认落点
/data/logs/<namespace>.log          实例日志
```

`namespace = sha256('vos-oidc\0' + sub)` 前 40 位，`linuxName = vh-` + 前 8 位。

## 跑起来

```bash
# 本地构建（不需要飞书）
docker build -t v-harness .

# 跑起来（先不连 VOS，只验证容器本身）
docker run --rm -p 8080:8080 -v /tmp/vh-data:/data v-harness
docker logs <id> | head -40      # 看 sandbox-probe 的 verdict
curl localhost:8080/__vh/health  # {"ok":true}
```

VOS 里部署走 `build_image.sh` + `ictrek.app/scripts/package.sh`，见 [RELEASE.md](ictrek.app/RELEASE.md)。

## 现在的状态

**能跑通的**：本地语法检查、网关空跑（health / session / bootstrap）、文件助手的读写与三类越权拦截、V-Office skill 的 CLI（用 mock 上游验证过 me/list/upload/download/rename/delete 与 401/404/409 文案、20MB 往返字节一致）与能力端点的路由白名单/令牌隔离。

**没验证的**：登录全流程、dsh 实例启动、cookie 交换、反代、沙盒在容器里的可用性。**一次都没在容器里跑过。**

**没做的**：

| 项 | 影响 |
|---|---|
| 默认 profile 模板（关终端） | 用户能开终端绕过沙盒 |
| 文件上传入口 | 后端有，界面没有 |
| 空闲回收 | 实例常驻，内存只涨不降 |
| LLM Key 策略 | 用户没 key 就用不了 |

## 已知取舍

- **key 由每个用户自己填写**，与 dsh 官方一致：写进该用户私有的 `.credentials.yaml`（0600）。不做网关代持/代理——没有平台共享 key，也就不存在"一个用户泄露等于全平台泄露"。
- **agent 能读自己的 key**：沙盒只防写。这是用户在自己的账号里读自己的凭据，影响面仅限本人。
- **单用户能拖垮全容器**：容器内做不到每用户 cgroup，只有容器级限制。
- **已做 mount / pid / ipc namespace 隔离**：`vh-jail` 先进入 mount+pid+ipc namespace，用 tmpfs 遮住 `/data/users` 再只 bind 回自己的 home，然后降权。租户看不到别人的目录或进程，`/dev/shm` 与 System V 共享内存都是各租户私有的。
- **挂载是白名单**：`/etc` 不再整体 bind，只给 loader/TLS/时区/NSS 等必需文件，`passwd`/`group`/`hosts` 按租户现生成；`/dev` 是最小设备节点 + 独立 devpts + 私有 shm；`/proc` 重挂为 `nosuid,nodev,noexec`。降权时清空 bounding/inheritable/ambient cap 并加 `--no-new-privs`。
- **每个租户一个 net namespace**：`vh-jail` 用 `ip netns` 为账号建一个持久命名空间，pasta（passt）以用户态方式给它外网、DNS 和独立 loopback——不需要 bridge、veth 或 iptables 规则。租户的 `127.0.0.1:3000` 与别人的 `127.0.0.1:3000` 是两个世界；命名空间跨实例存活，重启 dsh 不会带走还在跑的服务。代价是每个租户常驻一个 pasta 进程，随命名空间一起活到容器重启。
- **网关如何看见租户**：pasta 把命名空间发布到该租户独有的宿主回环地址 `127.<n>.<m>.1`（`gateway/netns.mjs` 的 `previewIp`），网关经此访问实例端口与 `/__vh/svc/<port>` 反代。pasta 在启动时就把每条转发都绑上，所以转发端口是固定清单：实例端口 + `3000-3099`、`5173`、`8000-8099`、`9000-9099`；清单外的端口浏览器打不开（租户 CLI 面板仍能看到服务，只是"打开"会连不上）。
- **租户如何看见网关**：`--config-net` 把宿主默认路由（`ip route` 的 `default via`）写进命名空间，pasta **默认**就把该网关地址映射到宿主 loopback，模型调用（`VH_SCHEDULER_URL`）走这条路；`--no-map-gw` 才是关掉它的开关，`--map-host-loopback` 不是 pasta 的选项（曾按参考实现误加，导致探针在每个租户上都拒绝启动，已移除）。容器仍需 `CAP_NET_ADMIN`（pasta 建 tap、配地址）与 `/dev/net/tun`（compose `devices`；宿主机没加载 `tun` 模块时容器直接起不来，不会降级）——pasta 以 `--runas 0:0` 运行，`setns` 与 tap 需要这份权限。
- **启动自检**：`bin/entrypoint` 先清掉上次遗留的命名空间与 pasta pidfile，再跑 `bin/network-probe.mjs`——建一个临时命名空间让 pasta 发布，双向各打一个回包（网关→租户 loopback、租户→网关地址）。缺 `/dev/net/tun`、image 里的 pasta 不认识 `--config-net` / `--dns-forward` / `--runas`、或任一方向不通，容器直接退出并打印结构化报告，不会带着"登录超时"上线。
- **有容器运行时，但只有经网关代理的那一种**：租户在 jail 里拿到 `DOCKER_HOST=$HOME/.dsh/docker.sock`，网关（root，持有宿主 `/var/run/docker.sock`）在那个 socket 上发布一个按租户过滤的 Engine API，CLI 照常说话，容器与镜像落在宿主 daemon 上，运维 `docker ps` / `docker images` 看得到。租户自身无 capability，够不着宿主 socket。被拒的：`privileged`、`--cap-add ALL`/`SYS_ADMIN`、host 的 net/pid/ipc/uts/user/cgroup、宿主路径挂载、`0.0.0.0` 发布、`prune`、别人的镜像与容器、未列出的端点。端口强制落在按 uid 派生的段内（默认 20000 起，每租户 100 个），`-p 8080:80` 的请求侧端口以受控标签保留，`/__vh/svc/8080` 与 `/__vh/svc/80` 等价。[实现在此](HANDOFF-docker-capability.md)。被否掉的是**租户内自跑 rootless podman**（要在嵌套命名空间挂 `/proc`，只有提成 `privileged` 才行）：[实测数据与否决理由见此](.agents/notes/rejected/architecture/2026-11-04-tenant-container-runtime.md)。
- **实例端口保留段**：实例端口从 `3101` 起分配，`3100-3999` 因此不接受服务登记——`/__vh/svc/<port>` 在那段里只会打到租户自己的 dsh。清单外的端口同理：不是网关拒绝，而是 pasta 没有转发。
