# v-harness 部署未解决问题

记录日期：2026-11-06
环境：容器 `vos-app-com-ictrek-v-harness-01m6qmz5tdzrs3cngaehapchjr-v-harness-amd-1`，租户 `admin`（uid 20000），profile 为 `web`。
状态：两项均已实现并部署到该容器（`/opt/v-harness/gateway` 已更新并重启生效）；镜像尚未重建，正式发布需重新 build。

---

## 问题一：安装插件后必须重启 dsh，而界面上没有可用的重启入口

### 现象

1. 在插件市场安装插件后，部分插件不生效，需要重启 dsh 进程。
2. 安装过程中市场弹出红色错误：

   ```
   安装 dsh-video-skin    the market was unloaded before this operation finished
   安装 dsh-pet#dsh-pet   the market was unloaded before this operation finished
   ```

   但包实际上已经装好（`package.json` 与 `node_modules` 中均存在）。
3. 界面提示"1 项变更需重启 DeepSeek Harness 后生效"，但**没有任何可点击的重启入口**，用户必须手工执行命令才能重启。

### 已确认的原因

**为什么有些插件必须重启**

dsh 的热加载（`hmr`）只能热挂载"纯 insert"的 bundle patch。patch 中带配置或表达式时，界面给出的原因文案是：

> bundle patch 含配置/表达式，热挂载仅支持纯 insert；重启后由 bundle 层生效

这类插件在安装后处于"已保存、未挂载"状态，必须重启进程。

**为什么市场报"被卸载"，但包其实装好了**

安装结束后，dsh 会调用 `hmr.reconcileProfile()` 重组插件树。这次重组把市场自身（`dshmarket`）卸载并重新挂载，而市场此时还在等待自己发起的安装请求返回，于是把它标记为取消：

- 报错来源：`dshmarket/lib/drain.js`，错误码 `MARKET_UNLOADED`
- 触发链路：`packages/boot/plugin-manager/src/index.ts` → `publishAndReload()` → `reload()` → `hmr.reconcileProfile()`

已实测排除的因素：pnpm 安装**不会**替换市场目录（`pnpm add` / `pnpm remove` 前后 `dshmarket/lib/index.js` 的 inode 不变）。

### 已实现（2026-11-06）

1. `gateway/shell-inject.mjs` 把右下角「重启工作区」按钮注入 dsh 的 shell 文档；点击后确认、POST `/__vh/restart`、成功后 `location.reload()`，走的是新挂载的插件树。
2. `gateway/server.mjs` 新增 `POST /__vh/restart`：`requireUser` 鉴权 + 拒绝 `sec-fetch-site: cross-site`，随后 `stopInstance` → `ensureInstance` → `startCapabilities`，返回 `{ ok: true, port }`。
3. 文档响应压缩不再让注入失效：`injectable` 现在接受 `gzip`/`deflate`/`br`，先解压再注入并去掉 `content-encoding`；无法解码的编码原样透传，宁可少注入也不吞文档。注入只对导航文档生效 —— 被 `fetch` 当数据取走的 HTML 有它自己的主人，往里面塞桥接会改写主人的请求。
4. `gateway/instances.mjs` 的 `reclaimPort` 增加升级：SIGTERM 等待 5s 仍未释放端口时发 SIGKILL。实例是各自 pid 命名空间的 init，**只接受自己装了处理函数的信号**，一个卡住的 dsh 能一直占着端口，这正是历史日志里 `reclaiming port 3101` 反复失败的直接原因。
5. 开发模式（`VH_AUTH_DISABLED=1`）不再强制走 VOS 引导页，否则脱离平台的调试连 shell 文档都拿不到。

验证方式：容器内另起一个 `VH_AUTH_DISABLED=1` 网关（8099）+ 桩实例，实测：
- 文档 200，注入命中（`vh-restart`、桥接脚本）；
- 上游 gzip 压缩时同样注入成功；
- `POST /__vh/restart` 返回 `{"ok":true,"port":3103}`，重启后文档仍正常；
- 故意留一个忽略 SIGTERM 的"卡死"实例占住端口，重启仍成功（日志出现 SIGKILL 升级记录）。
- 单测：`node --test gateway/shell-inject.test.mjs`（含 vm 沙箱里跑桥接脚本的用例）。

**待确证**：真实登录会话（VOS token）下浏览器中按钮的观感与位置，需要用户在平台页面上点一次确认。

### 明确不建议的做法

**不要通过 profile 的 `cordis.patch.yml` 关闭 `hmr`：**

```yaml
- id: hmr
  disabled: true
```

这样写会让 dsh 实例启动失败，gateway 陷入无限重启循环，日志表现为：

```
instance launch: reclaiming port 3101 from pid 232 (admin)
upstream 3101 failed: socket hang up
```

此时页面只能显示浏览器缓存中的旧内容，所有请求都是 502。

### 需求约束

必须是**用户可点击的按钮**。自动重启、让用户手工输入 URL、让用户执行命令，均不接受。

---

## 问题二：插件自带的服务端路由（如 `/dsh-gitea/config`）在平台上 404

### 现象

从官方市场安装的插件，如果自带 HTTP 服务端路由（例如 `@goodandready/dsh-gitea` 的 `/dsh-gitea/config`），插件前端按绝对路径请求 `https://<平台地址>/dsh-gitea/config`，得到 **404**，请求根本没到 dsh。

### 根因（已确认）

`ictrek.app/src/docker-compose.yml` 里，本应用的 Traefik 路由只有两类：

- `PathPrefix('/app/com.ictrek.v-harness')` → 应用容器（带 `stripprefix`）；
- 根路径白名单：`/api`、`/plugins`、`/assets`、`/__vh`、`/favicon.ico`（用 `Referer contains /app/com.ictrek.v-harness/` 绑定到本应用）。

因此插件注册在 dsh 上的任意其它路径（`/dsh-gitea/...`）在根上**不匹配任何路由**，落到平台自己的 Web 服务 → 404。网关本身对所有路径都转发（`proxyRequest` 无路径白名单），问题完全在入口路由。

### 已实现（2026-11-06）

在 dsh 的 shell 文档里注入"URL 桥"（`gateway/shell-inject.mjs`，与重启按钮同一个注入点，安装脚本前执行）：

- 打补丁：`fetch`、`XMLHttpRequest.open`、`WebSocket`、`EventSource`、`navigator.sendBeacon`；
- 规则：`/` 开头的同源绝对路径，若不在 `APP_BASE_PATH` 下、也不在入口已路由的根白名单（`/__vh`、`/api`、`/plugins`、`/assets`、`/favicon.ico`、`/app`）里，就前缀成 `/app/com.ictrek.v-harness<path>`；跨源请求原样放行（插件连自己的 Gitea 服务器不受影响）；
- 结果：插件无需知道自己被挂在哪里，`/dsh-gitea/config` 自动变成 `/app/com.ictrek.v-harness/dsh-gitea/config`，经应用路由 → `stripprefix` → 网关 → dsh，命中插件路由。

不用改 `ictrek.app` 的 Traefik 标签，也不需要为每个插件加白名单（那不可维护）。

### 未覆盖

- 插件的**页面级跳转**（`location.href = '/dsh-gitea/...'`、表单提交、`<a>` 链接）不走上面的补丁，仍会 404；这类入口如需支持，要在 Traefik 侧加白名单或改成相对路径。
- 从外部（另一个容器、Gitea 的 webhook 回调）打进租户 dsh 的请求依旧不可达，那是入口拓扑问题，不是本补丁的目标。

---

## 问题三：实例启动瞬间被判死，触发“起一个杀一个”的重启风暴

### 现象

- 网关日志连续出现 `instance launch: reclaiming port 3101 from pid N (admin)`，每次 pid 都是新的，几十秒内十几次；
- 页面里的插件（如 Gitea 设置页）报 `Cannot read properties of null (reading 'baseUrl')`：请求拿到 401/错误 JSON，`data.config` 为空。

### 根因（已确认）

`instances.mjs` 的 `exchangeCookie` 只发一次请求。dsh 从 listener 回调里打印 `dsh web: http://.../?token=`，但那一刻 socket 还不一定接受连接，首次 dial 会 `ECONNREFUSED` / `socket hang up`。交换失败 → `child.kill('SIGTERM')` → 下一个排队请求再 launch → `reclaimPort` 把上一个还没退出的实例 SIGKILL 掉。一个“本来会成功”的启动被自己掐死，并发请求越多循环越久。

注意：`reclaimPort` 里 SIGTERM 超时升级 SIGKILL 本身是对的（pid 命名空间 init 只接受自己装了处理函数的信号），它只是把循环从“卡住不动”变成“快速重来”。

### 已实现（2026-11-06）

- `exchangeCookie` 拆成单次 `exchangeOnce` + 重试循环：只对**没送达 dsh** 的错误（`ECONNREFUSED`/`ECONNRESET`/`EHOSTUNREACH`/`ENETUNREACH`/`EPIPE`/`ETIMEDOUT`、`socket hang up`）重试，250ms 间隔、总预算 15s；收到非 303 说明 launch token 已被消费，立即失败不重放。
- 新增 `gateway/instances.test.mjs`：晚 600ms 才监听的服务端可被重试到；401 不重放（只打一次）；303 无 cookie 直接报错。
- 容器实测：重启网关后启动次数 94 → 95（只一次），`reclaiming port` 0 次（修复前 12 次），40s 内无新增；`/dsh-gitea/config` 带 cookie 返回 200。

## 其他已确认事实（供后续排查参考）

1. 租户 home 在容器内有两个名字：root / gateway 视角为 `/data/<account>`，租户 jail 视角为 `/home/<account>`。pnpm 在 `node_modules/.modules.yaml` 中记录 store 的绝对路径，两个视角不一致时会触发 `ERR_PNPM_UNEXPECTED_STORE`。当前 profile 的 `pnpm-workspace.yaml` 已固定 `storeDir` 为租户视角路径。
2. 插件目录源为 `https://awesome-dsh-plugin.com/plugins.json`（GitHub Pages）。在受限网络中访问超时，会导致市场一直显示"正在加载插件目录"。该线路的 npm 镜像源 `dsh-plugin-catalog` 可正常访问（腾讯云镜像约 0.67s）。
3. 租户 `profiles/node_modules`（共享层）与 `profiles/web/node_modules`（pnpm 管理）是两层；pnpm 只管理后者。
