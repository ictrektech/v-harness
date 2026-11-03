# v-harness 多租户隔离方案

[多用户部署总览](MULTIUSER.md) · [发布流程](ictrek.app/RELEASE.md)

目标：用户 A 的实例里，B 不存在。

---

## 1. 账号与目录

```
/data/users/<account>/          0700  <uid>:<gid>
├── workspace/                  文档区，会话 cwd，唯一被 agent 默认可写的目录
├── .dsh/                       DSH_HOME
├── .agents/                    DSH_AGENTS_HOME
├── .cache/ .local/ .config/
```

`users.json` 每条记录：

```json
{
  "subject": "330abf1f...",
  "account": "tieniu",
  "uid": 20001,
  "namespace": "2d57591d...",
  "port": 3102,
  "createdAt": 1792479940356
}
```

- `account` 创建时生成一次，之后不变；`namespace` 只做内部主键，不进任何面向用户的路径。
- 生成规则：`preferred_username` → NFKC → 小写 → `[^a-z0-9_-]` 替换为 `-` → 压缩连字符 → 去首尾 → 截断 32 → 首字符非字母则前缀 `u` → 保留名（`root/bin/daemon/nobody/node/dsh/vh-*`）加后缀。
- 同名不同 subject：追加 `-2`、`-3`（创建时落库）。
- 清洗后为空（纯中文）：`u1001`、`u1002` 递增。
- 落库时打日志 `identity user=<account> sub=<subject>`。

---

## 2. jail 内的世界

```
/
├── usr/                    只读 bind（运行时、node、dsh、native）
├── bin,lib,lib64,sbin      软链 → usr/*
├── etc/                    白名单只读 + 三个生成文件
│   ├── ld.so.cache ld.so.conf.d alternatives ssl/certs ssl/openssl.cnf
│   ├── nsswitch.conf localtime timezone terminfo mime.types services protocols
│   ├── profile profile.d bash.bashrc bash_completion.d inputrc gitconfig
│   ├── resolv.conf
│   ├── passwd             仅 1 行：vh-<account>:x:<uid>:<gid>::/home/<account>:/usr/sbin/nologin
│   ├── group              仅 1 行
│   ├── hosts              127.0.0.1 localhost / ::1 localhost
│   └── hostname           <account>
├── home/<account>/         0700，可写，从 /data/users/<account> bind
├── opt/vh/                 只读 bind（dsh 运行时）
├── opt/vh-skills/          只读 bind（产品技能）
├── srv/public/             只读 bind（可选，平台素材，不含任何租户内容）
├── dev/                    私有 tmpfs + mknod + 私有 devpts + 私有 shm(64m)
├── proc/                   私有 procfs
├── tmp/                    私有 tmpfs，size=512m，1777
└── run/                    私有 tmpfs，size=16m，0755
```

**不创建**（保证 ENOENT 而非 EACCES）：`/data`、`/root`、`/srv/*`（除 public）、`/mnt`、`/media`、`/sys`、`/var`、`/boot`、`/etc/shadow`、`/etc/sudoers`、`/etc/ssh`、`/dev/kvm`、`/dev/dri`、`/dev/nvidia*`。

### 2.1 vh-jail 关键步骤

```bash
root=/run/vh-root-$account          # 放 /run，避免与容器共享 /tmp
mkdir -p "$root"; mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs "$root"

bind_ro() { mount --bind "/$1" "$root/$1"; mount -o remount,bind,ro "$root/$1"; }
bind_ro usr
for p in bin:usr/bin lib:usr/lib lib64:usr/lib64 sbin:usr/sbin; do ln -sfn "${p#*:}" "$root/${p%%:*}"; done
for e in ld.so.cache ld.so.conf.d alternatives ssl/certs ssl/openssl.cnf nsswitch.conf \
         localtime timezone terminfo mime.types services protocols profile profile.d \
         bash.bashrc bash_completion.d inputrc gitconfig resolv.conf; do bind_ro "etc/$e"; done

mkdir -p "$root/dev" "$root/proc" "$root/tmp" "$root/run" "$root/etc"
mount -t tmpfs -o mode=0755,nosuid tmpfs "$root/dev"
for n in null:1:3 zero:1:5 full:1:7 random:1:8 urandom:1:9 tty:5:0; do
  mknod -m 0666 "$root/dev/${n%%:*}" c "$(echo ${n#*:} | cut -d: -f1)" "$(echo ${n#*:} | cut -d: -f2)"; done
mkdir -p "$root/dev/pts" "$root/dev/shm"
mount -t devpts -o newinstance,ptmxmode=0666,mode=0620,gid=5 devpts "$root/dev/pts"
ln -sfn pts/ptmx "$root/dev/ptmx"
mount -t tmpfs -o mode=1777,nosuid,nodev,size=64m tmpfs "$root/dev/shm"
mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
mount -t tmpfs -o mode=1777,nosuid,nodev,size=512m tmpfs "$root/tmp"
mount -t tmpfs -o mode=0755,nosuid,nodev,size=16m tmpfs "$root/run"

printf '%s:x:%s:%s::/home/%s:/usr/sbin/nologin\n' "vh-$account" "$uid" "$uid" "$account" > "$root/etc/passwd"
printf '%s:x:%s:\n' "vh-$account" "$uid" > "$root/etc/group"
printf '%s\n' "$account" > "$root/etc/hostname"
printf '127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n' > "$root/etc/hosts"

mkdir -p "$root/home/$account"
mount --bind "/data/users/$account" "$root/home/$account"
chmod 0700 "$root/home/$account"

exec chroot "$root" /bin/sh -c '
  export HOME=/home/'"$account"' USER=vh-'"$account"' HOSTNAME='"$account"'
  cd "$HOME/workspace" 2>/dev/null || cd "$HOME"
  exec /usr/bin/setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
    --reuid='"$uid"' --regid='"$uid"' --init-groups "$@"' sh "$@"
```

### 2.2 启动自检（不满足即退出）

```bash
ns=$(readlink /proc/self/ns/mnt)
[ "$ns" != "$(readlink /proc/1/ns/mnt)" ]                 || die "not in own mount ns"
[ "$(wc -l < /etc/passwd)" -eq 1 ]                        || die "passwd leaks accounts"
[ "$(ls /home | wc -l)" -eq 1 ]                           || die "home leaks tenants"
[ -e /data ]                                              && die "/data visible"
[ "$(readlink -f /proc/self/root/home)" = "/home/$account" ] || die "home mismatch"
```

---

## 3. 公共区域

| 路径 | 源 | 挂法 | 可写 | 更新 |
|---|---|---|---|---|
| `/usr` `/bin` `/lib` `/lib64` `/sbin` | 容器根 | bind + remount ro，共享一份 | 否 | 镜像升级，全局同版本 |
| `/opt/vh` | `/opt/v-harness` | bind ro，共享 | 否 | 镜像 |
| `/opt/vh-skills` | `$BUNDLED_SKILL_DIR` | bind ro，共享 | 否 | 镜像 |
| `/srv/public` | 运维目录 | bind ro | 否 | 运维随时，需审计不含租户数据 |
| `/etc/<白名单>` | 容器根 | bind ro | 否 | 镜像 |
| 公共可写区 | — | **不提供** | — | — |

跨用户共享文件只有一个通道：网关签发的带鉴权 URL，文件系统里不出现共享目录。

---

## 4. 终端沙箱（bwrap）

```bash
bwrap --ro-bind / / \
      --tmpfs /home --bind "$HOME" "$HOME" \
      --tmpfs /data --tmpfs /root --tmpfs /srv --tmpfs /mnt --tmpfs /media \
      --dev-bind /dev /dev --proc /proc \
      --unshare-pid --unshare-ipc --die-with-parent \
      -- [命令]
```

- 不再 `--ro-bind / /` 后直接裸奔：`/home` 先清空再回绑自己，别人的 home 不存在。
- 不再挂 `--tmpfs /tmp`：复用 jail 的私有 `/tmp`，跨命令状态不丢。
- `--dev-bind /dev /dev`：复用 jail 的私有 `/dev`（含私有 shm），不重复挂。
- `workspace-write` 追加 `--bind "$WORKSPACE" "$WORKSPACE"`；`read-only` 只用上面的只读视图。

对应改动：`packages/sandbox/sandbox-local/src/profiles.ts` 的 `bwrapProfileArgs()`，policy 新增 `tenantRoot`（`packages/sandbox/sandbox/src/index.ts`），由 `sandbox-policy` 从 `process.env.HOME` 解析下发。

---

## 5. 身份与会话

### 5.1 凭证

cookie 只做索引，不承载身份：

```
__Host-vh_sid=<base64url(32B)>; HttpOnly; Secure; Path=/; SameSite=Lax
```

会话表（SQLite `/data/sessions.db`）：

```sql
CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,   -- 随机 32 字节
  subject    TEXT NOT NULL,
  account    TEXT NOT NULL,
  ua_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_subject ON sessions(subject);
```

### 5.2 登录

```
浏览器 → POST /__vh/session {access_token}
网关  → verifyVosToken → sub
     → users.upsert(sub) → account
     → sid = random(32); insert sessions
     → Set-Cookie __Host-vh_sid + 302 /
```

### 5.3 每个请求

```
sid = cookie
row = SELECT * FROM sessions WHERE sid=? AND revoked=0 AND expires_at>now
if !row → 401（文档请求 → bootstrap 页）
if row.subject ≠ 当前 VOS token 的 sub → 重建会话并路由到新实例
```

VOS 复核频率：文档请求必查；API 请求 5 分钟内复用结果。

### 5.4 撤销

| 动作 | 实现 |
|---|---|
| 登出 | `UPDATE sessions SET revoked=1 WHERE sid=?`，停该租户实例 |
| 删号 / 禁用 | `UPDATE sessions SET revoked=1 WHERE subject=?` |
| VOS 侧踢人 | sub 复核不一致 → 会话作废 |
| 密钥轮换 | 不再需要（无签名密钥） |

### 5.5 实例路由

`instanceFor(session)` 一律以 `row.subject` 为键；`users.json` 查不到 subject → 401，不建实例。

---

## 6. 改动清单

| 文件 | 改什么 |
|---|---|
| `gateway/session.mjs` | 删除 HMAC 自签；改为 `createSession / loadSession / revokeSession / revokeSubject`，基于 `/data/sessions.db` |
| `gateway/server.mjs` | `authenticate()` 查表；`/__vh/session` GET/POST 重写；bootstrap 无条件 authorize 并比对 subject；新增 `/__vh/whoami`；`/__vh/logout` 撤销 + 停实例 |
| `gateway/users.mjs` | `account` 生成（§1 规则）、唯一性后缀、`user=/sub=` 日志 |
| `gateway/instances.mjs` | 启动参数带 `account` 与 `home`；启动自检失败即杀实例；session 键改 subject |
| `bin/vh-jail` | §2 根树、`/sys` `/var` 不挂、`/run` 私有、size 限制、自检 |
| `packages/sandbox/sandbox-local/src/profiles.ts` | `bwrapProfileArgs` 改遮蔽式（§4） |
| `packages/sandbox/sandbox/src/index.ts` | `SandboxExecutionPolicy.tenantRoot` |
| `packages/sandbox/sandbox-policy/src/index.ts` | `Config.tenantRoot` + resolve 下发 |
| `packages/bundle/base/cordis.patch.yml` | 部署禁用 `danger-full-access` 预设 |
| `gateway/vos.patch.yml` | `sandbox-policy` 增加 `tenantRoot: process.env.HOME`（patch 替换整段 config，需同时重述 mode/workspaceRoot） |

---

## 7. 数据迁移

```bash
# 1. 停所有实例
# 2. 为每条 users.json 记录计算 account（幂等，已有则跳过），写回
# 3. 搬目录
mv /data/users/<namespace> /data/users/<account>
chown -R <uid>:<uid> /data/users/<account>
# 4. 重写历史会话里的路径（复用 instances.mjs 的 rewriteJailPaths，marker 版本 +1）
sed -i 's#/home/<namespace>#/home/<account>#g' /data/users/<account>/.dsh/storages/*.json
# 5. 清空 sessions 表（旧 cookie 全部失效）
# 6. 启动
```

回滚：目录名搬回 + `users.json` 恢复 + 清 sessions。

---

## 8. 验收（A 的实例里执行）

```sh
ls /home                  # 只有 <account>
ls /data /sys /var        # No such file or directory
cat /etc/passwd           # 1 行
cat /etc/hostname         # <account>
ps -ef; ls /proc          # 只有自己
ipcs -a                   # 空
ss -lntp                  # 只有自己
ls /dev                   # 无 kvm/dri/nvidia
df -h /tmp /dev/shm       # 有 size 上限
touch /home/<B>           # No such file
cd .. && cd .. && ls      # 只有自己
```

会话：

```sh
# 登出后用旧 cookie
curl -H 'Cookie: __Host-vh_sid=...' /api/...   # 401
# 同浏览器先 A 后 B
/__vh/whoami                                   # 返回 B
```
