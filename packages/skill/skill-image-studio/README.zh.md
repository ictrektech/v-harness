---
description: "随包提供的 Image Studio skill：本地文生图、编辑、视频生成与权重准备，通过零依赖 CLI 驱动。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-image-studio

[English](README.md) | 中文

## 概述

目录包含一个 Image Studio 路由，以及生成与模型准备两类 skill。生成和模型操作通过零依赖 Node CLI 完成：提交任务、轮询、下载产物、管理权重，全部走 Image Studio 的 HTTP API。凭据只存在于 CLI 读取的 auth 文件中，bearer 令牌不会进入模型上下文。当 tools、question 与 shell 服务都已挂载时，本包还会注册 `image_studio_generate`：先在同一个对话框里让用户确认模型与提示词，再调用同一个 CLI。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把提供方挂载到 skill 注册表与 `dsh-tool-skill` 旁。base bundle 声明了该行，但在部署指定端点或 auth 文件之前保持禁用，因此没有该服务的 profile 维持原有 skill 目录。

```yaml
- name: '@deepseek-ai/dsh-skill-image-studio'
  disabled: false
  config:
    baseUrl: http://image-studio-backend:5000
    authFile: /home/user/.config/dsh/image-studio.json
```

启用方式二选一：设置 `IMAGE_STUDIO_BASE_URL` 或 `IMAGE_STUDIO_AUTH_FILE`，或在 profile 行中显式 `disabled: false` 并给出 `baseUrl`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `assetRoot` | 打包的 `assets/` | 包含三个 skill 目录与 `scripts/` 的绝对目录。 |
| `node` | 宿主 Node.js | CLI 使用的独立 Node 可执行文件；打包载体需显式提供。 |
| `cli` | `assets/scripts/image-studio.mjs` | CLI 入口的绝对路径。 |
| `baseUrl` | `IMAGE_STUDIO_BASE_URL` 或网络内后端 | 后端源地址或 VOS 网关前缀。 |
| `authFile` | `IMAGE_STUDIO_AUTH_FILE` 或 `$XDG_CONFIG_HOME/dsh/image-studio.json` | 保存 `{ "baseUrl"?, "token"? }` 的 JSON 文件。 |
| `requestTimeoutMs` | `30000` | 单次 HTTP 请求超时。 |

auth 文件保存 VOS access token，由 CLI 在请求时读取：

```json
{ "baseUrl": "https://vos.example/api/com.ictrek.image-studio", "token": "<vos access token>" }
```

没有令牌时服务端把数据归入匿名桶：仍能生成图片，但无法使用按账户隔离的能力。非法 skill 资源、相对路径、非 http 端点以及缺失的可执行文件都会拒绝注册。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

提供方在注册时读取描述、按需读取正文，然后追加一段运行环境块，包含 Node 与 CLI 的绝对路径、解析后的端点与 auth 文件路径。注册表的优先级、作用域与调用权限对每个 skill 生效；销毁时注销全部候选项。

CLI 是零依赖 ESM 脚本。端点依次取自 `--base-url`、`IMAGE_STUDIO_BASE_URL`、auth 文件，最后回落到网络内默认地址；令牌依次取自 `--token-file`、auth 文件、`IMAGE_STUDIO_AUTH`。请求使用宿主 Node 的 `fetch`；下载以流写入工作区，二进制产物不经过文本工具。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 资源注册、配置校验、运行环境注入。 |
| [`assets/scripts/image-studio.mjs`](assets/scripts/image-studio.mjs) | 生成、轮询、下载、模型准备、参考图上传。 |
| [`assets/`](assets/) | 路由与两个子 skill。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [skill 注册表](../skill/README.zh.md)——发现与优先级。
- [skill 工具](../tool-skill/README.zh.md)——模型目录与加载正文。
- [Image Studio API 参考](https://github.com/ictrektech/image-studio)——端点、参数与模型注册表。

-----

<a id="model-experience"></a>
## 模型体验

两个面：tools、question 与 shell 服务都挂载时是 `image_studio_generate` 工具，否则经由 `dsh-tool-skill`：初始目录给出三条 Image Studio 摘要，`skill(name)` 返回路由或所选子 skill 的完整指令。工具只携带一个正向提示词、可选的模型与负向提示词，因此模型说明意图，其余参数由用户在对话框里确认。

#### KV Cache 影响

skill 结果追加到历史，不改变工具声明；操作结束后已加载的指令仍然保留。字符估算使用 `ceil(characters / 4)`：路由正文不超过 200 token，每个子 skill 不超过 700。运行环境块会在每个已加载 skill 中重复 Node、CLI、端点与 auth 文件路径；shell 声明、通用目录以及下载的图片或视频附件属于独立成本，这些估算不代表服务端用量。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- AI 相册（Immich）上传流程尚未包含在本包中。
- 生成任务在服务端排队；长视频任务可能运行约一小时。
- CLI 需要 shell 沙箱能够访问配置的端点。
- 模型下载按家族为 4–70 GB，由同一服务管理，不由本包处理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

None.

</details>
