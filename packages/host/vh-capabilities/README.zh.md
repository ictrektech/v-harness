---
description: "租户能力通道：在租户自己的 dsh 进程内监听 v-harness 能力 socket，并把每个请求经网关能力出口转发。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-vh-capabilities

[English](README.md) | 中文

## Summary

在 v-harness 部署里，每个 dsh 以自己的 Linux 账号运行，而 office、album、photocraft、image-studio、weknora 这些技能调用的能力 socket 都由网关持有。本包把这些 socket 搬进租户自己的进程，而不改动路径或线格式：网关把权威契约留在 root-only 状态目录，另写一份投递副本到 `DSH_HOME/capabilities.json`，插件只监听该副本点名的能力。每个请求再经 `/__vh/egress/*` 回到网关，由网关应用路由表并注入租户 VOS token。没有契约文件时插件不绑定任何东西。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 v-harness 载体 bundle 里挂载这一行即可，无需其它配置。契约只由网关写入，而且只在把本插件成功同步进租户 profile 之后、dsh 启动之前写；同步失败时保留网关自己的 socket，不把能力交给一个可能不存在的监听器；启动没有产生租户进程时则再次删除契约。只挂载该行而没有契约的 profile 是合法且惰性的——网关尚未迁移的租户、以及有意把能力 socket 留在网关的部署都处于这个状态。当被委托的 socket 在其租户运行期间不再应答时，网关会收回该能力并由自己提供。

插件读取三项配置。`dshHome` 指定契约与 socket 所在目录；它覆盖 `DSH_HOME`，后者又回落到 `$HOME/.dsh`，因为 `skills/*/scripts` 连接的是 `$HOME/.dsh/<name>.sock`，这个路径不能变。`gatewayUrl` 覆盖回环网关地址，默认取 `VH_GATEWAY_PORT`，缺省为 `http://127.0.0.1:8080`——被隔离的租户唯一能到达的端口。`timeoutMs` 限定单个转发请求的空闲时间（默认十分钟）；它是卡顿检测，不是总时长，因为技能上游会流式返回。

### 契约内容

本进程读取的文件是 JSON，包含 `version`、每租户 `key`，以及本进程需要监听的 `capabilities`。文件为 `0600`、归租户所有、原子写入；键在多次启动间保持不变，因此重启网关不会让被接管 dsh 里仍存活的插件失效。

这是**投递副本**。网关在自己的状态目录保留权威副本（目录 `0700 root`、文件 `0600`），只从它重建键索引与 socket 归属。因此改写 `DSH_HOME/capabilities.json` 最多让该租户自己的监听器出错，不能造出网关接受的键，也不能扩大键可达的范围。

读取会拒绝一切无法担保的文件：以 `O_NOFOLLOW` + `O_NONBLOCK` 打开，必须是本进程拥有的普通 `0600` 文件，且不超过 64 KiB。软链、FIFO、设备、组或其他人可读、owner 不符、键格式错误、能力列表为空，都视为没有契约。轮换键意味着删除两份副本并重启租户。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节——点击展开</summary>

### 设计思路

能力 socket 的归属只由磁盘决定，从不依赖内存，因为网关重启后必须能接管一个在它之前就已启动的 dsh 及其插件。契约是唯一来源：网关跳过其中列出、且 rollout 仍然允许的能力名，插件绑定全部列出的名字，重启后双方重新得到同一答案。因此归属只会在租户重启、rollout 变化或存活探测失败时改变，这三者也都会替换或退场插件，所以不会有两个进程有意持有同一路径。

契约记录的是「应该归谁」，不是「插件正在监听」。网关在跳过 socket 之前会检查路径：文件必须是租户拥有的 socket，并且连接必须被接受，重试约一秒以吸收 dsh 启动窗口。被杀死进程留下的陈旧 inode、他人拥有的文件、无人 accept 的 socket 都判失败。失败且租户正在运行时，网关删除两份副本、清键、丢弃该 subject 的缓存监听器并自己绑定该能力，因此技能不会连到没有读者的 socket。未运行的租户保留契约，因为停着的 dsh 无法应答，并会在下次启动时读到同一份契约。rollout 每个网关进程只读一次，因此回滚在下一次网关重启时改变归属，而不是按请求生效。

重启仍可能产生竞态：双方会在同一窗口尝试绑定。网关总是赢。它会清掉陈旧路径，并在绑定失败时有界重试；本插件只替换自己 uid 留下的 socket，另一个 uid 拥有的 socket 一律不动。路径上的其它东西——目录、普通文件、软链、FIFO——都不删除，因此租户无法种下一个会被本进程 unlink 的路径。关闭时先把路径移开再 `server.close`（否则 Node 会 unlink 当时路径上的任何东西），仍是本插件的陈旧 socket 才删除，已被网关重绑则用硬链接还原；同时先断开连接并给等待设上限，因为 SSE 或上传不该让插件卸载挂起。

插件只是传输层，不是服务。它不增加路由、不感知上游、也不持有凭据：`forwardCapability` 重放方法、路径、查询串与请求体，用 `x-vh-capability-key` 出示租户键，并只回放技能实际消费的响应头。它也会拒绝能力调用用不到的东西：`GET`/`HEAD`/`POST`/`PUT`/`PATCH`/`DELETE` 之外的方法，以及解析后会因点段、反斜杠或 NUL——无论原文还是百分号编码——离开能力前缀的目标。转发的请求有空闲超时，网关失联会销毁上游。网关出口路由在检查键之前就拒绝浏览器形态的请求和非回环来源，因此公网可达的 `/__vh` 前缀不会变成免会话代理。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis 行：读取契约，以 effect 持有监听器 |
| [`src/contract.ts`](src/contract.ts) | 契约校验与能力到 socket 的映射表 |
| [`src/servers.ts`](src/servers.ts) | 每个被委托能力一个 unix 监听器，归属网关优先，释放时不删除别的进程的 socket |
| [`src/forward.ts`](src/forward.ts) | 向 `/__vh/egress/*` 重放请求与响应 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [网关能力出口](../../../gateway/egress.mjs) —— 通道的另一半及其执行的授权规则。
- [租户能力注册表](../../../gateway/capability-registry.mjs) —— 契约格式、灰度范围与键索引。
- [网关迁移方案](../../../GATEWAY-PLAN.md) —— socket 为何搬家以及本包在灰度中的位置。

-----

<a id="model-experience"></a>
## Model Experience

无，因为该传输不注册任何提示词、工具或会话事件。

#### KV Cache effect

无；本包既不组装也不发送模型请求。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **`vh-services` 留在网关** —— 该能力不可委派：rollout 即使列出也会被丢弃，插件从不绑定它，其 egress 路由返回 403。注册表、docker 代理与 `/__vh/svc` 转发仍留在网关，因为尚无测试证明一个租户无法触达另一个租户的容器。
- **重启才能轮换** —— 键在启动时读取一次，轮换后的文件在租户重启时生效，运行中不生效。
- **单一写入方** —— 只有 v-harness 网关写入契约；在其它部署挂载本行是惰性的，而不是可配置的。
- **同 uid 可读** —— 投递副本对该租户是 `0600`，所以以该 uid 运行的其它进程能读到键并冒充插件。键仍只能到达该租户自己被委托的能力，且会在登出、账号切换与回滚时吊销。

<a id="dev-note"></a>

### Dev Note

<details>
<summary>维护者工作说明——点击展开</summary>

本包测试：`npx vitest run packages/host/vh-capabilities`。网关侧的契约与双轨用例在 `gateway/capability-contract.test.mjs`，用 `node --test gateway/*.test.mjs` 运行。

</details>
