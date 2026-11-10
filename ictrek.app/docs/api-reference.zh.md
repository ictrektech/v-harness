# v-harness VOS API

## 摘要

通过核验后的 VOS 会话管理自己的文件、运行服务和 Agent 工作区；模型调用由 V-Scheduler 按该用户身份鉴权。本参考覆盖 VOS 网关，原生 DSH RPC/SDK 字段由其各自生成文档维护。

## 目录

- [地址](#addresses) · [身份和密钥](#identity) · [会话 API](#sessions) · [文件](#files) · [服务](#services) · [模型](#models) · [原生 RPC](#rpc) · [错误和停止](#errors)

<h2 id="addresses">地址</h2>

容器别名 `v-harness:8080`；没有独立业务宿主端口映射。VOS 页面 `/app/com.ictrek.v-harness/`；网关控制 API 在同一 VOS 域名的 `/__vh/*`。使用容器地址时直接追加 `/__vh/*`，不要假设都在 `/api/v1`。侧栏 API 文档可直接查看本页。

<h2 id="identity">身份和密钥</h2>

VOS token 用于核验身份和续期；`vh_session` 是本应用会话，默认12小时滑动过期，并绑定 User-Agent。Cookie 与 `x-vh-session` 都是受保护的会话凭证，不能放进日志。每个 subject 拥有私有 OS 用户、工作区和 DSH 实例。

本应用没有个人访问 API Key 的创建/修改接口。V-Scheduler 个人 Key、模型专用 Key 和上游厂商 Key 不是网关管理凭证；不能用它们列其他用户文件。Agent 使用的 Scheduler/MCPHub 等 capability 由网关按用户生成，不向页面暴露上游 VOS token，不作为通用管理 Key。

<h2 id="sessions">会话 API</h2>

`GET /__vh/session`：未登录仍返回200 `{authenticated:false,clientId,scope,csrf}` 并设置CSRF cookie；已登录返回 authenticated、用户信息和 tokenReady。`POST /__vh/session`（兼容 `/__vh/auth`）带 JSON `{access_token,refresh_token?,expires_in?}`、同一次GET的cookie和 `x-vh-csrf`；200返回 `{authenticated:true,session,user:{username,namespace}}` 并设置会话。保持相同User-Agent。身份失败401，VOS服务不可达502，CSRF失败403；登录成功不代表用户进程已经启动。

`GET /__vh/whoami`：当前用户 subject/account/username/locale。`POST /__vh/logout` 撤销会话并停止该用户实例；返回 `{authenticated:false}`，并清除cookie。`GET /__vh/boot` 返回 `{boot,error?}`；`POST /__vh/restart` 接受后202 `{ok:true}`，后台排空并重启，需后续查状态，不能把202当作已恢复。`GET /__vh/enter?to=/PATH` 是会话已知但身份续期失败时的受限进入，目标只允许同源路径，不能恢复缺失的上游凭证。

<h2 id="files">文件 API</h2>

`GET /__vh/files?dir=RELATIVE_DIR`：200 `{path,entries:[{name,type,size?,mtime}]}`，仅当前用户 workspace。`GET /__vh/files/raw?path=RELATIVE_FILE` 返回附件二进制，不是JSON；缺path400、不是文件400、不可访问/不存在404。`POST /__vh/files/upload?dir=RELATIVE_DIR&name=FILENAME` 上传原始字节，不是multipart；响应为文件辅助进程的原生JSON（无法解析时回退 `{ok:true}`），非法路径/名称400。编码URL查询参数，禁止跨用户/目录穿越；不要将容器绝对路径当作 workspace 相对路径。

<h2 id="services">服务与应用对接 API</h2>

`GET /__vh/services` 列出该用户登记的服务；`POST /__vh/services/:port/restart` 和 `/stop` 只操作所属服务。请求体不用于指定任意进程；错误返回 `{error,message}`。`/__vh/svc/:port/*` 仅代理该用户已登记或所属容器已发布的端口，支持原生HTTP和WebSocket，不是全网开放代理。服务注册/心跳由用户内部服务通道管理，不等于向V-Scheduler注册推理模型。

`GET /__vh/mcphub/services` 返回服务与routing；`GET /__vh/mcphub/tools` 返回可预览的工具；`GET/PUT /__vh/mcphub/selection` 使用 `{names:string[]|null}` 保存下次启动的选择，返回selected/restartRequired。`POST /__vh/mcphub/servers/:name/toggle|reload` 只允许白名单操作，MCPHub仍按当前用户判权。`/__vh/mcphub/agent/*` 是进程capability代理，不可用普通模型Key替代。

`GET /__vh/office/list`：200 `{ok,total,files}`。`GET /__vh/office/session?name=FILE&edit=1&lang=en&v=0` 返回用户编辑器会话，`/open` 返回302重定向；name不能为空或包含目录分隔符，edit=0只读，v改变可强制新编辑器会话。`/__vh/weknora/*` 及相册、Image Studio、PhotoCraft等内部capability保留各应用协议和权限，原始文件内容不由网关统一改写为JSON。

<h2 id="models">模型与 V-Scheduler</h2>

网关用当前用户的VOS身份从 V-Scheduler `/api/v1/models` 发现可见模型，优先使用 qualified 模型ID，按原生 endpoints/capabilities 选择 OpenAI、Responses、Anthropic 或文本补全转换；vision模型声明图像输入。模型权限和预算仍由调度器检查，不能只因列表存在就绕过。

`/__vh/scheduler/v1/models` 和对应 chat/completions、responses、messages 是Agent内部进程capability入口，只代理发现与推理，不能修改Scheduler模型、public/private、调度策略或Key。需要外部Agent直连模型时，在V-Scheduler创建所属用户的Key，然后调用调度器地址；不要从Harness会话中提取内部Key。

<h2 id="rpc">原生 DSH RPC / SDK</h2>

用户DSH实例的 `/api` 是生成的Remote方法和精确路由，不是 `/v1/chat/completions`。一元调用用HTTP POST，流通过 `/api/remote.mux` WebSocket；请求参数/返回类型以生成的SDK和对应服务为准，不能对任意内部方法做通用调用。网关保持用户隔离并替换内部实例cookie，外部Key不等于实例owner身份。原生订阅、工具调用和会话流应使用SDK，不能把单次HTTP成功当作完整Agent运行结束。

- [原生传输与身份](../../packages/client/connection/README.md) · [Remote参数/结果/流](../../packages/api/gateway/README.md) · [生成接口说明](../../docs/api-gateway.zh.md) · [VOS网关处理器](../../gateway/server.mjs)

<h2 id="errors">错误、续期与停止</h2>

公开 `GET /__vh/health` 只返回 `{ok:true}`，不启动模型或用户实例。JSON错误通常含error，可选message；400输入、401会话/身份、403来源/权限、404路径/所属资源、405方法、409运行状态冲突、502上游/用户服务不可达。不要对上传、服务重启或会话写操作盲目重放。失效会话重新进行GET/POST握手；更换User-Agent也会失效。

停止Agent、关闭流、停止用户服务、重启用户实例和释放Scheduler模型资源是不同操作。流断开触发对应请求取消，但不能据此宣称远端模型已卸载；调度器按实际完成/停止回执释放资源。logout会停止该用户实例，restart会中断实例并重新启动，操作前注意该用户的活动任务。

## 开发说明

本参考不改变鉴权、实例API或模型路由。
