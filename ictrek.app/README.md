# v-harness VOS 应用说明

> VOS 应用标识为 `com.ictrek.v-harness`。

## 品牌资源

`assets/icon-master.png` 为确认的渐变圆角方形图标，`assets/mark.svg` 为透明底深色矢量标识。安装包图标通过 `node ictrek.app/scripts/gen-icon.mjs` 导出为 256×256 RGBA PNG（需要 ImageMagick）。镜像同时构建共享界面组件、动态插件及 Web 入口，将品牌覆盖应用于新用户和已有用户。原始版权和第三方许可声明保留。

## 应用形态

- 单容器：网关 + 每个用户一个 `dsh --profile web` 进程
- 网关负责 VOS OIDC Fastpath 免登录、会话、反代与实例生命周期
- 每用户独立 `vh-xxxxxxxx` OS 账号、独立 `DSH_HOME`、独立工作区
- 不用容器做用户隔离；隔离边界是 OS 账号 + 文件权限

## 插件安装

首次打开默认使用经典 Agent 界面。DS Bot 已预装，用户可在插件页启用，启用状态按用户保存。内置插件来自镜像中的固定版本。镜像构建时使用大陆镜像下载依赖和插件。运行时插件市场默认使用「全球」下载区域，标准 npm 安装使用官方源；用户可在插件市场设置中手动选择下载区域。

## VOS 认证

- `manifest.yml` 声明 `oauth2.client`（public client + PKCE S256）
- VOS 1.1+ 向同域 iframe 注入 `window.vos_platform.api.v1000.oauth2`
- 网关在无会话时返回 bootstrap 页面，由它静默完成 authorize/token 并 POST `/__vh/auth`
- 网关用 VOS `/v1000/oauth2/userinfo` 校验 token，然后签发自己的 `vh_session`

**注意**：VOS 的 userinfo 在 token 无效时同样返回 HTTP 200，body 是 `{"code":10001,...}` 错误信封。网关必须检查 `code`，不能只看状态码。

## 用户与数据

首次登录使用租户工作目录作为默认工作区的目录基准，不依赖容器中不存在的桌面 Documents/XDG 服务；已有工作区不改名或迁移。

镜像内置自媒体工作台 `dsh-media-desk@2.7.1` 和 IM 机器人 `@xmanrui/dsh-im@5.10.0`。网关在新用户首次启动、已有用户升级后首次启动时，将插件及其依赖声明同步到各自的 Web profile。镜像使用 DSH `0.2.2-rc.2` 作为运行时，定制组件从同步到同一上游版本的 fork 源码构建。操作入口见 [中文使用说明](src/README.zh-CN.md) 和 [English usage guide](src/README.en.md)。

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

Node 24 基镜像按架构上传到 ictrek SWR，标签为 `node:24-bookworm-slim-amd64` 和 `node:24-bookworm-slim-arm64`。

镜像：`swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-harness:<amd|arm>_YYYYMMDD`。当天重复构建更新同一标签，不添加自定义后缀。远端只构建通过 rsync 同步的本地代码，不执行 Git。

打包校验完整读取归档目录后再检查必需文件；外层归档必须仅包含 `app.tar.gz`。

两种架构的镜像均推送并写入飞书后，在本地运行 `./ictrek.app/scripts/update_version.sh`。版本前缀完全沿用根目录 `package.json` 中同步的官方版本，后缀按 `.vos.01`、`.vos.02` 递增；官方版本变化后重新从 `.vos.01` 计数。例如 `0.2.2-rc.1.vos.01`。可用 `--dry-run` 查看下一版本，原有 `patch` 参数仍可使用。打包与 CI 使用同一规则校验版本。GitHub Actions 从最新已发布 Release 解析 V-Scheduler 依赖版本，生成安装包并发布至 GitHub Release 和 VOS 应用商店；应用商店发布失败会令工作流失败。发布说明使用 fork 主线的提交记录，合并上游时保留同步提交和本地改动的发布记录。

发布前在构建机用独立容器运行 `scripts/verify_runtime.mjs`：将该文件只读挂载到容器并以 `node` 为入口，沿用 Compose 的 `SYS_ADMIN`、`SYS_PTRACE` 和 security_opt，不挂载真实 `/data`。它验证浏览器远程接口、真实租户实例启动、模拟 VOS 登录及首页反代；模型设置仍需在 VOS 页面选择并重新打开核验。

## 已知限制

- 模型统一在 V-Scheduler 中管理；设置页通过 VOS 应用抽屉跳转，保留平台身份上下文，并提供刷新及默认模型下拉框。推理沿用当前 VOS 用户身份。纯文本补全模型不支持工具调用。

## API 使用

「设置 → API 文档」内置 VOS OAuth2 登录、会话、任务和事件说明。[中文 API 文档](../gateway/pages/api-zh.md) · [English API reference](../gateway/pages/api-en.md)

## VOS 运维

打开「账号菜单 → 设置 → VOS 运维」，由当前 VOS 系统管理员点击「授权诊断」。每次授权持续 15 分钟，退出诊断可提前结束。其他角色会收到权限提示。

- 启动失败时先查看应用的状态、最近错误和 VOS 工作流，再打开相应主栈容器最近 150 行日志。日志上限 512 KiB，日志驱动不可读或响应超过上限时会报错。
- 输入宿主机端口，查找 Docker 发布端口对应的容器和协议。宿主机进程、host 网络监听和未发布的端口不在此列表内。
- 容器清单标明对应的应用版本。只有可识别、属于仍在本机安装的应用、版本与当前安装不同且已退出的主栈容器可清理。删除容器会移除其可写层，保留卷。带标签但没有容器引用的镜像仅供排查，只有无标签、无摘要且没有任何容器引用的镜像可清理。
- 重启应用或清理对象时，核对预览中的应用 ID、容器 ID 或镜像 ID，输入完整 ID 后确认。预览 60 秒内单次有效，目标发生变化时必须重新预览。重启由 VOS 执行，受理后会显示任务 ID。

如果要让 Agent 协助排查，新建会话并在输入区的权限菜单选择「完全访问（VOS 运维）」。保持该会话打开，在运维页授权时勾选「同时授权当前完全访问会话」。Agent 可在该会话中读取诊断信息，重启和清理仍在运维页确认。会话继续使用工作区沙箱。运维接口供此设置页和内置诊断工具使用，详细请求与响应见「设置 → API 文档」。Agent 会话 API 不提供运维操作。
