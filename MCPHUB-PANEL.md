# MCPHub 服务面板 —— 设计稿

状态：P0、P1、P2 已实现（代码与单测在仓库内，P2 待投放后验收）。**P3 面板内启停/重载已实现**（见 3.3.4）。开发与验收统一使用 **admin 账号**（`vos-admin-f81f12de873d`）。Agent 连接模式默认 **`all`（直连聚合端点）**，可选 `smart`，也可按服务逐条挂载。

本文分三部分：**一、调研与现状**（事实与约束）、**二、方案设计**（结构与决策）、**三、实施计划**（文件级改动与验证）。

---

# 一、调研与现状

## 1.1 目标行为

1. v-harness 左侧导航出现「MCPHUB服务」一项，点进去列出 MCPHub 中当前用户可用的 MCP 服务。
2. Agent 能直接调用这些服务的工具。
3. MCPHub 未安装时，该项整体隐藏，不报错、不刷日志、不发请求。
4. VOS 凭据不进入租户进程、不进入浏览器。

## 1.2 v-harness 侧接入点

| 能力 | 位置 | 结论 |
|---|---|---|
| 左侧导航 | `packages/client/ui-sidebar/src/client/contract/slots.ts:35`（`sidebar.panellist`） | 不是路由；注册图标项 + `main` keyed 槽即成一页 |
| 页面模板 | `packages/client/ui-plugin-manager/src/client/index.ts:144` | 左侧页 + 图标的最小完整范例 |
| 列表模板 | `packages/client/ui-services/`（`face.ts`、`store.ts`、`ServicesBody.tsx`） | 同源 `fetch('/__vh/...')` + 轮询 + 行内动作，可直接照抄；但它挂右侧栏，外壳要换 |
| 网关分派 | `gateway/server.mjs:873-937`，`requireUser` 在 `:503` | 新增 `/__vh/mcphub/*` 分支即可，无需改 Traefik |
| 用户令牌 | `gateway/office.mjs:74`（内存 Map）、`:253`（`accessTokenFor`，自动 refresh） | 网关已持有当前用户 VOS access token，只在内存 |
| 「租户进程 → 网关」能力键 | `gateway/scheduler.mjs:16`（`schedulerEnvironment`）、`:62`（key→namespace→token） | 现成范式：租户拿随机键，网关换用户令牌 |
| 「MCP Streamable HTTP 透传」 | `gateway/photocraft.mjs:45-74,131` | 现成范式：头白名单、`mcp-session-id` 双向透传、SSE 不缓冲 |
| 「上游没装就静默降级」 | `gateway/weknora.mjs:119-151` | 现成范式：2s 探活、单飞、连续 3 次失败丢缓存、不硬编码假地址 |
| 地址注入 | `gateway/instances.mjs` 的 `env`（`VH_GATEWAY_PORT`、`schedulerEnvironment()`）、`gateway/addressing.mjs:51`（`GATEWAY_IP='127.0.0.1'`） | 租户进程经 `127.0.0.1:8080` 回连网关 |
| 客户端包分发 | `Dockerfile:141-148`、`gateway/plugins.mjs` 的 `syncClientPlugins` | `packages/client/*` 里有 `lib/client.js` 就被打进镜像并按目录名同步到租户层，**无名单需要维护** |
| 未发布包的挂载先例 | `ui-voffice`：`tsconfig.client.json:113` 有引用、carrier patch 有行、carrier `package.json` **不列依赖** | 面板应照此登记，避免 pnpm 把未发布包当 extraneous |
| Agent 侧 MCP | `packages/mcp/mcp-client/src/index.ts:119`（Config）、`transport.ts:41`（静态 `headers`）、`tools.ts:81`（`mcp__<server>__<tool>`） | 支持 `streamable-http` + 静态头；`failOnStartupError:false` 时连不上不阻塞启动 |
| patch 能力 | `docs/cordis-primer.md:39`（`config` 内可用 `!!js`）、`apps/cli/src/args.ts:170`（`--patch` 可重复） | 可用环境变量门控整行 |

## 1.3 MCPHub 侧契约

| 项 | 内容 |
|---|---|
| 内部地址 | `http://mcphub:3000/app/com.ictrek.mcphub`（`vos_default` 网络服务别名 + 容器端口 3000，`BASE_PATH` 由 MCPHub 自己保留，不 strip） |
| 存活 | `GET /health`（硬编码根路径，**不受 BASE_PATH 影响**），返回 `servers.total/connected/disconnected` |
| 身份 | `GET /api/integration/whoami` → `kind/sub/username/is_admin/application_id/scope` |
| 发现 | `GET /api/integration/discovery` → `data.mcp_path`、`data.servers[]`，每条只有 `name/description/visibility/status/mcp_path`；`mcp_path` 相对请求 origin |
| MCP | `POST/GET/DELETE /mcp`、`/mcp/{server}`、`/mcp/$smart`，接受 VOS 用户 token（`Authorization: Bearer` 或 `x-vos-token`） |
| 应用令牌 | app-context token 只允许进两个 integration 接口，且强制 `isAdmin:false`、仅 public |

## 1.4 本机实测（2026-11-09，本服务器）

在 v-harness 容器（`192.168.64.37`）内向 MCPHub 容器（`192.168.64.57`）实测：

| 检查 | 结果 |
|---|---|
| `getent hosts mcphub` | 解析到 `192.168.64.57` |
| `GET http://mcphub:3000/health` | 200，`{"status":"healthy","servers":{"total":1,"connected":1,"disconnected":0}}` |
| `GET .../api/integration/discovery`（无 token） | 401（前缀与路由正确，不是 404） |
| `POST .../mcp/$smart`（无 token） | 401 `invalid_token`（路由存在） |
| MCPHub 环境 | `BASE_PATH=/app/com.ictrek.mcphub`、`VOS_AUTH_ENABLED=true`、`USE_DB=false`、`MCPHUB_SETTING_PATH=/app/data/mcp_settings.json` |
| 已配置服务 | 仅 1 个：`amap`（stdio，`npx -y @amap/amap-maps-mcp-server`，`visibility: private`，owner `vos-admin-f81f12de873d`） |

三条结论：

1. **别名与端口假设成立**，内部地址不含任何机器相关 IP，换服务器不需要改配置。
2. **普通用户登录后面板是空列表**：唯一服务是 `private`。这正是「已安装但 0 个可见服务」状态必须与「未安装」分开的原因。
3. **Smart Routing 在这套部署里不可用**：`USE_DB=false`，而 `$smart` 依赖 PostgreSQL + pgvector。检索路径 `vectorSearchService.searchToolsByVector` 会先 `getRepositoryFactory('vectorEmbeddings')()` → `getAppDataSource()`，后者在 `db/connection.ts:159` 抛 `Database not initialized`，异常被该函数的 `catch` 吞掉后**返回 `[]`**。表现为「不报错、永远搜不到工具」。所以默认走 `/mcp`，`$smart` 只保留为可配置项。

## 1.5 关键约束

- **凭据边界**：VOS token 只存在网关内存（`office.mjs`），不写盘、不下发租户、不进浏览器。面板与 agent 都只认「网关自己的入口」。
- **不读应用 context 令牌**：`/var/lib/vos-context/access-token` 是应用身份，MCPHub 会把它降级为 public-only，等于屏蔽用户私有服务。本方案不挂该目录。
- **隔离**：每个租户一个 dsh 进程、一个 Linux 账号；能力键按 namespace 生成，网关按 key 定位用户，跨租户不可复用。
- **工具命名**：MCPHub 默认用 `-` 连接 server 与 tool，dsh 再加 `mcp__<serverName>__` 前缀；最终名如 `mcp__mcphub__amap-xxx`，超过 64 字符时 dsh 追加 12 位哈希，不影响调用。
- **隐藏优先于报错**：未安装的判定是 DNS 解析失败或连接拒绝，不是 404；不能把「没装」显示成「服务异常」。

---

# 二、方案设计

## 2.1 架构与三跳地址

```
浏览器（v-harness 页面）
  │  同源 GET /__vh/mcphub/services                  ← cookie 会话
  ▼
v-harness 网关 (127.0.0.1:8080)
  │  Authorization: Bearer <该用户的 VOS token>     ← accessTokenFor(namespace)
  ▼
MCPHub  http://mcphub:3000/app/com.ictrek.mcphub
       /api/integration/discovery
       /mcp  (Streamable HTTP)

租户 dsh 进程（agent）
  │  POST http://127.0.0.1:8080/__vh/mcphub/agent/mcp
  │  Authorization: Bearer <per-tenant 能力键>       ← 只有键，没有用户令牌
  ▼
v-harness 网关 → 同上
```

| 跳 | 地址 | 与机器无关的原因 |
|---|---|---|
| 面板 → 网关 | `/__vh/mcphub/*`（相对路径） | 同源 |
| 租户 → 网关 | `http://127.0.0.1:${VH_GATEWAY_PORT}/__vh/mcphub/agent/mcp` | 容器内回环 + 已注入端口 |
| 网关 → MCPHub | `http://mcphub:3000/app/com.ictrek.mcphub` | Docker DNS 别名 + 容器端口 |

## 2.2 配置

`ictrek.app/src/docker-compose.yml` 的 `x-v-harness-env` 增加一行，与 `IMAGE_STUDIO_BASE_URL`、`WEKNORA_URL` 同级：

```yaml
MCPHUB_URL: ${MCPHUB_URL:-http://mcphub:3000/app/com.ictrek.mcphub}
```

健康探测从该地址派生根路径（`new URL('/health', MCPHUB_URL)`），因为 MCPHub 的 `/health` 不带 BASE_PATH。不设 `172.17.0.1:1182` 之类的兜底地址：硬编码私有地址会把「没装」变成误导性的 503。

## 2.3 网关模块 `gateway/mcphub.mjs`

| 导出 | 行为 | 阶段 |
|---|---|---|
| `mcphubServices(namespace)` | `accessTokenFor(namespace)` → 转发 discovery；返回 `{available, authorized, servers, error?}`；上游条目逐字段重建，`url/command/env` 不可能漏出 | P0 已实现 |
| `mcphubEnvironment(namespace)` | 可达时返回 `{ VH_MCPHUB, VH_MCPHUB_ENDPOINT, VH_MCPHUB_KEY, VH_MCPHUB_ROUTING }`，不可达返回 `{}`；失败记 60s 负缓存，避免每次启动都付探测成本 | P0/P1 已实现 |
| `handleAgent(req, res, rest)` | MCP 透传：能力键换 namespace、方法白名单、路径白名单、头白名单、注入 `authorization`、`mcp-session-id` 双向透传、SSE 不缓冲 | P1 已实现 |
| `mcphubRouting()` | 读部署变量 `MCPHUB_ROUTING`，只认 `smart`，其余按 `all` | P2 已实现 |
| `mcphubTools(namespace)` | `GET /api/servers` → 只重建 `{ name, tools: [{ name, description, enabled }] }` | P2 已实现 |
| `mcphubSelection(ns)` / `saveMcphubSelection(ns, names)` | 读写 `STATE_ROOT/mcphub-selection.json`；`undefined` 表示跟随聚合端点 | P2 已实现 |
| `mcphubLaunchPatch({namespace, home, linuxName, jailHome, uid})` | 按选择生成 `<home>/.dsh/profiles/web/mcphub.patch.yml`，返回 `--patch` 路径与 `VH_MCPHUB_SELECT`；无选择则删除该文件 | P2 已实现 |

探测参数：每次尝试 1.2s 超时、最多 2 次（相隔 300ms，用来等兄弟容器起来）；成功结果缓存，连续 3 次上游失败后丢弃；`mcphubServices` 绕过负缓存取实时结果，`mcphubEnvironment` 复用最近一次结论。

路径拼接用 `new URL(data.mcp_path, new URL(MCPHUB_URL).origin)`：`mcp_path` 已含 `/app/com.ictrek.mcphub` 前缀，**不能**以带路径的 base 为基准，否则会拼成 `/app/.../app/...`。

## 2.4 面板 `packages/client/ui-mcphub`

文件与 `ui-plugin-manager` 同构：

```
package.json            @deepseek-ai/dsh-client-ui-mcphub，exports "./" + "./client"，dsh.client.platform = web
tsconfig.json           继承 ../../tsconfig.base.client.json
tsdown.config.ts        clientBundle(import.meta.dirname, ['lib/types/index.js'])
src/index.ts            export function apply(): void {}      ← 无 Host RPC，数据全走网关
src/client/index.ts     locale.register → main 注册 → sidebar.panellist 注册
src/client/face.ts      /__vh/mcphub/{services,tools,selection}，逐个字段校验
src/client/McphubPage.tsx + .module.css（页面状态用 React state，不引入 store）
src/client/McphubPanelIcon.tsx
src/client/locales.ts   zh（key 源）+ en + LocaleNamespaceMap 声明合并
locale/{zh,en}.json     文档站 meta
README.md / README.i18n.yaml
tests/*.client.spec.tsx
```

界面：

```
MCPHUB服务                                             [全部服务]  ● 已连接    [刷新] [打开 MCPHub]
──────────────────────────────────────────────────────────────────────
amap   高德地图 MCP   私有   运行中            [工具] [☑ 加入 Agent]
  amap-maps_geo     地理编码
  amap-maps_route   路径规划   已停用
──────────────────────────────────────────────────────────────────────
Agent 挂载方式  (全部服务) (仅选中的服务)   [保存选择]   选择在下一次启动工作区时生效
```

样式遵循 `docs/web-styling.md`：CSS Modules + `--dsw-alias-*` 语义 token，禁 Tailwind、禁字面颜色、禁组件库；文案只写在 `locales.ts`，受 `verify-client-ui-i18n` 约束。「打开 MCPHub」用 `target="_top"` 指向 `/#/app/com.ictrek.mcphub/mcphub`。

## 2.5 Agent 接入

carrier patch（`gateway/agent-plugins/vh-agent-plugins/cordis.patch.yml`）两行。门控变量是 **`VH_MCPHUB=1`**（网关注入），不是上游地址：租户进程不需要、也不应该知道 MCPHub 在哪。

```yaml
- id: ui-mcphub
  name: '@deepseek-ai/dsh-client-ui-mcphub'
  disabled: !!js "!process.env.VH_MCPHUB"

- id: mcp-mcphub                                  # P1
  name: '@deepseek-ai/dsh-mcp-client'
  disabled: !!js "!process.env.VH_MCPHUB || !!process.env.VH_MCPHUB_SELECT"
  config:
    transport: streamable-http
    serverName: mcphub
    url: !!js "process.env.VH_MCPHUB_ENDPOINT + (process.env.VH_MCPHUB_ROUTING === 'smart' ? '/$smart' : '/mcp')"
    headers: !!js "({ authorization: 'Bearer ' + process.env.VH_MCPHUB_KEY })"
    toolCallTimeoutMs: 120000
```

`serverName: mcphub` 固定，工具名即 `mcp__mcphub__*`。模式开关 `MCPHUB_ROUTING=all|smart`（网关注入为 `VH_MCPHUB_ROUTING`）默认 `all`；`smart` 需要 MCPHub 处于数据库模式并配好 embedding provider。

租户选了具体服务时，网关额外写一个 overlay（3.3.2）并注入 `VH_MCPHUB_SELECT=1`：聚合行被 `disabled` 摘掉，改由 overlay 里每服务一条 `mcp-client` 行接管，`serverName` 就是服务名，工具名变成 `mcp__<服务名>__*`。

## 2.6 隐藏与三态

| 判定 | 面板 | Agent 行 |
|---|---|---|
| `mcphub` 不可达（DNS/连接失败） | 不注册侧栏项（patch 行被 `disabled`），零请求 | 不挂载 |
| 可达但无可见服务（普通用户常见） | 显示空态 + 「在 MCPHub 中创建或共享」 | 挂载，工具为空 |
| 可达且有服务 | 正常列表 | 挂载，工具可用 |
| 可达但 token 失效 | 显示「登录已过期，请刷新页面」 | 调用返回明确的 401 文案 |

显隐以**网关启动前探活 + 环境变量门控**实现，因此装/卸 MCPHub 后需要重启该租户实例（面板侧已有「重启工作区」入口）。不采用客户端异步探测后再注册：仓库内 76 处 `ctx.slots` 注册全是同步的，没有延迟注册先例，为一个可省掉的重启引入未验证机制不划算。

## 2.7 安全与多租户

- 能力键每租户独立、32 字节随机、仅存网关内存；网关重启后失效，实例随重启重新拿到新键（P1）。
- `/__vh/mcphub/agent/*` **不认 cookie**，只认能力键；`/__vh/mcphub/services` 只认 `requireUser` 的会话。
- 上游请求固定只加 `authorization`，其余请求头按白名单转发，避免把浏览器 cookie、`x-vh-*` 带到 MCPHub。
- MCPHub 的可见性由它自己判定（`DataService.filterData`），v-harness 不做二次过滤，也不缓存服务列表到磁盘。

## 2.8 决策记录

| 决策 | 选择 | 理由 | 被否方案 |
|---|---|---|---|
| 令牌归属 | 网关持有 | 与 office/album/photocraft 一致；租户被控也拿不到令牌 | 下发租户；读应用 context 文件 |
| Agent 连接方式 | `dsh-mcp-client` + 网关能力键 | 复用重连、工具同步、错误规范，零新增协议代码 | 仿 `skill-photocraft` 自写 MCP 客户端走 unix socket |
| 工具暴露 | 默认 `/mcp`（all） | 本部署 `USE_DB=false`，`$smart` 静默返回空 | `$smart` 默认；面板逐服务勾选 |
| 显隐 | 网关探活 + 环境变量门控 | 零请求、零闪烁、无新机制 | 客户端延迟注册 |
| 面板数据源 | 只读 discovery | 文档化白名单接口；管理权留在 MCPHub | 把整个 dashboard API 代理给页面 |
| 服务启停（P3） | 面板 → 网关 → MCPHub 管理 API | MCPHub 在 VOS 模式下对 `/api/*` 全量认 VOS token 且自带 owner/isAdmin 钳制；网关只签名、白名单、重建响应 | 浏览器直连（无 token、跨域）；把 VOS token 下发到页面 |

---

# 三、实施计划

实施分三段：**P0 只读面板**、**P1 Agent 接入**、**P2 可选增强**。每段可独立上线、独立验收；P1 依赖 P0 的网关模块，P2 依赖 P1 的连接。

| 阶段 | 目标 | 交付 | 独立验收 |
|---|---|---|---|
| P0 | 让用户看见 MCPHub 里有什么，并正确隐藏 | 网关探活 + discovery + 面板 | admin 看到 `amap`；停容器后侧栏项消失 |
| P1 | 让 Agent 真的能调用 | 能力键代理 + mcp-client 行 | 对话中调用 `mcp__mcphub__amap-*` 成功 |
| P2 | 按需增强，不改变既有契约 | `smart` 开关、逐服务选择、工具预览 | 见各条前置条件 |

---

## 3.1 P0：网关探测与只读面板

### 目标

v-harness 左侧出现「MCPHUB服务」，点进去看到当前用户可见的 MCPHub 服务列表；MCPHub 未安装时该项不存在，且不产生任何请求或错误日志。

### 步骤（已落地）

1. `ictrek.app/src/docker-compose.yml`：在 `x-v-harness-env` 增加 `MCPHUB_URL: ${MCPHUB_URL:-http://mcphub:3000/app/com.ictrek.mcphub}`。
2. 新建 `gateway/mcphub.mjs`：`mcphubServices(namespace)` 与 `mcphubEnvironment()`，含 `/health` 探活（1.2s × 2 次）、60s 负缓存、上游条目逐字段重建。
3. 新建 `gateway/mcphub.test.mjs`：起假 MCPHub，覆盖可达/不可达切换、无 token、上游 401、字段不泄漏、负缓存复用，共 6 例。
4. `gateway/server.mjs`：`GET /__vh/mcphub/services`（`requireUser`，非 GET 返回 405）。
5. `gateway/instances.mjs`：`launch()` 里 `await mcphubEnvironment()` 并入 spawn env，与 `schedulerEnvironment` 并列。
6. 新建 `packages/client/ui-mcphub/`：`face.ts`、`McphubPage.tsx`、`McphubPage.module.css`、`McphubPanelIcon.tsx`、`locales.ts`、`tests/`、`README.md`；`main` 与 `sidebar.panellist` 各注册一次，`order: 20`。
7. `tsconfig.client.json`：`references` 加 `./packages/client/ui-mcphub`。
8. `gateway/agent-plugins/vh-agent-plugins/cordis.patch.yml`：面板行，`disabled: !!js "!process.env.VH_MCPHUB"`。
9. `scripts/verify-package-readme-model-experience.ts`：把新包登记为 `kind: 'none'` 并写明理由（Model Experience 门禁按 `packages/*/*/package.json` 全量扫描）。

### 改动文件

| 文件 | 动作 | 要点 |
|---|---|---|
| `ictrek.app/src/docker-compose.yml` | 改 | 一行 `MCPHUB_URL` |
| `gateway/mcphub.mjs` | 新增 | 探活 + discovery + `mcphubEnvironment` |
| `gateway/mcphub.test.mjs` | 新增 | 6 例，含探活与字段白名单 |
| `gateway/server.mjs` | 改 | `GET /__vh/mcphub/services` |
| `gateway/instances.mjs` | 改 | env 注入 `VH_MCPHUB` |
| `gateway/agent-plugins/vh-agent-plugins/cordis.patch.yml` | 改 | `ui-mcphub` 一行 |
| `packages/client/ui-mcphub/**` | 新增 | 见 2.4 |
| `tsconfig.client.json` | 改 | 加 package reference |
| `scripts/verify-package-readme-model-experience.ts` | 改 | 新包的 Model Experience 分类 |
| `pnpm-lock.yaml` | 改 | 新 workspace 包 |

### 验证

```bash
node --test gateway/mcphub.test.mjs        # 6 passed
node --test gateway/*.test.mjs             # 138 passed
tsc -b packages/client/ui-mcphub           # 类型通过
pnpm --filter @deepseek-ai/dsh-client-ui-mcphub run bundle
npx vitest run packages/client/ui-mcphub   # 6 passed
npx tsx scripts/run-oxlint.ts <改动文件>    # 0 warnings, 0 errors
pnpm run verify-client-ui-i18n             # 1107 files
pnpm run verify-client-packages            # 71 packages
pnpm run verify-client-route-resolution    # 本包无违规
npx tsx scripts/verify-package-readme-model-experience.ts  # 本包无违规
```

### 完成判据

- admin 登录后侧栏出现「MCPHUB服务」，列表含 `amap`、`private`、`running`。
- 停掉 MCPHub 容器并重启租户实例：侧栏项消失（bundle 未 mount），日志无报错。
- 普通用户登录：面板显示空态，不是错误态；接口返回 `{available:true, authorized:true, servers:[]}`。
- 登录失效：面板显示「VOS 登录状态已失效」，不是空列表。
- 面板打开期间不做任何写操作，也不缓存服务列表到磁盘。

---

## 3.2 P1：Agent 接入

### 目标

当前用户可见的 MCPHub 工具进入 Agent 的工具表，名字为 `mcp__mcphub__*`，调用时由网关以该用户的 VOS token 转发。

### 步骤

1. `gateway/mcphub.mjs`：能力键双向表（`namespace → key`、`key → namespace`），`mcphubEnvironment(namespace)` 返回 `{ VH_MCPHUB, VH_MCPHUB_ENDPOINT, VH_MCPHUB_KEY }`，每次启动换新键并退役旧键；MCPHub 不可达时仍只返回 `{}`。
2. 同文件加 `handleAgent(req, res, rest)` 与内部 `forward`：方法白名单（POST/GET/DELETE）、路径白名单（只允许 `/mcp` 及其子路径，`$smart` 也在此列）、请求头按名拷贝（`content-type`、`content-length`、`mcp-session-id`、`mcp-protocol-version`、`last-event-id`）、`accept` 强制含 `text/event-stream`、注入 `authorization`、响应只回放 `content-type`/`cache-control`/`mcp-session-id`/`mcp-protocol-version`、`setTimeout(0)` 保住 SSE、拒绝时 `req.resume()` 免得连接被重置。
3. `gateway/server.mjs`：`/__vh/mcphub/agent/*` 分支，**只认能力键**，不读 cookie。
4. `gateway/instances.mjs`：`mcphubEnvironment(record.namespace)` 的返回值并入 spawn env，与 `schedulerEnvironment` 并列，早于 `syncPlugins()`。
5. `gateway/agent-plugins/vh-agent-plugins/cordis.patch.yml`：`mcp-mcphub` 行，`transport: streamable-http`、`serverName: mcphub`、`url: !!js "process.env.VH_MCPHUB_ENDPOINT + '/mcp'"`、`headers: !!js "({ authorization: 'Bearer ' + process.env.VH_MCPHUB_KEY })"`、`toolCallTimeoutMs: 120000`；与面板同按 `VH_MCPHUB` 门控。
6. 打包：`gateway/agent-plugins/plugins.txt` 加 `packages/mcp/mcp-client`，carrier `package.json` 声明 `@deepseek-ai/dsh-mcp-client`。租户 profile 从 registry 装的 bundle 不含这个包，不加这两处，行会 import 失败——`scripts/stage-agent-plugins.ts:132` 就是为这种漏配准备的构建期断言。
7. 单测补齐：能力键缺失、只允许 MCP 路径、只允许 MCP 方法、session/protocol 头透传、已登出用户 401 `vos-token-unavailable`、上游 401 原样透传。

关于 `!!js` 的对象字面量：`vendor/loader/src/config/utils.ts:5` 用 `eval(expr)` 求值并对任意深度的 `!!js` 节点递归插值（`interpolate`），所以 `({ authorization: ... })` 这种带括号的对象表达式是合法的。

### 改动文件

| 文件 | 动作 | 要点 |
|---|---|---|
| `gateway/mcphub.mjs` | 改 | 能力键、`mcphubEnvironment(namespace)`、`handleAgent` |
| `gateway/mcphub.test.mjs` | 改 | 能力键、路径/方法白名单、头透传、401 透传用例 |
| `gateway/server.mjs` | 改 | `/__vh/mcphub/agent/*` 分支 |
| `gateway/instances.mjs` | 改 | env 合并 `VH_MCPHUB_ENDPOINT` + `VH_MCPHUB_KEY` |
| `gateway/agent-plugins/vh-agent-plugins/cordis.patch.yml` | 改 | `mcp-mcphub` 一行 |
| `gateway/agent-plugins/plugins.txt` | 改 | 加 `packages/mcp/mcp-client`，随镜像打进行囊 |
| `gateway/agent-plugins/vh-agent-plugins/package.json` | 改 | 声明 `@deepseek-ai/dsh-mcp-client` |

### 验证

```bash
node --test gateway/mcphub.test.mjs        # 13 passed（含 8 个 P1 用例）
node --test gateway/*.test.mjs             # 145 passed
```

端到端（需投放后）：重建租户实例 → 对话中让模型列出可用工具，确认存在 `mcp__mcphub__*` → 调用一次真实工具（`amap` 的路径规划）→ 确认 MCPHub 日志里的请求带的是该用户 token，且请求来自 `mcphub:3000`。

### 完成判据

- admin 会话中的工具表包含 `mcp__mcphub__*`，一次真实调用返回结果。
- 停掉 MCPHub：租户实例仍能正常启动与对话，工具缺失但不阻塞，日志只有 mcp-client 的重连记录。
- 通过能力键无法读到别人的服务：用 A 的键请求时，网关解析出的 namespace 只可能是 A。
- 网关重启后实例重启，键自动重建，工具恢复。

---

## 3.3 P2：可选增强（已实现）

三项互不依赖，按需挑选；每项都不得改变 P0/P1 已确立的对外契约（接口路径、工具名前缀、隐藏语义）。

### 3.3.1 `smart` 模式开关

前置条件：MCPHub 切到数据库模式（`USE_DB=true` + PostgreSQL/pgvector）并配置 embedding provider。

实现：网关读部署变量 `MCPHUB_ROUTING`（`all` 默认 / `smart`，其他值按 `all` 处理），经 `mcphubEnvironment()` 注入 `VH_MCPHUB_ROUTING`；`mcp-mcphub` 行按它拼 `/mcp` 或 `/mcp/$smart`。`/__vh/mcphub/services` 的答复带 `routing`，面板把它显示为头部徽标。门控留在部署侧而不是租户侧：租户能翻这个开关，就等于能在 JSON 模式 MCPHub 上把自己变成「一个工具都没有」。

### 3.3.2 逐服务选择

在面板选「仅选中的服务」并勾选，网关于启动时按选择生成 `<home>/.dsh/profiles/web/mcphub.patch.yml`，并在 launch args 追加 `--patch <该文件>`（`--patch` 可重复，见 `apps/cli/src/args.ts:170`）；每个选中服务一条 `mcp-client` 行，`serverName` 用服务名，`url` 指向 `VH_MCPHUB_ENDPOINT + '/mcp/' + name`，`authorization` 仍是 `!!js` 表达式。生成文件里不写能力键：键随每次启动重签，写进文件就会立刻过期。

- 覆盖文件必须写成**loader patch 列表**（顶层数组，行放在 `- insert:` 下面），不是 `plugins:` 插件树；空选择写 `[]`。写错形状启动器会直接拒绝该文件、工作区起不来——这一点由单测钉死。
- 选择存 `STATE_ROOT/mcphub-selection.json`（可用 `MCPHUB_SELECTION_FILE` 覆盖，单测用它），按 namespace 分键，写入走临时文件 + rename。
- 有选择时注入 `VH_MCPHUB_SELECT=1`，聚合行据此 `disabled`；选择被清空（`names: null`）时删除补丁文件、回到聚合端点。
- 服务名必须先过 `^[\w.$~%-]{1,128}$`：它同时是 URL 段和 YAML 标量，不过关的名字会被丢弃而不是转义。
- **重启生效**：`PUT /__vh/mcphub/selection` 的答复带 `restartRequired: true`，面板照此提示，不伪装成实时生效。

### 3.3.3 工具预览与面板动作

- 工具预览（已实现）：`GET /__vh/mcphub/tools` 带用户 token 读 MCPHub 的 `GET /api/servers`，只重建 `{ name, tools: [{ name, description, enabled }] }`。**不**在网关侧做 `initialize` + `tools/list`：那样看一眼工具就会开一次 MCP 会话、甚至唤醒 stdio 服务，代价和副作用都不该由「预览」承担。面板按行折叠展示，缓存一次答复。
- 重新探测：面板的「刷新」已经走 `upstream(true)` 绕过负缓存，等价于重新探测，不再单设按钮。
- 启停/重载后来进入了范围，见 3.3.4；仍然不做：通过面板创建、编辑、删除服务或修改可见性与凭据——它们涉及任意命令执行与凭据表单，MCPHub 自己的界面已有完整实现。

### 3.3.4 面板内启停/重载（P3，已实现）

面板的每行服务新增「启用/停用」「重载」两个动作，经网关转发到 MCPHub 自己的管理 API（`POST /api/servers/:name/toggle`、`POST /api/servers/:name/reload`）。

- **鉴权**：MCPHub 的 `auth` 中间件在 VOS 模式下对全部 `/api/*` 路由认 VOS 用户 token，网关用会话用户的 token 签名转发；能否操作某个服务（owner/isAdmin）由 MCPHub 自己判定，越权返回 404，网关原样透传。
- **白名单**：路径只放 `toggle|reload` 两个动作、服务名先过 `^[\w.$~%-]{1,128}$`；`toggle` 的 body 必须是 `{enabled: boolean}`，否则 400，不上游。跨站请求（`sec-fetch-site: cross-site`）拒绝。
- **生效**：MCPHub 自己同步关连接、异步广播 `tools/list_changed`，Agent 侧 `dsh-mcp-client` 自动同步——**不需要重启工作区**。成功后面板**静默**重读列表展示新状态（不出现读取态，也不重置未保存的挂载选择）；失败把 MCPHub 的 message 显示在该行下方。
- **影响面提示**：MCPHub 的服务连接是单实例共享的，一个人的启停对可见该服务的所有使用者立即生效——列表下方常驻一句说明，两个动作按钮的 `title` 同文案。
- **响应重建**：上游答复只保留 `message`；配置字段（`url`/`command`/`env`）不可能漏出，与 discovery 同一纪律。服务名解码在网关模块内完成，畸形编码（`%zz`）返回 400 `invalid-name`，不会以 500 冒充内部错误。

完成判据：

- 运行中的服务点「停用」→ 行状态变「已停止」，Agent 工具表同步收敛；「启用」后恢复。
- 普通用户对他不拥有的服务操作 → 行下方显示 MCPHub 的「Server not found」原话，不是误导性的成功。
- `delete`/`create` 等动作路径打不到网关（404），能力键路径（`/agent/*`）也打不到管理 API（既有 403 白名单不变）。

验证：

```bash
node --test gateway/mcphub.test.mjs        # 29 passed（P3 新增 7 例）
npx vitest run packages/client/ui-mcphub   # 14 passed（P3 新增 3 例）
```

### 完成判据

- 没有选择记录时与 P1 行为完全一致：走聚合端点，工具名 `mcp__mcphub__*`，不生成补丁文件。
- 面板选「仅选中的服务」→ 勾两个服务 → 保存 → 重启工作区：工具表只剩所选服务的 `mcp__<服务名>__*`。
- 再切回「全部服务」并保存 → 重启：补丁文件被删除，聚合端点恢复。
- 折叠某行工具能看到工具名与简介，被停用的工具带「已停用」；MCPHub 未安装的环境里这些交互不可达、无报错。
- `MCPHUB_ROUTING=smart` 时面板徽标显示「智能路由」，连接走 `/mcp/$smart`（真正可用仍需 MCPHub 的数据库模式）。
- 保存后文案明确写「重启工作区后生效」，不伪装成实时生效。

### 验证

```bash
node --test gateway/mcphub.test.mjs        # 19 passed（P2 新增 7 例）
node --test gateway/*.test.mjs             # 151 passed
npx vitest run packages/client/ui-mcphub   # 11 passed
tsc -b packages/client/ui-mcphub
pnpm --filter @deepseek-ai/dsh-client-ui-mcphub run bundle
npx tsx scripts/run-oxlint.ts <改动文件>    # 0 warnings, 0 errors
npx tsx scripts/verify-client-ui-i18n.ts   # 1107 files
```

### 改动文件

| 文件 | 动作 | 要点 |
|---|---|---|
| `gateway/mcphub.mjs` | 改 | `mcphubRouting`、`mcphubTools`、选择读写、启动补丁生成 |
| `gateway/mcphub.test.mjs` | 改 | 7 例：路由模式、工具预览字段白名单、选择落盘与补丁生成 |
| `gateway/server.mjs` | 改 | `/__vh/mcphub/tools`、`/__vh/mcphub/selection`（PUT 带跨站拦截） |
| `gateway/instances.mjs` | 改 | 启动补丁并入 `--patch`，`VH_MCPHUB_SELECT` 并入 env |
| `gateway/agent-plugins/vh-agent-plugins/cordis.patch.yml` | 改 | `url` 支持 `$smart`，聚合行在 select 下禁用 |
| `packages/client/ui-mcphub/**` | 改 | 路由徽标、工具折叠、挂载方式与保存 |
| `MCPHUB-PANEL.md` | 改 | 本节 |

---

## 3.4 通用约束与范围外

- 不修改 `ictrek.app/src/routers.yml`：那是 VOS 门户入口，不是应用内面板。
- 不修改 `packages/bundle/web-app/*`：面板行放在 v-harness 自己的 carrier 层。
- 不在 carrier `package.json` 声明未发布包：照 `ui-voffice` 先例，由 `gateway/plugins.mjs` 同步进租户 profile 层。
- MCPHub 未装时不显示安装引导；产品若要引导，归 VOS 应用商店层。
- 不在 v-harness 内编辑 MCPHub 的服务配置、可见性与凭据。P2 的选择记录是 v-harness 自己的状态，不下发、不改 MCPHub。
- 不支持应用 context 令牌（无用户的后台场景）调用 MCPHub。

## 3.5 风险与已知坑

| 风险 | 处理 |
|---|---|
| `mcp_path` 拼接错位 | 单测钉死：基准必须是 `new URL(MCPHUB_URL).origin` |
| MCPHub 的 `/health` 与 BASE_PATH 不同源 | 探活单独拼根路径 |
| SSE 长连接被网关空闲超时切断 | 参考 `photocraft.mjs` 的 `call.setTimeout(0)` |
| 停容器时租户实例启动慢 | 探活放 `Promise.allSettled`，失败只记日志 |
| 工具名超 64 字符被哈希 | 验收时按前缀识别，不依赖完整名 |
| `$smart` 被误开启 | 默认 `all`；开关注释写明前置条件（数据库模式 + pgvector） |
| 能力键随网关重启失效 | 键与实例生命周期绑定；重启实例即重建，面板提示「重启工作区」 |
| 选择里的服务被删或改名 | 该行连不上但 `failOnStartupError` 默认 false，只进重连日志，不阻塞启动；面板列表里它先消失，重选即可 |
| 补丁文件残留 | 每次启动按当前选择重写，无选择时删除；不需要手工清理，也不会在能力键轮换后留下旧键 |
| 服务名被写进 YAML | 名字必须先匹配 `^[\w.$~%-]{1,128}$`，不过关的直接丢弃，不做转义 |
