# 仓库模板说明

模板位于 `assets/repo-template/`。复制到新仓库后，先改应用标识，再改构建逻辑。

## 需要修改的内容

| 文件 | 修改点 |
| --- | --- |
| `ictrek.app/src/manifest.yml` | 应用 id（默认 `com.example.myapp`）；按需调整 `profiles`、`assets`、`storage` |
| `ictrek.app/src/docker-compose.yml` | 服务名、`image`、Traefik 路由规则、端口 |
| `ictrek.app/src/configs.yml` | 安装时收集的配置项 |
| `ictrek.app/src/routers.yml` | 前端入口的 id、标题、`iframe-src` |
| `Dockerfile` | 应用镜像的构建步骤 |
| `VERSION` | 首次发布版本 |
| `.gitea/workflows/local-build.yml` | runner 标签 |

运行用户必须保持 root。VOS 把存储挂到容器 `/data`，该目录在宿主上是 `nobody:nogroup`、权限 `0700`，容器内只有 root 可写；Dockerfile 写 `USER app` 会让应用启动即崩，日志为 `Error: unable to open database file`。

## 命名约定

- 应用 id：`com.example.<name>`。
- 镜像：`local/<name>:<version>`，并设 `pull_policy: never`，因为安装前会先 `docker load`。
- 镜像归档：`<name>-<version>.tar.gz`。
- 服务名：`<name>-amd`、`<name>-arm`。

## 打包产物

`bash ictrek.app/scripts/package-local.sh` 产出两个文件：

- `dist/app.tar.gz`：内层包，只含 `.env`、`manifest.yml`、`docker-compose.yml`、`configs.yml`、`routers.yml`、`icon.png`。
- `dist/<name>-<version>-<arch>.tar`：外层归档，含 `app.tar.gz` 与 `assets/<arch>/<name>-<version>.tar.gz`。

安装与上传都用外层归档。镜像必须在**外层** `assets/<arch>/`：放进 `app.tar.gz` 时上传能成功，安装会报 `本地文件不存在: .../assets/amd64/<name>-<version>.tar.gz`。`package-local.sh` 的 `verify_package` 与 `install-app.sh --check` 都拒绝这种布局。

## 版本占位符

`__APP_VERSION__` 在打包时替换为 `VERSION` 的值，出现在三处且必须一致：`manifest.yml` 的 `version`、`manifest.yml` 的 `assets[].filename`、`docker-compose.yml` 的 `image`。

## 打包自校验

`package-local.sh` 打包后检查：必需文件都在 `app.tar.gz` 内、外层有 `assets/<arch>/` 归档、`manifest.yml` 的 `version` 与 `assets[].filename` 和 `docker-compose.yml` 的 `image` 与本版本一致、没有残留 `__APP_VERSION__`。

`docker save` 不可用时（受限 Docker 能力不开放 `GET /images/get`），`package-local.sh` 调用 `export-image.py`：`docker create` 加 `docker export` 加 `docker container inspect`，拼出与 `docker load` 兼容的 docker-archive。

`ictrek.app/src/icon.png` 缺失时由 `make-icon.py` 生成 256×256 RGBA 图标；需要自定义时替换该文件。

## SPA / 前后端分离应用

前端 `base` 必须是相对路径，否则静态资源在 `/app/<id>/` 前缀下 404：

```js
export default { base: './' }   // vite.config.ts
```

API 基址由 `document.baseURI` 推导，不写死 `/api`：

```js
const apiBase = new URL('api/', document.baseURI)
```

`docker-compose.yml` 的 `PathPrefix` 规则与 `stripprefix` 中间件必须成对出现，缺一个会 404 或让前缀重复。

## 运行验证

`docker run -d` 在受限 Docker 能力下可能挂住。用 `docker create` 加 `docker start` 加 `docker logs`，或 `vh-service run --name <name> --port <port> -- node src/server.js`。

## CI 与 runner

`.gitea/workflows/local-build.yml` 跑在平台自带的 `ubuntu-latest` runner 上，只用 shell。

- 需要 `git`；构建还要 `docker` CLI 与可用 socket、`python3`、`tar`、`gzip`。
- job 容器有宿主 socket 但没有 docker CLI，`ensure docker` 步骤补装，构建因此跑在宿主 daemon 上。
- 不要用 GARM 的 LXD 实例构建：嵌套 overlay 被拒，报 containerd overlayfs `permission denied`。
- 缺 docker 时只校验 `ictrek.app/src` 的源文件，不出包，也不发布 Release。
- 克隆地址默认 `http://gitea:8080/app/com.ictrek.gitea`，可用 `GITEA_BASE` 覆盖。
- 运行长期停在 `waiting` 表示该标签没有空闲 runner，不是 workflow 的问题。
