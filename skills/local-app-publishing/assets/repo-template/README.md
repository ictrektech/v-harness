# 本地 VOS 应用模板

这个仓库用 Gitea Actions 在本地构建镜像，并打包成 VOS 离线安装包。不推送远端镜像，不写飞书，不发布应用商店。

## 目录

- `Dockerfile`：应用镜像的构建入口。
- `index.html`：示例静态页，按需替换。
- `ictrek.app/src/manifest.yml`：应用 id、profile、assets 声明。
- `ictrek.app/src/docker-compose.yml`：按 profile 定义服务。
- `ictrek.app/src/configs.yml`：安装时收集的配置项。
- `ictrek.app/src/routers.yml`：VOS 前端入口。
- `ictrek.app/scripts/package-local.sh`：构建并打包。
- `.gitea/workflows/local-build.yml`：推送后自动构建。

## 开始

1. 把 `com.example.myapp` 替换成你的应用 id。
2. 替换 `myapp` 为你的应用名。
3. 在 `ictrek.app/src/` 放入 256×256 RGBA 的 `icon.png`。
4. 按需修改 `Dockerfile`。
5. 提交并推送。

## 构建

本地直接构建：

```bash
bash ictrek.app/scripts/package-local.sh
```

产物在 `dist/app.tar.gz`。

## 安装

把 `dist/app.tar.gz` 交给本地安装命令。安装入口见 v-harness 的 `local-app-publishing` skill。

## 注意

- `docker-compose.yml` 的 `image` 标签必须和 `manifest.yml` 的 assets 归档标签一致。
- 本地镜像使用 `local/<app>` 前缀，避免和远端仓库冲突。
- 卸载或升级时保留 `${VOS_APP_STORAGE_PATH}` 下的数据。
