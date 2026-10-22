# v-harness VOS 应用说明

> VOS 应用标识为 `com.ictrek.v-harness`。

## 应用形态

- 单容器：网关 + 每个用户一个 `dsh --profile web` 进程
- 网关负责 VOS OIDC Fastpath 免登录、会话、反代与实例生命周期
- 每用户独立 `vh-xxxxxxxx` OS 账号、独立 `DSH_HOME`、独立工作区
- 不用容器做用户隔离；隔离边界是 OS 账号 + 文件权限

## VOS 认证

- `manifest.yml` 声明 `oauth2.client`（public client + PKCE S256）
- VOS 1.1+ 向同域 iframe 注入 `window.vos_platform.api.v1000.oauth2`
- 网关在无会话时返回 bootstrap 页面，由它静默完成 authorize/token 并 POST `/__vh/auth`
- 网关用 VOS `/v1000/oauth2/userinfo` 校验 token，然后签发自己的 `vh_session`

**注意**：VOS 的 userinfo 在 token 无效时同样返回 HTTP 200，body 是 `{"code":10001,...}` 错误信封。网关必须检查 `code`，不能只看状态码。

## 用户与数据

| 路径 | 用途 |
|---|---|
| `/data/users.json` | 用户表（subject、namespace、uid、端口） |
| `/data/users/<namespace>/` | 该用户全部数据，0700，属主 `vh-xxxxxxxx` |
| `/data/users/<namespace>/.dsh/` | `DSH_HOME`：profile、会话、凭据 |
| `/data/users/<namespace>/.agents/` | `DSH_AGENTS_HOME`：skills、AGENTS.md |
| `/data/users/<namespace>/workspace/` | agent 工作根，预置 `日常/` |
| `/data/logs/<namespace>.log` | 该实例的 stdout/stderr |

目录名来自 `sha256('vos-oidc\0' + sub)`，**不是用户名**：两个 VOS 账号可能解析成同一个显示名。

`uid` 与端口在首次登录时分配并写入 `users.json`，之后不再变化。容器重建后 `entrypoint` 会按表重建 OS 账号，volume 里的文件因此不会变成无主文件。

## 安装配置

- `VOS_OIDC_USERINFO_URL`：VOS userinfo 地址，默认 `http://172.17.0.1:8105/v1000/oauth2/userinfo`
- `SESSION_TTL_MS`：网关会话有效期，默认 12 小时
- `V_HARNESS_MEM_LIMIT` / `V_HARNESS_CPU_LIMIT`：整个容器的资源上限

## 构建与发布

```bash
V_HARNESS_SOURCE_REVISION=<本地提交完整 SHA> ./build_image.sh --target amd --sheet AMD_with_cuda
V_HARNESS_SOURCE_REVISION=<本地提交完整 SHA> ./build_image.sh --target arm --sheet ARM_with_cuda
./build_image.sh --dry-run             # 只看计划
./build_image.sh --no-feishu           # 不写飞书
```

镜像：`swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-harness:<amd|arm>_YYYYMMDD`。当天重复构建更新同一标签，不添加自定义后缀。远端只构建通过 rsync 同步的本地代码，不执行 Git。

两种架构的镜像均推送并写入飞书后，在本地运行 `./ictrek.app/scripts/update_version.sh patch`。GitHub Actions 从最新已发布 Release 解析 V-Scheduler 依赖版本，生成安装包并发布至 GitHub Release 和 VOS 应用商店；应用商店发布失败会令工作流失败。

## 已知限制

- 模型统一在 V-Scheduler 中管理；设置页提供跳转、刷新及默认模型下拉框，推理沿用当前 VOS 用户身份。纯文本补全模型不支持工具调用。
- 每用户一份 pnpm store 与 `node_modules`，磁盘按「用户数 × 插件体积」预算。
- 容器内 `dsh` 首次启动要 `pnpm install` profile bundles，首登会慢若干秒。
