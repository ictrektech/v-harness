# v-harness 插件与 Skill 开发指南

写给后面要做工具的人。读完这一篇，你能把一个新能力从 CLI 一路做到租户会话里的交互卡片。

其他入口文档：[多用户架构](MULTIUSER.md) · [发布流程](ictrek.app/RELEASE.md)。

## 一句话架构

一个能力通常由三层组成，逐层可选：

```
skills/<name>/            SKILL.md + 零依赖 CLI     ← agent 用 bash 调它（发现层）
packages/skill/skill-<x>/ agent 侧工具插件           ← 类型化工具调用（执行层）
packages/client/ui-*/     浏览器卡片插件            ← 把结果渲染成交互卡片（呈现层）
```

以 V-Office 为例：`skills/voffice/`（SKILL.md + voffice.mjs）→ `packages/skill/skill-voffice`（voffice_list/open/rename/upload 四个工具）→ `packages/client/ui-tool-cards`（voffice.* 卡片视图）。

三层是解耦的：只做 skill 就能用（agent 走 bash）；加工具插件后获得 schema 校验、权限审批、卡片元数据；加客户端卡片后才有真正的交互 UI。

## 硬性约束（先记住再动手）

1. **令牌不能走环境变量**。dsh 会清洗子进程环境（名字带 `KEY|PASSWORD|SECRET|TOKEN` 的都进不去 bash）。给 agent 的能力要走**每租户能力 socket**：网关在 `$HOME/.dsh/<name>.sock` 起端点、代理补 `Authorization`、`vh-userctl claim` 把 socket 交给租户（0600）。agent 拿不到令牌，能做的只有该用户名下的事。参考 `gateway/office.mjs` + `skills/voffice/scripts/voffice.mjs`。
2. **模型可见 ⟺ 会话留痕**。工具结果里给卡片的元数据（`presentationMeta`）会随会话日志持久化，别往里塞敏感信息。
3. **配置显式声明**，不硬编码端点：部署相关的值用 `disabled: !!js "!process.env.XXX"` 行表达式 + 环境变量门控（见 carrier 补丁里的 image-studio 行）。

## 第 1 层：Skill（可选，但推荐先做）

目录约定（进镜像后由 `DSH_BUNDLED_SKILL_DIR=/opt/v-harness/skills` 发现，租户不可改）：

```
skills/<name>/
  SKILL.md              # frontmatter（name/description 给模型看）+ 用法说明
  scripts/<name>.mjs    # 零依赖 CLI，stdout 只输出 JSON
```

CLI 约定：子命令风格（`list` / `open --name X`），成功输出 JSON 到 stdout，失败非零退出 + stderr 文案；socket 路径从 `$HOME/.dsh/<name>.sock` 读。参考 `skills/voffice/scripts/voffice.mjs`。

**验收**：`runuser -u vh-xxx -- node skills/<name>/scripts/<name>.mjs list` 能跑通且输出合法 JSON。

## 第 2 层：agent 侧工具插件

新建 `packages/skill/skill-<name>/`，最小三件套：

**package.json** —— 只声明 peer 依赖（实现由 dsh 安装供给），不要有真实依赖：

```json
{
  "name": "@deepseek-ai/dsh-skill-<name>",
  "version": "0.2.1-rc.2",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "peerDependencies": {
    "@deepseek-ai/dsh-shell": "workspace:*",
    "@deepseek-ai/dsh-tools": "workspace:*",
    "@deepseek-ai/cordis": "workspace:~"
  }
}
```

**src/index.ts** —— 插件入口，解析 CLI 运行时并注册工具：

```ts
export const name = 'skill-<name>'
export function apply(ctx: Context, config: Config = {}): void {
  const assetRoot = config.assetRoot ?? process.env.VH_SKILLS_DIR ?? /* 仓库默认 */
  ctx.inject(['tools', 'shell'], (toolCtx) => registerXxxTools(toolCtx, runtime))
}
```

**src/tools.ts** —— 用 `defineTool` 声明，关键是 `output.presentationMeta`（卡片元数据，必须可 JSON 序列化、可从持久化值重放）：

```ts
ctx.tools.register(defineTool({
  name: '<name>_list',
  description: '...',
  parameters: {},
  output: {
    schema: { /* JSON schema，字段全部 required 标注 */ },
    presentationMeta: (_args, value) => ({ kind: '<name>.list', ...value }),
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(_args, exec) { /* 调 CLI，返回对象 */ },
}))
```

抄作业顺序：`packages/skill/skill-voffice/src/tools.ts`（最完整）。测试写在同包 `tests/` 下。

**注册（三处，缺一构建时报错）**：

| 文件 | 改动 |
|---|---|
| `gateway/agent-plugins/plugins.txt` | +1 行 `packages/skill/skill-<name>`（tsc/tsdown/staging 自动跟随） |
| `gateway/agent-plugins/vh-agent-plugins/package.json` | dependencies +1 行 `"@deepseek-ai/dsh-skill-<name>": "0.2.1-rc.2"` |
| `gateway/agent-plugins/vh-agent-plugins/cordis.patch.yml` | insert 里 +1 个挂载行（id 用 `skill-<name>`，带环境变量门控） |

加完后跑 `node --import tsx/esm scripts/stage-agent-plugins.ts --out /tmp/x` 自检——它会校验清单、carrier 依赖、补丁行三方一致，漏一处直接报错。

## 第 3 层：浏览器交互卡片（可选）

`packages/client/ui-tool-cards/src/client/` 四个文件：

- `index.ts`：`TOOL_KEYS` 加工具名（按名注册键控 `tool.call.toolview`）；
- `Cards.tsx`：按 `meta.kind` 分支的卡片组件（从 `presentationMeta` 派生，重放可复现）；
- `meta.ts`：把持久化 meta 收窄成卡片模型的守卫；
- `locales.ts`：`voffice.*` 风格的文案键（中英都写）。

如果工具自带交互卡片，记得客户端插件包也要能到租户浏览器：`syncClientPlugins` 会把镜像构建复制进 profile 并自动创建缺失目标，carrier 补丁里的 `ui-<name>` 行负责挂载（纯 agent 工具跳过本层）。

## 构建与上线

```bash
./build_image.sh --no-push   # 本地构建；去掉 --no-push 推 SWR
```

镜像里自动发生的事：`plugins.txt` 驱动 tsc/tsdown 构建并产出 `lib/index.js`（发布同款入口）→ staging 脚本按 package.json 自动算依赖闭包（peer 依赖不打包，由 dsh 安装解析层供给）→ payload 进 `/opt/v-harness/agent-plugins/`，客户端 bundle 进 `/opt/v-harness/plugins/`。

租户侧由 `gateway/plugins.mjs` 全自动处理：**首次登录前** profile 已预创建（含 carrier 行），客户端包缺失即创建、已有则覆盖，agent 插件包覆盖、闭包依赖缺了才补。新工具上线 = 换镜像，租户无感。

## 排障速查

| 症状 | 看哪里 | 常见原因 |
|---|---|---|
| agent 说没有这个工具 | `/data/logs/<ns>.log` 搜 `skipping` | carrier 行没加 / 包没进 profile / 行 disabled 表达式为真 |
| 工具调了但卡片是通用 JSON 面板 | 会话日志（`session.v4.jsonl.zstd`，多帧 zstd）里查 `data.meta` | 有 meta → 浏览器端客户端包旧，强刷；无 meta → 工具没声明 `presentationMeta` |
| 构建时 stage-agent-plugins 报错 | 报错文本直接指名缺什么 | 三处注册没改齐 |
| 租户页面「网关错误」 | `docker logs` + 实例日志 | 见 MULTIUSER.md（曾出现过孤儿 dsh 占端口，杀掉即可） |

改完代码不用手装：构建镜像 + 换 tag 即可，热修（`docker cp` 进容器）只用于临时验证。
