# v-harness API v1

用 VOS 账号从脚本创建会话、提交任务并读取结果。API 会话使用该账号的 v-harness 工作区和「设置 → 模型」中选定的默认模型。使用前请在 V-Scheduler 配置该账号可用的模型。能进入 v-harness 的普通 VOS 账号即可调用。

## 获取 VOS 访问令牌

访问同一台 VOS 设备的 `https://<vos-host>:1180/v1000/oauth2/.well-known/openid-configuration`。外部集成使用 VOS 管理员注册的 OAuth2 客户端和回调地址。嵌入 v-harness 的集成可以使用安装时注册的公开客户端 `com.ictrek.v-harness`。

1. 生成随机 `state` 和 43–128 个 URL 安全字符的 PKCE verifier。对 verifier 求 SHA-256，再用无填充 Base64URL 编码得到 challenge。
2. 在浏览器打开发现文档的 `authorization_endpoint`，相对地址以 VOS 源站为基准。传入 `client_id`、已注册的 `redirect_uri`、`response_type=code`、`scope=openid profile email`、`state`、`code_challenge` 和 `code_challenge_method=S256`，登录 VOS 并完成授权。
3. 核对回调的 `state`。向 `token_endpoint` 提交表单 POST，传入 `grant_type=authorization_code`、回调 `code`、`client_id`、相同的 `redirect_uri` 和 `code_verifier`。机密客户端按其注册方式认证客户端身份。读取返回的 `access_token` 和有效期 `expires_in`（秒）。
4. 访问令牌过期后，如果平台发放了刷新令牌，向同一端点提交表单 `grant_type=refresh_token`、`client_id` 和 `refresh_token`。保存更新的刷新令牌。没有刷新令牌时重新走浏览器授权。

每次调用 v-harness API 都带上 `Authorization: Bearer <access_token>`。网关逐次请求 VOS UserInfo，并根据校验后的账号 subject 选择租户。会话和工作区 ID 均归该账号所有。使用 HTTPS，令牌放在请求头，避免写入 URL 和日志。

## 提交任务

VOS 基地址为 `https://<vos-host>:1180/app/com.ictrek.v-harness/__vh/api/v1`。单独对外提供的 v-harness 网关用其源站加 `/__vh/api/v1`。响应均为 JSON。POST 需要 `Content-Type: application/json`，请求体上限为 8 KiB，包含 JSON 编码开销。

```bash
BASE='https://<vos-host>:1180/app/com.ictrek.v-harness/__vh/api/v1'
# 将通过 OAuth 换得的访问令牌写入环境变量 VOS_ACCESS_TOKEN。
SESSION=$(curl -fsS "$BASE/sessions" -H "Authorization: Bearer $VOS_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq -er .sessionId)
REQUEST_ID=$(uuidgen)
curl -fsS "$BASE/sessions/$SESSION/prompts" -H "Authorization: Bearer $VOS_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg id "$REQUEST_ID" --arg text '总结这个工作区的用途。' '{requestId:$id,text:$text}')"
curl -fsS "$BASE/sessions/$SESSION/events" -H "Authorization: Bearer $VOS_ACCESS_TOKEN"
```

每隔几秒读取一次事件。在新会话中每次提交一条任务，先等待与请求 ID 对应的 `prompt-recorded`，再等 `turn-ended`。按序号读取该轮的 `assistant-text`。需要交互时，可以在 v-harness 界面打开该会话继续。客户端断开后，已接收的任务仍可运行。

## 请求和响应字段

| 方法和路径 | 输入 | 成功响应 |
| --- | --- | --- |
| `POST /sessions` | JSON 对象。可选 `workspaceId` 选择当前账号的已有工作区。发送 `{}` 使用部署默认会话目录。 | `201 {"sessionId":"session-…"}`。每次成功创建一个新会话。 |
| `POST /sessions/{sessionId}/prompts` | 必填字符串 `requestId` 和非空白字符串 `text`。任务进入会话队列。 | `202 {"requestId":"…","accepted":true}`。提交结果不确定时，用同一请求 ID 和文本重试。 |
| `GET /sessions/{sessionId}/events` | 可选整数 `throughSeq`（含该序号，最小 −1，默认当前日志末尾）和 `beforeSeq`（不含该序号，最小 0，默认该日志切点末尾）。二者均为安全整数。 | 空日志返回 `200 {"cursor":-1,"beforeSeq":null,"events":[]}`。`cursor` 是含该序号的日志切点。非空的 `beforeSeq` 用于翻到更早的一页。 |

ID 区分大小写，允许 1–128 个 ASCII 字母、数字、下划线或连字符。可选字段省略时使用表中的默认值。未知字段、未知查询参数、显式 null 和空 ID 均拒绝。每页最多覆盖 50 条用户或助手消息以及关联记录。向前翻页时把返回的 `cursor` 作为 `throughSeq`，并传入返回的 `beforeSeq`。实时轮询时省略二者，按 `seq` 去重。筛选后 `events` 可能为空，同时仍有更早的一页。

事件按时间顺序返回。每项都有 `seq`（从零开始的日志序号）、`time`（Unix 毫秒）和 `type`。

| 类型 | 额外字段 |
| --- | --- |
| `prompt-recorded` | 字符串 `requestId`。任务已写入持久日志。 |
| `assistant-text` | 整数 `turn` 和字符串 `text`。一条已提交助手消息的文本。 |
| `turn-ended` | 整数 `turn` 和 `outcome`。`completed` 正常完成，`aborted` 已取消，`blocked` 在策略或交互边界停止，`error` 失败，`max-tokens` 达到输出上限，`interrupted` 进程中断后补记结束，`forked` 在分叉处关闭，`other` 为插件定义的结果。 |

API 轮询返回已提交文本。工具事件、附件和逐字输出可在会话界面查看。

## 错误和重试

错误响应包含一个字符串字段 `error`，例如 `{"error":"invalid-token"}`。405 响应的 `Allow` 给出可用方法。

| HTTP | 错误 | 处理 |
| --- | --- | --- |
| 400 | `invalid-request` | 检查 JSON 字段、ID 和分页参数。 |
| 401 | `invalid-token` | 刷新或重新授权 VOS 账号，再重试。 |
| 404 | `route-not-found`、`resource-not-found` | 检查路径，或使用当前账号拥有的 ID。 |
| 405 | `method-not-allowed` | 使用 `Allow` 指定的方法。 |
| 409 | `session-busy` | 等会话可用，再用同一请求 ID 重试任务。 |
| 413 | `body-too-large` | 缩小 JSON 请求体。 |
| 415 | `json-required` | 设置 `Content-Type: application/json`。 |
| 422 | `operation-rejected` | 在 v-harness 打开会话，检查工作区和模型设置。 |
| 500 | `internal` | 查看网关健康状态或联系管理员。 |
| 502 | `identity-unavailable`、`controller-unavailable` | 检查 VOS UserInfo 或租户会话控制器，再退避重试。 |
| 503 | `instance-unavailable` | 等待租户启动，再退避重试。 |
| 504 | `controller-timeout` | 内部 RPC 超过 30 秒。重试前先检查会话。 |

VOS UserInfo 请求超时为 8 秒。冷启动可能在调用会话控制器前额外等待，请为客户端预留启动时间。创建会话超时后，先到界面确认是否已创建，再决定是否重试。

## VOS 运维入口

从「设置 → VOS 运维」使用。以下是设置页的浏览器接口，路径基址为同源 `/__vh/vos-ops`，也可加 VOS 应用前缀 `/app/com.ictrek.v-harness`。使用当前 VOS 登录派生的 v-harness 会话 Cookie，每次请求都向 VOS 校验 `system_admin`。请求带 `X-VH-Ops: 1`，除授权外还需 `X-VH-Ops-Grant`。POST 请求使用 JSON 对象，响应均为 JSON，禁止缓存。没有跨域接口和 Agent Bearer 入口。

| 方法与路径 | 输入和输出 |
|---|---|
| POST /authorize | 请求 `{}`。返回 `grant`（不透明字符串）及 `expiresIn: 900`（秒），并替换同一会话的先前授权。 |
| POST /close | 请求 `{}`。撤销此授权及其待确认操作，返回 `closed: true`。 |
| GET /inventory | 无参数。返回 `apps`、`containers`、`publishedPorts`、`unusedImages`、`unreferencedTaggedImages` 五个数组，无结果时为空数组。 |
| GET /status | 必填查询参数 `id` 为应用 ID，最多 128 字符，字母或数字开头，其余还可用点、下划线和连字符。返回 `appId`、`version`、`state`、`lastError` 和 `workflow`。 |
| GET /logs | 必填查询参数 `id` 为 64 位小写十六进制完整容器 ID。返回 `id` 和 `text`，后者为最近最多 150 行 UTF-8 日志，含时间戳，原始响应上限 512 KiB。 |
| POST /preview | 必填字符串 `action` 和 `id`。支持 `restart`（应用 ID）、`remove-container`（完整容器 ID）、`stop-container`（完整容器 ID）、`remove-image`（`sha256:` 加 64 位小写十六进制）。返回 `confirmation`（不透明字符串）、`expiresIn: 60`、`action`、`targetId`、`target`（相应清单条目）。每个授权同时只有一个预览。 |
| POST /execute | 必填字符串 `confirmation` 和 `targetId`。核对具体对象后提交预览中的确认码和完整 ID。返回 `action`、`id` 和 `taskId`（重启任务 ID，清理时为 null）。受理重启后可重新查看应用状态。确认码单次使用，失败后应重新查看状态及预览。 |
| GET /proposal | 查询参数 `sessionId` 为会话 ID。返回 `proposal`（无待确认操作为 null，否则包含 `action`、`targetId`、`target` 和 `confirmation`）。 |
| POST /confirm-proposal | 查询参数 `sessionId`。请求体含 `confirmation`、布尔 `approved`，确认时还需 `targetId`。返回同 /execute，取消时返回 `cancelled: true`。 |

`apps` 条目字段为字符串 `appId`、`installationId`、`version`、`state`、`lastError`（无错误为空字符串）。VOS 应用状态为 `not_installed`、`installing`、`installed`、`stopping`、`stopped`、`starting`、`upgrading`、`uninstalling`、`uninstalled`、`restarting`、`error`；按平台原值显示。可重启 `installed` 的其他应用，VOS 可拒绝不允许的状态。状态响应的 `workflow` 可为 null；否则包含字符串 `taskId`、`status`、`failure`（无失败为空字符串）及字符串或 null 的 `stage`。工作流状态为 `Running`、`Completed`、`Failed`、`Cancelled`、`Terminated`、`TimedOut`、`ContinuedAsNew`。

`containers` 条目包含字符串 `id`、`name`、`image`、`imageId`、`state`、`status`，以及布尔 `cleanup`、`stack`（字符串 `appId`、`version`、`project`）和 `ports` 数组。容器状态取 Docker 原值，清理接受 `created` 或 `exited` 且归属与版本通过复核。端口条目包括数字 `hostPort`、`containerPort`，字符串 `protocol`（Docker 的 tcp、udp、sctp 值）、`address`。全机 `publishedPorts` 还带容器名称 `container` 和字符串或 null 的 `appId`。

无标签镜像条目包括字符串 `id`、数字 `created`（Unix 秒）和 `bytes`（字节）；带标签镜像条目以字符串数组 `tags` 代替 `created`，仅供查看。容器清理不移除卷，镜像清理不会强制删除或清理父层。

错误响应为 `{"error":"<code>"}`。400 为 `invalid-body`、`invalid-target` 或 `confirmation-mismatch`，请核对 JSON、操作和完整 ID；401 `sign-in-required` 请重新登录；403 `forbidden` 请检查角色、浏览器同源请求和有效授权；404 `not-found` 请刷新；409 `target-changed` 请刷新和重新预览；429 `too-many-grants` 请等待授权到期；502 `vos-request-failed`、`docker-unavailable`、`response-too-large` 或 `upstream-unavailable` 表示上游拒绝、不可用或返回超限，请检查 VOS 或 Docker 状态。重启受理与完成是两个阶段，超时后先刷新应用状态再决定是否重试。

内置工具 `vos_diagnostics` 支持 `inventory`、`status`、`logs`、`propose`。后三项需字符串 `id`，格式同表；`propose` 另需 `action`。返回诊断 JSON 文本，最长 49,152 字符。VOS 系统管理员选择 `vos-full-access` 即可使用。会话确认接口无需设置页授权头；`sessionId` 是当前租户的会话 ID，1–128 个字母、数字、下划线或连字符。每个会话最多一个待确认提议，120 秒有效，已有提议时返回 409 `confirmation-pending`。

在 DS Bot 中打开「设置 → 模型」。「V-Scheduler」区可从现有目录选择默认模型，也可刷新列表。「自定义模型供应商」仅统计在 DS Bot 中添加的供应商，仍可点击「添加供应商」配置。Agent API 的模型接口保持原有契约。

如果旧版 VOS 容器占用端口或持有 runner 文件锁，在会话中选择「完全访问（VOS 运维）」并让 Agent 检查应用。核对「停止旧版容器」提议，点击「确认执行」或「跳过」。刷新清单后，可再请求重启当前应用或单独清理已退出的容器。停止操作保留容器及数据。`stoppable` 表示容器可识别、处于运行或重启中，所属应用已安装或停止，容器版本与当前安装版本不同，且所属应用不是 v-harness。停止前会重新校验当前安装版本和安装 ID。目标变化或不符合条件时返回 409 `target-changed`。

查应用状态或请求重启时，请使用清单中的应用 ID。修复提议等待用户确认，返回 `executed: false`。已有提议时，HTTP 409 `confirmation-pending` 返回该提议的 `action`、`id` 和剩余秒数 `expiresIn`。请在会话里确认或取消。过期或已使用的确认返回 409 `confirmation-unavailable`。应用状态收到 Docker ID 时返回 400 `app-id-required`，请在清单里看容器状态或用日志查询读取输出。

### 宿主机管理

VOS 系统管理员打开会话，点击「宿主机管理」，再点击「开启宿主机管理」。Agent 可列出宿主机 Docker 容器、查看近期日志，并按完整容器 ID 提议启动、停止、重启或删除。执行前请在会话里核对目标并确认。删除要求容器已停止，数据卷保留。点击「关闭宿主机管理」可提前结束。授权在 30 分钟后过期，每次调用都会核验管理员角色和 VOS 登录会话。接口见「设置 → API 文档」。

浏览器通过 `GET /__vh/vos-ops/host-mode?sessionId=<会话ID>` 读取 `{available:true,enabled:boolean}`。对同一路径发送 `POST`，JSON 为 `{enabled:true}` 或 `{enabled:false}`，可开启或关闭。使用当前 VOS 登录会话和同源请求头 `X-VH-Ops: 1`。会话 ID 格式同上，切换模式时会话须存在于当前账号。退出登录、撤销管理员角色或网关重启都会终止授权。

会话工具 `vos_host_containers` 的 `operation` 取值为 `list`、`logs`、`start`、`stop`、`restart`、`remove`。除 `list` 外，`id` 均为 64 位小写十六进制容器 ID。清单沿用上面的容器记录，非 VOS 主栈容器的 `stack` 为 null。日志沿用 VOS 诊断的行数和字节限制。写操作通过现有会话确认流程提交 `host-start`、`host-stop`、`host-restart`、`host-remove`。启动接受 `created` 或 `exited`，停止和重启接受 `running` 或 `restarting`，删除接受 `created`、`exited` 或 `dead`。确认成功返回 `action`、`id`、`taskId:null`。参数无效返回 400，未登录返回 401，角色或会话未授权返回 403，日志目标不存在返回 404，目标已变化或不符合条件返回 409，授权数达到上限返回 429，Docker 调用失败返回 502。

输入框的 VOS 运维权限名称随当前界面语言切换。

### 批量清理接口

`remove-container`、`host-remove` 或 `remove-image` 可用 `ids` 替代 `id`，提交 1–20 个同类型、不重复的完整 ID。新提议及 409 `confirmation-pending` 按输入顺序返回 `ids`。`GET /proposal` 返回 `targetIds` 和 `targets`。批准时向 `POST /confirm-proposal` 提交同顺序的 `targetIds`，不匹配返回 400。跳过时提交 `approved:false` 和确认令牌。删除前重新校验所有目标，目标变化或不符合条件时返回 409，整批均不执行。成功响应包含 `action` 和按顺序排列的 `results`，每项包含 `id`、布尔值 `removed`，失败项还包含 `error`。保留数据卷。
