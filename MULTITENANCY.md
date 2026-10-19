# v-harness 多用户设计

**v-harness 是多进程架构：1 个网关 + 每用户 1 个 dsh 进程。**

不是单进程多租户，不是"共享 dsh + 服务替换"，而是每个用户一个独立的 Node 进程、一个独立 OS 账号、一份独立 `DSH_HOME`。

## 0. 定位

v-harness 是 **dsh 的服务器化外壳**，不是 IDE。

- dsh 负责 agent 能力：会话、工具、插件、沙盒
- v-harness 负责：多人各自使用、互不可见、可运维
- 用户只做两件事：**提需求、验收产物**；不提供编辑器，不提供给用户用的终端

设计只围绕一个判断：

> **隔离由操作系统负责，不由 dsh 负责。**

dsh 内部不做任何租户判断，它只在自己的账号和自己的目录里跑。

## 1. 进程模型（多进程）

```
gateway                  1 个进程（共享）
dsh instance × N         每用户 1 个进程
```

| 项 | 值 |
|---|---|
| 进程数 | `1 + 在线用户数` |
| 每个 dsh 进程 | 独立 `DSH_HOME`、独立端口、独立 profile、独立插件、独立会话 |
| 进程间共享 | 只有只读的安装目录与 `node_modules` |
| 进程间不共享 | 内存、插件、会话、凭据 |
| 网关 | 不加载任何用户插件，只做鉴权与反代 |
| 单用户成本 | 约 180–280 MB RSS |
| 10 个在线 | 约 2–3 GB |

**为什么必须多进程**：插件是任意 JS，安装后在主进程里执行。只要 A、B 共用一个进程，B 的插件就能 `import('node:fs')` 读 A 的数据，没有任何配置能挡住。`isolate` realm 是逻辑作用域，不是安全边界。

**怎么轻量化**：共享只读的 dsh 安装目录与 `node_modules`、pnpm store 硬链接、懒启动、空闲 30 min 回收、预热池 1–2 个。轻量只能压常数，不能省掉进程。

**不做的中间态**：不做"单进程 + 替换 `fs`/`subprocess`/`shell`"，因为插件仍在主进程，隔离不成立；也不做"插件跑 worker、主进程共享"，那等于在 dsh 里重写进程模型，工作量大且偏离 dsh 的 profile 设计。

## 2. 架构

```
浏览器 ──https──▶ TLS 反代 ──▶ v-harness gateway（1 个进程）
                                    │
                                    ├─ 登录 / 会话 / 限流 / 路由 / 生命周期
                                    ├─ 文件操作经 sudo 助手降权
                                    │
                                    ├─▶ dsh #1  vh-alice  :3101  DSH_HOME=/opt/v-harness/users/alice/.dsh
                                    ├─▶ dsh #2  vh-bob    :3102  DSH_HOME=/opt/v-harness/users/bob/.dsh
                                    └─▶ dsh #N  vh-<name> :310N  ...
```

关键点：

- 所有实例只监听 `127.0.0.1`，公网只能走反代
- 网关对用户目录**零权限**，文件访问 `runuser -u vh-<name>`
- 回环防火墙按 **uid** 只放行自己的端口（防止 agent 用 `curl 127.0.0.1:<别人端口>`）
- profile 固定为 `web`，每用户 `DSH_HOME` 独立，插件互不影响
- 每个实例由独立 systemd unit 管理：`dsh-web-<name>.service`

## 3. 目录布局

```
<base> = /opt/v-harness

<base>/
  users/<name>/                0700  vh-<name>
    ├─ .dsh/                   DSH_HOME：profile、注册表、会话、凭据
    │   └─ profiles/web/       cordis.patch.yml、插件
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

## 4. 用户初始化：幂等

**没有就创建，有就跳过，绝不覆盖。**

### 4.1 判定顺序

| 对象 | 已存在 | 不存在 |
|---|---|---|
| OS 账号 `vh-<name>` | 跳过 `useradd` | `useradd --system --no-create-home --shell /usr/sbin/nologin` |
| 用户根目录 | **只校正** `0700` + 属主 | `mkdir -p` + `chmod 0700` + `chown` |
| `.dsh/` | 只补缺失文件 | 初始化 |
| `profiles/web/` | 只在缺 `cordis.patch.yml` 时写 | 写入默认内容 |
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

### 4.3 硬约束

- **不覆盖 `.credentials.yaml`**：存在即视为用户已配置
- **不覆盖 `cordis.patch.yml`**：用户装过的插件不能被重装抹掉
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
- 用户无需"先建项目才能说话"

「日常」只是目录名，语义是"没有项目时的落点"，不是特殊模式。

## 6. 文件与产物

### 6.1 写路径

| 路径 | 执行者 | 边界 |
|---|---|---|
| `fs` 工具 | dsh 进程（`vh-<name>`） | OS 权限，只能写自己目录 |
| `bash` / 子进程 | dsh 子进程 | dsh 沙盒 `workspace-write`，可写根 = `workspace/` |
| 上传 | 网关 → `runuser` | 只能落自己 `workspace/` |

两层叠加：OS 账号保证读不到别人；沙盒保证写不坏 `.dsh`。

### 6.2 可见性

- 文件抽屉范围硬限 `workspace/`
- 隐藏文件不可下载（`.credentials.yaml`、`.dsh`）
- 自动定位到当前会话的 cwd

### 6.3 版本（默认开）

每个 workspace 初始化成 git 仓库，agent 每完成一个任务自动 commit（message 带会话 ID），用户可回退。没有版本，"agent 改坏了"无解。

## 7. 插件

- 市场按 **profile** 安装：写入该用户 `profiles/web/cordis.patch.yml`
- 每用户独立 `DSH_HOME` → 插件互不影响
- 热启用经 HMR，需要重启时只重启该用户进程
- 网关不参与插件安装，只路由

## 8. 隔离层次（进程级）

| 层 | 机制 | 防什么 |
|---|---|---|
| 进程 | 每用户一个 dsh 进程 | 插件、内存、会话共享 |
| 网络 | 只监听 `127.0.0.1` | 公网直连 |
| 回环 | iptables 按 uid 只放行自己端口 | `curl` 打别人实例 |
| 账号 | `vh-<name>` + `DSH_HOME` 0700 | 文件互读 |
| 凭据 | `.credentials.yaml` 0600 + `assertOwnerOnly` | Key 跨用户 |
| 沙盒 | dsh `sandbox-local`（bwrap，`workspace-write`） | agent 写坏 `.dsh` |
| 资源 | systemd `MemoryMax` / `CPUQuota` / `TasksMax` | 单用户拖垮整机 |
| 网关 | 零权限 + `runuser` 降权 | 网关失守放大 |

## 9. 生命周期

```
VOS 登录 → 网关会话 Cookie
        → 首次访问：幂等初始化 + 起实例
        → 后续：反代到该用户端口
        → 空闲 30 min：stop（保留目录）
        → 再访问：start（冷启动 1–2 s）
        → 升级：逐实例摘流重启
```

## 10. 明确不做

- 不做单进程多租户
- 不替换 `fs` / `subprocess` / `shell`
- 不做 chroot/agent-room 作为隔离层
- 不在 dsh 里加租户字段
- 不给用户编辑器或终端
- 不做跨用户共享目录（二期另议）

## 11. 待定

| 项 | 备选 | 建议 |
|---|---|---|
| workspace 是否默认 git | 是 / 否 | 是 |
| 模型 Key 来源 | 用户自填 / 网关注入 | 网关注入，落用户私有凭据 |
| 空闲回收时长 | 15 / 30 / 60 min | 30 min |
| 预热池大小 | 0 / 1–2 | 1 |
| 磁盘配额 | project quota / 定时 du | 定时 du + 告警，简单 |
