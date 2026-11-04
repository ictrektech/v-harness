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

命令工具在调用结束时回收整个进程组，裸的 `cmd &` 活不过这一次调用。要让服务跨调用存活，用：

```sh
setsid nohup node server.js > ~/workspace/server.log 2>&1 < /dev/null &
```

然后轮询 `curl -sS localhost:<port>/health` 确认起来了。

端口：避开 `3100-3999`（实例保留段）。其余端口随便用，`5173`、`8000`、`5432` 都可以——这台机器有你自己的 `127.0.0.1`，不会和别人的服务撞车。

## 网络

- 你的服务只在这个账号自己的网络里：别人连不进来，你也连不到别人的 `127.0.0.1`。
- 浏览器（服务面板的「打开」）只转发这些端口段：`3000-3099`、`5173`、`8000-8099`、`9000-9099`。监听在别处的服务自己能访问，面板里也看得到，但「打开」连不上——换一个段内的端口。
- npm registry、GitHub、npmmirror、jsdelivr 可访问。
- 这台机器内**没有 docker**，也没有容器运行时：`docker`、`podman` 都不可用。需要运行的东西直接以进程方式启动（`node`、`python`、`java -jar` 等）。

## 别做的事

- 不要改 `~/.dsh` 下的 profile 和凭据文件：那是运行时自己的状态，改坏了要重建账号。
- 不要指望 `systemd`、`supervisord`：没有 init 系统，进程由你自己托管。
- 不要把服务绑到 `127.0.0.1` 以外还指望面板能打开：网关只连本机回环，绑到外面等于没暴露，也拿不到任何额外可达性。
- 不要指望端口凭空可访问：网关只转发上面那几段，其余端口只有你自己连得上。
