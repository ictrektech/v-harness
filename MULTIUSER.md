# v-harness 多用户设计

> 本文件取代 `MULTITENANCY.md`（单进程 + namespace 执行舱方案，已否决）。
> 所有事实均对照 dsh 源码核验过，行号见文末索引。

## 0. 定位

v-harness 是 **dsh 的服务器化外壳**，不是 IDE。

- dsh 负责 agent 能力：会话、工具、插件、沙盒
- v-harness 负责：多人各自使用、互不可见、可运维
- 用户只做两件事：**提需求、验收产物**；不提供编辑器，不提供给用户用的终端

设计只围绕一个判断：

> **隔离由操作系统负责，不由 dsh 负责。**

dsh 内部不做任何租户判断，它只在自己的账号和自己的目录里跑。

## 1. 结论

| 约束 | 结论 |
|---|---|
| 用户能自由装插件 | 插件是任意 JS，必须有进程边界 |
| A 不能读 B 的文件/会话/凭据 | 边界在 OS 层 |
| 可运维 | 用系统现成工具管理 |

三条同时成立，只有一种结构：**每用户一个 OS 账号、一个 dsh 实例、一份 `DSH_HOME`**。

单进程多租户不成立：插件在主进程跑，没有任何配置能隔离不可信 JS。

**隔离形态：裸机 systemd + OS 账号。本期不使用 docker / 容器做隔离。**

## 2. 架构

```
浏览器 ──https──▶ TLS 反代 ──▶ v-harness gateway
                                    │
                                    ├─ 会话 / 限流 / 路由 / 生命周期
                                    ├─ 文件操作经 sudo 助手降权
                                    ├─ LLM 透传（可选，见 §6.4）
                                    │
                                    └─▶ dsh --profile web --host 127.0.0.1 --port 3101+（每用户）
                                          run as vh-<name>
                                          HOME=<base>/users/<name>
                                          DSH_HOME=<base>/users/<name>/.dsh
                                          DSH_AGENTS_HOME=<base>/users/<name>/.agents
```

关键点：

- 所有实例只监听 `127.0.0.1`，公网只能走反代
- 网关对用户目录**零权限**，文件访问 `runuser -u vh-<name>`
- 回环防火墙按 **uid** 只放行自己的端口（防止 agent 用 `curl 127.0.0.1:<别人端口>`）
- profile 固定为 `web`，每用户 `DSH_HOME` 独立，插件互不影响
- **三个环境变量必须齐全**。systemd 的 `User=` 不会自动设置 `HOME`；漏设会让 `~/.agents` 解析到错误位置，skills 与 `AGENTS.md` 静默失效

## 3. 目录布局

```
<base> = /opt/v-harness

<base>/
  dsh/                         dsh 安装树（所有实例共享，必须只读）
  users/<name>/                0700  vh-<name>
    ├─ .dsh/                   DSH_HOME：profile、会话、凭据
    │   ├─ profiles/web/       package.json、cordis.patch.yml、node_modules
    │   ├─ sessions/           会话 JSONL
    │   ├─ storages/           非会话存储
    │   ├─ cache/              附件、临时缓存
    │   └─ .credentials.yaml   0600
    ├─ .agents/                DSH_AGENTS_HOME：skills、AGENTS.md
    └─ workspace/              agent 的工作根
        ├─ 日常/               预置，闲聊落点
        └─ <project>/          用户自建
  gateway/
    ├─ users.json              用户表（网关与 userctl 共用）
    └─ state-port.json         网关端口
  bin/                         文件助手与用户管理入口
```

分离理由：

| | `.dsh` | `workspace` |
|---|---|---|
| 性质 | 运行时状态 | 产物 |
| 用户可见 | 否 | 是 |
| agent 可写 | 只能经 dsh 自身 | 是 |

**安装树约束**（最关键）：`<base>/dsh` 整棵树不得带 group/other 写位。所有实例共享执行这份代码，任何可写点都是跨租户注入点。自检：

```bash
find <base>/dsh -perm /022 | wc -l    # 必须为 0
```

## 4. 用户初始化：幂等

**没有就创建，有就跳过，绝不覆盖。**

### 4.1 判定顺序

| 对象 | 已存在 | 不存在 |
|---|---|---|
| OS 账号 `vh-<name>` | 跳过 `useradd` | `useradd --system --no-create-home --shell /usr/sbin/nologin` |
| 用户根目录 | **只校正** `0700` + 属主 | `mkdir -p` + `chmod 0700` + `chown` |
| `.dsh/` | 只补缺失文件 | 初始化 |
| `.agents/` | 只补缺失文件 | 初始化 |
| `profiles/web/` | 只在缺 `package.json` 时写 | 写入默认内容 |
| `workspace/日常/` | 跳过 | `mkdir` |
| 工作区注册表 | 已含该路径则不追加 | 追加一条 |
| 凭据 | 不读不写 | 留空，首次登录引导 |
| systemd unit | 内容一致则不重写；不一致则报错交由人工 | 生成 |
| 端口 | 复用 `users.json` 中已分配的 | 取下一个空闲端口 |
| 网关用户表 | 更新显示名等非敏感字段 | 新增记录 |

### 4.2 伪代码

```bash
# 建号（幂等）
id -u "vh-$NAME" >/dev/null 2>&1 || useradd --system --no-create-home \
  --home "$BASE/users/$NAME" --shell /usr/sbin/nologin "vh-$NAME"

# 目录（幂等）
[ -d "$HOME_DIR" ] || mkdir -p "$HOME_DIR"
chmod 0700 "$HOME_DIR"                    # 已存在时仅校正，不重建
chown -R "vh-$NAME:vh-$NAME" "$HOME_DIR"  # 递归校正属主

# 默认工作区（幂等）
[ -d "$HOME_DIR/workspace/日常" ] || mkdir -p "$HOME_DIR/workspace/日常"
chown "vh-$NAME:vh-$NAME" "$HOME_DIR/workspace/日常"

# 实例（幂等）
if systemctl is-active --quiet "dsh-web-$NAME"; then
  exit 0                                  # 已在跑，不重启
fi
systemctl enable --now "dsh-web-$NAME"
```

unit 的 Environment 必须是这三行：

```ini
Environment=HOME=<base>/users/<name>
Environment=DSH_HOME=<base>/users/<name>/.dsh
Environment=DSH_AGENTS_HOME=<base>/users/<name>/.agents
Environment=DSH_PERMISSION_MODE=workspace-write
ExecStart=<node> <base>/dsh --profile web --host 127.0.0.1 --port <port> --trusted-host <反代 authority>
```

### 4.3 硬约束

- **不覆盖 `.credentials.yaml`**：存在即视为用户已配置
- **不覆盖 `cordis.patch.yml`**：用户装过的插件不能被重装抹掉
- **不覆盖 `profiles/web/package.json`**：这是插件清单，重写会丢依赖
- **不删除 `workspace/` 下任何内容**：初始化只补空目录
- **目录权限只收紧不放宽**：已存在时 `chmod 0700`，不改成 `0755`
- 重复执行 `userctl add` 必须是安全操作，结果与首次一致

## 5. 默认工作区与闲聊

dsh 的 session 必须绑定一个工作目录，所以每个用户预置一个工作区：

```
workspace/日常/
```

- 闲聊、问答、调 skill、上传图片、临时导出，全部落「日常」
- 多个会话可在「日常」下并存
- 想认真做项目：再建 `workspace/<project>/`，切过去
- 用户无需“先建项目才能说话”

「日常」只是目录名，语义是“没有项目时的落点”，不是特殊模式。

**注意**：沙盒的可写根是 **session 的 cwd**，不是 `workspace/` 根。会话在 `workspace/日常/` 时，写不到 `workspace/<project>/`。这是预期行为，切换项目要切换会话目录。

## 6. 文件与产物

### 6.1 写路径

| 路径 | 执行者 | 边界 |
|---|---|---|
| `fs` 工具 | dsh 进程（`vh-<name>`） | OS 权限，只能写自己目录 |
| `bash` / 子进程 | dsh 子进程 | 沙盒 `workspace-write`：可写 = session cwd + `/tmp` |
| 上传 | 网关 → `runuser` | 只能落自己 `workspace/` |

两层叠加：OS 账号保证读不到别人；沙盒减少 agent 误写 `.dsh` 的概率。

### 6.2 沙盒的真实边界

`workspace-write` 不是安全边界，是**防误操作**：

| 维度 | 实际 |
|---|---|
| 可写 | `session.cwd` + `/tmp` + `os.tmpdir()` |
| 可读 | **全盘**（bwrap `--ro-bind / /`、Landlock `readOnly: ['/']`） |
| 网络 | **不受限**（无 `--unshare-net`） |
| 可降级 | 用户在 UI 选 `danger-full-access` preset → 写保护与审批同时关闭 |

所以：

- agent **能读自己的** `~/.dsh/.credentials.yaml`
- agent **能 `curl` 自己的实例**
- 用户主动放宽权限后，`.dsh` 可写

这三条不是漏洞，是选定的取舍。缓解措施见 §6.4 与 §11。

### 6.3 可见性

- 文件抽屉范围硬限 `workspace/`
- 隐藏文件不可下载（`.credentials.yaml`、`.dsh`、`.agents`）
- 自动定位到当前会话的 cwd

### 6.4 LLM 凭据：网关代理（推荐）

agent 侧不持有真 key，网关持有并注入。可行性已核验：

- key 每次请求解析（`resolveAuth`），header 是 `x-api-key`
- base URL 可由 `DEEPSEEK_BASE_URL` 或插件配置覆盖
- 网关丢弃 `x-api-key` 换成真 key 即可

五个实现约束：

| # | 约束 | 后果 |
|---|---|---|
| 1 | agent 侧必须有**非空占位 key**（如 `gateway-managed`） | 否则 `MISSING_CREDENTIAL`，请求发不出去 |
| 2 | 网关不能返回 3xx | `redirect: 'error'` 直接抛错 |
| 3 | SSE 必须是合法 Anthropic Messages 格式，`event:` 与 `data.type` 一致 | 否则 `MALFORMED_RESPONSE` |
| 4 | `POST /v1/files` 也带 `x-api-key` | 图片/附件 offload 会走，需要一起代理 |
| 5 | web search 是另一套：`authorization: Bearer` + `DEEPSEEK_SEARCH_BASE_URL` | 要联网搜索需单独代理 |

不做的后果：agent 能读到自己的 key。若 key 是**平台共享**的，一个用户泄露 = 全平台额度泄露；若**每用户独立**，影响面仅该用户。所以要么走网关，要么接受“每用户独立 key + 泄露影响面可控”。

platform OAuth（余额、资料）是另一套凭据，单槽位，每用户独立 `DSH_HOME` 天然隔离，不受影响。

### 6.5 版本（可选，默认开）

每个 workspace 初始化成 git 仓库，agent 每完成一个任务自动 commit（message 带会话 ID），用户可回退。没有版本，“agent 改坏了”无解。

落地要点：

- 需要一个新的 dsh 插件，挂在 turn 结束事件上
- 初始化时写 `user.name` / `user.email`，否则 commit 失败
- `.git` 在 `workspace/` 内，用户可见（这是好事）

### 6.6 docker

**本期不提供 docker 隔离，也不把 `/var/run/docker.sock` 暴露给用户环境。**

- 部署形态是裸机 systemd，不用容器做隔离
- agent 无法 `docker build` / `docker run`
- 需要容器内工作流的任务本期不支持
- 沙盒本身没有 net namespace，所以这是“不开放”而非“隔离住”

## 7. 插件

**落点不是 `cordis.patch.yml`**，而是 profile 变成一个独立 pnpm 项目：

```
$DSH_HOME/profiles/web/
  package.json        dependencies + dsh.profile.bundles
  pnpm-lock.yaml
  node_modules/
  cordis.patch.yml    仅在开关某个 entry 时写
```

- 市场安装 = 在该目录跑 `pnpm add <spec>`
- 每用户独立 `DSH_HOME` → 插件互不影响
- 热启用经 HMR，需要重启时只重启该用户进程
- 网关不参与插件安装，只路由

两个运维注意：

- 磁盘按「用户数 × 插件体积」预算，每用户一份 `node_modules`
- `pnpm add` 会执行 postinstall 脚本。市场开放等于允许任意安装脚本，建议白名单或禁用 scripts

## 8. 隔离层次

| 层 | 机制 | 防什么 |
|---|---|---|
| 网络 | 只监听 `127.0.0.1` | 公网直连 |
| 回环 | iptables 按 uid 只放行自己端口（仅 `lo`、逐目标端口 REJECT） | `curl` 打别人实例 |
| 实例 | 每用户独立进程与端口 | 会话、内存、插件共享 |
| 账号 | `vh-<name>` + `DSH_HOME` 0700 | 文件互读 |
| 凭据 | `.credentials.yaml` 0600 + `assertOwnerOnly` | Key 跨用户 |
| 沙盒 | dsh `sandbox-local`（`workspace-write`） | agent **误写** `.dsh`；不防主动降级 |
| 资源 | systemd `MemoryMax` / `CPUQuota` / `TasksMax` | 单用户拖垮整机 |
| 网关 | 零权限 + `runuser` 降权 | 网关失守放大 |

补充两条实现约束：

- iptables 规则必须**只作用于 `lo`**，否则会掐断 LLM 出站
- 必须**按目标端口逐条 REJECT**，不能按 uid 全量拒绝，否则内核回包被一并掐掉

## 9. 生命周期

```
VOS 登录 → 网关会话 Cookie
        → 首次访问：幂等初始化 + 起实例
        → 后续：反代到该用户端口
        → 默认常驻（systemd Restart=on-failure）
        → 可选空闲回收：见下
        → 升级：逐实例摘流重启
```

### 9.1 空闲回收（可选，默认关）

dsh **没有 `/health` 或活动状态端点**，`session/writer-held` / `agent-busy` 只是 RPC 错误码，不能被动查询。

唯一可靠的信号：

- 对 `$DSH_HOME/sessions/**/session.lock` 做非阻塞 `LOCK_EX|LOCK_NB` 试探，`EWOULDBLOCK` = 有活跃写者
- 网关记录该用户最近一次 `/api` 请求时间

两个条件同时满足才能 stop。**只看 WebSocket 流量会误杀长任务。**

### 9.2 关闭语义

SIGTERM 的行为：

- `exit 0`，**5 秒硬上限**
- 正在跑的 turn 被 **abort**，不是等它结束
- 已接受的 session 写入由句柄 close 时 drain 落盘

所以回收可能中断用户任务。默认常驻可以完全避开这一类故障。

## 10. 明确不做

- 不在 dsh 里加租户字段
- 不替换 `fs` / `subprocess` / `shell`
- 不做 chroot / agent-room / namespace 执行舱作为隔离层
- **不做 docker / 容器隔离**
- 不开放 `/var/run/docker.sock`
- 不做单进程多租户
- 不给用户编辑器或终端
- 不做跨用户共享目录（二期另议）

## 11. 残留风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| agent 读自己的 `.credentials.yaml` | 用户 key 泄露 | 网关代理 key（§6.4） |
| agent `curl` 自己的实例 | 可调用自己实例的全部 API | 影响面仅自己；iptables 只防跨用户 |
| 用户切 `danger-full-access` | 沙盒失效，`.dsh` 可写 | 产品决策；可删掉该 preset |
| 安装树可写 | 跨租户代码注入 | `find -perm /022` 必须为 0 |
| 插件 postinstall | 任意安装脚本 | 市场白名单 / `--ignore-scripts` |
| 空闲回收误判 | 中断正在跑的任务 | 默认常驻；双条件判定 |

## 12. 待定

| 项 | 备选 | 建议 |
|---|---|---|
| workspace 是否默认 git | 是 / 否 | 是 |
| 模型 Key 来源 | 用户自填 / 网关注入 | 网关注入（§6.4） |
| 是否保留 `danger-full-access` preset | 保留 / 删除 | 删除，或加二次确认 |
| 空闲回收时长 | 关闭 / 30 / 60 min | 关闭 |
| 预热池大小 | 0 / 1–2 | 0（常驻优先） |
| 磁盘配额 | project quota / 定时 du | 定时 du + 告警 |

## 13. 验收

| # | 用例 | 期望 |
|---|---|---|
| D1 | A 的 agent `cat ../../B/.dsh/.credentials.yaml` | 权限拒绝 |
| D2 | A 的 agent `curl 127.0.0.1:<B端口>/` | 连接被拒 |
| D3 | A 的浏览器 `session/list` | 只返回自己的会话 |
| D4 | A 的市场装插件后 B 的列表 | B 看不到该插件 |
| D5 | 网关进程被 kill | 用户实例不受影响 |
| D6 | 重复 `userctl add alice` 三次 | 结果与首次一致，无覆盖 |
| D7 | `find <base>/dsh -perm /022` | 输出 0 |
| D8 | 回收后重新访问 | 冷启动可用，会话完整 |

## 14. 源码索引

| 结论 | 位置 |
|---|---|
| 沙盒默认 `workspace-write` | `packages/bundle/base/cordis.patch.yml:243-247` |
| `danger-full-access` preset 关闭审批 | `packages/bundle/base/cordis.patch.yml:264-276` |
| bwrap `--ro-bind / /`（全盘可读） | `packages/sandbox/sandbox-local/src/profiles.ts:17` |
| 可写根 = cwd + tmp | `packages/sandbox/sandbox/src/roots.ts:52-55` |
| 无 net namespace | `packages/sandbox/sandbox-local/src/profiles.ts:16-23` |
| 插件安装 = profile 内 `pnpm add` | `packages/boot/plugin-manager/src/index.ts:528`、`operations.ts:285-288` |
| profile patch 只在开关 entry 时写 | `packages/boot/plugin-manager/src/patch.ts:25,76` |
| 三个 home 的解析顺序 | `packages/util/home-paths/src/index.ts:135,151` |
| key 每次请求解析 | `packages/llm/llm-deepseek/src/adapter.ts:98` |
| baseURL 可配 | `packages/llm/llm-deepseek/src/config.ts:300` |
| SSE 强校验 | `packages/llm/llm-deepseek/src/sse.ts:13,22` |
| session 锁（单会话粒度） | `packages/session/session-persistence-jsonl/src/lease.ts:40,71-98` |
| 无 `/health` 端点 | `packages/host/webserver/src/index.ts:366-403` |
| SIGTERM 5s 上限、turn 被 abort | `apps/cli/src/process-shutdown.ts:4`、`apps/cli/tests/web-agent-shutdown.e2e.ts:74-78` |
| `--trusted-host` 不建立身份 | `packages/client/connection/src/api-request-trust.ts:12` |
