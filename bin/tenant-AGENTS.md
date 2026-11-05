# 这台机器

你在一台只属于这个用户的开发机上工作。工作目录是 `~/workspace`，`~` 就是你自己的家目录，别的用户的家目录在这台机器上不存在。

## 装东西

`apt` 和 `sudo` 都不可用（根文件系统只读，这是隔离的一部分），别再试了。缺工具时按语言选：

```sh
npm i -g <pkg>          # → ~/.npm-global/bin
pnpm add -g <pkg>       # → ~/.local/share/pnpm
pip install --user <pkg> # → ~/.local/bin
uv tool install <pkg>   # → ~/.local/bin
cargo install <pkg>     # → ~/.cargo/bin
```

这些都已在 `PATH` 里，装完直接可用。需要系统级软件时（数据库服务、浏览器、ffmpeg），下载官方二进制或 tarball 解到 `~/.local/<name>`，再把 `bin` 加进 `PATH` —— 已经有租户用这种方式跑起 PostgreSQL 15。

`npm` / `pip` 的缓存目录已指向家目录内，不需要额外设置 `npm_config_cache`。

## 起服务

**要给用户点开的服务，必须用 `vh-service` 启动。** 它同时完成登记和保活，服务才会出现在面板里、才有对外地址：

```sh
vh-service run --name <名称> --port <端口> -- <启动命令>
# 例：vh-service run --name demo --port 8000 -- node server.js
```

只用 `setsid nohup ... &` 起的服务**不会出现在面板里**，用户也打不开——网关只代理你用 `vh-service` 登记过的端口。

`vh-service list` 查看已登记的服务，`vh-service stop --port <端口>` 停止。

不需要给用户看的后台进程才用：

```sh
setsid nohup node worker.js > ~/workspace/worker.log 2>&1 < /dev/null &
```

然后轮询 `curl -sS localhost:<port>/health` 确认起来了。

端口：避开 `3100-3999`（实例保留段）。其余端口可以用，但回环是和同容器内其他账号共享的，端口被占用就换一个（`ss -lnt` 能看到谁在听）。

## 网络

- 你和其他账号共享同一个容器回环：你的服务监听 `127.0.0.1:<port>`，网关也经这同一个回环访问它。端口是共享资源，登记前先确认没被占用。
- **不要把 `127.0.0.1:<port>` 直接给用户。** 用户的浏览器在平台域名下，打不开容器回环。把地址告诉用户时，给下面两种之一：
  - 让用户点服务面板里的「打开」；
  - 或者给相对路径 `/__vh/svc/<port>/`（用户当前站点的域名 + 这个路径，例如 `https://当前域名/__vh/svc/8000/`）。
- `/__vh/svc/<port>/` 只转发你登记过的端口，其他端口一律 404。端口范围 1024-65535，避开 `3100-3999`。
- npm registry、GitHub、npmmirror、jsdelivr 可访问。
- 有浏览器：`chromium`（`/usr/bin/chromium`，全机器共用一份只读副本）。抓页面、截图、跑无头自动化时用
  `chromium --headless=new --no-sandbox --disable-dev-shm-usage --user-data-dir="$HOME/.cache/chromium" <url>`：
  jail 的 `/dev/shm` 只有 64MB，不带 `--disable-dev-shm-usage` 渲染进程会被 OOM；沙箱起不来时靠 `--no-sandbox`。
  用户数据目录必须放在自己的 `$HOME` 下，那是你私有的。
  容器里没有 dbus，stderr 会刷一串 `Failed to connect to the bus`；那是警告不是故障，判断标准是 stdout 有没有 DOM 输出。
- 有 `docker` CLI，连的是宿主机 daemon，容器与镜像落在宿主上（运维 `docker ps` 看得到）。用法见下节。

## 容器

`docker` 直接可用（`DOCKER_HOST` 已指向你自己的能力 socket，不用设）。这是真 docker：拉镜像、`docker run`、`docker ps` 都正常，产物落在宿主机上（运维看得到）。

```sh
docker run -d --name web -p 8080:80 nginx:alpine
docker ps
docker logs web
```

- **端口**：`-p 8080:80` 里宿主侧那个端口会被换成你自己段内的一个端口（别人用不了），但 `8080` 这个号仍然记得住——用户打开 `/__vh/svc/8080/` 或 `/__vh/svc/80/`（容器端口）都能到，两者等价。`docker port web` 看到的是宿主侧的真实端口，不用把它给用户。
- **名字**：`--name web` 在宿主上叫 `vh-<你的账号>-web`，你这边 `docker ps` / `docker inspect web` 看到的仍然是 `web`。
- **网络**：不指定 `--network` 时落在你自己的 `vh-<账号>-default` 上，和别的租户二层隔离；需要多容器互通就 `docker network create app-net`（同样会被加上前缀）。
- **权限**：`--privileged`、`--cap-add ALL`、`--net host`、`--pid host`、`-v /:/host`（除自己 home 外的任何宿主路径）、把端口绑到 `0.0.0.0`、`docker system prune`、读别人的镜像，都会被网关拒绝并返回 403。
- **资源**：单容器的内存/CPU/PID 有上限，超了会被拒或起不来。
- `docker exec`（含 `-it`）和 `docker run -it` **不可用**：它们要把连接切成裸流，网关只做普通 HTTP 转发，一律立刻返回 501。调试靠 `docker logs`、`docker cp`，或把要排查的动作写进镜像/启动命令里重跑。
- **构建**：`DOCKER_BUILDKIT=0 docker build ...` 可用。默认（BuildKit）不行——镜像里没有 buildx，而且它也要劫持连接。
- 容器端口能打开，但**不出现在右侧服务面板里**（面板列的是 `vh-service` 登记的进程服务）。要让用户从面板点开，仍然用 `vh-service`；容器适合跑数据库、Redis、别人的镜像这类现成组件。

## 别做的事

- 不要改 `~/.dsh` 下的 profile 和凭据文件：那是运行时自己的状态，改坏了要重建账号。
- 不要指望 `systemd`、`supervisord`：没有 init 系统，进程由你自己托管。
- 不要把服务绑到 `127.0.0.1` 以外还指望面板能打开：网关只连本机回环，绑到外面等于没暴露，也拿不到任何额外可达性。
- 不要指望端口凭空可访问：网关只转发上面那几段，其余端口只有你自己连得上。
