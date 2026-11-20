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
4. 在浏览器下载 Release 资产，或直接用本机产物。
5. `bash scripts/install-app.sh --package <外层归档> --token <token>` 安装。
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
| `scripts/install-app.sh` | 上传外层包并安装到本地 VOS，只依赖 `curl` |
| `scripts/device-paths.sh` | 打印本应用的宿主路径与卷 UUID |

`install-app.sh` 退出码：0 成功；2 平台返回业务错误；4 包结构不合法；5 缺 access_token。

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

## CI

workflow 在平台自带的 `ubuntu-latest` runner 上跑，不用任何 Node action。

| 要求 | 不满足时 |
| --- | --- |
| runner 有 `git` | 克隆失败，没有源码 |
| runner 有 `docker` CLI 与可用 socket | 只校验应用定义，不出包、不发布 |
| runner 有 `python3`、`tar`、`gzip` | 打包失败 |

- 平台 runner 的 job 容器挂了宿主 docker socket，但没有 docker CLI；`ensure docker` 步骤用 `apt-get install docker.io` 补上，实测约 2.5 分钟，`server=27.0.3`。构建跑在宿主 daemon 上。
- `ensure docker` 装不上时只警告，不失败：GARM 的 LXD 实例以非 root 用户执行步骤（无 `sudo`，`apt-get` 报 `Permission denied`），随后 `build` 只校验应用定义。
- 不要用 GARM 的 LXD 实例构建，三层限制都实测过：缺 registry 代理时报 `registry-1.docker.io ... i/o timeout`；加代理后解包报 `overlay ... permission denied`，改 `storage-driver=vfs` 加 `features.containerd-snapshotter=false` 可过；随后 `RUN` 报 `mount "cgroup" ... permission denied`，LXD 不允许嵌套容器挂 cgroup。
- 用 `VOS_BUILD` 控制构建：`auto`（默认，有可用 docker 就构建）、`1`（强制构建）、`0`（只校验应用定义）。在 GARM 池上跑时设 `0`。
- 克隆地址取 `GITHUB_SERVER_URL`，它等于 runner 注册时登记的地址：平台 runner 是 `http://gitea:8080/app/com.ictrek.gitea`，GARM 的 LXD 实例是宿主网桥地址（如 `http://10.184.191.1:1182/app/com.ictrek.gitea`）。`GITEA_BASE` 优先，用于手工覆盖。不要用 `actions/checkout`：它拼出的地址缺子路径，报 `repository not found`。
- 发布：推 tag 发布该 tag；推 `main` 按 `VERSION` 发布 `v<VERSION>`；没有构建出包时输出 `[WARN] no built package` 并跳过。
- 重跑发布会留下同名资产（Gitea 允许重名），workflow 上传前先 `DELETE`。
- 设备侧下载走浏览器：租户容器访问 Gitea API 返回 401。

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
