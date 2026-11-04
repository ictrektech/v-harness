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

端口：避开 `3100-3999`（实例保留段，会被网络规则挡掉）。其余端口随便用，`5173`、`8000`、`5432` 都可以，但**同一台机器上只有一个 `127.0.0.1`**，选择非默认端口能避免和别的项目撞车。

## 网络

- npm registry、GitHub、npmmirror、jsdelivr 可访问。
- Docker Hub 直连不通（DNS 被污染），但 `docker pull` 已配置镜像站，正常用即可。
- 嵌套容器用 `--network host`，bridge 是关掉的。

## 别做的事

- 不要改 `~/.dsh` 下的 profile 和凭据文件：那是运行时自己的状态，改坏了要重建账号。
- 不要指望 `systemd`、`supervisord`：没有 init 系统，进程由你自己托管。
- 不要把服务绑定到 `0.0.0.0` 以外的地址后还期望外部能访问：本机没有对外暴露的端口映射。
