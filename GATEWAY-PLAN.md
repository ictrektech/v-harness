# 网关改造：四步

**第一步（进程归属）**：租户 dsh 进程不再由网关持有，交给容器内独立的管理进程；网关只负责找到它、转发。
几乎总是值的：1 天，纯收益，不涉及安全取舍。今天重启 3 次掉 3 次线，这一条直接消掉。

**第二步（功能搬家）**：把网关进程里的业务代理（office / 相册 / 图生图 / weknora / 文件 / 服务面板 / MCP 入口）做成 dsh 插件，跑在租户自己的进程里。
看用户规模：几十个用户天天用时，一次“整站进不去”的损失远超 3 天工时；几个人内部试用可以先不做。

**第三步（凭据）**：VOS token 继续锁在网关里，还是放进租户自己的目录（`0600`）。
纯取舍，不产生收益，只决定第二步能走多远。

**第四步（删代码）**：搬完后删掉网关里的空壳，然后验收——停掉网关再启动，正在使用的人应该照常在线。
是第二步的收尾，不单独算收益。

---

## 边界（这些不动）

- **skills 不动。** 搬家只改“代码住在哪个进程”，对外接口一律保持：socket 路径、方法名、返回结构不变，现有 skill 零改动。
- **MCP 协议不动。** 给 agent 增加工具走 MCPHub（往它里面注册服务），不改网关、不改 skills。搬家清单里的“MCP 入口代理”只是网关里那段转发代码，与协议无关。
- **租户隔离不动。** 一租户一账号一进程的边界保持原样。

## 安全

现状边界（已验证）：

- 租户进程以独立 uid 运行；出站被 iptables 限制，只能到自己的回环地址、DNS、网关 `127.0.0.1:8080`；`172.16/12`、`192.168/16`、`10/8` 与共享回环一律 DROP
- VOS token 只存在于网关内存与其 root-only 状态文件 `$STATE_ROOT/vos-tokens.json`（目录 `0700 root`、文件 `0600`，P2 起）；从不进入租户 home、浏览器响应或 dsh 环境
- 一租户一进程、一账号、一目录，权限 `0600`

**at-rest 凭据清单**（都在 `$STATE_ROOT`，目录 `0700 root`；四份都是凭据级文件，review 时按同一套纪律检查）：

| 文件 | 内容 | 权限纪律 |
|---|---|---|
| `vos-tokens.json` | 每租户 VOS `access_token` / `refresh_token`（全平台身份） | `0600`；tmp + rename 原子写；恢复时校验权限、丢弃过期条目 |
| `state-instances.json` | 每租户 dsh 会话 cookie、`schedulerKey` / `mcphubKey`、port/uid/boot/pid | `0600`；tmp + rename，已存在的临时文件补 chmod；读取前校验权限（与 token store 对齐） |
| `capabilities/<sha256(subject)>.json` | 每租户能力键（只授权 `/__vh/egress/*` 代签转发，不是 VOS 凭据） | `0600`；tmp + rename；`O_NOFOLLOW` + `fstat` 读取，拒绝软链/FIFO/宽权限/伪键；logout、切换、回滚即删 |
| `sessions.db`（含 `-wal` / `-shm`） | session id、subject、UA hash | `0600`；`openSessionStore` 显式 chmod 主库及 WAL 附属文件 |

租户 home 的 `.dsh/capabilities.json` 是投递副本，**不在清单内**：它归租户所有，网关从不据此授权或决定 socket 归属；即使被改写或泄漏，也只能影响该租户自己的插件，不会产生新的上游调用能力。

目录 `0700` 挡住租户，但文件本身也必须 `0600` —— 否则一次误 `chmod` 就把全部会话 id、dsh cookie 与 VOS token 暴露给容器内其它主体。`gateway.pid` 等非凭据状态文件同样 `0600`；`entrypoint` 启动时清理被中断写入留下的 0 字节 `*.tmp` 残留，避免累积。

四步对安全的影响：

| 步骤 | 影响 |
|---|---|
| 一（进程归属） | 中性。进程仍以租户 uid 运行。新的监管进程以 root 跑，**它不得监听任何网络端口** |
| 二（功能搬家） | 取决于第三步 |
| 三（凭据） | 核心取舍：token 交给租户进程 = agent 能以该用户身份调用平台 API（用户本人能做的它都能做）；守住 = 相关功能继续留在网关。**已按「守住」实施（P2）**：token 落网关 root-only 状态文件，能力请求仍由网关代签，因此 P5 不必因凭据把 office 系留下 |
| 四（删代码） | 正收益：删掉的代码不再有攻击面 |

已知缺口与处置（P6 已逐条给出结论，不再有悬置项）：

| # | 缺口 | 当前状态 | P6 处置 |
|---|---|---|---|
| 1 | 带会话的浏览器转发前不校验 `Origin` / `Sec-Fetch-Site`（`/__vh/egress/*` 已一律拒绝浏览器形态） | 部分缓解：若干状态变更路由已有 `sec-fetch-site: cross-site` 拒绝与 CSRF 双提交；通用转发 fallthrough 仍依赖 `SameSite` 与 cookie 分区 | **书面接受**：全局 Origin 白名单会打断平台同源反代与嵌入页面；状态变更已有 CSRF 双提交，egress 独立拒绝浏览器形态。灰度窗口内复核，不阻塞 P6 |
| 2 | 入口全放行：未认领根路径都进容器 | `ea48ecd7` 已从 Traefik 移除 root catch-all，平台层不再把未认领根路径交给本容器；容器内 fallthrough 仍把带会话的未认领路径反代到租户实例 | **书面接受**：这是工作区应用的正常反代语义（会话即授权），未认证请求在 `requireUser` 被挡；平台层抢占问题已修 |
| 3 | 浏览器 localStorage 跨账号残留 | 按 sessionId 分键的已缓解（`ui-sidebar-right` 的 `persistence.ts`）；固定键仍在（`shortcuts` 的 `dsh.keybindings.v1`） | **书面接受**：残留的是键位偏好等非敏感 UI 状态，不承载凭据；逐插件按 sessionId 分键列入后续清理，不阻塞 P6 |
| 4 | MCP 服务端会话失效（`-32001`）客户端不自动重新握手 | 仓库内无 `-32001` 处理逻辑，属于 MCP 客户端/服务端握手行为 | **书面接受**：可用性问题而非安全问题，修复点在 dsh MCP 客户端，不在本仓库范围 |

原则：**谁能读到 token，谁就能以该用户身份行动。** 上面所有取舍都由这一条决定。

## 判定标准

加任何功能前问一句：**这个功能坏了，会不会让人进不去工作区？** 会 → 放错位置了。

---

# 执行计划（P0–P6）

## 已核实的事实（2026-11-10）

| 项 | 结论 | 证据 |
|---|---|---|
| 线上版本 | 容器 `01m720v69…` 14:03 新建，镜像 `amd_20261110`；13:34 那批修复（fail-open、缓存头、模板转义、访问日志）**已在线上**。**改造前 PID 1 是网关**，线上容器仍是旧镜像，P3 需重建镜像才生效 | `docker ps/inspect/exec`；`bin/entrypoint` |
| 「重启 3 次」 | 旧容器名已不存在 = **容器重建**，不是同容器 `docker restart`。容器内任何进程都救不了容器重建，只能救「网关进程重启」 | `docker ps -a`；`GATEWAY-ISSUES.md:45` |
| 实例状态 | `state-instances.json` 线上两个租户，字段只有 `cookie,cookieExpiresAt`，且**从不读回**；`reclaimPort` 会把健康的旧实例 SIGTERM→SIGKILL | `gateway/instances.mjs:111-139,471-492,743-745,856` |
| 上游网络 | `mcphub` 192.168.64.56/.53、`v-office-storage` .34、`hybrag-app` .52、`image-studio-backend` .28，全在 `192.168/16` DROP 里且 IP 动态；`VH_NET_ALLOW_CIDRS` 只有 CIDR 粒度、无端口、全局共享 → **租户直连上游不可行** | `bin/vh-jail:128-146`；`getent hosts` |
| 文件抽屉 | `/__vh/files*` 曾是正式对外 API（`884c5496` 的 api-reference + routers.yml），文档虽被 `2f399419` revert，**接口仍在**且 `/__vh` 无条件可达 → 公开契约，必须保留同名路由 | `ictrek.app/src/docker-compose.yml:87-89` |
| 插件承载 | `packages/**/src` 无插件自监听 unix socket 的先例，但 `WebServer` 的 `ctx.effect` + `register` 可承载；新增插件最少 4 个文件，构建期有断言；**skills 逐 CLI 核对后确实零改动** | `scripts/stage-agent-plugins.ts:132-151`；`packages/experimental/webhook-github/src/index.ts:47-62` |
| 验收骨架 | `ictrek.app/scripts/verify_runtime.mjs:18-29` 已有「起 entrypoint → health → session → auth → 取页 → kill」；网关测试是 `node --test gateway/*.test.mjs` | 仓库内 |

## 决策（已定，不再悬置）

1. **验收口径 = 「网关进程重启」**：`vh_session` 不失效、`/__vh/boot` 的 `boot` 不变、实例 pid 不变、WS 重连后同一会话且能力调用成功。「容器重建照常在线」在容器内方案中物理上不可能，写进边界；对应措施是**发布时不再重建容器**（P3）。
2. **目标架构（P3 按薄方案实施）**：`bin/entrypoint` 改为 `exec` 一个极简 **supervisor（PID 1）**，只负责 spawn 网关子进程、等 `exit` 后串行拉起、reap 孤儿；网关退出后 dsh 被 reparent 到 PID 1 继续存活，新网关靠 P1 的注册表探活接管。注册表、VOS token 与能力键的**权威副本**仍归网关，不引入第二个写者；被委托的 socket 由租户插件监听，但契约只有网关能写（`vos-tokens.json` 是「内存 Map + 全量覆盖写」，两个进程会 last-writer-wins 丢更新）。supervisor **不监听任何端口、不发进程组信号**（安全章节约束），也不需要 IPC。
3. **凭据（P2 已关闭）**：继续锁在**网关**（不是管理进程），持久化到 root-only `$STATE_ROOT/vos-tokens.json`（0600，与 `sessions.db` 同级），**不进租户 home**；未选分支及其代价见 P2。
4. **搬家方式（能力化转发）**：unix socket 由租户 dsh 插件监听（接口不变、skills 零改动），插件把请求经网关 `127.0.0.1:8080`（已放行端口）上的 `/__vh/egress/*` 交给网关，由网关补 token 并连上游；按 subject 校验能力键 + 上游白名单。**不放宽任何 CIDR、不下发 token、不改 MCP 协议、不动隔离**。
5. **P0 不做 `server.mjs` 顶层重构**：把接管内核抽成可单测的新模块，避免重写 2469 行文件；`server.mjs` 只做必要的小改。

## 阶段表

| 阶段 | 目标 | 主要落点 | 人日 | 验收判据 |
|---|---|---|---|---|
| **P0** | 可测基线 + 接管内核 | 新增 `gateway/instance-state.mjs`、`gateway/adoption.test.mjs` | 0.5 | 新模块单测全绿；现有 `node --test gateway/*.test.mjs` 全绿 |
| **P1** | 状态接管（**已实施**） | `instances.mjs`、`server.mjs`、`scheduler.mjs`、`mcphub.mjs`、新增 `instance-state.mjs`、`adoption.test.mjs` | 1.5 | `node --test gateway/*.test.mjs` 全绿；接管不 spawn、`boot` 稳定、能力键恢复 |
| **P2** | 凭据归属（**已实施**） | 新增 `vos-token-store.mjs`、`vos-token-store.test.mjs`；改 `office.mjs`、`server.mjs` 与 5 个消费方 | 1 | `node --test gateway/*.test.mjs` 198/198；token 跨网关重启存活、租户 home 无 VOS token 文件（只有无授权效力的能力投递副本） |
| **P3** | 进程归属（**已实施**，薄方案） | 新增 `bin/vh-supervisor.sh`、`gateway/supervisor.test.mjs`；改 `instances.mjs`（日志 fd）、`server.mjs`（能力预热）、`entrypoint`、`Dockerfile`、`hotfix-plugins.sh` | 1 | `node --test gateway/*.test.mjs` 205/205；网关退出后租户进程存活且日志可写、supervisor 串行拉起、SIGTERM 干净退出 |
| **P4** | 能力通道 + 插件骨架（**已实施**） | 新增 `capability-registry.mjs`、`egress.mjs`、`socket-path.mjs`、`capability-contract.test.mjs`、`packages/host/vh-capabilities/**`；改 `server.mjs`、`instances.mjs`、`plugins.mjs` 与 5 个能力模块；能力键权威副本落 `$STATE_ROOT/capabilities/`（root `0600`），租户 home 只放无授权效力的投递副本；网关侧 socket 保留双轨 | 1.5 | `node --test gateway/*.test.mjs` 230/230；契约对拍 + 真实插件双轨用例全绿；插件包 36 用例、4 文件 100% 覆盖率 |
| **P5** | 功能搬家（**已实施**，双轨切流） | 六个 socket 全部支持插件侧监听：新增 `vh-services` egress 与租户身份传递；其余五个沿用 P4 通道；支持按 namespace 灰度 | 3 | 六能力分派 + 服务身份用例 + 契约对拍全绿；`node --test gateway/*.test.mjs` 230/230 |
| **P6** | 删空壳 + 整体验收（**已做可安全部分**；主删除项待灰度） | 删不可达死分支、4 条安全缺口处置、修正文档矛盾；五模块 socket 实现、`startCapabilities` 与 `vh-userctl` 白名单保留至灰度完成 | 1 | 全量测试 / 类型检查 / lint / 语法通过；4 条缺口已逐条关闭或书面接受；容器级演练与 services 隔离实测待新镜像上线（当前 `amd_20261109` 为旧镜像，无法执行） |

## P0 · 可测基线（已实施）

- 新建 `gateway/instance-state.mjs`：注册表读写（0600 + tmp/rename）、`probeInstance()`（带 cookie 的 `GET /`，Host 固定 `127.0.0.1:<port>`，只认 200）、`adoptable()` 纯函数、`backfillInstanceState()` 老记录升级、`COOKIE_MAX_AGE_MS` 单一真源。
- 新建 `gateway/adoption.test.mjs`：假 dsh server + 临时 STATE_ROOT，当时 11 个用例（P3 后 14 个）覆盖探活、接管、不 spawn、不误杀、boot 稳定、迁移、能力键恢复与停止路径。
- 不拆 `server.mjs` 顶层副作用：重构风险大于收益，接管逻辑全部放在可测的新模块里。

## P1 · 状态接管（已实施）

| # | 改动 | 落点 |
|---|---|---|
| 1 | 扩展 `InstanceState`：`+ port, uid, bootedAt, pid, schedulerKey, mcphubKey`；旧记录由 `migrateInstanceStateKeys` 补齐（`bootedAt` 由 `cookieExpiresAt - 30d` 推得），线上两个租户的 cookie 记录可直接升级 | `gateway/instances.mjs` |
| 2 | `ensureInstance()` 改为「读注册表 → `adoptable` → `probeInstance` → 复原内存 Map（不 spawn）→ 失败才 launch」；接管实例按节流周期复探，死亡自动回退到 launch | 同上 |
| 3 | `ensureInstance()` 在决定 spawn 之前完成接管：接管成功根本不进入 `reclaimPort()`，健康实例因此不会被杀；`reclaimPort()` 只在确认要重新 spawn（cookie 失效或进程无响应）时才清理端口 | 同上 |
| 4 | `stopAll()` 不再 kill 子进程（网关退出时租户进程留给内核/下一次接管）；标记停止意图，避免刚停掉的进程又被 adopt 回来。**P3 后修正**：`stopInstance()` 不再只给 `vh-jail` 包装发信号（它不转发信号，真正的 dsh 是已降权的孙进程），改为按**端口持有者**停（uid 校验 + SIGTERM→SIGKILL），并校验注册表 pid 的 `/proc` 归属（uid + `vh-jail` cmdline）后才清理包装；调用方 `await` | `gateway/instances.mjs`、`gateway/server.mjs` |
| 5 | `instanceBoot()` 改读持久 `bootedAt`，`primeInstanceBoots()` 在网关启动时灌值 | `gateway/instances.mjs`、`gateway/server.mjs` 启动段 |
| 6 | 能力键随注册表落盘、启动时恢复 `keys`/`tenants` Map（旧 dsh 的 env 无法改写，这是唯一解） | `gateway/scheduler.mjs`、`gateway/mcphub.mjs` |
| 7 | `restartInstance()` 不再等 `child.once('exit')`，改等 `waitForFreePort()`；`instanceFor()` 对接管实例走 `ensureInstance` 以驱动节流复探（自 spawn 的实例仍走缓存快速路径） | `gateway/server.mjs` 的 `instanceFor()` / `restartInstance()` |

**P1 边界**：不动 VOS token（留给 P2 决策）、不动业务代理。实施 P1 时网关仍是容器 PID 1，网关退出即容器退出、内核回收 dsh，所以当时「网关重启后实例仍存活」只能在单测层验证；P3 把 supervisor 做成 PID 1 后这一限制已解除。`shutdown()` 仍会关闭能力 socket；P2 之前它同时清空 token，重启后需要 `/__vh/verify` 重放，P2 之后 token 从 root-only 状态文件恢复，不再依赖重放；网关重启后的首个导航会经历一次 STARTING→reload（STARTING 页只要 `boot > 0` 就 reload）。

**P0/P1 验证**（2026-11-10 实跑）：`node --test gateway/adoption.test.mjs` 11/11；当时 `node --test gateway/*.test.mjs` 188/188；六个改动文件 `node --check` 全部通过；IDE 诊断 0 条。仓库 `.oxlintrc.json:28-29` 忽略 `**/*.mjs`，故 gateway 面的检查以语法、单测、诊断为准；P6 的 `pnpm run lint` 覆盖的是 TS 工程。无待办标记 / 死代码 / 临时文件残留。

## P2 · 凭据（已实施）

**决策已关闭**：选「继续锁在网关」分支 —— token 只落在网关私有的 `$STATE_ROOT/vos-tokens.json`（目录 `0700 root`、文件 `0600`），不进租户 home、不下发浏览器、不交给 agent。P5 因此不必因为凭据把 office 系留在网关。

| 改动 | 落点 |
|---|---|
| 新增 `vos-token-store.mjs`：内存 Map 仍是读路径；`rememberTokens()`/`forgetTokens()`/refresh 成功时同步原子写盘（tmp + rename + chmod 0600）；`initTokenStore()` 启动时恢复并丢弃「过期且无 refresh」条目；文件缺失、损坏或权限过宽一律视为空，不阻断启动 | `gateway/vos-token-store.mjs` |
| `office.mjs` 移除整段内存 token 实现（Map、JWT 过期、refresh、可用性判断），只保留 socket 与 `rememberOrigin`；`closeOfficeCapabilities()` 不再清 token | `gateway/office.mjs` |
| 5 个能力模块、3 个测试与 `server.mjs` 改为从 store 导入 `accessTokenFor`/`rememberTokens` 等；无兼容壳、无重复存储 | `photocraft.mjs`、`album.mjs`、`weknora.mjs`、`scheduler.mjs`、`mcphub.mjs`、`server.mjs`、`*.test.mjs` |
| 启动时 `initTokenStore(VOS_TOKENS_FILE)`；logout 与账号切换删除旧 namespace 凭据；**只有 `invalid_grant`（或无 refresh token）才由 store 删除凭据**，5xx/429/超时/网络错误/畸形成功响应一律保留，等下一次刷新重试 | `gateway/server.mjs` |
| 8 个用例：0600 落盘与重启恢复、过期清理、损坏/权限过宽、删除、refresh 成功落盘、`invalid_grant` 删除、瞬态失败（503 / 200 无 token）保留凭据、过期时间计算 | `gateway/vos-token-store.test.mjs` |

**验收**：`node --test gateway/vos-token-store.test.mjs` **8/8**（P2 当时的全量为 198/198，加固后的总数见 P4/P5），改动文件 `node --check` 与 IDE 诊断全过。容器实测 `/data/.vh` 为 `0700 root`，`bin/entrypoint:9-13` 保证目录权限，部署脚本不清理 state 文件，凭据不会随发布丢失。P3 落地后「停网关再启动、能力调用仍 200」可做容器级完整演练；本阶段的跨重启验证在 store 层完成。

**权限加固**：线上实测 `sessions.db` 为 `0644`，`openSessionStore` 现在显式把主库及 `-wal` / `-shm` 收敛到 `0600`；`instance-state.mjs` 与 `vos-token-store.mjs` 对齐 —— 读取前校验文件权限（过宽即按空处理，实例会重新 spawn 一次，安全优先）、写入时对已存在的临时文件补 `chmod 0600`。四份 at-rest 凭据的纪律见安全章节清单，新增 3 个权限用例。

**行为变化**：logout 现在删除该 namespace 的持久凭据。同一账号的其它设备因此会短暂失去能力凭据，`/__vh/session` 的 `tokenReady=false` 触发一次 PKCE 重放即可恢复；这是「登出即删」的代价，换取磁盘上不残留已注销的身份。

**未选的分支**：若改选「租户 home 0600」，agent 拿到的是全平台身份，office 系功能必须留网关、P5 清单收缩，并需重写本节与「安全」章节；本次不实施。

## P3 · 进程归属（已实施，薄方案）

不把 launch / 能力 socket / token 搬进第二个进程：那会引入 IPC，还会让两个进程同时覆盖写 `vos-tokens.json`。只把 PID 1 换掉，P1 的 adopt 机制负责其余部分。

| 改动 | 落点 |
|---|---|
| 新增 `vh-supervisor.sh`：bash 作 PID 1，spawn 网关为子进程；等 `exit` 后按 1s→30s 退避**串行**拉起（两个网关并存会抢 socket / `sessions.db` / 状态文件）；写 `$STATE_ROOT/gateway.pid`（`0600`）；只有自己收到 Docker 的 SIGTERM 才转发单 pid 给网关并退出，绝不发进程组信号（实例 jail 与网关同组，组杀会误伤）；bash 作 init 只回收**被 reparent 到 PID 1** 的孤儿 | `bin/vh-supervisor.sh` |
| `entrypoint` 保留 `:1-54` 的一次性初始化，末端 `exec` supervisor；`VH_SQLITE_FLAGS` 透传；启动时清理被中断写入留下的 0 字节 `*.tmp` 残留（线上实测 `services.json.1.tmp` / `.85.tmp`） | `bin/entrypoint` |
| **躲不掉的隐藏改造**：dsh 的 stdio 从网关持有的 pipe 改为日志文件 fd（`openSync` + `fchmodSync 0600`，spawn 后父进程关闭），`waitForLaunchUrl()` 改为按偏移 tail 日志（旧 URL 不会被当成一次性 token 重放）。否则网关退出后读端关闭，dsh 写日志撞 EPIPE；它是自己 pid namespace 的 init，一退整个租户清空 | `gateway/instances.mjs` |
| 启动时按 `listUsers` 预热 7 个能力 socket，消除重启窗口内 skill CLI 连到 stale socket 的 `ECONNREFUSED` | `gateway/server.mjs` |
| 镜像 chmod 新脚本；热修脚本由 `docker restart` 改为 `docker exec … kill -TERM <gateway.pid>`。**退避期 pid 文件会短暂消失**，所以轮询最多 60s 等新 pid，绝不因单次失败立刻回退 `docker restart` | `Dockerfile`、`ictrek.app/scripts/hotfix-plugins.sh` |
| **P3 让两条旧路径可达后一并修掉**：`stopInstance()` 改为按端口持有者停（uid 校验 + SIGTERM→SIGKILL）并校验注册表 pid 归属，logout / 重启真的停掉 dsh，而不是只杀 `vh-jail` 包装 | `gateway/instances.mjs`、`gateway/server.mjs` |
| 3 个用例：supervisor 语法、退出后拉起 + SIGTERM 干净停止、网关重启后租户进程存活且日志 fd 仍可写；URL 发现另有 3 个用例；停止路径另有 2 个用例（陈旧 pid 不误杀、按端口持有者真停） | `gateway/supervisor.test.mjs`、`gateway/instances.test.mjs`、`gateway/adoption.test.mjs` |

**验收**：`node --test gateway/*.test.mjs` 205/205；`bash -n` 三个脚本、`node --check` 改动模块全过。容器级演练待镜像重建后执行：`docker exec <C> ps -o pid,ppid,comm -p 1`（应为 supervisor）→ `docker exec <C> sh -c 'kill -TERM "$(cat /data/.vh/gateway.pid)"'` → `/__vh/health`、`/__vh/whoami`、`/__vh/boot`、实例 pid、一次真实能力调用。

**边界**：容器重建 / 换镜像灰度仍全量重连；WS 断连不可消除；supervisor 自身退出即容器退出。`docker restart` 现在只作为旧镜像的回退路径保留。

**reap 的适用边界**：线上僵尸 `node`（pid 1082）的父进程是租户自己的 dsh（830），不是 PID 1 —— 那是 dsh 没 wait 自己的子进程，不归 supervisor 管。supervisor 只能回收被 reparent 到它的孤儿；这条能力既未被证伪，也还没有被真正验证过（当前容器仍是旧镜像）。

## P4 · 能力通道与插件骨架（已实施）

**薄 P3 改变的前提**：PID 1 现在只是 `bin/vh-supervisor.sh`（bash），不参与业务、不监听端口、没有 IPC socket；注册表、能力 socket、VOS token 与能力键**仍在网关**。所以 egress 只有一条通路 —— 租户 dsh 插件 → 网关 `127.0.0.1:8080` 的 HTTP 路由 → 上游，网关是唯一代签者与唯一出口；任何「让管理进程补 token」的假设都不成立。

另一个前提是**网关重启不再重启 dsh**（线上日志已验证 `instance adopted`）。两条硬约束随之而来：

- 启动期注入的 env 对已运行的 dsh 无效，egress 的 per-tenant 能力键必须落盘（可轮换、插件可读），不能沿用 `VH_SCHEDULER_KEY` / `VH_MCPHUB_KEY` 的 env 注入。键有**两份、权威不同**：`$STATE_ROOT/capabilities/<sha256(subject)>.json` 是权威副本（目录 `0700 root`、文件 `0600`、`O_NOFOLLOW` 读取），网关只从它重建键索引和决定 socket 归属；tenant home 的 `.dsh/capabilities.json` 只是**投递副本**，插件读它、但它没有任何授权效力 —— 租户改写它最多让自己的插件行为异常，不能自造可用键、扩大能力范围或指向别的租户；
- 插件分发（`plugins.txt` / carrier patch）只在**新实例启动**时落地，迁移期必然存在「老 dsh（无插件，仍连网关 socket）+ 新网关」共存，不能一次性删掉网关侧实现。

| 工作 | 落点 |
|---|---|
| 新增能力注册表：六个 socket 的名称/文件/`egress` 与 `delegable` 标记（`vh-services` 暂不可委派，见 P5）；`VH_PLUGIN_CAPABILITIES`（默认 `image-studio`）与按 namespace 覆盖的 `VH_PLUGIN_CAPABILITIES_BY_NAMESPACE` 过滤出可下放能力，`CAPABILITY_ENV` 在进程启动时快照，授权与归属读同一份；两份契约的读写（权威副本 `$STATE_ROOT/capabilities/<sha256(subject)>.json`、投递副本 `$DSH_HOME/capabilities.json`，均 `0600` + tmp/rename、复用旧键、root 下把投递副本 chown 给租户）；读取用 `O_NOFOLLOW` + `O_NONBLOCK` + `fstat`，拒绝软链、FIFO/设备、非普通文件、owner 不符、组/其他人可读、超过 64 KiB、伪键与非空能力列表；进程内键索引与 `timingSafeEqual`；授权范围 = 契约 ∩ 该 namespace 的 rollout | `gateway/capability-registry.mjs` |
| 新增 egress 传输层：`/__vh/egress/<capability><path>` 解析、浏览器形状（`Origin`/`Referer`/`Sec-Fetch-*` 一律拒绝）与回环 TCP 对端校验、`Host` 必须是回环 authority、按 capability 分派到各模块的 `handle*Egress`；键校验后取「契约 ∩ rollout」范围；raw 与解码后的点段、反斜杠、NUL 一律 400；不经过 `vh_session` | `gateway/egress.mjs` |
| 新增归属与探测模块：`capabilitySocketAnswers()` 先 `lstat`（必须是 tenant uid 拥有的 socket）再 `connect`，陈旧 inode、他人绑定、无人 accept 都不算通过；`missingCapabilitySockets()` 有界重试（5×200 ms）吸收 dsh 应答 HTTP 到插件 effect 之间的窗口；`startOwnedCapabilities()` 在「契约 ∩ rollout ∩ 镜像附带插件」之外再要求监听器可证明，失败时删除两侧契约与键、丢弃各能力按 subject 缓存的监听器并立即由网关重绑；租户不在运行时只记录、保留契约 | `gateway/capability-ownership.mjs` |
| `handleControl` 最前分流 egress；启动用户循环从**权威副本**重建键索引，镜像未附带插件时删除残留契约并清键；`startCapabilities` 调用 `startOwnedCapabilities`，boot 阶段带 `requireRunning`（离线租户不夺权），launch 后不带（进程已应答，探测失败即回退）；docker 代理始终由网关 `ensure`；logout 停实例、删两侧契约并清键后**立即重绑**网关 socket；账号切换在删除旧契约后停掉旧实例，同样立即重绑，切回时由下一次 launch 重新写契约 | `gateway/server.mjs` |
| `launch()` 在 `syncPlugins` **成功**之后、spawn 之前写两份契约；`syncPlugins` 返回布尔值，`ensureProfile` / 客户端插件复制 / 单个 agent 包复制 / manifest 列出的包缺失 / bundle mount 任一步失败都返回 `false`，调用方据此不委派；镜像未附带插件（`capabilitiesPluginShipped()` 为假）、契约写入失败、无可下放能力，或 spawn 后没有任何进程应答时都删契约，回退网关持有 socket | `gateway/instances.mjs`、`gateway/plugins.mjs` |
| 五个能力模块只新增导出：`SOCKET_NAME`、`ROUTES`，以及 `handleOfficeEgress` / `handleAlbumEgress` / `handlePhotocraft` / `handleImageStudioEgress` / `handleWeknoraEgress`；office 的 `/__vh/origin` 在网关侧直接回答，其余原样走既有 `forward` | `office.mjs`、`album.mjs`、`photocraft.mjs`、`image-studio.mjs`、`weknora.mjs` |
| 新插件 `packages/host/vh-capabilities/`：读契约（`O_NOFOLLOW` + `O_NONBLOCK`，校验普通文件/owner/`0600`/大小）→ `ctx.effect` 内逐个 `listen($DSH_HOME/<name>.sock)`（`0600`）→ 转发到 `/__vh/egress/*`；无契约直接返回；网关地址默认 `http://127.0.0.1:${VH_GATEWAY_PORT ?? 8080}`；socket 归属**网关优先**：只清理本 uid 的陈旧 socket，外部 uid 的 socket 与目录/普通文件/软链一律不删；停止时先断开连接、把路径 rename 成 tombstone 再 close，仍是自己的就删、已被网关重绑就 `link()` 还原（避免 Node `close()` 隐式 unlink 掉网关的新 inode），等待上限 5 s | 新包四文件（`contract.ts` / `forward.ts` / `servers.ts` / `index.ts`） |
| 分发与工程注册：`plugins.txt`、carrier `package.json` + `cordis.patch.yml`、`tsconfig.base.json` 路径、`tsconfig.host.json` 引用、`packages/host` 双语 README、Model Experience 白名单 | 见同目录改动 |
| 测试：契约对拍（六能力命名/`SOCKET_NAME`/`ROUTES` 合法性/方法+路径唯一/`vh-services` 不可委派）＋双轨用例（同一请求分别经网关 socket 与**真实插件 `lib/index.js`** 的 socket，断言 status/body/content-type 一致，五个可委派能力逐个走一遍）＋拒绝矩阵（浏览器形状/外部 Host/路径穿越/401/401/403/404）＋伪造投递副本、软链、FIFO、超大文件、吊销后键失效、按 namespace 灰度 | `gateway/capability-contract.test.mjs` |
| 测试：归属探测（活监听器通过、普通文件/缺失路径/他人 uid 拒绝、SIGKILL 残留 inode 拒绝、有界重试）＋启动竞态回退（运行中租户无监听 → 删两侧契约与键、丢弃缓存监听器、全部重绑；离线租户 → 保留契约）＋镜像无插件全绑＋rollout 收窄后重绑＋契约删除后（logout/账号切换）全绑 | `gateway/capability-ownership.test.mjs` |
| 测试：契约读取全分支（目录/超大/软链/FIFO/宽权限/伪键）、转发方法白名单与路径越界、响应头白名单（含 `x-voffice-token`）、陈旧 socket 接管、网关不可达 502、上游超时、关闭时外部替换/还原、长连接下 `close` 有界、启动半途失败回收、插件惰性与 dispose、`DSH_HOME`/`HOME` 回退 | `packages/host/vh-capabilities/tests/` |

**开工前悬置的四条契约（已按实现关闭）**：

1. **能力键的签发与轮换**：网关在实例 `launch()` 时写入两份契约 —— 权威副本 `$STATE_ROOT/capabilities/<sha256(subject)>.json`（root `0600`，网关唯一的授权与归属依据）与投递副本 `$DSH_HOME/capabilities.json`（`0600`，原子写，root 下 chown 给租户；插件读它，但它无授权效力）。键是 32 字节随机 hex，重写时复用已有键，因此网关重启不会让存活的插件失联；轮换 = 删两份契约 + 重启该租户；吊销发生在 logout、账号切换、镜像回滚（`capabilitiesPluginShipped()` 为假）、rollout 收窄的租户重启，以及委派 socket 探测失败（网关删两份契约、清键并由自己重绑）。网关重启后只从权威副本重建键索引；网关 shutdown **有意不删契约**，否则重启后无法接管仍存活的租户（吊销时机是上面几处，不是进程退出）。
2. **流式与上传语义**：插件只做流式管道，不整体缓冲（请求体 `pipe`，GET/HEAD/DELETE 直接 `end`，响应 `answer.pipe(res)`）；方法限 `GET/HEAD/POST/PUT/PATCH/DELETE`，其余 405；路径先拒绝点段/反斜杠/NUL（raw 与解码两次），再由 `new URL` 校验 origin，越界 400；只回传 `content-type` / `content-length` / `content-disposition` / `cache-control` / `etag` / `last-modified` / `mcp-session-id` / `mcp-protocol-version` / `x-voffice-token`；office 的 100MB 上传与 SSE 仍走网关各模块既有 `forward`，超时与错误文案不变；这一跳有超时（`timeoutMs`，默认 10 分钟，按空闲计时，`unref` 的 `setTimeout` 不拖住退出），网关不可达时插件返回 502 `{error:'gateway-unreachable'}`，已发头则 `destroy`。
3. **`/__vh/origin` 的归属**：`publicOrigins` 仍只存在于网关；`handleOfficeEgress` 在进入 `forward` 前直接返回 `{origin: publicOrigins.get(namespace) ?? ''}`，插件不缓存、不猜。
4. **兼容期判定**：唯一磁盘判据是契约文件，入口判据是镜像是否附带插件（`capabilitiesPluginShipped()`，任何失败按「未附带」处理）。无契约 → 网关持有全部 socket；老 dsh 从不被重新 launch，因此不会凭空出现契约；插件侧只监听契约列出的能力。两份契约都会被严格校验：`O_NOFOLLOW` + `O_NONBLOCK` 打开，必须是普通文件、owner 符合预期、权限 `0600`、不超过 64 KiB，且版本/键格式/能力列表合法；软链、FIFO/设备、权限过宽、坏 JSON、版本不符、伪键、能力为空一律视为不存在（安全优先）。

**验收（2026-11-10 实跑，含四轮审查加固）**：`node --test gateway/*.test.mjs` **240/240**（`capability-contract.test.mjs` 20 个、`capability-ownership.test.mjs` 9 个）；插件包 `npx vitest run packages/host/vh-capabilities/tests` **36 用例全绿**，`--coverage.include='packages/host/vh-capabilities/src/**'` 显示 `contract.ts` / `forward.ts` / `servers.ts` / `index.ts` 四项 100%；`npx tsc -b tsconfig.host.json` 通过；`oxlint` 0 诊断；所有改动的 `.mjs` `node --check` 通过；新包中英 README、i18n 与 Model Experience 校验通过。双轨用例加载真实插件 `lib/index.js`（未构建则 skip），用本地 fake upstream + 临时 HOME 运行，不需要 DEEPSEEK / VOS 密钥。

**边界与遗留**：P4 只铺通道，不切流 —— 默认 rollout 仅 `image-studio`，且仅在镜像附带插件的新实例上生效；网关侧五个能力的 `start()/ensure*/close*` 全部保留，P5 逐个 namespace 灰度后才能进入 P6 删除。`vh-services` 虽然已有 egress 处理与监听器搬家代码，但按本计划自己的验收条款（跨租户容器隔离未实测）**保持网关持有**：`delegable: false`，rollout 即使列出也会被丢弃，P6 删除清单不含它。未放宽任何 CIDR，未向租户 home 下发 VOS token，MCP 协议未改；本轮未触碰生产容器。能力键的投递副本虽然落在租户 home，但它不是凭据：网关从不读它做授权，泄漏或改写都不产生新的上游调用能力。

## P5 · 功能搬家（已实施，双轨切流）

顺序不变：`image-studio`（上游无鉴权、租户侧已有 `skill-image-studio`）→ `photocraft` → `album` → `office` → `weknora` → `vh-services`。`/__vh/*` 公开 HTTP 入口与 `/__vh/svc` 反代保留在网关。

**实施结果**：五个能力 socket 具备「网关侧 egress 处理 + 租户插件监听」两条腿；`vh-services` 只完成 egress 处理与搬家代码，归属按验收条款保持网关。归属由契约文件与探测共同决定，不再只看契约。

| 能力 | 网关 egress 处理 | 说明 |
|---|---|---|
| `voffice` | `handleOfficeEgress` | `/__vh/origin` 由网关直接回答（`publicOrigins` 不下发），其余走既有 `forward` |
| `album` | `handleAlbumEgress` | 路由表与 token 交换不变，namespace 决定租户身份 |
| `photocraft` | `handlePhotocraft` | 复用既有入口，路由表不变 |
| `image-studio` | `handleImageStudioEgress` | 上游无鉴权；P4 的默认 rollout |
| `weknora` | `handleWeknoraEgress` | 地址探测与 VOS→HybRAG 交换仍在网关 |
| `vh-services` | `handleServicesEgress` | **网关持有**：`delegable: false`，rollout 列出也会被丢弃；注册表、docker 代理、`/__vh/svc` 与独立 jail 重启留在网关。待 P6 的 A→B 容器隔离实测通过后再评估搬家 |

**灰度方式**：`VH_PLUGIN_CAPABILITIES` 是全局 rollout（默认 `image-studio`），`VH_PLUGIN_CAPABILITIES_BY_NAMESPACE` 可按 namespace 覆盖（JSON 对象，值可以是逗号串或数组）—— 打开单个租户不需要同时打开其他人，非法配置回落全局并 warn。按上表顺序逐项加入；只有**重启过的租户**在下次启动时写入新契约并改由插件监听，未重启的老 dsh 继续连网关 socket。全部可委派能力切完且线上稳定后才进入 P6。回滚 = 从 rollout 移除该能力（或按 namespace 收窄）并**重启网关**（`CAPABILITY_ENV` 是启动快照，进程内改 env 既不会重绑 socket，也不应立刻 403）；重启后 boot 循环按「契约 ∩ rollout」重算归属，把被移除的能力重新绑到网关。**只删租户 home 的投递副本不会改变归属** —— 网关只读权威副本。租户重启同样会重算：launch 写入新契约后，`startCapabilities` 把不再下放的能力绑回网关。镜像回滚（`capabilitiesPluginShipped()` 为假）会在下次启动删除残留契约并清键，避免老 dsh 两侧都没有 socket。委派 socket 探测失败则是唯一的热回退：网关删两侧契约、清键并立即重绑，不需要重启。

**不搬的边界**：`docker-proxy` / `docker.sock`（宿主 socket + root）不搬；`/__vh/svc` 反代、端口白名单、独立 jail 重启保留在网关；`/__vh/files*`、`/__vh/office*`、`/__vh/weknora*` 保留同名路由与返回结构，网关实现不变；`/__vh/mcphub/agent/*` 保持带 `VH_MCPHUB_KEY` 的 HTTP 入口 —— MCP 客户端说的是 HTTP URL，插件监听 socket 无法替换该 env，且其转发终点仍是网关，搬家不会增加网关重启期间的可用性。MCP 协议、CIDR、VOS token 位置均未改变。

**验收（2026-11-10 实跑，含四轮审查加固）**：`node --test gateway/*.test.mjs` **240/240**（`capability-contract.test.mjs` 20 个：五能力分派、真实插件双轨、rollout 收窄 403、`vh-services` 拒绝委派；`capability-ownership.test.mjs` 9 个：监听器探测（活监听器、普通文件、缺失、他人 uid、SIGKILL 残留、有界重试）、启动竞态回退、离线租户保留、镜像无插件全绑、收窄与契约删除后重绑）；插件包 36 用例全绿、4 个源文件 100% 覆盖率；`npx tsc -b tsconfig.host.json` 通过；`oxlint` 0 诊断；所有改动 `.mjs` `node --check` 通过；`pnpm install --lockfile-only` 补入新包的 workspace 依赖。各能力的真实 skill 调用验证属于部署步骤（需要镜像与租户），不在本仓库测试内；其中「老 dsh 无契约 + 网关持有 socket + 真实 skill 连接」那条腿归 P6 容器级演练，不计入 P5 验收。

## 安全加固（2026-11-10 四轮审查，已修复/已挂验收）

| 审查项 | 结论与修复 | 证据 |
|---|---|---|
| 契约信任模型 | 权威副本移入 `$STATE_ROOT/capabilities/<sha256(subject)>.json`（root `0600`），网关只从它恢复键索引与 socket 归属；租户 home 的 `capabilities.json` 降级为无授权效力的投递副本。两侧读取用 `O_NOFOLLOW` + `O_NONBLOCK` + `fstat`，拒绝软链、FIFO/设备、非普通文件、owner 不符、组/其他人可读、超过 64 KiB、伪键；root 写投递副本前 `lstat` 拒绝被软链的 home/`.dsh` | `capability-registry.mjs`、`contract.ts`；用例「权威副本与投递副本」「租户改写投递副本不能造键」「软链与 FIFO」「超大文件」 |
| 键无吊销 | `removeCapabilityContract` 接入 logout、账号切换、镜像未附带插件（启动时与 `launch()` 前）与契约写入失败路径：删除两份契约并 `forgetCapabilityContract`，egress 立刻 401。网关 shutdown **有意不删**，否则重启后无法接管存活租户 | `server.mjs`、`instances.mjs`；用例「吊销后键失效」 |
| egress 校验偏弱 | 除浏览器头存在性外，`Host` 必须是回环 authority（`127.x`/`localhost`/`[::1]` 可带端口），拒绝 raw 与解码后的点段、反斜杠、NUL；顺序为浏览器形状 → TCP 对端 → `Host` → 路径 → 键，浏览器探测学不到键是否有效。跨租户越权仍由「用户库键→namespace、scope ∩ rollout、`timingSafeEqual`」挡住 | `egress.mjs`；用例「浏览器/外部 Host/穿越在查键前拒绝」 |
| socket 竞态 | 网关统一 `listenOnSocket`：不删目录、`EADDRINUSE` 有限重试，网关优先；插件只清理本 uid 的陈旧 socket，外部 uid 的 socket 与目录/普通文件/软链一律不碰。关闭先 `closeAllConnections()`，把路径 rename 成 tombstone 再 `close`，仍是自己的就删、被网关重绑就 `link()` 还原，等待上限 5 s | `socket-path.mjs`、`servers.ts`；插件用例「陈旧 socket 接管」「外部替换后还原」「长连接下 close 有界」 |
| 插件侧零纵深 | 方法白名单（其余 405）、路径先拒点段/反斜杠/NUL 再校验 `new URL` origin（越界 400）、请求/响应头白名单（含 `x-voffice-token`）、转发空闲超时（`timeoutMs`，默认 10 分钟）、`res.on('close')` 销毁上游 | `forward.ts`、`index.ts`；插件用例「405/400/超时/头白名单」 |
| 测试有效性 | 双轨用例改为加载真实插件 `lib/index.js`（未构建则 skip），六个能力逐个经插件 socket 走一遍；新增伪造投递副本、软链/FIFO、吊销、rollout 收窄、按 namespace 灰度。`pluginOwnedCapabilities` 同时受契约、rollout 与镜像是否附带插件约束，回滚不会留下「两侧都没 socket」 | `capability-contract.test.mjs`、`packages/host/vh-capabilities/tests/` |
| 委派但无人监听（二轮发现，四轮修复） | 契约只证明「应归插件」，不能证明「插件在听」。网关在跳过绑定前逐个探测路径：`lstat` 必须是租户 uid 拥有的 socket，`connect` 必须真的被 `accept`，5 × 200 ms 有界重试；陈旧 inode、他人绑定、无人 accept 都判失败。失败时若租户正在运行，删除两侧契约、清键、对六个能力逐个 `forget*Capability(subject)` 丢弃缓存并立即由网关重绑；租户未运行则保留契约与键，否则未登录租户会永久失去委派。探测同时吸收 dsh 启动早期竞态 | `capability-ownership.mjs`；`capability-ownership.test.mjs` 的「SIGKILL 残留 inode」「运行中租户无监听→重绑」「离线租户保留」 |
| 刷新瞬态失败误删（二轮） | 刷新结果改为三态：`invalid_grant`／无 refresh token 才是 `rejected`（删凭据），5xx、429、超时、网络错误、200 但无 `access_token` 一律 `transient`（保留凭据，下次重试）。`hasUsableTokens` 不再因一次上游抖动变成 false | `vos-token-store.mjs`；用例「瞬态失败保留凭据」 |
| `vh-services` 权限面（二轮） | 监听器搬家不改变授权来源：注册表、docker 代理与 `/__vh/svc` 留在网关，`docker.sock` 不进入租户；但这是权限面变更，P6 增加「租户只能看到/操作自己的容器」的实测项，无法证明则 services 保持网关持有 | `GATEWAY-PLAN.md` P6 清单 |
| `syncPlugins` 失败仍委派（三轮发现，四轮补全） | `launch()` 只在 `syncPlugins` 返回成功且镜像附带插件时写契约；失败时**不写契约**并删除残留，回退网关持有 socket。四轮补全了返回值的覆盖面：`syncPlugins`/`syncAgentPlugins`/`mountBundles` 现在返回布尔，`ensureProfile`、profile 存储对齐、客户端插件复制、单个 agent 包复制、manifest 列出但 payload 缺失、bundle mount 任一步失败都使整体为 false，不再只捕获抛异常那一类 | `plugins.mjs`、`instances.mjs`；`plugins.test.mjs` 的「manifest 缺包 → false」；日志「keeping gateway sockets」 |
| 账号切换/登出通道失效（三轮发现，四轮修复） | 切换账号时旧契约与新键随会话一起删除，但仍在运行的插件只认启动时读到的旧键；登出后同样没有进程重建通道。两处现在都在删契约后立即 `startCapabilities`，由网关按「无契约」重绑全部 socket，不依赖内存 `instances` Map（网关刚启动时该 Map 为空，旧实现要等下次登录或网关重启） | `server.mjs` 的 logout 与切换分支；`capability-ownership.test.mjs` 的「契约删除后全部重绑」 |
| 灰度收窄不热切 socket（四轮） | 授权每请求读 rollout，socket 归属只在网关启动、租户 launch 或探测失败时重算；两处若读不同的 rollout，进程内改 env 会造成「有 socket、必 403」。现在授权与归属共用启动快照 `CAPABILITY_ENV`：回滚 = 改 env + 重启网关，boot 循环按「契约 ∩ rollout」把收窄掉的能力绑回网关；租户重启同样重算。**只删投递副本不改变归属** —— 网关只读权威副本 | `capability-registry.mjs` 的 `CAPABILITY_ENV`；`server.mjs` 的 egress 与 `startCapabilities`；`instances.mjs` 的契约写入 |
| 归属粒度与缓存键不一致（四轮） | 归属按 subject，socket 缓存原按 namespace，同 namespace 多 subject 会互相影响。五个能力与 services/docker 的缓存键统一为 subject，新增 `forget*Capability(subject)` 关闭并删除对应监听器；顺带修正 `start()` 不返回 server 导致 `close*` 实际无法关闭 | 五个能力模块、`services.mjs`、`docker-proxy.mjs`；`capability-ownership.test.mjs` 的 `forget` 断言 |
| `vh-services` 委派条款（四轮） | 按本计划「实测优先」条款硬性回退：`delegable: false`，rollout 即使列出也被丢弃，egress 返回 403 `capability-not-enabled`，P6 删除清单不含它。docker-proxy 既有属主校验缺口（`/images/{name}/(json|history|tag)`、`/exec/{id}/json` 只按名字/ID 转发，不校验属主）记为 P6 前置阻塞项，未修完不得谈搬家 | `capability-registry.mjs`；`capability-contract.test.mjs` 的 403 期望 |

## P6 · 删空壳与整体验收（已完成可安全部分；主删除项有灰度门槛）

**先说清楚为什么不能全删**（2026-11-10 实测，两条硬事实）：

1. **线上跑的是旧镜像** `amd_20261109`：PID 1 仍是 `node`（网关），没有 `VH_PLUGIN_CAPABILITIES*`、`/data/.vh/capabilities/`、空 `gateway.pid`，镜像内连 `capability-registry.mjs` / `vh-supervisor.sh` 都不存在 —— P3/P4/P5 代码尚未上线，当前所有租户能力**完全依赖网关侧 socket**。
2. **灰度前提未满足**：默认 rollout 只有 `image-studio`，只有「新 launch + 镜像附带插件」才写契约；老 dsh 从不被重新 launch、无契约、继续连网关 socket。而五个模块的 `ensure*Capability` 是 `capability-ownership.mjs` 热回退的**唯一重绑路径**，删掉后探测失败会「删契约 + 清键」却没有代码重新监听，skill 得到 ECONNREFUSED；`vh-userctl` 白名单若收敛成只剩 `docker.sock`，连 P6 明确保留的 `vh-services.sock` 也会一起 die。

### 已完成

- 删 `server.mjs` 里第二个 `/__vh/office/open` 分支：前面的同源分支无条件先匹配并 `return`，这段含死调用 `editorUrlFor`，是全仓唯一确证的运行时死代码（`reportMissingPluginSocket` 在四轮审查中已不存在，无需再删）。
- 安全章节 4 条已知缺口逐条关闭或书面接受（见上表），不留悬置项。
- 修正 P6 内部矛盾：阶段表「删 6 个 socket 创建链路」与详细清单「services/docker 保留」对齐；「白名单收敛为 `docker.sock`」改为至少保留 `vh-services.sock` + `docker.sock`。
- 复跑：`node --test gateway/*.test.mjs`、`node --test gateway/capability-contract.test.mjs`、`npx tsc -b tsconfig.host.json`、`npx tsx scripts/run-oxlint.ts packages/host/vh-capabilities`、`bash -n` 三个脚本、`node --check` 改动文件、`git diff --check`。

### 容器级演练与委派可观测性实测（本轮无法执行，待新镜像上线）

当前容器是旧镜像，以下待 `./build_image.sh` → `ictrek.app/scripts/package.sh` 部署后跑：

- `docker exec <C> ps -o pid,ppid,comm -p 1`（应为 supervisor）→ `kill -TERM "$(cat /data/.vh/gateway.pid)"` → 校验 `/__vh/health`、`/__vh/whoami`、`/__vh/boot`、实例 pid 不变、日志出现 `instance adopted`、一次真实能力调用；再验 `gateway.pid` 为 `0600`、state 目录无 0 字节 `*.tmp`、热修脚本在退避期不回退 `docker restart`。
- 迁移一个 namespace 后重启网关，确认探测不误报；再制造一次 stage 失败、一次启动失败与一次「插件在 RUNNING 租户里不监听」，确认前两者不写契约、第三者删两侧契约并即时重绑，日志分别出现「keeping gateway sockets」与「taking the capability back」。
- `vh-services` 保持网关持有：若要重新评估搬家，先补 ① A 的会话/能力键 → egress → 只能操作 A 的容器 的端到端实测；② docker-proxy 既有属主缺口（`/images/{name}/(json|history|tag)`、`/exec/{id}/json` 只按名字/ID 转发，`filterListing` 只覆盖列表）。

### 灰度完成后的删除清单（触发条件满足才动手）

触发条件（**全部**满足）：① 新镜像上线，PID 1 为 supervisor、镜像内有 `capability-registry.mjs`；② 五个可委派能力按 namespace 灰度切完且线上稳定，无契约的老 dsh 清零；③ `vh-services` 仍 `delegable:false` 时其监听器永久保留。

| 删除项 | 必须同步修改 |
|---|---|
| 五模块 `start()` / `capabilities` Map / `ensure*` / `forget*` / `close*` / `SOCKET_NAME` / 5 处 `runUserHelper(['claim'])` | `capability-contract.test.mjs` 的 `SOCKET_NAME` 断言；`server.mjs` 的 bind / forget 表、shutdown 五个 `close*`；`vh-userctl` 白名单**至少**留 `vh-services.sock` + `docker.sock` |
| `server.mjs` 的 `startCapabilities` 预热（P3 引入） | 7 个调用点（boot / identity recheck / 账号切换 / login / logout / `instanceFor` / restart）逐一确认不再需要重绑；`capability-ownership.mjs` 的热回退改为「只重绑保留项 + 显式上报不可恢复」，不能留假回退 |
| 被 egress 取代的 socket 内本地分支（如 office socket 的 `/__vh/origin`） | 随 socket 删除自然消失；`handle*Egress` / `ROUTES` / `forward` / `isAllowed` / `listDocuments` / `editorUrlFor` / `rememberOrigin` / `handleWeknoraControl` / `accessTokenFor` 链路**永久保留**（HTTP 路由与 egress 仍在用） |

正式上线顺序见 `ictrek.app/RELEASE.md`；灰度换镜像仍会产生一次全量重连（容器重建），需提前告知。

## 风险与回退

| 风险 | 处理 |
|---|---|
| 容器重建仍全灭（已查实） | 冻结「不再 `docker restart`」；验收只针对网关进程重启，镜像灰度另算 |
| 网关重启期间 WS 必断 | 不可消除；持久 `bootedAt` 不变 → `watchBoot` 不整页 reload，只剩 WS 重连 |
| probe 误判串租户 | uid + cookie + 200 三重校验；接管成功根本不进入 `reclaimPort`，只有确认要重新 spawn 时才清理端口 |
| 插件在租户里不监听 | 网关用 `lstat`（租户 uid 的 socket）+ `connect`（真被 `accept`）有界探测每个已委派路径；RUNNING 租户失败即删两侧契约、清键、`forget*Capability(subject)` 并立即重绑，离线租户保留契约等下次启动。这是唯一的热回退；rollout 变更仍需重启网关（`CAPABILITY_ENV` 快照） |
| 能力键/env 不可逆 | 注册表持久化 + 启动恢复；P1 先做，P3 复用。rollout 读取固定为启动快照，改 env 必须重启网关才影响归属与授权 |
| at-rest 凭据面（清单见安全章节） | `vos-tokens.json`（VOS token）、`state-instances.json`（dsh cookie + scheduler/MCPHub 键）、`capabilities/`（能力键权威副本）、`sessions.db` + WAL（session id）四份都只放 root-only `$STATE_ROOT`（0700/0600），不进租户 home、不进浏览器；登出/切换/`invalid_grant`/镜像回滚即删（**瞬态刷新失败保留**），恢复时丢弃过期条目、权限过宽的文件不被信任。租户 home 的 `capabilities.json` 是投递副本，不是凭据：网关从不读它做授权，泄漏或改写只影响该租户自己的插件 |
| egress 变 SSRF | 能力键（`timingSafeEqual`）+「契约 ∩ namespace rollout」+ 上游白名单；egress 只接受回环 TCP 对端、回环 `Host`，拒绝浏览器头与路径穿越；supervisor（PID 1）不监听任何端口，网关是唯一网络入口 |
| 能力键泄漏（新面） | 键只能换到该租户、该 rollout 内已下放能力的代签调用，不能跨 namespace；吊销在 logout/切换/回滚时立即生效。已知残余风险：同一租户 uid 下运行的其他进程可以读到投递副本并冒用该键，与「该 uid 能读自己的 dsh 目录」同级，未扩大租户边界 |
| P4/P5 迁移期新旧 dsh 共存 | 网关侧 socket 与插件侧双轨、按 namespace 灰度；插件分发只在新实例启动生效，老 dsh 不能被「一次性删网关实现」打断 |
| P6 提前删空壳 | 五个 `ensure*` 是 P5 热回退唯一重绑路径；默认 rollout 仅 `image-studio` 且线上仍是旧镜像。删前必须满足「新镜像上线 + 五个可委派能力切完 + 老 dsh 清零」；`vh-services` / `docker` 监听器与白名单至少两项永久保留，非 socket 逻辑永久保留 |
| 新插件无 socket 先例 | `ctx.effect` 异步 disposer + 构建期断言 + 契约对拍 |
| `/__vh/files*` 外部契约 | 保留同名路由与返回结构 |

**工期**：P0–P5 已实施（约 9 人日），「网关进程重启不掉线」的代码路径已闭合，线上日志已验证 `instance adopted`；P6 的可安全部分已完成，主删除项因线上仍是旧镜像、五个能力灰度未切完而挂有明确触发条件（见 P6），不计入已完成人日。比本文开头「1 天 + 3 天」多出来的是：PID 1 改造、token/能力键持久化、egress 通道、契约测试、发布脚本改造，均有上表证据支撑。镜像构建与灰度不在估算内。
