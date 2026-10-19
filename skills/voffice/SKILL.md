---
name: voffice
description: "读写当前用户在 VOS「我的文档」里的办公文档（V-Office）。当用户要求把文档保存/归档到 V-Office、列出或管理云端文档、把云端文档取下来查看或修改、重命名/删除云端文档时触发。"
---

# V-Office 云端文档

当前 VOS 用户在 V-Office 里有一份私有文档目录。本 skill 把产物推上去，或把云端的取下来改。

所有命令都用同一个入口（绝对路径固定，不要 cd）：

```bash
node /opt/v-harness/skills/voffice/scripts/voffice.mjs <命令> [参数...]
```

每个命令输出一个 JSON 对象；失败时退出码非 0，错误在 stderr。

## 命令

| 命令 | 用途 |
|---|---|
| `me` | 确认当前令牌归属的用户，排障第一步 |
| `list` | 列出「我的文档」全部文件（name / size / modified） |
| `download <name> [--out <路径>]` | 下载到 workspace（默认 `./<name>`） |
| `view <name> [--out <路径>]` | 下载后立刻用 `present` 交付给用户查看 |
| `upload <文件> [--name <云端文件名>]` | 新建或原子覆盖云端文档 |
| `rename <name> <新名字>` | 重命名 |
| `delete <name>` | 删除 |
| `health` | 连通性检查 |

## 交付流程（用户要"存到 V-Office / 归档 / 发我一份"）

1. 在 workspace 里把文档准备好，文件名要能表达内容，带受支持扩展名。
2. `upload <文件> --name '<文件名>'`。
3. 回复里说明已保存，并给出文件名。

支持 docx / xlsx / pptx / pdf / odt / ods / odp / csv / txt / md，单文件上限 100 MB。同名上传是原子覆盖。

## 查看流程（用户要"打开 / 让我看看 / 取下来改"）

1. `view <name>`：脚本把文件下载到 workspace，返回 `path`。
2. **紧接着调用 `present` 工具**，`files: [{ path: <返回的 path>, description: '<文档名>' }]`。
   用户在聊天里点卡片即可在右侧预览（docx/pptx 由客户端转 PDF 渲染，xlsx 用表格渲染）。
3. 需要在线编辑时，提示用户到 VOS 门户 → V-Office → 「我的文档」里打开；本 skill 不能直接唤起编辑器。

不要用 `download` 把二进制读进上下文，也不要 base64。

## 规则

- 先 `view`/`download` 再改：用户说"改一下上次那份报告"，先下载，改完再 `upload` 覆盖。
- 删除前必须得到用户明确确认；`delete` 不可恢复。
- 文件名不要带路径或 `..`；中文、空格由脚本负责编码，不要手动编码。
- 云端是扁平结构，没有目录、没有移动/复制、没有分享链接、没有历史版本，不要承诺这些。
- 失败就如实转述，不要静默重试：
  - `401` → VOS 登录令牌过期，让用户刷新 v-harness 页面后重试；
  - `404` → 当前用户目录下没有这个文件，先 `list` 确认名字；
  - `409` → 目标名已存在，或文档在别的窗口被改过，先与用户确认覆盖/改名；
  - `413` → 超过 100 MB。

## 环境

脚本自己找接入点，不需要你拼地址或令牌：

1. `$HOME/.dsh/voffice.sock`（v-harness 网关按租户提供的本地能力端点，鉴权由网关完成）；
2. 本地调试时才用 `V_OFFICE_URL` + `V_OFFICE_BEARER_TOKEN`。

因此**不要**自己 `curl` v-office 的地址：模型侧拿不到令牌，直连只会 401。
