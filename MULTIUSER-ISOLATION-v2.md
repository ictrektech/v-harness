# v-harness 多租户隔离方案（v2）

> **已废弃 2026-11-05**：本文描述的每租户 `ip netns` + pasta 网络隔离已从代码中删除，租户现共享容器网络（见 [MULTIUSER.md](MULTIUSER.md) 的「已知取舍」）。保留本文仅作设计记录，任务列表与代码落点不再代表现状。

[v1 原稿](MULTIUSER-ISOLATION.md) · [部署总览](MULTIUSER.md)

目标不变：用户 A 的实例里，B 不存在。

v1 是目标态描述；v2 以当前代码为基线，修正了 v1 与实现不符、以及 v1 自身遗漏的点。每条决策给出理由，改动清单落到具体文件。

---

## 任务列表

状态：P1–P5 ✅ 已完成并验证；P6（§5.1–5.3）仅有设计，未实施；P7 ✅ 已完成（私有网络命名空间，取代 P5 的 nft 规则）。每阶段独立可回滚；P3 与 P4 有依赖顺序（先有 `/home` 视图，`tenantRoot` 解析才正确）。验收命令见 §9。

### ~~P1 独立修复~~ ✅

- [x] `gateway/server.mjs`：登录落 `identity user=<account> sub=<subject> created=<bool>`（原日志缺 sub）
- [x] `gateway/users.mjs`：保留名覆盖 `vh-*` 前缀（撞 jail 生成的 `vh-<account>` 命名空间）；纯中文空 slug 改为 `u1001` 起递增
- [x] `gateway/instances.mjs`：`rewriteJailPaths` 递归遍历 `storages/`（原来只扫一层，嵌套路径漏改）

### ~~P2 会话层~~ ✅

- [x] `gateway/session.mjs`：HMAC 自签删除；`openSessionStore()` 基于 SQLite（`$STATE_ROOT/sessions.db`，WAL），`createSession / loadSession / revokeSession / revokeSubject`，UA 绑定 + 滑动续期
- [x] `gateway/server.mjs`：`authenticate()` 查表；登录收编为 `POST /__vh/session`（旧 `/__vh/auth` 兼容保留）；新增 `GET /__vh/whoami`；`/__vh/logout` 撤销会话 + 停实例；API 请求 5 分钟 sub 复核（`subjectRecheck`，VOS 不可达 fail-open 且节流）
- [x] `gateway/instances.mjs`：实例 Map 与 `state-instances.json` 键 namespace → subject；`migrateInstanceStateKeys()` 启动时一次性迁移
- [x] `bin/entrypoint`：`node:sqlite` 可用性探测，旧 22.x 自动加 `--experimental-sqlite`
- [x] 测试：`gateway/session.test.mjs`（9 用例：往返、UA 重放、过期、滑动、双撤销路径）

### ~~P3 jail 视图 `/home/<account>`~~ ✅（与 storages 重写原子落地）

- [x] `bin/vh-jail`：home 绑定 `$root/home/<account>`；passwd home 字段；内层自检改为"`/home` 唯一 + `/data` 必须不存在"；`HOME=/home/<account>`
- [x] `gateway/instances.mjs`：`jailHome = /home/<account>`（与物理根解耦）；`rewriteJailPaths` v3（stale 增 `/data/<account>`，marker `.jail-paths-home-v3`）
- [x] `userPaths` 调用点 `dataRoot:` → `stateRoot:` 改名（D7，行为零变化）
- [x] 验证：双层 `bash -n` + 网关启动冒烟

### ~~P4 沙箱~~ ✅

- [x] `packages/sandbox/sandbox-local/src/profiles.ts`：补 `--unshare-ipc`；`--dev`/`--dev-bind` 与 `--tmpfs /tmp`/`--bind /tmp /tmp` 均按 `tenantRoot` 条件化（jail 内复用私有 dev 与 512m tmpfs，裸开发机保持全新 devtree/tmpfs）
- [x] `local.spec.ts` 四组 bwrap 断言更新（41 测试全过）
- [x] `tenantRoot` 下发链路核对：`sandbox-policy` Config、`sandbox` 类型、`vos.patch.yml` 的 `tenantRoot: process.env.HOME` **均已在位**，无需改动
- [x] `danger-full-access`：VOS 部署的 preset 替换已在 `vos.patch.yml` 生效；base `cordis.patch.yml` 保持不动（非部署形态仍可用），已核对 approval policy 不受影响

### ~~P5 nft 端口屏蔽~~ ✅（已被 P7 取代）

- [x] `bin/vh-jail` `net_isolate()`；`gateway/instances.mjs` 下发 `VH_JAIL_PORT`；`Dockerfile` 装 `nftables`；compose 加 `NET_ADMIN` —— 细节见 §5

P7 落地后 `net_isolate()` 已删除：命名空间隔离的是整张网络表，不再需要按 uid 丢弃保留段的规则。

### ~~P7 私有网络命名空间~~ ✅

每个租户一个持久 `ip netns`（`vh-<account>`），pasta（passt）以用户态方式提供外网、DNS 与独立 loopback；实例与服务都在其中监听自己的 `127.0.0.1`，跨租户同名端口不再相遇。

- [x] `bin/vh-jail`：建/复用命名空间；pasta 按命名空间单例（pidfile + `flock`，跨 jail 存活，服务重启不会掐断实例）；`--config-net` 配地址路由、`--map-host-loopback` 让租户能回到网关、`--dns-forward 10.0.2.3` 接管 resolv.conf 里的上游；缺 `VH_PREVIEW_IP` / `VH_GATEWAY_IP` 或 pasta 不支持上述选项时拒绝启动
- [x] `gateway/netns.mjs`：`previewIp(uid)`（宿主回环 `127.<n>.<m>.1`，两端唯一真源）、`GATEWAY_IP`（租户视角的网关地址，默认 `10.0.2.2`）、`netnsName(account)`
- [x] `gateway/instances.mjs`：实例带 `uid`；cookie 交换与端口回收（`ip netns exec … ss`）都改走命名空间视角；`VH_PREVIEW_IP` / `VH_GATEWAY_IP` 随启动下发
- [x] `gateway/server.mjs`：实例反代/WS 隧道与 `/__vh/svc/<port>` 反代一律连租户发布地址（Host 头仍是 `127.0.0.1:<port>`，那是 cookie 的 authority）
- [x] `gateway/scheduler.mjs`：`VH_SCHEDULER_URL` 用 `GATEWAY_IP` 而非 `127.0.0.1`（命名空间里的 `127.0.0.1` 是租户自己的）
- [x] `gateway/services.mjs`：重启 jail 带上 `VH_JAIL_PORT` / `VH_PREVIEW_IP` / `VH_GATEWAY_IP`，否则它启的 pasta 会漏掉实例端口的转发
- [x] `Dockerfile` 装 `passt`、去掉 `nftables`；compose 加 `/dev/net/tun` 设备；`CAP_NET_ADMIN` 保留（pasta 建 tap、配地址）
- [x] `bin/network-probe.mjs` + `bin/entrypoint`：启动时清理遗留命名空间与 pasta pidfile，然后用临时命名空间做一次双向实测（网关→租户 loopback、租户→`GATEWAY_IP`），失败即拒绝启动并打印结构化报告——pasta 的转发语义、`--map-host-loopback` 的方向、镜像里的 pasta 版本都不再是"上线后才知道"

已知边界：pasta 启动即绑定每条转发，所以浏览器可达端口是固定清单（实例端口 + `3000-3099` / `5173` / `8000-8099` / `9000-9099`）；清单外的服务租户自己能连，面板打不开。

### P6 私有 Docker + 服务面板 + 预览反代（设计已定，未实施）

- [ ] `bin/vh-jail`：cgroup2 旁路挂载、降权前以 jail-root 起 `dockerd`、`/run/docker.sock` chown 给租户 uid、`/var/lib/docker` 绑租户卷 `~/.docker`（§5.1）
- [ ] `Dockerfile` 加 `docker.io`；应用清单加 `SYS_ADMIN`（与 `NET_ADMIN` 同处）
- [ ] `gateway/services.mjs`：`nsenter -n ss -ltnp` 扫描 + `.dsh/services.json` 读写 + `/__vh/services` 五个路由（§5.2）
- [ ] `gateway/server.mjs`：`/preview/<account>/<port>/` 反代（账号校验、端口白名单、剥 cookie、`no-store`）+ `upgrade` 分支（§5.3）
- [ ] 测试：`gateway/services.test.mjs`（uid/保留段过滤、`cmdline`/`cwd` 补齐、FIFO 上限）、预览路由（跨账号 403、实例段 403、cookie 剥离）

P6 内部顺序：先 5.1（没有私有 docker，"嵌套容器端口"那条边界无从验证），再 5.2 的 `GET`，最后 5.3 反代——反代是面板"打开"按钮的前置条件。

---

## 0. 与 v1 的关键差异

| # | v1 | v2 | 理由 |
|---|---|---|---|
| D1 | 物理目录搬到 `/data/users/<account>` | **物理布局保持 `<DATA_ROOT>/<account>`** | entrypoint 已完成 `/data/users/<ns>` → `/data/<account>` 迁移（`bin/entrypoint:36-47`），commit `6d1971db` 专门做了这次收敛。再搬一次只增加风险，无隔离收益 |
| D2 | jail 内 home 挂在 `/data/<account>` | **jail 内挂在 `/home/<account>`，`/data` 不存在** | 达成 v1 的 ENOENT 目标（v8 验收 `ls /data` → No such file），同时物理卷不动（D1）。挂载点与物理路径解耦即可 |
| D3 | 会话表 `/data/sessions.db` | **`$STATE_ROOT/sessions.db`** | 网关状态与租户 home 分离是既定原则（`instances.mjs` 注释、entrypoint 0700）；`/data` 是 home 根，不该混入网关文件 |
| D4 | cookie 名 `__Host-vh_sid` | **保留现名 `vh_session`**，HTTPS 时附加 `Secure` | 拒绝 `__Host-`：它要求 HTTPS 源，而 bootstrap 页注释明确"内部 VOS portal 常为纯 HTTP"（`server.mjs:172`），HTTP 部署上 cookie 直接写不进去。也不改名（`vh_sid` 之类）：现名是 `vh_session`（`session.mjs:14`），改值不改名，重命名等于全员强制重登，无安全收益 |
| D5 | 未提及网络隔离 | **新增 §5：nft 按租户 uid 屏蔽其它实例端口** | `unshare` 未加 `--net`（模型调用需要外网），所有租户 dsh 在同一 loopback 上。v1 §8 的 `ss -lntp` 因 PID ns 看不见别人，给人假象 |
| D6 | bwrap `--dev-bind /dev /dev`、不挂 `--tmpfs /tmp` | **dev 与 /tmp 都按 `tenantRoot` 条件化**：jail 内用 `--dev-bind /dev /dev` + 可写 `--bind /tmp /tmp`；裸开发机保留 `--dev /dev` + `--tmpfs /tmp` | `--dev` 让 bwrap 自建 dev 树，`/dev/shm` 变成不受 64m 限制的新 tmpfs；但 `--dev-bind` 在裸开发机上会把宿主 `/dev` 以可写交给沙箱进程——两个方向都有坑，条件化后两条路都显式正确（§6） |
| D7 | — | **`userPaths` 参数改名（可读性重构，不是 bug 修复）** | 调用点 `dataRoot: STATE_ROOT` 的字面名有误导，但行为是对的：`userPaths` 的 home 取模块常量 `HOME_ROOT`（`instances.mjs:62`），入参只喂 log 路径。改名消除误导，随 P3 落地 |
| D8 | 未提及 | **新增 §5.1：jail 内嵌套 dockerd，每租户私有** | 用户把 jail 当独立 VPS 用，`docker ps` 只看自己是最小可用语义；共享网络下只能 `--network host`，否则多个 daemon 抢全局 iptables |
| D9 | 未提及 | **新增 §5.2/§5.3：服务面板 + `/preview/<account>/<port>/` 反代** | 隔离解决了"别人看不见"，但也让用户找不回自己起的服务；且租户服务监听在 `127.0.0.1`，没有反代从浏览器根本到不了。端口区间只保留 `3100-3999`，不再设"从 30000 起"的下限（与 nft 规则实际范围对齐） |

沿用 v1、代码已达标、不再重复的部分：jail 根树与自检（`bin/vh-jail`）、遮蔽式 bwrap 骨架与 `tenantRoot`（`packages/sandbox/sandbox-local/src/profiles.ts`）、account slug 生成骨架（`gateway/users.mjs`）、`rewriteJailPaths` 的 marker 机制。

---

## 1. 现状基线（代码事实）

- 会话：`gateway/session.mjs` HMAC 无状态 cookie（`vh_session`），无撤销、无 sub 复核；`/__vh/logout` 只清 cookie。
- 实例：`gateway/instances.mjs` 以 `namespace` 为 Map 键；dsh cookie 存 `$STATE_ROOT/state-instances.json`（键也是 namespace）。
- jail：`bin/vh-jail` home 绑定在 `$root/data/<account>`；jail 内 `/data` 存在。
- 沙箱：`profiles.ts` 已有 `TENANT_MASK_ROOTS` 与回绑，但用 `--dev /dev`，workspace-write 挂了 `--tmpfs /tmp`。
- 运行时：基础镜像 `node:22-bookworm-slim`（`node:sqlite` 需 `--experimental-sqlite`）；网关零 npm 依赖。

---

## 2. 账号（`gateway/users.mjs`）

v1 §1 规则基本保留，三处对齐：

1. 清洗后为空 → `u1001` 递增（当前是 `user-2`），落库与日志统一用它。
2. `RESERVED_ACCOUNTS` 增加前缀保留：候选命中 `^vh-` 视同保留名（v1 提到 `vh-*`，代码集合漏了）。
3. 创建/更新时打一行 `identity user=<account> sub=<subject> created=<bool>`（当前日志缺 `sub`，排障必需）。

`uid`/`port` 一次分配永不复用的现有规则不变。

---

## 3. jail（`bin/vh-jail`）

改动最小化：根树、设备、tmpfs、自检全部保持现状（已达标且超出 v1），只动三处：

1. **挂载点**：`mount --bind "$VH_JAIL_HOME" "$root/home/$account"`；`mkdir -p "$root/home"`，不再创建 `$root/data`。`/etc/passwd` 的 home 字段写 `/home/<account>`。
2. **入参语义**：第 3 参仍是宿主侧 home（`<HOME_ROOT>/<account>`，校验不变），新增内部变量 `JAIL_HOME=/home/<account>` 用于 chroot 后的 `HOME`/`cd`/`passwd`。
3. **自检统一**：所有断言改成 `[ cond ] || die "..."` 形式（`[ -e /data ] && die` 这种混用在 `set -e` 下语义脆弱），并补一条 v1 的 `readlink /proc/self/ns/mnt ≠ /proc/1/ns/mnt`。

保留现有超出 v1 的部分：`--make-rprivate`、ulimit、XDG/npm prefix 导出、`/etc/mtab`、`dev/fd` 软链。XDG 等 env 的值从 `$VH_JAIL_HOME` 改为 `$JAIL_HOME`（由 `instances.mjs` 下发的 env 同步改，见 §7）。

---

## 4. 会话层（`gateway/session.mjs` + `server.mjs`）

### 4.1 存储

`node:sqlite`（`DatabaseSync`），启动参数加 `--experimental-sqlite`（`bin/entrypoint:51`）。文件 `$STATE_ROOT/sessions.db`，WAL 模式。表结构同 v1 §5.1，另加：

```sql
CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,   -- randomBytes(32) base64url
  subject    TEXT NOT NULL,
  account    TEXT NOT NULL,
  ua_hash    TEXT NOT NULL,      -- sha256(UA)，绑定防会话固定
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,   -- 默认 12h，滚动续期
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_subject ON sessions(subject);
```

UA 不一致 → 视为无效（防御 cookie 被复制到另一浏览器）。**代价明说**：用户换浏览器、浏览器大版本升级、或经过改写 UA 的代理，都会 401 掉线，这是安全换来的体验损失。先按严格语义上线；反馈不可接受时降级为"只告警不撤销"（`ua_hash` 保留作排障字段）。后台每次登录顺手 `DELETE FROM sessions WHERE expires_at < now` 清理。

### 4.2 API（替换 `session.mjs` 现有导出）

`createSession(subject, account, ua) / loadSession(sid, ua) / revokeSession(sid) / revokeSubject(subject)`。CSRF 双提交机制原样保留（`csrfMatches` 与 cookie 解析不动）。

### 4.3 server.mjs 流程

- `authenticate()`：查表，命中返回 `{subject, account, expiresAt}`；未命中 → 401 / bootstrap。
- 登录：`POST /__vh/session {access_token}`（替换现 `/__vh/auth`，旧路径一个版本内 302 到新路径）→ `verifyVosToken` → `upsertUser` → `createSession` → Set-Cookie。
- **sub 复核**：文档请求照旧走 bootstrap 无条件重新 authorize（现有行为已满足 v1 §5.3）；API 请求内存缓存 `{sid → sub, checkedAt}`，5 分钟复核一次；不一致 → `revokeSession` + 回 bootstrap。复核失败分两类：**VOS 明确拒绝**（token 被拒、userinfo 401/403，`VosAuthError.status`）→ 撤销该会话、fail closed，只影响本租户；**VOS 故障**（不可达、5xx、坏 payload）→ fail open 保留会话，复核窗口节流重试，避免"VOS 抖一下全员掉线"。
- 新增 `GET /__vh/whoami`：返回 `{subject, account, username, locale}`。
- `/__vh/logout`：`revokeSession` + `stopInstance(subject)` + 清 cookie（当前只清 cookie）。
- `instanceFor()` 改以 `subject` 查 `findUser`，不再信任 cookie 里的 namespace。

### 4.4 实例键

`instances` Map 与 `state-instances.json` 键从 `namespace` 改为 `subject`。读旧 state 文件时按 `users.json` 做 namespace → subject 一次性转换后重写。

---

## 5. 网络隔离（新增）

jail 保持共享网络（模型调用、网关代理都需要）。租户实例只监听 `127.0.0.1:<port>`，cookie 在租户 home 的 `.credentials.yaml` 里、租户只能拿到自己的，所以现状的实际风险是**纵深防御缺口**而非直接越权——但仍按 D5 收掉：

**已实施**（P5）。实现在 `bin/vh-jail` 的 `net_isolate()`：在 unshare 后的内层 bash 里、chroot 之前执行——此时仍是 root、网络命名空间与宿主共享，nft 操作直接落在宿主 ruleset 上。port 由 `gateway/instances.mjs` 通过 `VH_JAIL_PORT` env 下发（jail 的 argv 里只有包在里面的 dsh 命令，port 无法可靠推导）：

```
table inet vh-tenant
chain out { type filter hook output priority filter; policy accept; }
# 本租户 uid 访问 loopback 上除自己端口外的 3100-3999 一律丢弃
meta skuid <uid> ip  daddr 127.0.0.1 tcp dport 3100-3999 tcp dport != <port> drop comment "vh-<account>"
meta skuid <uid> ip6 daddr ::1       tcp dport 3100-3999 tcp dport != <port> drop comment "vh-<account>"
```

dsh 现只监听 `127.0.0.1`，IPv4 规则已覆盖现状；IPv6 那条防的是"以后某个服务监听 `::`"——一条规则的成本，换掉一整类未来漏洞。

**`3100-3999` 是保留段**：规则只放行本租户自己的实例端口，租户在 jail 里自己起的服务若监听这个区间会被自己的规则挡掉。约定因此只有一条——**租户自建服务不要监听 `3100-3999`**，区间外（`5173`、`8000`、`3004` 之类）随意。不额外设下限：nft 只丢保留段，文档若写"必须从 `30000` 起"，就与规则实际执行的范围不符，用户按文档改端口纯属多余。

生命周期与降级设计：

- **不做 trap 删除**：`vh-jail` 是 `exec` 链，退出钩子无处安放；且 `uid`/`port` 一次分配永不复用（`users.mjs`），残留规则对不存在的进程是惰性的。改为**启动时按 comment 标签先删后加**（`grep handle` → `delete rule ... handle`），同账号重启不重复累积。
- 网关（root）与外部 API 不受影响；能力走 unix socket（`.dsh/*.sock`），不经 TCP。
- 降级路径（全部打警告日志后继续，不算 fatal）：`VH_JAIL_PORT` 未设置、`nft` 不存在、建表/建链失败（无 CAP_NET_ADMIN）、加规则失败。主防线是 dsh 自身鉴权，此层是加固。
- 部署前提已落地：镜像加装 `nftables` 包（`Dockerfile`），应用清单加 `NET_ADMIN`（`ictrek.app/src/docker-compose.yml`；`dist/staging/` 为构建产物，随发布再生成）。

### 5.1 租户私有 Docker（嵌套 dockerd，新增）

需求：租户在终端里能跑 `docker ps / run / logs`，且**只看到自己的容器**——把 jail 当一台独立 VPS 用。

设计（已本地探针验证全链路：受限容器 + `SYS_ADMIN/NET_ADMIN` + seccomp/apparmor unconfined 的姿态下，嵌套 `docker run` 打通）：

- **daemon 位置**：`vh-jail` 在 chroot 内、降权前以 jail-root 启动 `dockerd`，socket 放 `/run/docker.sock` 并 chown 给租户 uid，`DOCKER_HOST` 注入租户环境。daemon 的 mount/pid/ipc namespace 就是租户 jail 的——嵌套容器的整个世界被关在租户的视图里（`/` 是 jail 根，`/data` 不存在），租户 `ps` 能看到自己的 daemon 和容器。
- **cgroup**：容器自带的 `/sys/fs/cgroup` 只读，`vh-jail` 在旁路 `mount -t cgroup2` 一个新的（内核自动限定在容器的 cgroup 子树，**不暴露宿主层级**）再 bind 到 jail 的 `/sys/fs/cgroup`；不可用时跳过 dockerd，打警告降级。
- **存储**：graph root 持久化在物理卷 `<HOME_ROOT>/<account>/.docker`，bind 到 jail 的 `/var/lib/docker`——镜像/容器状态随租户卷留存，不占 RAM。
- **网络**：`--iptables=false --bridge=none`。共享网络下多个 daemon 各自改全局 iptables 会互相打架，全部关掉；租户容器用 `--network host`。
- **生命周期**：daemon 是 jail pid-ns init（租户主命令）的后台子进程，实例结束随 pid namespace 一起被内核回收。
- **镜像**：`Dockerfile` 加装 `docker.io`（dockerd/CLI/containerd/runc 一次到位）。

代价与约定：

- 每租户常驻 dockerd + containerd 约 100–150MB 内存；镜像存储落在租户卷（不共享、按租户计）。
- 端口约定：**`3100-3999` 为实例保留段，租户自建服务（含嵌套容器映射）避开即可**；docker 默认映射到 `32768+`，天然落在区间外。
- 残余风险（明说）：嵌套容器进程以 root 跑在共享网络命名空间里，nft 的按 uid 规则对它失效——但它能到达的只有 dsh 自身鉴权保护的实例端口，且文件系统视图仍锁死在租户 jail 内。嵌套容器以 root 向 `-v` 挂载的租户目录写文件会落 root 属主，建议容器内带 `--user $(id -u):$(id -g)`。
- 端口区间 `3100-3999` 对应 `FIRST_PORT=3101` 向上留量，规则生成放 `vh-jail` 内，不新增配置面。

### 5.2 租户服务面板（"我的服务"）

**缺口**：用户在 jail 里 `npm run dev -- --port 3004` 起了一个项目，当时能看到页面；页面一关、换个浏览器、过一小时回来，就不知道刚才是哪个端口、服务还在不在、怎么重新打开。

隔离解决"别人看不见"，这一节解决"自己找得回来"。

**面板**：

```
● 3004   npm run dev         ~/workspace/my-app      [打开] [停止]
● 8000   uvicorn main:app    ~/workspace/api         [打开] [停止]
○ 5173   npm run dev         ~/workspace/old-demo    [重新运行]
```

- `●` 运行中，`○` 已停止；已停止的保留命令与工作目录，一键重开
- 不显示 `3100-3999` 的实例端口（那是系统内部）
- "打开"就是 §5.3 的预览地址，用户不需要知道端口映射规则

**数据**：`~/.dsh/services.json`（jail 内视角；物理 `<DATA_ROOT>/<account>/.dsh/services.json`），跟着租户卷走：

```json
[
  {
    "port": 3004,
    "cmd": "npm run dev -- --host 0.0.0.0 --port 3004",
    "cwd": "/home/<account>/workspace/my-app",
    "lastStarted": "2026-11-03T10:20:00Z",
    "status": "running"
  }
]
```

`cwd` 记 jail 内路径（`/home/<account>/…`，与 §0 D2 一致）。网关读文件时做一次 `/home/<account>` → `<DATA_ROOT>/<account>` 前缀映射；文件内容只有一种视角，不存在"网关写一份宿主路径、dsh 读不懂"的双份状态。

`status` 由扫描结果决定，不靠用户操作；记录上限 50 条，FIFO。

**API**（网关，`/__vh/` 前缀）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/__vh/services` | 扫描结果与历史合并 |
| POST | `/__vh/services/<port>/open` | 返回预览 URL |
| POST | `/__vh/services/<port>/stop` | 杀进程树 |
| POST | `/__vh/services/<port>/restart` | 按记录重跑 |
| DELETE | `/__vh/services/<port>` | 删除历史 |

**扫描**：

```sh
nsenter -t <租户主进程 pid> -n ss -ltnp
```

- 只 `nsenter` 网络命名空间：jail 里 unshare 了 pid/mount，但网关仍在宿主 pidns，`ss` 报出的 pid 就是宿主 pid，`/proc/<pid>` 直接可读。
- 按 uid 过滤（`users.mjs` 分配的 uid 一租户一个），排除 `3100-3999`（实例保留段，见 §5），其余一律收下——`5173`、`8000`、docker 映射的 `32768+` 都该出现在面板里。
- 读 `/proc/<pid>/cmdline` 与 `/proc/<pid>/cwd` 补齐命令与目录；`cmdline` 是真值，比历史记录更可信时以扫描为准。

**预览**：面板里的"打开"就是 §5.3 那条反代路径，租户不需要理解端口怎么映射。

**边界**：

| 情况 | 处理 |
|---|---|
| 进程挂了 | 扫描发现端口消失 → `stopped`，记录保留 |
| 端口冲突 | 提示"3004 已被占用"，建议下一个可用端口 |
| 只监听 127.0.0.1 | 面板提示改成 `0.0.0.0`，给出一行命令 |
| 嵌套容器端口 | 扫描到的是宿主映射端口，同样走预览 |
| 项目目录被删 | 重开时提示 `cwd` 不存在 |

**不做**：独立的进程管理器（不替代 systemd/supervisor）、跨租户视图、在面板里编辑代码。

**落地**：新增 `gateway/services.mjs`，`server.mjs` 挂路由，一个前端卡片轮询；第一阶段只做 `GET`，第二阶段落盘与"重新运行"。

### 5.3 预览反代（`/preview/<account>/<port>/`）

租户服务监听在 `127.0.0.1:<port>`，浏览器在别的机器上。反代把两者接起来：

```
https://<域名>/app/com.ictrek.v-harness/preview/<account>/<port>/...
                            ↓ strip 前缀 + 鉴权
                        127.0.0.1:<port>/...
```

挂在 `APP_BASE_PATH` 下的第二个路由，与现有实例反代（`server.mjs:929-1000` 的 `stripPrefix` + `httpRequest`、`proxyUpgrade`）同一套机制，不引入新依赖。四条硬约束：

1. **`<account>` 必须等于会话账号**。路径里带账号是为了日志和排障可读，不是授权凭据——租户 A 改 URL 里的一段就想看 B 的服务，在路由入口直接 403，不进 `httpRequest`。
2. **端口必须是该租户扫描到的端口**。网关是 root，nft 的按 uid 规则对它不生效，不做白名单的话 `/preview/<A>/3103` 就是一条直通 B 实例端口的 SSRF。判定顺序：`3100-3999` 一律拒（实例段）、不在本租户 `services.json` 或当次扫描结果里的一律拒。
3. **剥 cookie**。转发前删掉 `cookie`/`authorization`，租户会话不该泄漏给一个用户随手起的 dev server；响应里的 `set-cookie` 一并删，dev server 的会话与网关无关。
4. **不缓存 + 透传 `Upgrade`**。`cache-control: no-store`，`location` 头去掉前缀再回给浏览器；`server.on('upgrade')`（`server.mjs:1060`）加一条同类分支，否则 vite HMR/`ws` 全挂。

**base path 是真问题**：dev server 输出的 `/assets/app.js` 是站根绝对路径，浏览器会请求到 `https://<域名>/assets/app.js`，绕过前缀。三条路里选第三条：

- 反代改写 HTML 里的绝对路径 —— 无底洞（内联脚本、动态 `import()`、sourcemap 全都要管），不做。
- 让用户在 jail 里记住 `--base` —— 记不住，且每个框架参数名不同。
- **面板生成命令时就把前缀写进去**，常见工具一张表：

| 工具 | 参数 |
|---|---|
| vite | `--base=/app/com.ictrek.v-harness/preview/<account>/<port>/` |
| next | `BASE_PATH=… ` 或 `next.config.js` 的 `basePath` |
| uvicorn/fastapi | `--root-path <前缀>` |
| streamlit | `--server.baseUrlPath <前缀>` |

面板的"重新运行"直接用记录里的 `cmd`，首次给出命令时按检测到的工具补上参数；检测不到就原样跑，并在卡片上标一行"该服务可能不支持子路径，建议用 `--host 0.0.0.0` 直接在实例端口外访问"。这句提示是备案，不是默认路径。

**不做**：自定义子域名（`<account>-<port>.<域名>` 需要泛域名证书与 DNS，部署侧成本远大于收益）、预览的访问统计、给预览加独立鉴权（复用会话即可）。

---

## 6. 沙箱（`packages/sandbox/sandbox-local/src/profiles.ts`）

对现有 `bwrapProfileArgs()` 的修改：

1. `/tmp` 条件化，**不是删除**——只删掉 `--tmpfs /tmp` 后，只读根下的 `/tmp` 可写性就得依赖 bwrap 的挂载语义细节（`--ro-bind` 的 remount 只作用于顶层挂载），这是不该赌的赌注：

```ts
if (policy.mode === 'workspace-write') {
  if (policy.tenantRoot !== undefined) {
    // jail 内：显式回绑 jail 的私有 tmpfs——可写、受 512m 上限、跨命令状态保留。
    args.push('--bind', '/tmp', '/tmp')
  } else {
    // 裸开发机：没有可复用的私有 /tmp，保持全新 tmpfs，
    // 沙箱进程读不到宿主 /tmp 的既有内容。
    args.push('--tmpfs', '/tmp')
  }
}
```
2. dev 同样条件化：jail 内（`tenantRoot` 存在）`--dev /dev` → `--dev-bind /dev /dev`（复用 jail 私有 dev，shm 保持 64m 上限）；裸开发机保留 `--dev /dev`（宿主 `/dev` 不能以可写交给沙箱进程）。
3. 补 `--unshare-ipc`（jail 已 unshare，bwrap 层补上是防止绕过 jail 直接调用沙箱的部署形态）。

遮蔽逻辑（`TENANT_MASK_ROOTS` + 回绑顺序）保持不变；jail 视图改为 `/home/<account>` 后，`tenantRoot` 由 `sandbox-policy` 从 `process.env.HOME` 解析（v1 §6 的 `vos.patch.yml` 条目成立）：patch 替换整段 config，需同时重述 `mode` 与 `workspaceRoot`。

`workspaceRoot` 也取 `$HOME`，不再是 `$HOME/workspace`。npm、pnpm、pip、uv、cargo 在写第一个项目文件之前就要写 `~/.npm`、`~/.cache`、`~/.local`；把可写根限制在 `workspace/` 的后果不是"更安全"，而是**每个会话都要先撞一次 `npm log directory not writable`，再由 agent 自己摸出 `npm_config_cache=...`**。隔离边界是 `tenantRoot`（兄弟租户的 home 在这个 jail 里不存在），把自己家目录写成可写不改变这一点。

`packages/bundle/base/cordis.patch.yml` 禁用 `danger-full-access` 预设（v1 §6 原条目）。

---

## 7. 实例启动（`gateway/instances.mjs` + `server.mjs`）

1. **`userPaths` 改名（D7，可读性）**：现状无 bug——home 取 `HOME_ROOT` 常量，入参只喂 log 路径。把调用点的 `dataRoot: STATE_ROOT` 改名 `stateRoot: STATE_ROOT`（与形参一致），或拆成 `userPaths(dataRoot, stateRoot, account)` 双参显式化，行为零变化。
2. **env 全量换 `jailHome = /home/<account>`**：`HOME/DSH_HOME/DSH_AGENTS_HOME/PATH/XDG_*/DS_BOT_*`（`instances.mjs:302-359`）；`--patch`、`--port` 等不变。传给 `vh-jail` 的第 3 参仍是宿主侧 home。
3. **`rewriteJailPaths` 两处加强**：
   - 遍历 `storages/` 改为递归（`readdir` `withFileTypes` + 目录入栈），当前只扫一层，子目录会漏；
   - `stale` 前缀追加 `/data/<account>`，`current` 改为 `/home/<account>`（dsh 从此记录 jail 内路径），marker 升 `.jail-paths-home-v3`。
4. 启动自检失败（`vh-jail` exit 97）→ 杀实例并把 stderr 透传到网关日志，不静默重试。

---

## 8. 数据迁移

物理目录**不搬**（D1）。实际动作：

1. 停网关与全部实例。
2. 部署新镜像；entrypoint 幂等重建账号（现有逻辑）。
3. 首个请求触发 `rewriteJailPaths` v3：storages 内 `/data/<account>` → `/home/<account>`（含递归子目录），session_projcache 删除重建。
4. `state-instances.json` 键 namespace → subject（§4.4，启动时一次转换）。
5. sessions.db 全新空表，旧 cookie 天然失效（HMAC cookie 校验直接失败）。

回滚：**不是镜像回退就完事**。`rewriteJailPaths` 是单向重写：旧代码的 stale 列表只有 `/data/users/<ns>` 和 `/home/<ns>`（`instances.mjs:209`），不会把 `/home/<account>` 改回去——直接回退镜像后 storages 里全是 jail 内不存在的路径，历史会话打不开。正确顺序：

1. 停网关与全部实例。
2. 跑随 P3 PR 提供的回写脚本：递归把 storages 内 `/home/<account>` → `/data/<account>`，删除 `.jail-paths-home-v3` marker。
3. 回退镜像并启动（v2 marker 保留未动，旧代码不会重复扫描）。

---

## 9. 验收（A 的 jail 内执行）

**以下命令都在 jail shell 里直接跑，不经 bash 工具沙箱。**两层行为不同是预期：jail 层 `/data` 根本不存在（ENOENT）；bash 工具的 bwrap 层因 `--tmpfs` 遮蔽，`/data` 呈现为**空目录**而非 ENOENT——验收时先确认自己在哪一层，别把沙箱层的空目录当成"没生效"。两层各自跑一遍本节文件系统部分。

```sh
ls /home                  # 只有 <account>
ls /data /sys /var        # No such file or directory（v1 未达成项，本版达成）
cat /etc/passwd           # 1 行，home 字段 /home/<account>
cat /etc/hostname         # <account>
ps -ef; ls /proc          # 只有自己
ipcs -a                   # 空
ls /dev                   # 无 kvm/dri/nvidia
df -h /tmp /dev/shm       # 512m / 64m 上限
touch /home/<B>           # No such file
cd .. && cd .. && ls      # 只有自己
```

网络（本版新增）：

```sh
# A 的 jail 内（假设 B port=3103）
curl -m 3 127.0.0.1:3103   # 超时/拒绝
curl -m 3 127.0.0.1:3102   # 自己的端口可达
curl -m 3 https://api.<外部域名>  # 外网不受影响

# 宿主侧
nft list table inet vh-tenant   # 本租户两条规则，comment "vh-<account>"，chain out 存在
```

租户 Docker（jail 内）：

```sh
docker version --format {{.Server.Version}}   # 出版本号（daemon 已就绪）
docker run --rm --network host alpine echo ok # 嵌套容器跑通
# A 起一个常驻容器后，B 的 jail 内：docker ps 报连不上 daemon（无 socket）；ps 看不到 A 的容器
ls -ld /var/lib/docker /sys/fs/cgroup         # 持久 graph 与可写 cgroup2 在位
```

bwrap（jail 内触发一次 bash 工具沙箱）：

```sh
# jail 内先写一个标记文件，再触发沙箱
echo probe > /tmp/vh-probe
# 沙箱内
cat /tmp/vh-probe       # probe（跨命令状态保留）
echo ok > /tmp/probe2   # 写入成功（可写，非 EROFS）
df -h /tmp /dev/shm     # /tmp 受 jail 512m 上限；/dev/shm 64m（不是 bwrap 新建的无限 tmpfs）
```

会话：

```sh
curl -H 'Cookie: vh_session=已撤销的sid' /api/...   # 401
curl /__vh/whoami -H 'Cookie: vh_session=...'       # 返回当前 subject/account
# 同浏览器先 A 后 B：bootstrap 重新 authorize → whoami 返回 B，A 的会话已 revoke
# 换 UA 重放 sid → 401
```

服务面板与预览（P6，实施后）：

```sh
# jail 内起两个服务：一个正常端口、一个撞保留段
python3 -m http.server 8000 &
python3 -m http.server 3200 &          # 预期：面板不显示，且 A 自己也访问不通（nft）
curl -s -H "Cookie: vh_session=$SID" localhost/__vh/services   # 8000 在列，3200 不在列
curl -s -H "Cookie: vh_session=$SID" -o /dev/null -w '%{http_code}\n' \
  localhost/app/com.ictrek.v-harness/preview/<A>/8000/           # 200
curl -s -H "Cookie: vh_session=$SID" -o /dev/null -w '%{http_code}\n' \
  localhost/app/com.ictrek.v-harness/preview/<B>/8000/           # 403（跨账号）
curl -s -H "Cookie: vh_session=$SID" -o /dev/null -w '%{http_code}\n' \
  localhost/app/com.ictrek.v-harness/preview/<A>/3103/           # 403（实例保留段，SSRF 防线）
kill %1 && curl -s -H "Cookie: vh_session=$SID" localhost/__vh/services  # 8000 转 stopped，记录仍在
```

测试落点：`gateway/session.test.mjs`（新建：create/load/revoke/UA 绑定/过期）、`gateway/users.test.mjs`（slug、`u<seq>`、`vh-` 保留）、`packages/sandbox/sandbox-local` 现有 profile 快照更新 bwrap 参数断言（`--dev-bind`、`--unshare-ipc`、条件化 `/tmp` 两个分支各一例）。
