# 版本发布流程

v-harness 有两条**独立**的流水线，顺序不能颠倒：

```
① 镜像 ── build_image.sh ──▶ 华为云 SWR + 飞书发布表
                                    │
                                    │ package.sh 从飞书读最新 tag
                                    ▼
② 应用包 ── update_version.sh ──▶ tag ──▶ GitHub Actions ──▶ Release + VOS App Store
```

**为什么分开**：镜像可以一天发多次（改一行网关代码就重建），应用包只在需要
更新 VOS 商店里的版本时发。应用包不烧死镜像 tag，而是打包时从飞书读最新的，
所以重发应用包不需要重新构建镜像。

## 0. 前置条件

| 项 | 位置 | 用途 |
|---|---|---|
| SWR 登录 | 构建机 | `docker login swr.cn-southwest-2.myhuaweicloud.com` |
| `~/.feishu.json` | 构建机（**不提交**） | `feishu_app_id` / `feishu_app_secret` / `feishu_spreadsheet_token` |
| `~/.feishu.components.json` | CI（由 secrets 生成） | 同上，供 `package.sh` 读取 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | GitHub secrets | CI 读写飞书 |
| `FEISHU_SPREADSHEET_TOKEN` | GitHub secrets 或本地配置文件 | 定位发布表；**仓库里不留任何值** |
| `APPSTORE_IP` / `APPSTORE_TOKEN` | GitHub secrets | 推送到 VOS App Store |

三个飞书取值都不写进仓库。本地放在 `~/.feishu.json`：

```json
{
  "feishu_app_id": "...",
  "feishu_app_secret": "...",
  "feishu_spreadsheet_token": "..."
}
```

两个脚本的解析顺序一致：环境变量 `FEISHU_SPREADSHEET_TOKEN` → 配置文件里的
`feishu_spreadsheet_token` → 报错退出。缺失时**不会静默使用内置默认值**。

## 1. 发布镜像

在对应架构的构建机上执行（amd 用 x86_64，arm 用 aarch64）：

```bash
./build_image.sh --dry-run          # 先看计划：target、tag、sheet、版本
./build_image.sh --target amd       # 构建 + push SWR + 写飞书
./build_image.sh --target arm       # 换 arm 构建机
```

产物：

```
swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-harness:amd_YYYYMMDD
swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-harness:arm_YYYYMMDD
```

行为细节：

- tag 为 `amd_YYYYMMDD`；同日第二次构建自动让位为 `amd_YYYYMMDD_2`、`_3`，
  避免覆盖飞书表里已记录的那一版
- 飞书表按 `--target` 选 sheet：amd → `AMD_with_cuda,AMD_with_mxn100`；
  arm → `ARM_without_cuda,l4t,ARM_with_cuda,thor_spark,SOPHON_bm1688`
- 服务列名固定 `v-harness`；列不存在时追加，日期行不存在时插入 A4
- `--no-push` 只构建、`--no-feishu` 不写表、`--feishu-only` 只登记已有 tag

**完成标准**：`docker manifest inspect` 能看到新 tag，飞书对应 sheet 的
`v-harness` 列当天行有值。

## 2. 发布应用包

先确认工作区干净（脚本会拒绝脏工作区），然后：

```bash
./ictrek.app/scripts/update_version.sh patch   # 或 minor / major
```

这个脚本做四件事：

1. 递增 `ictrek.app/VERSION`
2. `git commit -m "chore: release VOS v-harness x.y.z"`
3. 打 tag `vos-v-harness-vx.y.z`
4. push 分支与 tag

tag 推上去后，`.github/workflows/vos-release.yml` 自动：

1. 写入飞书凭据
2. 跑 `package.sh`：按 profile 从飞书读最新镜像 tag，渲染进 `app.tar.gz/.env`
3. 打 `v-harness_x.y.z_pull.tar`
4. 创建 GitHub Release（tag `vx.y.z`，附变更日志）
5. 通过 SSH 隧道把包投到 VOS App Store

**完成标准**：

```bash
gh run list --workflow vos-release.yml --limit 3
gh run view <run-id> --log-failed        # 有失败时必看
gh release view vx.y.z --json assets     # 应包含 v-harness_x.y.z_pull.tar
```

之后在 VOS 应用商店确认版本号已更新。

## 3. 本地验证应用包（可选）

不推 tag 也能先验证打包内容，但需要飞书可达：

```bash
PACKAGE_VERSION=0.1.0 ./ictrek.app/scripts/package.sh
tar tf ictrek.app/dist/v-harness_0.1.0_pull.tar
tar xOf ictrek.app/dist/v-harness_0.1.0_pull.tar app.tar.gz | tar tz
```

`package.sh` 会校验：

- `manifest.yml` 的 profiles 恰好是 `amd` / `arm`，且互斥声明完整
- `docker-compose.yml` 每个 profile 都有对应 service
- 渲染后不残留 `__APP_VERSION__` 或 `${V_HARNESS_*_IMAGE}`
- Traefik 规则用 v3 的 `HeaderRegexp`（`HeadersRegexp` 会让路由静默失效）
- `routers.yml` 的 page id、iframe-src、entrypoint、embed 与约定一致
- `icon.png` 是 256×256 8-bit RGBA

## 4. 回滚

| 场景 | 做法 |
|---|---|
| 应用逻辑坏了，镜像可复用 | 把 `VERSION` 回退到上一个版本，再跑一次 `update_version.sh`（新 tag） |
| 镜像本身坏了 | 修复后重新 `build_image.sh`，得到新 tag，再发应用包 |
| 只想让某个租户回退 | 改该用户 unit 的镜像 tag 并重启实例，不影响其他用户 |

镜像 tag 不可变：同一天重发会得到 `_2`、`_3` 后缀的新 tag，不会覆盖旧 tag，
所以回滚永远有据可查。

## 5. 组件与文件对照

| 文件 | 谁写 | 谁读 |
|---|---|---|
| `ictrek.app/VERSION` | `update_version.sh` | `package.sh`、CI |
| `ictrek.app/src/manifest.yml` | 手写 | `package.sh` 渲染 |
| `ictrek.app/src/docker-compose.yml` | 手写 | `package.sh` 渲染镜像变量 |
| `ictrek.app/src/icon.png` | `scripts/gen-icon.mjs` | `package.sh` 校验 |
| `ictrek.app/dist/*_pull.tar` | `package.sh` | CI 上传 Release |
| 飞书发布表 | `build_image.sh` | `package.sh` 读 tag |
