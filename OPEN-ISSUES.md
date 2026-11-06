# v-harness 部署未解决问题

记录日期：2026-11-06
环境：容器 `vos-app-com-ictrek-v-harness-01m6qmz5tdzrs3cngaehapchjr-v-harness-amd-1`，租户 `admin`（uid 20000），profile 为 `web`。

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

### 尝试过但未成功的方案

在网关侧新增 `GET|POST /__vh/restart` 端点，并往 dsh 返回的 HTML 中注入一个右下角「重启工作区」按钮：

- 注入函数本身可用：用真实页面验证，输出增加 1479 字节，包含 `vh-restart`。
- 但该按钮**从未在用户浏览器中出现过**；网关日志中没有任何注入记录。
- 已定位到的一个确定缺陷：dsh 首页返回 `Content-Encoding: gzip`，而原注入逻辑要求 `content-encoding` 为空才执行，导致注入被整段跳过。改为解压后再注入，但**未在真实登录会话中验证成功**。
- 该方案的全部代码改动已撤销，未保留。

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

## 问题二：网关下载的 gitea 服务访问不到租户的 dsh

### 现象

通过网关下载并部署的 gitea 服务，无法访问到租户自己的 dsh。

### 状态

**未调查**。没有收集日志、端口监听、网络命名空间或服务注册情况，暂无法给出原因。

### 相关线索

- 该租户的插件层中曾出现 `@goodandready/dsh-gitea`，安装后导致前端 boot 失败（`Failed to load plugins`，白屏）。已从 profile 的 `dsh.profile.bundles` 中移除，该插件与"服务访问不到 dsh"是否为同一问题尚未确认。
- 租户服务通过 `gateway/server.mjs` 的 `POST /__vh/services/<port>/restart|stop` 与 `/__vh/svc/<port>` 代理访问；gitea 是否走这条链路未验证。

---

## 其他已确认事实（供后续排查参考）

1. 租户 home 在容器内有两个名字：root / gateway 视角为 `/data/<account>`，租户 jail 视角为 `/home/<account>`。pnpm 在 `node_modules/.modules.yaml` 中记录 store 的绝对路径，两个视角不一致时会触发 `ERR_PNPM_UNEXPECTED_STORE`。当前 profile 的 `pnpm-workspace.yaml` 已固定 `storeDir` 为租户视角路径。
2. 插件目录源为 `https://awesome-dsh-plugin.com/plugins.json`（GitHub Pages）。在受限网络中访问超时，会导致市场一直显示"正在加载插件目录"。该线路的 npm 镜像源 `dsh-plugin-catalog` 可正常访问（腾讯云镜像约 0.67s）。
3. 租户 `profiles/node_modules`（共享层）与 `profiles/web/node_modules`（pnpm 管理）是两层；pnpm 只管理后者。
