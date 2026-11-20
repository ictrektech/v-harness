---
name: vos-local-app-dev
description: 开发 VOS 应用并安装到本地 VOS：复制模板建仓库、Gitea CI 构建离线包与 Release、本地安装与运行验证。不推送远端镜像、不写飞书、不发布应用商店。当用户要求开发 VOS app、构建离线安装包、安装到本地 VOS 时触发。
---

# 本地应用发布

覆盖 VOS app 的开发到本地安装。产物只有本机或 CI 打出的 tar 包，安装走平台 HTTP 接口。

## 前置条件

- 目标机器已安装 VOS，Gitea 在运行。
- Gitea MCP 已接入当前会话。
- 构建需要 `python3`：图标生成与镜像导出回退依赖它。
- 安装需要平台 `access_token`。平台没有长期 token，有效期 1 小时。

## 流程

1. 用 Gitea MCP 建仓库，把 `assets/repo-template/` 复制进去。
2. 修改 `ictrek.app/src/` 下的应用定义，再开发应用代码。
3. 推 `main` 让 CI 构建并发 Release；或本机跑 `./ictrek.app/scripts/package-local.sh`。
4. CI 配好凭据后，发布 Release 的同一个 job 会把包上传并安装到本机 VOS（见「自动安装」）。没有凭据时步进跳过，改走手动安装。
5. 手动安装：在浏览器下载 Release 资产，`bash scripts/install-app.sh --package <外层归档> --token <token>`。
6. 脚本最后打印 `GET /v1000/app/status` 的结果。

## 离线包结构

平台按外层归档安装，镜像必须在外层 `assets/<arch>/`，不能放进 `app.tar.gz`：

```
todo-0.1.0-amd64.tar
├── app.tar.gz                              5 KB   元数据
└── assets/amd64/todo-0.1.0.tar.gz          62 MB  docker 镜像
```

- `app.tar.gz` 只装 `.env`、`manifest.yml`、`docker-compose.yml`、`configs.yml`、`routers.yml`、`icon.png`。
- 平台解出的商店目录是 `apps/<id>/<version>/app.tar.gz` 与 `apps/<id>/<version>/assets/<arch>/<image>.tar.gz`。
- 镜像放进 `app.tar.gz` 时上传能成功，安装会失败：`[DownloadStorePackage] 应用商店下载 asset amd64/<name>-<version>.tar.gz 失败: 本地文件不存在`。
- 体积来自镜像：VOS 离线安装要用 `docker load` 导入，所以几十 MB 属正常。
- `install-app.sh --check` 对错误布局返回退出码 4。

## 模板

```bash
cp -a /opt/v-harness/skills/vos-local-app-dev/assets/repo-template/. <仓库目录>/
```

- `ictrek.app/src/`：`manifest.yml`、`docker-compose.yml`、`configs.yml`、`routers.yml`。`icon.png` 由构建脚本生成，不入库。
- `ictrek.app/scripts/`：`package-local.sh`（构建打包）、`export-image.py`（`docker save` 回退）、`make-icon.py`（256×256 RGBA 图标）。
- `.gitea/workflows/local-build.yml`：CI 构建与发布。

## 命令

| 脚本 | 用途 |
| --- | --- |
| `ictrek.app/scripts/package-local.sh` | 构建镜像，产出 `dist/app.tar.gz`（内层，只有元数据）与 `dist/<name>-<version>-<arch>.tar`（外层，含镜像） |
| `ictrek.app/scripts/install-to-vos.sh` | CI 用：把 `dist/` 外层包上传并安装到本机 VOS，装完轮询到终态 |
| `scripts/install-app.sh` | 上传外层包并安装到本地 VOS，只依赖 `curl` |
| `scripts/device-paths.sh` | 打印本应用的宿主路径与卷 UUID |

`install-app.sh` 退出码：0 成功；2 平台返回业务错误；4 包结构不合法；5 缺 access_token。
`install-to-vos.sh` 退出码：0 成功或跳过；2 平台业务错误或安装失败；3 首次安装缺目标卷；4 轮询超时；5 登录失败。

## 安装接口

| 端点 | 用途 |
| --- | --- |
| `POST /v1000/app-store/upload_app` | multipart 上传外层包，返回 `source_id=#local:<ULID>`（24 小时 TTL，重启丢失） |
| `POST /v1000/app-store/install` | 按 `source_id`、`app_id`、`version`、`volume_id` 安装，同步返回 |

- 都要求 `Authorization: Bearer <access_token>` 与 `platform:app:install` 权限。
- 存储路径由 `volume_id` 推导为 `<mount>/apps/<app_id>/{data,assets}`，调用方不需要宿主路径。
- `access_token` 由 `POST /v1000/user/login` 用账号密码换取。
- 平台没有构建接口。构建在本机或 CI 完成。
- 接口清单：`GET /v1000/openapi.json`；浏览用 `https://<host>:1180/swagger-ui/`。

## 自动安装

平台没有单独的"上传安装"接口，用两个端点组合即可，不必先下载 Release。

1. `POST /v1000/app-store/upload_app`：multipart，field 名 `package`，body 上限 2 GiB。返回 `#local:<ULID>`、`app_id`、`version`。
2. `POST /v1000/app-store/install_async`：首次安装，`volume_id` 必填。
3. `POST /v1000/app-store/upgrade_async`：已安装时升级，存储配置沿用旧记录，不接受 `volume_id`。
4. `GET /v1000/app/status?app_id=`：轮询到 `state` 为 `installed` 或 `error`。

凭据按下列顺序取，前一个为空才看下一个：

1. `VOS_TOKEN`。
2. 账号密码：`VOS_ADMIN_USER` + `VOS_ADMIN_PASSWORD`，每次换 `access_token`。
3. `/var/lib/vos-context/access-token`：平台注入给应用的长期令牌，`username` 为应用 id（如 `com.ictrek.gitea`），`system_admin`，2099 年到期。`VOS_CONTEXT_TOKEN_FILE` 可改路径。

走第 3 条时不用配任何 secret，但要让 runner 把应用上下目录挂进 job 容器：

```yaml
# runner 配置：<VOS_APP_STORAGE_PATH>/runner/config.yaml，容器内 /data/config.yaml
container:
  network: vos_default
  options: "-v <VOS_APP_CONTEXT_PATH>:/var/lib/vos-context:ro"
  valid_volumes:
    - <VOS_APP_CONTEXT_PATH>
```

- 少了 `valid_volumes`，这个 bind 会被丢弃，日志为 `<path> is not a valid volume, will be ignored`。
- 改完配置必须重启 runner：`docker restart <act-runner 容器>`。
- 该令牌对所有仓库的 job 可见。要求按仓库隔离时，改用 secrets。

其余变量：

| 变量 | 用途 |
| --- | --- |
| `VOS_GATEWAY` | 缺省 `https://172.17.0.1:1180` |
| `VOS_VOLUME_ID` 或 `VOS_VOLUME` | 首次安装的目标卷；已安装时不需要 |
| `VOS_PROFILES` | 覆盖按架构推导的 profile 名 |

- 三个凭据来源都为空时，`install-to-vos.sh` 打 `[WARN]` 并退出 0：workflow 不变红。
- job 容器挂在 `vos_default` 网络，可以直接访问网关，不需要下载 Release 再上传。
- `manifest.yml` 写了 `require-profiles: true` 时，安装必须带 `profiles`。脚本按包名推导：`amd64` → `amd`，`arm64` → `arm`。
- 改过 profile 名时，必须同时设置 `VOS_PROFILES`，否则首次安装报 profile 校验失败。
- 上传目录 24 小时过期，平台重启后注册表丢失。这只影响 catalog 浏览，不影响已完成的安装。

## CI

workflow 在平台自带的 `ubuntu-latest` runner 上跑，不用任何 Node action。

| 要求 | 不满足时 |
| --- | --- |
| runner 有 `git` | 克隆失败，没有源码 |
| runner 有 `docker` CLI 与可用 socket | 只校验应用定义，不出包、不发布 |
| runner 有 `python3`、`tar`、`gzip` | 打包失败 |
| runner 有 `curl` | 发布 Release 与自动安装都失败 |

- 平台 runner 的 job 容器挂了宿主 docker socket，但没有 docker CLI。`ensure docker` 先试静态 CLI（`docker-27.3.1.tgz`，只取 `docker/docker`）放到 `/usr/local/bin`，失败再回退 `apt-get install docker.io`。构建跑在宿主 daemon 上，`server=27.0.3`。
- 两条路径都先测速选源，国内外都能跑：静态 CLI 比较 `mirrors.aliyun.com` 与 `download.docker.com`，apt 比较 `mirrors.aliyun.com` 与 `deb.debian.org`。无需手工切换镜像。
- apt 路径很慢：实测 apt 约 55 KB/s，同容器 curl 到同一镜像有 4.7 MB/s，装 `docker.io` 要 14 分钟以上。静态 CLI 路径约 25 秒。
- apt 慢的两种原因都实测过：`deb.debian.org` 的 DNS 轮询会命中慢节点（`199.232.162.132` 143 KB/s 对 `146.75.114.132` 8.1 MB/s）；换到 `mirrors.aliyun.com` 后 apt 仍只有 55 KB/s，说明瓶颈在 apt 自身，不在网络。
- `ensure docker` 装不上或 daemon 不可达时只警告，不失败：GARM 的 LXD 实例以非 root 用户执行步骤（无 `sudo`、`apt-get` 报 `Permission denied`），随后 `build` 只校验应用定义。
- 不要用 GARM 的 LXD 实例构建，三层限制都实测过：缺 registry 代理时报 `registry-1.docker.io ... i/o timeout`；加代理后解包报 `overlay ... permission denied`，改 `storage-driver=vfs` 加 `features.containerd-snapshotter=false` 可过；随后 `RUN` 报 `mount "cgroup" ... permission denied`，LXD 不允许嵌套容器挂 cgroup。
- 用 `VOS_BUILD` 控制构建：`auto`（默认，有可用 docker 就构建）、`1`（强制构建）、`0`（只校验应用定义）。在 GARM 池上跑时设 `0`。
- 克隆地址取 `GITHUB_SERVER_URL`，它等于 runner 注册时登记的地址：平台 runner 是 `http://gitea:8080/app/com.ictrek.gitea`，GARM 的 LXD 实例是宿主网桥地址（如 `http://10.184.191.1:1182/app/com.ictrek.gitea`）。`GITEA_BASE` 优先，用于手工覆盖。不要用 `actions/checkout`：它拼出的地址缺子路径，报 `repository not found`。
- 发布：推 tag 发布该 tag；推 `main` 按 `VERSION` 发布 `v<VERSION>`；没有构建出包时输出 `[WARN] no built package` 并跳过。
- 重跑发布会留下同名资产（Gitea 允许重名），workflow 上传前先 `DELETE`。
- 自动安装是独立步骤，排在 `publish tag and release` 之后：安装失败不回滚已完成 Release。
- 设备侧下载走浏览器：租户容器访问 Gitea API 返回 401。
- run 日志在 Gitea 容器的 `/data/gitea/actions_log/<owner>/<repo>/<hex>/<task>.log.zst`，用 `zstd -dc` 解压。容器里没有 `zstd`，先 `docker cp` 出来。

## 约束

- 不推送镜像到远端仓库，不写飞书发布表，不发布 VOS 应用商店。
- 不把机密写入模板或镜像。
- 应用容器必须 root 运行，不写 `USER <非 root>`。VOS 存储挂载由 user-namespace 映射创建（宿主显示 `nobody:nogroup`、权限 `0700`），容器内只有 root 可写；非 root 启动即崩，日志 `Error: unable to open database file`。
- 构建前必须 `export DOCKER_BUILDKIT=0`。
- `docker save` 失败时回退到 `export-image.py`，不中断打包。

## 检查点

- 打包：`dist/<name>-<version>-<arch>.tar` 存在，`package-local.sh` 自校验通过。
- 安装前：`install-app.sh --check` 打印 package、gateway、volume、token 四项，退出码 0 才算就绪。
- 安装后：`GET /v1000/app/status` 返回 `state: running`，`docker logs <容器>` 出现 `listening on`。
- 运行验证（受限 docker 能力下）：用 `docker create` 加 `docker start` 加 `docker logs`；`docker run -d` 可能挂住。
- CI（实测）：`clone`、`ensure docker`、`build`、`publish tag and release` 全绿；产物资产含 `app.tar.gz`（约 5 KB）与 `assets/amd64/<name>-<version>.tar.gz`（约 60 MB）。
- CI 用时（实测）：`ensure docker` 约 30 秒，整轮约 1 分钟（构建缓存命中时）；用 apt 补 docker CLI 时 `ensure docker` 单步就要 14 分钟以上。
- 自动安装（实测）：`install to vos` 依次打印 `source_id=...`、`already installed ... submit upgrade`、多次 `workflow Running`、`workflow Completed`、`state=installed; install done`，整步约 50 秒。失败时打印 `install failed` 与平台返回的 `last_error`。
