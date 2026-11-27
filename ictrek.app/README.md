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

预装的 12 个插件及其版本由 [镜像配置](../gateway/agent-plugins/registry-plugins.json) 固定。用户在侧栏「插件」查看预装插件，在「设置 → 内置插件」检查运行状态。插件市场默认使用「全球」下载区域，标准 npm 安装使用官方源；可在插件市场设置中调整。OpenMotion、Billion Context、语音输入、自定义插件索引、自动授权审查和变更请求与工作树默认开启；仅 ModSearch 默认关闭。旧用户首次启动时移除 DS Bot 及其设置入口，保留插件数据。

## VOS 认证

- `manifest.yml` 声明 `oauth2.client`（public client + PKCE S256）
- VOS 1.1+ 向同域 iframe 注入 `window.vos_platform.api.v1000.oauth2`
- 网关在无会话时返回 bootstrap 页面，由它静默完成 authorize/token 并 POST `/__vh/auth`
- 网关用 VOS `/v1000/oauth2/userinfo` 校验 token，然后签发自己的 `vh_session`

**注意**：VOS 的 userinfo 在 token 无效时同样返回 HTTP 200，body 是 `{"code":10001,...}` 错误信封。网关必须检查 `code`，不能只看状态码。

## 用户与数据

首次登录使用租户工作目录作为默认工作区的目录基准，不依赖容器中不存在的桌面 Documents/XDG 服务；已有工作区不改名或迁移。

新用户首次启动和旧用户升级后首次启动时，网关将预装插件及其依赖同步到各自的 Web profile。DSH 运行时为 `0.2.2-rc.3`。操作入口见 [中文使用说明](src/README.zh-CN.md) 和 [English usage guide](src/README.en.md)。

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

- 「设置 → 模型」可选择 V-Scheduler 模型、添加第三方模型提供商或自定义模型 API。V-Scheduler 请求使用 VOS 身份，个人模型使用当前租户保存的凭据。V-Scheduler 是可选依赖。两类模型均可设为新会话默认模型。纯文本补全模型不支持工具调用。

## API 使用

「设置 → API 文档」内置 VOS OAuth2 登录、会话、任务和事件说明。[中文 API 文档](../gateway/pages/api-zh.md) · [English API reference](../gateway/pages/api-en.md)

## VOS 运维

打开「账号菜单 → 设置 → VOS 运维」，由当前 VOS 系统管理员点击「授权诊断」。每次授权持续 15 分钟，退出诊断可提前结束。其他角色会收到权限提示。

- 启动失败时先查看应用的状态、最近错误和 VOS 工作流，再打开相应主栈容器最近 150 行日志。日志上限 512 KiB，日志驱动不可读或响应超过上限时会报错。
- 输入宿主机端口，查找 Docker 发布端口对应的容器和协议。宿主机进程、host 网络监听和未发布的端口不在此列表内。
- 容器清单标明对应的应用版本。只有可识别、属于仍在本机安装的应用、版本与当前安装不同且已退出的主栈容器可清理。删除容器会移除其可写层，保留卷。带标签但没有容器引用的镜像仅供排查，只有无标签、无摘要且没有任何容器引用的镜像可清理。
- 重启应用或清理对象时，核对预览中的应用 ID、容器 ID 或镜像 ID，输入完整 ID 后确认。预览 60 秒内单次有效，目标发生变化时必须重新预览。重启由 VOS 执行，受理后会显示任务 ID。

VOS 系统管理员在会话里选择「完全访问（VOS 运维）」即可直接诊断。Agent 提出重启或清理时，会话里会显示具体目标并请管理员确认。会话继续使用工作区沙箱。支持的操作见「设置 → API 文档」。

## PGV 内置技能 / Built-in PGV skill

在同一台 VOS 启动 PGV 后，在会话中输入 `/pgv`。使用工作区已获授权的服务凭据。自定义 `VH_NET_ALLOW_HOSTS` 时，在允许 PGV 的部署中保留 `pgv,pgv-redis,pgv-viewer`。PGV 容器地址变动后需重新启动租户运行实例。接入说明见 [技能文档](../skills/pgv/SKILL.md)。

Start PGV on the same VOS device, then use `/pgv` with the workspace's approved service credentials. If you override `VH_NET_ALLOW_HOSTS`, include `pgv,pgv-redis,pgv-viewer` where PGV access is intended. Restart the tenant runtime after a PGV container address changes. See the [skill instructions](../skills/pgv/SKILL.md).

V-Scheduler 自动发现的 ModelInfer DeepSeek V4 对话模型支持在会话模型选择器设置「关闭」「低」「高」「最高」。默认「高」。沿用现有会话模型目录和 Chat Completions 端点，分别发送 `reasoning_effort: "none"` 或 `reasoning_effort: "high"`。

本版基于 DSH 0.2.3-alpha.2。预装 OpenMotion 本地应用 0.2.1 的 MCP/Skills 插件，默认开启。在「设置 → VOS 运维」查看节点与应用后端，并进入 V-Scheduler 节点管理或 Image Studio 部署界面。会话可使用内置 Image Studio 技能执行节点管理、后端部署和模型传输注册。文件持久化路径及完整流程见包内中英文 README。


## 默认开启的语音与实验功能

OpenMotion、Billion Context，以及「插件 → 已安装 → 实验性插件」中的语音输入、自定义插件索引、自动授权审查、变更请求与工作树均默认开启。ModSearch 保持默认关闭。

语音输入默认选择 **V-Voice · V-Scheduler**，复用 V-Voice 已启用的 ASR 模型，识别请求经过 V-Scheduler 的用户权限和资源调度；v-harness 发布镜像不包含本地 SenseVoice 插件及其 sherpa-onnx 原生依赖，不下载或装载本地识别模型。先安装并启动 V-Voice 与 V-Scheduler，在 V-Voice 准备 ASR 模型。然后在语音输入详情页允许麦克风、选择输入设备和识别语言，在会话输入区录音，结束后核对转写文字，再发送消息。服务未就绪时检查 V-Voice 模型和调度资源，再重试；登录过期时刷新 v-harness。升级会把原本地 SenseVoice 选择迁移至该服务，保留旧模型文件。

在「插件 → 已安装 → 语音输入」打开「识别服务 / 运算节点」下拉框。`V-Voice · V-Scheduler` 使用自动路由；带模型名和节点 ID 的 `V-Voice · <模型> · <节点>` 选项使用该节点已登记的部署和执行器。先由管理员在 V-Voice 准备后端与模型，点击「刷新运算节点」后再选择。选择按当前账号保存，录音开始时固定；节点失效或执行位置不匹配时本次识别失败，不切换到其他节点。刷新后重新选择可用项，再录音。节点功能要求配套版本通过 V-Scheduler 提供 `/api/v1/voice/compute/placements` 和 `/api/v1/voice/compute/transcriptions`；旧版只显示自动服务。

变更请求与工作树所需 Git、GitHub CLI (`gh`) 和 GitLab CLI (`glab`) 已随镜像安装。访问私有仓库仍需在当前租户中完成相应账号登录；开启自定义插件索引不会自动添加索引源。默认启用自动授权审查只使该访问模式可选，不会改变已有会话的访问模式。

语音转写使用已有 `speech/catalog`、`speech/configure`、`speech/prepare` 和 `speech/transcribe` Remote 协议，麦克风音频不会自动提交为 Agent 消息。公开会话 API v1 的路径、鉴权、请求和事件格式不变。

## OpenMotion 使用

使用步骤：

1. 在 v-harness 选择工作区，在「插件 → 已安装 → openmotion-dsh」确认开关开启；如有重启提示，按提示重启工作区。
2. 在对话里说「用 OpenMotion 打开模板库」或描述动画的主题、时长、画幅和风格。智能体调用插件后，点击它返回的预览/Studio 链接；仅打开插件详情页不会打开编辑器。预览链接仅供当前 VOS 账号访问；保留完整路径、参数和 # 片段，登录失效后刷新工作台再打开。 若回复只有纯文本路径，请让智能体返回可点击的 Markdown 链接，或从「服务」面板打开 OpenMotion。模板库与项目界面的资源和 API 均通过同一预览服务加载，刷新时保留原链接。
3. 在预览中检查画面和时间轴，在对话里提出修改；先预览，再确认导出。生成图片、视频、配乐或配音素材时，先按 OpenMotion 的引导配置相应供应商。
4. 确认后让智能体导出 MP4，把项目、素材和成片保存在工作区。项目目录为 `$HOME/workspace/OpenMotion`；从返回的文件链接下载或另行备份。

可直接复制：「用 OpenMotion 做一个 10 秒、16:9 的产品介绍动画，先用文字和几何图形，给我分镜和可打开的预览；等我确认后再导出 MP4，把项目和视频保存到工作区。」

v-harness 的安装清单只声明 V-Scheduler，不声明 V-Voice、Image Studio 或其他应用依赖。调用这些应用的 API 属于按需集成：未安装时仅对应功能不可用，不应阻止 v-harness 安装、升级或使用个人模型。此变更只调整安装约束，不改变功能 API 的请求和响应。
