# v-harness API v1

用 VOS 账号从脚本创建会话、提交任务并读取结果。API 会话使用该账号的 v-harness 工作区和「设置 → 模型」中选定的默认模型。使用前可选该账号可访问的 V-Scheduler 模型，或在「设置 → 模型 → 添加模型提供商」配置自己的服务。个人模型使用该租户保存的凭据。能进入 v-harness 的普通 VOS 账号即可调用。

0.2.3-alpha.2 的 VOS 运行时统一使用随应用安装的存储服务。升级前的工作区 ID 和会话 ID 可以继续使用，以下请求、响应和鉴权约定保持现状。

预装插件及 DS Bot 迁移见[应用说明](https://twp99wyutbs.feishu.cn/docx/DTWGdRXGhoblP5xue4Gcf8Bpnsc)。会话、任务、事件和鉴权继续使用本文定义的接口。

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

从「设置 → VOS 运维」使用。以下是设置页的浏览器接口，路径基址为同源 `/__vh/vos-ops`，也可加 VOS 应用前缀 `/app/com.ictrek.v-harness`。使用当前 VOS 登录派生的 v-harness 会话 Cookie，每次请求都向 VOS 校验 `system_admin`。请求带 `X-VH-Ops: 1`，除授权和 `GET /containers` 外还需 `X-VH-Ops-Grant`。POST 请求使用 JSON 对象，响应均为 JSON，禁止缓存。没有跨域接口和 Agent Bearer 入口。

| 方法与路径 | 输入和输出 |
|---|---|
| POST /authorize | 请求 `{}`。返回 `grant`（不透明字符串）及 `expiresIn: 900`（秒），并替换同一会话的先前授权。 |
| POST /close | 请求 `{}`。撤销此授权及其待确认操作，返回 `closed: true`。 |
| GET /inventory | 无参数。返回 `apps`、`containers`、`publishedPorts`、`unusedImages`、`unreferencedTaggedImages` 五个数组，无结果时为空数组。 |
| GET /containers | 查询参数 `sessionId` 为会话 ID，该会话须选择「完全访问（VOS 运维）」或已开启应用容器管理。不需要授权头。返回 `containers` 数组，条目为 `id`、`name`、`appId`、`version`、`state`、`status`，只含 VOS 应用栈容器；数据库、模型和宿主机上的其他容器不返回。输入框的 `@` 容器来源使用此接口。 |
| GET /status | 必填查询参数 `id` 为应用 ID，最多 128 字符，字母或数字开头，其余还可用点、下划线和连字符。返回 `appId`、`version`、`state`、`lastError` 和 `workflow`。 |
| GET /logs | 必填查询参数 `id` 为 64 位小写十六进制完整容器 ID。可选 `since` 与 `until`（RFC 3339 时间或如 `30m` 的相对时长）、`after`（RFC 3339 游标：轮询时回传上次响应的 `next`，只返回更晚的记录，与 `since` 互斥）、`pattern`（不超过 200 字符的不区分大小写正则）与 `context`（0–50，每条命中记录前后附带的记录数）。时间窗与游标以 unix 秒（各留一秒余量）作为 `since`/`until` 传给 Docker（本部署的 daemon 拒绝 RFC 3339），`pattern` 与 `context` 由网关按记录过滤；记录以时间戳开头，多行输出（如栈追踪）并入同一条记录。返回 `id`、按记录重组的 `text`，以及 `scanned`、`returned`、`first`、`last`、`next`（下次轮询的游标；没有更晚记录时保持不变）和布尔 `truncated`；超过 300 条记录返回最早一批并置 `truncated`。带任一过滤参数或游标时扫描窗从 150 行放宽到 1000 行。 |
| GET /app-logs | 必填查询参数 `appId` 为应用 ID，其余参数同 /logs。返回该应用 compose 栈全部容器按时间戳交错合并的一条时间线，每条记录以容器名作前缀。返回 `appId`、`containers`（容器名数组）、合并后的 `text`，以及与 /logs 同语义的 `scanned`、`returned`、`first`、`last`、`next` 和布尔 `truncated`。应用不在清单或栈内无可见容器返回 404。 |
| GET /diagnose | 必填查询参数 `id` 为完整容器 ID。返回 `id`、`name`、`image`、`stack`、`state` 与 `logs`。`state` 含 `status`、`running`、`restarting`、`oomKilled`、`exitCode`、`error`、`startedAt`、`finishedAt`、`restartCount` 和 `health`（`status`、`failingStreak`、最近最多三次 `recent`，各含 `start`、`end`、`exitCode`、`output`）；无健康检查时 `health` 为 null。`logs` 含 `scanned`、`first`、`last` 与折叠后的 `errors`（每条含 `count`、`first`、`last`、`sample`，最多 40 条）。容器不可见返回 404；Docker 元数据缺失返回 409 `target-changed`。 |
| POST /preview | 必填字符串 `action` 和 `id`。支持 `restart`（应用 ID）、`remove-container`（完整容器 ID）、`stop-container`（完整容器 ID）、`remove-image`（`sha256:` 加 64 位小写十六进制）。返回 `confirmation`（不透明字符串）、`expiresIn: 60`、`action`、`targetId`、`target`（相应清单条目）。每个授权同时只有一个预览。 |
| POST /execute | 必填字符串 `confirmation` 和 `targetId`。核对具体对象后提交预览中的确认码和完整 ID。返回 `action`、`id` 和 `taskId`（重启任务 ID，清理时为 null）。受理重启后可重新查看应用状态。确认码单次使用，失败后应重新查看状态及预览。 |
| GET /proposal | 查询参数 `sessionId` 为会话 ID。返回 `proposal`（无待确认操作为 null，否则包含 `action`、`targetId`、`target` 和 `confirmation`）。 |
| POST /confirm-proposal | 查询参数 `sessionId`。请求体含 `confirmation`、布尔 `approved`，确认时还需 `targetId`。返回同 /execute，取消时返回 `cancelled: true`。 |

`apps` 条目字段为字符串 `appId`、`installationId`、`version`、`state`、`lastError`（无错误为空字符串）。VOS 应用状态为 `not_installed`、`installing`、`installed`、`stopping`、`stopped`、`starting`、`upgrading`、`uninstalling`、`uninstalled`、`restarting`、`error`；按平台原值显示。可重启 `installed` 的其他应用，VOS 可拒绝不允许的状态。状态响应的 `workflow` 可为 null；否则包含字符串 `taskId`、`status`、`failure`（无失败为空字符串）及字符串或 null 的 `stage`。工作流状态为 `Running`、`Completed`、`Failed`、`Cancelled`、`Terminated`、`TimedOut`、`ContinuedAsNew`。

`containers` 条目包含字符串 `id`、`name`、`image`、`imageId`、`state`、`status`，以及布尔 `cleanup`、`stack`（字符串 `appId`、`version`、`project`）和 `ports` 数组。容器状态取 Docker 原值，清理接受 `created` 或 `exited` 且归属与版本通过复核。端口条目包括数字 `hostPort`、`containerPort`，字符串 `protocol`（Docker 的 tcp、udp、sctp 值）、`address`。全机 `publishedPorts` 还带容器名称 `container` 和字符串或 null 的 `appId`。

镜像条目包括字符串 `id` 和数字 `bytes`（字节）。`unusedImages` 还包含数字 `created`（Unix 秒），对应无标签、无摘要且未被任何容器引用的镜像。`unreferencedTaggedImages` 还包含非空字符串数组 `tags` 和可能为空的字符串数组 `digests`，对应带标签且未被任何容器引用的镜像。两类均可用 `remove-image` 提议清理。 未开启「完全访问（VOS 运维）」时，会话会提示管理员开启。租户终端的 Docker 清单仅覆盖当前租户。管理员在会话选「完全访问（VOS 运维）」并要求清理未使用镜像，核对确认框中的标签和 ID 后点击确认或跳过。删除时按完整 ID 复核引用和标签，保留卷和父镜像。Docker 遇到多标签、依赖镜像或新容器引用等冲突时可拒绝非强制删除。单项返回 409 `image-delete-conflict`，批量结果的对应条目返回 `removed: false` 和同一错误码。刷新清单核对失败项。

错误响应为 `{"error":"<code>"}`。400 为 `invalid-body`、`invalid-target`、`confirmation-mismatch`、`invalid-since`、`invalid-until`、`invalid-after`、`invalid-pattern` 或 `invalid-context`，请核对 JSON、操作、完整 ID 和日志查询参数；401 `sign-in-required` 请重新登录；403 `forbidden` 请检查角色、浏览器同源请求和有效授权；404 `not-found` 请刷新；409 `target-changed` 请刷新和重新预览；429 `too-many-grants` 请等待授权到期；502 `vos-request-failed`、`docker-unavailable`、`response-too-large` 或 `upstream-unavailable` 表示上游拒绝、不可用或返回超限，请检查 VOS 或 Docker 状态。重启受理与完成是两个阶段，超时后先刷新应用状态再决定是否重试。

内置工具 `vos_diagnostics` 支持 `inventory`、`status`、`logs`、`app-logs`、`diagnose`、`propose`。除 `inventory` 外需字符串 `id`，格式同表；`propose` 另需 `action`。`diagnose` 要求完整容器 ID，优先于 `logs` 使用：它返回状态事实（退出码、是否 OOM、重启计数、健康检查）和折叠的错误摘要，不返回原始日志。`app-logs` 接收应用 ID，返回整个应用栈交错合并、带容器名标签的时间线，跨 service 问题无需猜测该看哪个容器。`logs` 与 `app-logs` 可另带 `since`、`until`、`after`、`pattern` 和 `context`，语义同上表。返回诊断 JSON 文本，最长 49,152 字符。VOS 系统管理员选择 `vos-full-access` 即可使用。会话确认接口无需设置页授权头；`sessionId` 是当前租户的会话 ID，1–128 个字母、数字、下划线或连字符。每个会话最多一个待确认提议，120 秒有效，已有提议时返回 409 `confirmation-pending`。

如果旧版 VOS 容器占用端口或持有 runner 文件锁，在会话中选择「完全访问（VOS 运维）」并让 Agent 检查应用。核对「停止旧版容器」提议，点击「确认执行」或「跳过」。刷新清单后，可再请求重启当前应用或单独清理已退出的容器。停止操作保留容器及数据。`stoppable` 表示容器可识别、处于运行或重启中，所属应用已安装或停止，容器版本与当前安装版本不同，且所属应用不是 v-harness。停止前会重新校验当前安装版本和安装 ID。目标变化或不符合条件时返回 409 `target-changed`。

查应用状态或请求重启时，请使用清单中的应用 ID。修复提议等待用户确认，返回 `executed: false`。已有提议时，HTTP 409 `confirmation-pending` 返回该提议的 `action`、`id` 和剩余秒数 `expiresIn`。请在会话里确认或取消。过期或已使用的确认返回 409 `confirmation-unavailable`。应用状态收到 Docker ID 时返回 400 `app-id-required`，请在清单里看容器状态或用日志查询读取输出。

### 应用容器管理

VOS 系统管理员打开会话，点击「应用容器管理」，再点击「开启应用容器管理」。Agent 只看到 VOS 应用栈的容器（带 VOS 平台标签且属于 `vos-app-*` 项目）：数据库、模型和宿主机上的其他容器不列出，按它们的 ID 查日志返回 404，发起操作返回 409 `target-changed`。应用已卸载但残留的栈容器仍会列出，便于清理。Agent 可查看近期日志，并按完整容器 ID 提议启动、停止、重启或删除。执行前请在会话里核对目标并确认。删除要求容器已停止，数据卷保留。点击「关闭应用容器管理」可提前结束。授权在 30 分钟后过期，每次调用都会核验管理员角色和 VOS 登录会话。接口见「设置 → API 文档」。

浏览器通过 `GET /__vh/vos-ops/host-mode?sessionId=<会话ID>` 读取 `{available:true,enabled:boolean}`。对同一路径发送 `POST`，JSON 为 `{enabled:true}` 或 `{enabled:false}`，可开启或关闭。使用当前 VOS 登录会话和同源请求头 `X-VH-Ops: 1`。会话 ID 格式同上，切换模式时会话须存在于当前账号。退出登录、撤销管理员角色或网关重启都会终止授权。

会话工具 `vos_host_containers` 的 `operation` 取值为 `list`、`logs`、`diagnose`、`start`、`stop`、`restart`、`remove`。除 `list` 外，`id` 均为 64 位小写十六进制容器 ID。`diagnose` 返回与 `/diagnose` 相同的报告，`logs` 可另带 `since`、`until`、`after`、`pattern` 和 `context`，语义同上表。清单只包含 VOS 应用栈容器，沿用上面的容器记录；其他容器 ID 查日志或诊断返回 404，发起操作返回 409。日志沿用 VOS 诊断的过滤参数和字节限制。写操作通过现有会话确认流程提交 `host-start`、`host-stop`、`host-restart`、`host-remove`。启动接受 `created` 或 `exited`，停止和重启接受 `running` 或 `restarting`，删除接受 `created`、`exited` 或 `dead`。确认成功返回 `action`、`id`、`taskId:null`。参数无效返回 400，未登录返回 401，角色或会话未授权返回 403，日志目标不存在返回 404，目标已变化或不符合条件返回 409，授权数达到上限返回 429，Docker 调用失败返回 502。

输入框的 VOS 运维权限名称随当前界面语言切换。

在输入框输入 `@`，选择「VOS 容器」再点一个容器，即可把该容器作为引用放进对话。引用文本带完整容器 ID，Agent 可直接按 ID 提议操作。这个来源只列出 VOS 应用栈容器，并且只有在 VOS 系统管理员、且当前会话已选择「完全访问（VOS 运维）」时才会出现在菜单里；其他情况完全不显示，也不发起请求。

### 批量清理接口

`remove-container`、`host-remove` 或 `remove-image` 可用 `ids` 替代 `id`，提交 1–20 个同类型、不重复的完整 ID。新提议及 409 `confirmation-pending` 按输入顺序返回 `ids`。`GET /proposal` 返回 `targetIds` 和 `targets`。批准时向 `POST /confirm-proposal` 提交同顺序的 `targetIds`，不匹配返回 400。跳过时提交 `approved:false` 和确认令牌。删除前重新校验所有目标，目标变化或不符合条件时返回 409，整批均不执行。成功响应包含 `action` 和按顺序排列的 `results`，每项包含 `id`、布尔值 `removed`，失败项还包含 `error`。保留数据卷。

## 在会话中使用内置技能

Archify、Mnemon、PPT Design Skill 和 Vox Director 沿用会话任务入口。生成文件写入用户工作区，Mnemon 将记忆存放在当前用户的持久目录里，Atlas Cloud 视频生成需要用户配置密钥。使用 `POST /sessions/{sessionId}/prompts` 提交任务，通过 `GET /sessions/{sessionId}/events` 查看进度。会话 API 约定保持现状。

调用 PGV 时，向同一个提示词端点提交 `{"requestId":"<唯一ID>","text":"用 /pgv 检查已配置的 PostgreSQL 数据库安装了哪些扩展。"}`。Agent 使用已为工作区配置的服务凭据连接 PGV，通过现有提示词和事件端点返回结果。加入 `vos_default` 的 VOS 应用也可直连 `pgv:5432`（PostgreSQL）或 `pgv-redis:6379`（Redis）。数据库连接器 HTTP 基址为可信内网的 `http://pgv-viewer:8081/app/com.ictrek.pgv`，或使用 VOS CA 的 `https://<vos-host>:1180/app/com.ictrek.pgv`。使用同源 `Origin` 和 JSON `{"access_token":"<VOS admin 令牌>"}` 调用 `POST /api/vos/login` 获取 `pgv_vos_session` Cookie。携带该 Cookie 调用 `GET /api/auth/check` 和 `GET /api/connection/list`，最后携带 Cookie 与同源 `Origin` 调用 `POST /api/auth/logout` 注销。PGV 服务凭据和 v-harness Bearer 令牌各用于对应的接口。PGV 完整请求字段、响应和错误见 **PGV → 接入指南 → API 与协议参考**。

在「插件 → 已安装」中，可以启用 ModSearch 处理网页搜索，或启用 Billion Context 管理符合条件的模型请求上下文。Billion Context 默认开启，ModSearch 默认关闭。通过 API 创建的会话使用当前租户在 Web 界面配置的插件及设置。VOS API v1 的会话、提示词和事件协议保持一致。安装使用步骤见 [VAI 应用使用文档](https://twp99wyutbs.feishu.cn/docx/DTWGdRXGhoblP5xue4Gcf8Bpnsc)。

## 算力节点与模型部署

打开「设置 → VOS 运维」，授权诊断后查看「机器」和「应用后端」。点击「在 V-Scheduler 管理算力节点」或「在 Image Studio 部署后端与准备模型」，可使用当前 VOS 身份进入对应应用。节点登记、硬件复验、容器验证、后端部署和模型准备需要对应服务的管理员权限。

也可以在会话中让智能体操作。例如「列出算力节点，在我选定的节点部署 Image Studio 后端，准备模型并报告传输和注册进度」。SSH 凭据通过私有 JSON 文件提供。智能体通过租户 socket 使用当前 VOS 身份。收到部署回执后继续查询状态。模型准备依次显示源文件检查、复制或共享存储、目标校验与注册，达到「registered」后再使用该部署生成。中断的准备流程可重试。删除远端模型前，由对应服务检查在途任务，随后注销该模型并删除它在目标节点上的文件。

## OpenMotion 与文件持久化

预装 **OpenMotion 0.2.1**，插件名称为 `openmotion-dsh`，使用官方本地应用的 MCP 工具和 Skills。默认开启，可直接在对话中请求创建 OpenMotion 项目、动画或导出视频。项目数据写入 `$HOME/workspace/OpenMotion`。媒体供应商需要单独配置，较大的渲染需要足够的 CPU、内存和磁盘。

使用步骤：

1. 在 v-harness 选择工作区，在「插件 → 已安装 → openmotion-dsh」确认开关开启；如有重启提示，按提示重启工作区。
2. 在对话里说「用 OpenMotion 打开模板库」或描述动画的主题、时长、画幅和风格。智能体调用插件后，点击它返回的预览/Studio 链接；仅打开插件详情页不会打开编辑器。预览链接仅供当前 VOS 账号访问；保留完整路径、参数和 # 片段，登录失效后刷新工作台再打开。
3. 在预览中检查画面和时间轴，在对话里提出修改；先预览，再确认导出。生成图片、视频、配乐或配音素材时，先按 OpenMotion 的引导配置相应供应商。
4. 确认后让智能体导出 MP4，把项目、素材和成片保存在工作区。项目目录为 `$HOME/workspace/OpenMotion`；从返回的文件链接下载或另行备份。

可直接复制：「用 OpenMotion 做一个 10 秒、16:9 的产品介绍动画，先用文字和几何图形，给我分镜和可打开的预览；等我确认后再导出 MP4，把项目和视频保存到工作区。」

租户主目录中的工作区、设计文件、导出文件、会话和插件设置通过 `${VOS_APP_STORAGE_PATH}/data:/data` 保存在主 VOS 机器上。交付文件请保存在 `$HOME/workspace`。普通容器重建和应用升级会沿用该存储。删除应用数据或修改存储设置前，请先备份应用存储。

这些集成通过租户私有 Unix socket 调用，由网关提供当前 VOS 令牌。公共 VOS API v1 的会话、提示词和事件协议保持原有契约。原生算力 API 由 [Image Studio](https://github.com/ictrektech/image-studio) 维护，节点管理 API 由 [V-Scheduler](https://github.com/ictrektech/V-Scheduler/blob/main/docs/node-management.md) 维护。


## 默认开启的语音与实验功能

OpenMotion、Billion Context，以及「插件 → 已安装 → 实验性插件」中的语音输入、自定义插件索引、自动授权审查、变更请求与工作树均默认开启。ModSearch 保持默认关闭。

语音输入默认选择 **V-Voice · V-Scheduler**，复用 V-Voice 已启用的 ASR 模型，识别请求经过 V-Scheduler 的用户权限和资源调度；v-harness 发布镜像不包含本地 SenseVoice 插件及其 sherpa-onnx 原生依赖，不下载或装载本地识别模型。先安装并启动 V-Voice 与 V-Scheduler，在 V-Voice 准备 ASR 模型。然后在语音输入详情页允许麦克风、选择输入设备和识别语言，在会话输入区录音，结束后核对转写文字，再发送消息。服务未就绪时检查 V-Voice 模型和调度资源，再重试；登录过期时刷新 v-harness。升级会把原本地 SenseVoice 选择迁移至该服务，保留旧模型文件。

在「插件 → 已安装 → 语音输入」打开「识别服务 / 运算节点」下拉框。`V-Voice · V-Scheduler` 使用自动路由；带模型名和节点 ID 的 `V-Voice · <模型> · <节点>` 选项使用该节点已登记的部署和执行器。先由管理员在 V-Voice 准备后端与模型，点击「刷新运算节点」后再选择。选择按当前账号保存，录音开始时固定；节点失效或执行位置不匹配时本次识别失败，不切换到其他节点。刷新后重新选择可用项，再录音。节点功能要求 V-Voice 提供 `/api/v1/compute/placements` 和 `/api/v1/compute/transcriptions`；旧版只显示自动服务。

变更请求与工作树所需 Git、GitHub CLI (`gh`) 和 GitLab CLI (`glab`) 已随镜像安装。访问私有仓库仍需在当前租户中完成相应账号登录；开启自定义插件索引不会自动添加索引源。默认启用自动授权审查只使该访问模式可选，不会改变已有会话的访问模式。

语音转写使用已有 `speech/catalog`、`speech/configure`、`speech/prepare` 和 `speech/transcribe` Remote 协议，麦克风音频不会自动提交为 Agent 消息。公开会话 API v1 的路径、鉴权、请求和事件格式不变。

### VOS 语音 Remote 接口

以下为同源浏览器接口，基址 `/app/com.ictrek.v-harness/api/`，使用 VOS 登录派生的租户 Cookie 和 Connection 来源校验；仅返回当前用户可见的 V-Voice ASR 模型，不使用管理员服务凭据。POST JSON 外壳为 `{"type":"client-request","rpcId":"<unique-id>","method":"speech/catalog","payload":{"args":{}}}`，URL 后缀和 method 使用下表同一方法名。成功返回 `{"type":"server-response","rpcId":"<same-id>","result":{"ok":true,"value":...}}`；失败返回 `result.ok:false` 及 `result.error`（code、message、details）。

| 方法后缀 | payload.args | 成功 value |
|---|---|---|
| `speech/catalog` | 空对象 | `providers`（id、name、location、languages、preparation）、`selection`（providerId、language）、`maxAudioBytes`（4194304 字节）、`maxDurationSeconds`（120 秒） |
| `speech/configure` | `patch`：可选 providerId、language；省略字段保持原设置 | 无返回值；保存当前用户的选择 |
| `speech/prepare` | 必填 providerId；可选 options；VOS 服务无需 downloadSource | 无返回值；重新检查服务可用性，不下载模型 |
| `speech/cancelPreparation` | 必填 providerId | 无返回值；取消并等待当前服务检查结束 |
| `speech/transcribe` | 必填 request.audioBase64；可选 request.providerId、request.language | text（字符串，可为空）、audioSeconds、inferenceSeconds（均为秒） |

本部署 providerId 为 `v-scheduler-voice`，location 为 `cloud`（协议中表示进程外服务，此处实际为 VOS 内的 V-Voice）。默认 language 为 auto；完整可选值为 auto、zh、en、ja、ko、yue。preparation.phase 为 checking、ready、failed、cancelled；checking 含 startedAt（Unix 毫秒），failed 含 message，其他状态不带这些字段。音频必须是完整、标准 base64 编码的 16 kHz、单声道、16-bit PCM WAV，受上述大小与时长限制及 V-Voice 自身准入限制约束。转写最多等待 120 秒，取消会中止请求，资源释放仍由 V-Scheduler 确认。

超出 base64 编码长度返回 `speech/invalid-audio`；WAV 校验、未知服务/语言、缺少 ASR 模型、识别或调度失败返回 `speech/transcription-failed`，details.reason 为可变诊断文字。没有 VOS 登录返回 HTTP 401，来源不可信返回 403；服务内错误由 Remote 结果表达，应同时检查 result.ok。服务未就绪或资源忙时先检查 V-Voice/V-Scheduler，再明确重试；不会静默切换到本地模型。

节点选项沿用 `speech/catalog` 的 providers：`id` 为 `v-scheduler-voice/<URL编码的deployment_id>/<URL编码的executor_id>`，`name` 含模型和节点 ID；调用方应从当前目录读取该不透明 ID，不能自行拼接。`speech/configure` 用 `patch.providerId` 保存选择；`speech/transcribe` 可用 `request.providerId` 指定本次选择，省略时用已保存值。`speech/prepare` 刷新自动模型及节点目录。请求和返回字段不变，转写仍返回 text、audioSeconds、inferenceSeconds；执行位置由 V-Voice 校验，v-harness 还核对 deployment_id、executor_id、node_id 后才交付文字。下线节点保留旧选择以提示重新选择，不自动回落。
