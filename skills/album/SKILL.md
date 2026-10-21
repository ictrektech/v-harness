---
name: album
description: "搜索与整理当前用户的 AI 相册（VOS 应用 ai-album/Immich）：语义搜图、按人/时间/地点/相册筛选、在线预览、相册分组、照片与视频上传；配合 image-studio 对相册照片做风格化或生成视频后存回。当用户要找照片、浏览相册、整理照片、把照片/视频存进相册时触发。"
---

# AI 相册

当前 VOS 用户在 AI 相册（ai-album）里有一份私有照片库。本 skill 负责「找 / 看 / 管 / 存」；**创作（风格化、老照片处理、照片变视频）不在这里做**——那是 image-studio skill 的事，两边衔接方式见下文。

所有命令都用同一个入口（绝对路径固定，不要 cd）：

```bash
node /opt/v-harness/skills/album/scripts/album.mjs <命令> [参数...]
```

每个命令输出一个 JSON 对象；失败时退出码非 0，错误在 stderr。

## 命令

| 命令 | 用途 |
|---|---|
| `health` | 连通性检查 |
| `me` | 确认当前相册账号 |
| `search <描述> [--size n] [--thumbs n]` | CLIP 语义搜图（「去年夏天海边的日落」） |
| `photos [--city --country --from --to --type image\|video --favorite --album <id> --person <id> --rating 1-5]` | 结构化筛选 |
| `person <名字>` | 按人脸找人（返回 id 与张数） |
| `explore` | 城市/地点聚合浏览 |
| `albums` | 列出相册 |
| `album-create <名称> [--description d]` | 新建相册 |
| `album-add <相册id> <照片id...>` | 把照片加进相册 |
| `view <id> [--out 路径]` |下载原图到 workspace（给 image-studio 取材） |
| `thumb <id> [--size thumb\|preview\|full]` | 下载缩略图到 workspace |
| `upload <文件> [--album <id>]` | 上传照片/视频进相册（SHA-1 去重） |

`search` / `photos` 默认把前几张（最多 6 张）的缩略图下载到 `album-thumbs/`（`--thumbs 0` 关闭），结果的 `thumbPath` 就是本地文件路径，直接用 `present` 展示。

## 交互原则

- **每个动作的回复都是「回执 + 下一步的钩子」**：搜完给网格，告诉用户总数、还能怎么收窄、以及「指着某张就能加工」。
- **原图永不动**：相册里的照片不会被覆盖；生成结果存回时是新条目，字节级去重。
- **长任务先交代时长**：交给 image-studio 的生成任务要说明预计耗时，生成中允许用户继续聊别的。

## 找照片（"看看有哪些 / 找找去年海边的"）

1. `search '<用户原话>'`（语义搜图）或 `photos --from 2025-06-01 --to 2025-08-31`（明确条件时）。
2. 用 `present` 把 `thumbPath` 缩略图摆成网格展示：每张注明拍摄时间/地点；交代「共 N 张，这是最相关的 M 张」。
3. 留钩子：**「想收窄就再给条件（时间/地点/人物/相册），想加工就指着说哪张——做成视频、改风格都行」**。
4. 用户说「日落的那些」「有人物的」→ 加条件重新搜；说「朵朵的」→ 先 `person <名字>` 拿 id，再 `photos --person <id>`。

## 看大图（"打开看看 / 放大"）

`thumb <id> --size full` 后用 `present` 展示；要看原图细节（打印、裁剪前确认）用 `view <id>`。

## 整理（"放进相册 / 新建个相册"）

1. 歧义必确认：用户说「把朵朵的照片放进相册」，先 `person` + `photos --person` 列出候选与张数，给预览，让用户确认范围（全部/挑几张）。
2. 相册不存在时 `album-create '<名称>'`，再 `album-add <相册id> <id...>`。
3. 回执交代：**相册只是分组，移动不搬运文件、原图不受影响**。

## 存回相册（"存到相册 / 收藏这张"）

- 上传 workspace 里的文件：`upload <文件> [--album <id>]`；返回 `duplicate:true` 说明库里已有字节相同的内容，如实告诉用户即可。
- 生成作品的回流：image-studio 生成完 → `upload` 存回（或 image-studio 自己的 immich-upload 流程）→ 回执「新增 N 个条目、原图未动」。

## 与 image-studio 的衔接

用户指着照片说「做成视频 / 改成 XX 风格 / 修复」时：

1. `view <id>` 取原图到 workspace；
2. **交棒给 image-studio skill**（`--input` 参考图 / `--init-job` 迭代），并交代预计时长；
3. 完成后回执 + 问「要存回相册吗」→ `upload --album <id>` 收尾。

## 规则

- 语义搜图是第一选择：用户描述画面而不是给文件名时，用 `search`。
- 筛选条件不确定就先 `explore`（看有哪些城市）或 `albums`（看有哪些分组）。
- 失败如实转述，不要静默重试：
  - `401` → 登录状态失效，让用户刷新 v-harness 页面后重试；
  - `404` → id 不存在，先 `search`/`albums` 确认；
  - `403` + 提示缺少权限 → 平台侧 `IMMICH_VOS_PERMISSIONS` 未放开，告知用户联系管理员，不要换其他命令绕过；
  - `duplicate` → 内容已存在，如实转述。

## 环境

脚本自己找接入点，不需要你拼地址或密钥：

1. `$HOME/.dsh/album.sock`（v-harness 网关按租户提供的本地能力端点，VOS 令牌与相册密钥都在网关侧）；
2. 本地调试才用 `ALBUM_URL` + `ALBUM_API_KEY`。

因此**不要**自己 curl 相册服务地址：模型侧拿不到密钥，直连只会 401。
