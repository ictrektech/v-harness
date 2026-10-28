---
name: photocraft
description: 用自然语言编辑照片。一句话能说清就走 photocraft_edit；卡片外的活走 photocraft_search → photocraft_describe → photocraft_run。每次编辑都返回预览图：必须先看图再决定下一步或交付，但看图只核对有没有搞坏，不是评判好坏；同一张图同一个改动最多 2 次。
---

# PhotoCraft

你决定「要什么像素结果」，工具负责执行。

## 规矩（就这四条）

1. **一次把需求拆全。** 一段话里常有几件事（去水印 + 调色 + 加字），逐件各做一次，**全做完再交**。不要做完一件就汇报，也不要在一件上反复打磨。
2. **结果回来先看图，再决定。** 只看三件事：位置对不对、有没有伤到别处、有没有穿帮。没这三样就直接交付——不评判"够不够好"，不为更理想重跑，也不再 `look` 确认一遍。
3. **同一张图、同一个改动最多 2 次。** 第 3 次工具直接拒绝。被拒绝就是该交付、或直接说做不到，不是换个说法再试。
4. **不要乱调。** 参数不确定 → `photocraft_describe` 查一次，查到就用；已成功的调用不重试；不探环境（`ls`/`which`/试库）；不凭空造框，不放大用户的框。

## 走哪条路

- 一句话能说清 → `photocraft_edit` 一张卡
- 卡片外的活（局部选区、按颜色选、滤镜库、路径、批处理）→ `photocraft_search` → `photocraft_describe` → `photocraft_run`

## 卡片：photocraft_edit

| intent | 干什么 | 必备输入 |
|---|---|---|
| `film` | 整图调色（冷/暖/胶片）；带 `regions` 即局部调色 | 无，`look`/`strength` 可选 |
| `cutout` | 抠出主体、换底色 | 有框或笔迹最好 |
| `remove` | 去水印、路人、字迹 | 框或笔迹标位置 |
| `enhance` | 降噪、锐化、修画质 | 无；抱怨偏色时 `autoColor: true` |
| `poster` | 海报排版 | `text` |
| `composite` | 贴另一张图（换背景/天空） | `assets` |
| `brush` | 画笔 / 橡皮擦 | `strokes`；`color`/`erase` 可选 |
| `retouch` | 修图笔刷：`tool` 取 dodge / burn / sponge / blur / sharpen / smudge / clone / spotHeal / heal / patch | `tool` + `strokes` |
| `fill` | `tool`：bucket 油漆桶 / gradient 渐变 | `tool` + 落点 + `color` |
| `transform` | `action`：crop / rotate / flipH / flipV / trim / resize | `action` + 参数 |
| `gray` | 转黑白 | 无 |
| `text` | 加一段字，**位置由引擎决定**，不能指定 | `text` |

- 参数值一律按 `photocraft_describe` 的声明给，不要凭记忆；用户没给数值就取轻档（宁轻不重）。
- 分区域不同调（"花变冷、其余变暖"）：先整图调"剩下"那个调子，再带选区调目标区。
- 要精确落位（尤其文字）不要用 `text` 卡，走 `type.create`。

## 走 run：一次调用跑完

`photocraft_search {query}` 用自然语言搜命令 → `photocraft_describe {id}` 看参数与 `blocked`（跑不了的原因）→ 一次 `photocraft_run { steps: [doc_open, 命令..., doc_export] }`。

**会话会过期**（引擎放在内存，空闲或重启即失效，历史回不来）。所以：

- 一个工作流写成**一次** `steps`，不要拆成先 open、再 run、再 export。
- 必须跨调用时，用上一轮导出的 `wish-*.png` 重新 `doc_open`；报 `no open document` 就是重开再继续。

`doc_open` 的 `path` 是**工作区文件名**或 `sha256:<hex>`；`doc_export` / `doc_save` 的 `path` 是**工作区落点**（`out/最终.png`，省略则自动 `wish-<时间戳>.png`），导出后文件就在工作区。

## 两套坐标，别混

- 卡片（`regions` / `strokes` / `fill`）：**0..1 相对比例**，工具自己乘画布尺寸。
- 引擎命令（`type.create`、`select.*`、`layer.*`…）：**像素**，先用 `doc_inspect` 拿尺寸自己乘。
- 例：547×365 画布，画面中上 → 卡片 `{x:0.5, y:0.1}`，命令 `{x:273, y:36}`。

## 用户画的框和笔迹

```text
把这块背景换成第二张
<region role="cut" n="1" img="1" image="att_7f3c" x="0.1410" y="0.6900" w="0.7100" h="0.1100"/>
<strokes img="1" n="1">[[0.31,0.52],[0.33,0.51]]</strokes>
```

- 已是 `0..1`，**直接用**，不换算、不放大。`role="cut"` 按 `n` 顺序进 `regions`。
- `<strokes>` 的 tag 体就是点数组 → `strokes: [{ points: [[0.31,0.52],[0.33,0.51]] }]`。
- **框不在图里**：你收到的永远是原图，不要在图里找红框，也不要因为"看着干净"就当用户没画。
- 笔迹比框精确，擦除/画笔/局部调色优先用笔迹。

## 图从哪来

- 图片标识形如 `sha256:<hex>`，**原样**传 `source`（素材进 `assets`）；绝对路径也认。
- `<region>` 把同一张图写两遍：用 `img="1"`/`"2"` 认附件顺序，`image="att_7f3c"` 是草稿 id，**永远匹配不上，不要解析**。
- **不要把图拷进工作区**，只会制造失败。只支持图片，上限 30MB。
- 附两张图：第一张主体、第二张素材；有框 = 填进框，没框 = 贴到后面。

## 交

- `photocraft_edit` 出两个文件：`wish-<时间戳>.png`（可看可发）+ `.psd`（保图层存档）。交付报这两个名字。
- 要展示就写 `![说明](wish-<时间戳>.png)`，用**工作区**的成品名；工具结果里的 `*-preview.png` / `*-closeup.png` 只是附件，工作区没有。
- 续改：`source` 写上一轮的 `wish-*.png`；**省略 `source` 就是改最近交付的成品**；`.psd` 不要当 `source`。
- 返工：回到**出问题那一步之前**的 `wish-*.png` 重做，不在原图重来，也不在成品上再叠。

## 出错怎么办

| 症状 | 处理 |
|---|---|
| `unknown command` | `photocraft_search` 重找，别改拼写硬试 |
| `no open document` / `HTTP 404` | 会话换过了，重新 `doc_open` 整段重跑 |
| `blocked` | 读 `disabled_reason`，先做选择 / 建图层 / 开文档 |
| 找不到图片 X | 报错会列工作区最近 5 张，换对的 `source` |
| 画面没变化 | `photocraft_describe` 核对字段名，别猜 |

## 边界

- **没有生成式能力**：换脸、扩图、凭空画元素做不了，直接说。
- 处理永远用原始字节，不要让引擎先降采样。
- `preview: "off"` 只适合纯数值可判定的改动（调色强度、裁剪尺寸）；删除、抠图、合成必须看图。
- 颗粒、噪点这类细微差别预览不可靠，按用户语义一次定稿。
- 引擎中间文件在 `photocraft-tmp/`，成品才落工作区。
- `这个账号还没有被授予任何目录` → 数据授权没配，不是程序坏了。
