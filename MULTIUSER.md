# v-harness 多用户

唯一入口文档。其他文档：[发布流程](ictrek.app/RELEASE.md) · [VOS 应用说明](ictrek.app/README.md)。

## 一句话

**一个容器，每个用户一个 Linux 账号、一个 dsh 进程、一份 `DSH_HOME`。**

隔离由操作系统负责，dsh 内部不做任何租户判断。

## 用户视角

```
VOS 门户 → 打开 v-harness（无登录页）
         → 新建会话，提需求
         → agent 在自己的 workspace 里干活
         → 用户验收产物
```

没有编辑器，没有用户终端，没有注册流程。

## 架构

```
浏览器（VOS iframe）
   │ ① Fastpath 静默换 access_token
   ▼
v-harness gateway
   │ ② 调 VOS userinfo → sub → namespace
   │ ③ 确保该用户的 dsh 实例在跑
   │ ④ 签发 vh_session，之后所有请求转发
   ▼
dsh 实例 × N　（runuser -u vh-xxxxxxxx）
   DSH_HOME=/data/users/<ns>/.dsh
   端口 3101+，只监听 127.0.0.1
```

转发时网关做两件事：`Host` 改写成 `127.0.0.1:<port>`，`Cookie` 换成该实例自己的 dsh cookie。

## 代码地图

| 路径 | 职责 |
|---|---|
| `gateway/server.mjs` | HTTP/WS 入口、SSO 端点、bootstrap 页、反代 |
| `gateway/vos-auth.mjs` | VOS token 验证、身份映射 |
| `gateway/session.mjs` | `vh_session` HMAC cookie、CSRF |
| `gateway/users.mjs` | `users.json`，uid/端口一次性分配 |
| `gateway/instances.mjs` | 启动 dsh、抓 launch token、换 cookie |
| `gateway/files.mjs` | 文件抽屉后端（list/read/upload） |
| `bin/vh-userctl` | root：建号、目录权限（幂等） |
| `bin/vh-file` | root：校验参数后 `runuser` 降权 |
| `bin/vh-file-impl.mjs` | 用户身份下实际读写，路径锁死 workspace |
| `bin/entrypoint` | 容器启动：探测沙盒 → 重建账号 → 起网关 |
| `Dockerfile` | 镜像定义（根目录，配 `.dockerignore`） |
| `ictrek.app/` | VOS 应用包：manifest、compose、打包、发版 |
| `build_image.sh` | 构建镜像 → 推 SWR → 写飞书 |

`packages/` 和 `apps/` 是 dsh 源码，**一行未改**。

## 五条关键事实

这些是踩过源码确认的，改动前先看：

1. **dsh 的 `/api` 强制要求它自己签的 cookie**。伪装 `Host: 127.0.0.1` 只能过 DNS-rebinding 栅栏，过不了认证。所以网关必须抓 `dsh web: ...?token=` 换一次 `Set-Cookie`。
2. **cookie 的 authority 绑定 Host**。网关转发时必须固定 `127.0.0.1:<port>`，不能透传浏览器域名。
3. **沙盒只防写不防读**。`workspace-write` 下全盘可读（`--ro-bind / /`），agent 能读自己的 `.credentials.yaml`。
4. **终端默认开启且不受沙盒约束**。`ui-sidebar-terminal` 里的命令用系统用户权限，能读 key、改 profile、装插件。必须关。
5. **目录名必须由 `sub` 派生**，不能用用户名：两个 VOS 账号可能解析成同一个显示名。

## 数据布局

```
/data/users.json                    用户表：subject / namespace / linuxName / uid / port
/data/users/<namespace>/            0700，属主 vh-xxxxxxxx
  .dsh/                             会话、凭据、profile
  .agents/                          skills
  workspace/日常/                    默认落点
/data/logs/<namespace>.log          实例日志
```

`namespace = sha256('vos-oidc\0' + sub)` 前 40 位，`linuxName = vh-` + 前 8 位。

## 跑起来

```bash
# 本地构建（不需要飞书）
docker build -t v-harness .

# 跑起来（先不连 VOS，只验证容器本身）
docker run --rm -p 8080:8080 -v /tmp/vh-data:/data v-harness
docker logs <id> | head -40      # 看 sandbox-probe 的 verdict
curl localhost:8080/__vh/health  # {"ok":true}
```

VOS 里部署走 `build_image.sh` + `ictrek.app/scripts/package.sh`，见 [RELEASE.md](ictrek.app/RELEASE.md)。

## 现在的状态

**能跑通的**：本地语法检查、网关空跑（health / session / bootstrap）、文件助手的读写与三类越权拦截。

**没验证的**：登录全流程、dsh 实例启动、cookie 交换、反代、沙盒在容器里的可用性。**一次都没在容器里跑过。**

**没做的**：

| 项 | 影响 |
|---|---|
| 默认 profile 模板（关终端） | 用户能开终端绕过沙盒 |
| 文件上传入口 | 后端有，界面没有 |
| 空闲回收 | 实例常驻，内存只涨不降 |
| LLM Key 策略 | 用户没 key 就用不了 |

## 已知取舍

- **key 由每个用户自己填写**，与 dsh 官方一致：写进该用户私有的 `.credentials.yaml`（0600）。不做网关代持/代理——没有平台共享 key，也就不存在"一个用户泄露等于全平台泄露"。
- **agent 能读自己的 key**：沙盒只防写。这是用户在自己的账号里读自己的凭据，影响面仅限本人。
- **单用户能拖垮全容器**：容器内做不到每用户 cgroup，只有容器级限制。
- **`ps` 能看到别人的进程**：同 PID namespace，不影响文件隔离。
- **不做 iptables**：容器无 `NET_ADMIN`；且跨用户需要对方的 cookie，协议层已经挡住。
- **不做 net / pid namespace 隔离**：每用户一个进程已经给了文件和故障隔离；`ps` 能看到彼此、端口共享，属于本期接受的取舍。将来要补，在 `runuser` 外面套一层 `unshare` 即可。
