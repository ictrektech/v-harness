---
name: photocraft
description: 用自然语言编辑照片。PhotoCraft 有 918 条引擎命令，全量可达——影调、滤镜、局部调色、抠图换底、去物、修画质、海报、动作、批处理都在其中；命令靠检索发现，不靠背，也不要假定某个能力不存在。常见事一步走 photocraft_edit，其余一切走 photocraft_search → photocraft_describe → photocraft_run。
---

# PhotoCraft

PhotoCraft 是一个跑在 harness 旁边的完整图像编辑器：**每个菜单项、每个滑块、每个对话框都是一条命令**，共 918 条。每一次编辑都是真实文档——有图层、有选区、有历史，不是一个一次性滤镜。

工具经网关持有的 socket 访问引擎；你不接触任何凭据，也够不到别人的文件。

## 一、两条路，先选路

| 用户要的 | 走哪条 |
|---|---|
| 调色 / 抠图换底 / 去水印杂物 / 修画质 / 加标题做海报 | `photocraft_edit`，一步 |
| 其余一切：局部改、按颜色选、蒙版、路径、文字排版、滤镜库、动作、批处理 | `photocraft_search` → `photocraft_describe` → `photocraft_run` |
| 不确定文档现在是什么状态 | `photocraft_inspect` |

**`photocraft_edit` 是捷径，不是边界。** 它覆盖日常八成；剩下两成走 search + run，同样是一等能力，不是退路。

一句话判断：**能一句话说清的，用 edit；需要"只改这一块/只改这个颜色/分几步来"的，用 search + run。**

## 二、918 条命令的族表

不要背命令，但要大致知道东西在哪族：

| 族 | 条数 | 用来做 |
|---|---:|---|
| `filter.*` | 62 | 滤镜库（blur 11 / stylize 9 / distort 9 / render 9 / pixelate 7 / noise 5 / sharpen 5 / gallery 47） |
| `edit.*` | 31 | 编辑操作（填充、描边、变换、内容识别） |
| `layer.*` | 26 | 图层、调整层、蒙版、混合、样式、裁切 |
| `select.*` | 19 | 选区：矩形、魔棒、色彩范围、主体/对象/快速选择、细化边缘、反选 |
| `file.automate.*` | 18 | 批处理、动作、数据组 |
| `channel.*` | 18 | 通道 |
| `actions.*` | 14 | 动作录制与播放 |
| `brush.*` / `paint.*` | 13 / 12 | 画笔、绘制 |
| `gradient.*` | 12 | 渐变 |
| `image.adjustments.*` | 9 | 图像级调整（色阶、曲线、色彩平衡…） |
| `type.*` / `shape.*` / `path.*` | 9 / 9 / 9 | 文字、形状、路径 |
| `pattern.*` / `swatches.*` | 10 / 9 | 图案、色板 |
| `slice.*` / `variables.*` / `jobs.*` | 6 / — / — | 切片、数据组、后台任务 |

查具体命令：`photocraft_search { query: "局部调色" }` 这类自然语言即可，中英文都认。

## 三、局部调色：标准三步

引擎原生支持，这是最常用的一组组合。**整个工作流一次调用跑完**，不要拆成多次 `photocraft_run`：

```text
photocraft_run { steps: [
  { id: "doc_open",  params: { path: "输入图" } },
  { id: "select.rect", params: { x: 0, y: 0, width: 417, height: 470, feather: 0 } },
  { id: "layer.newAdjustmentLayer.hueSaturation", params: { hue: 8, saturation: 10 } },
  { id: "select.deselect", params: {} },
  { id: "doc_export", params: { format: "png" } }
] }
```

- 选区也可用 `select.colorRange` / `select.magicWand` / `select.subject` / `select.quick`
- 有选区时，选区自动成为调整层的图层蒙版，改动只落在选区内
- `doc_open` / `doc_save` / `doc_export` / `doc_inspect` 这些会话工具和引擎命令可以混在同一个 `steps` 里，按顺序执行
- 要中途看图确认，就用 `photocraft_inspect`，或者把 `doc_export` 放在 steps 末尾

同一个套路适用于任意调整层：`colorBalance`（色偏）、`curves`（曲线）、`vibrance`（饱和度）、`levels`、`selectiveColor`。**不要**因为"只改一半"就放弃，也不要整图改完了再告诉用户做不到。

## 四、纪律：探 → 改 → 验

1. **探**：动手前 `photocraft_inspect` 看文档（尺寸、图层树、选区、活动图层）；命令不熟就 `photocraft_describe` 看参数和前置（`blocked` 会写明为什么现在跑不了）。
2. **改**：**一次一个工作流**。把 `doc_open`、若干引擎命令、`doc_export` 写进同一个 `photocraft_run { steps: [...] }`，一次调用跑完——拆成多次调用只会多出几轮等待。参数按 describe 的声明给，别猜；`photocraft_run` 调用前会按引擎自己的声明校验，拼错字段会被拒绝（引擎本身会静默忽略）。
3. **验**：改完 `photocraft_inspect` 看图层/选区有没有变；画面类判断必须出图看，不要只信返回码。
4. **交付**：`photocraft_edit` 会自动出 PNG + PSD；走 `photocraft_run` 的编辑要显式保存，见第九节。

## 五、图从哪来

消息里的 `<region>` 标签会把同一张图写两遍，用 `img`，忽略 `image`：

- `img="1"` 是消息里**第一张**图，`img="2"` 是第二张——就是附件顺序，也是你看到的顺序。
- `image="att_7f3c"` 只是编辑器草稿 id，不是路径、不是哈希，**永远匹配不上任何东西**。不要去解析它，也不要因为它对不上附件就拒绝任务。

图片本身是消息的图像附件，标识形如 `sha256:<hex>`。`img="2"` 指的那张就是第二个附件，把它的 id **原样**作为 `source` 传入（素材则作为 `assets[0]`）：

```text
source: "sha256:04a5784b204ec6390ab8a0539157f1d3e525d8c2c70e662809c37abc75718e4e"
```

绝对路径也认（你生成的副本可以），裸文件名按引擎自己的工作区解释。**不要把图先拷进工作区**——引擎打开的不是那个副本，这一步只会制造失败。只支持图片格式，上限 30MB。

## 六、用户画的框和笔迹

用户在图上拖拽时，编辑器会给每个框追加一个标签：

```text
把这块的背景换成第二张
<region role="cut" n="1" img="1" image="att_7f3c" x="0.1410" y="0.6900" w="0.7100" h="0.1100"/>
```

照字面读——比例已经是 `0..1`，**绝不要重新换算**：

- `img` 说明框画在哪张图上：`img="1"` 是第一张，`img="2"` 是第二张。`image` 对你没有意义。
- `role="cut"` 是**红框**：要处理或抠出来的东西。按 `n` 顺序作为 `regions` 传入。
- 有红框时，动作对同一张图逐框各做一次。素材按序号配对（`assets[0]` 进第一个框）并缩放到框大小，所以框就是替换后的像素尺寸。
- 用户涂的笔迹放 `strokes`：`[{ points: [[x, y], …], size?, mode? }, …]`，同样是比例。笔迹比框精确，工具会从笔迹生长出选区；两者都给了就都传，框会把笔迹选区限制在框内。

**绝不凭空造框，也不要"为了保险"把框放大**：用户是在他看着的图上量的。

## 七、两张图，一次调用

用了另一张图的诉求（换背景、换天空、贴素材）把它作为 `assets` 传入。**用户在改的那张永远是画布，素材叠上去，不反过来。**

- 用户附了两张：**第一张是主体，第二张是素材**。
- 说"换成这张背景/天空"时，把用户给的那张作为 `assets[0]`。
- 说"做张海报/加个标题"时，把要写的字放进 `text`；没有文案就先问一句。

## 八、photocraft_edit 的参数

只传用户真正提到的，其余保持默认。

| 参数 | 范围 / 默认 | 作用 |
|---|---|---|
| `look` | `cool`（默认）/ `warm` / `bleach` | 调色风格，见下一节 |
| `strength` | 1..100，默认 50 | 唯一的力度来源：三个 look 都用它换算色偏、曲线和饱和度 |
| `vignette` | 0..100，默认 30 | 暗角；一对一映射到引擎 `-100..100`，`0` 表示不要 |
| `grain` | 0..100，默认 0 | 颗粒；乘 4 映射到引擎 `0.1..400` |
| `shift` | -100..100，默认 -25 | 抠图收边；主体边缘留着一圈原背景时再调小 |
| `soften` | 0..100，默认 20 | 抠图边缘平滑 |
| `margin` | 0..0.1，默认 0.01 | 去水印/去杂物向外扩的余量 |
| `denoise` | 0..10，默认 4 | 降噪，对应引擎 `reduceNoise.strength` |
| `sharpen` | 1..500，默认 50 | 锐化，对应引擎 `unsharpMask.amount` |
| `previewSide` | 64..2048，默认 768 | 本次预览长边；反复迭代时给 `448` |
| `feather` | ≥0 | 贴过去那块边缘羽化；`0` 是硬边 |
| `text` / `subline` | — | 海报主标题（必填）与副标题 |

### 三个 look 怎么选

| 用户说 | 用哪个 | 色偏方向 |
|---|---|---|
| 冷调 / 电影感 / 青蓝 / 赛博 / 冷白 | `cool` | 朝青和蓝，三轴负方向，不动饱和度 |
| 暖调 / 日系 / 夕阳 / 奶油 / 柔光 | `warm` | 朝红和黄，三轴正方向，另加一点自然饱和度 |
| 胶片 / 复古 / 老照片 / 褪色 / 漂白 | `bleach` | 提黑位、压高光、明显降饱和、略偏冷 |

「胶片感」不要给 `cool`：胶片的标志是**褪色**，只有 `bleach` 做这件事。

「背景调暗 / 压暗背景」是调色，不是抠图：走 `look: cool` 或 `bleach` 配 `vignette`。**如果要只压背景不压主体，那是局部编辑**——按第三节建选区（`select.subject` 后 `select.inverse`）再叠调整层。

这些参数不是调出来的经验值，而是引擎自己声明的量纲：`colorBalance` 三轴各 `-100..100`（满强度只花 25 点）、`curves` 是 `0..255`（满强度中间调移动 40 级）、`unsharpMask.amount` 默认 50、`reduceNoise.strength` 默认 6、`addNoise.amount` 默认 12.5、`lensCorrection.vignetteAmount` 是 `-100..100`。所以 `strength` 是唯一需要判断的档位：`25` 轻、`50` 默认、`75` 明显、`100` 满量程。

## 九、产物

`photocraft_edit` 会在工作区留**两个**文件，两个都是答案的一部分：

- `wish-<时间戳>.png` — 图。用来展示、发送、附给用户；聊天窗口打不开 PSD，所以**绝不只交 PSD**。
- `wish-<时间戳>.psd` — 同一结果，保留每个调整层，给还要在真编辑器里继续改的人。

交付时报两个名字，并用一句话说明哪个是哪个（"PNG 可直接看，PSD 保留了曲线/色偏层，可以再调"）。

走 `photocraft_run` 做的编辑留在引擎文档里，没落盘。要交付时用 `photocraft_export { format: "png" }` 和 `{ format: "psd" }` 各导一次，或者最后用 `photocraft_edit` 的收尾路径。要别的格式（`jpg` 小文件、`tif` 印刷）同样走 `photocraft_export`。

## 十、常见的坑

| 症状 | 原因 | 对策 |
|---|---|---|
| `unknown command` | id 写错或版本差异 | `photocraft_search` 重新找 |
| 命令返回成功但画面没变 | 参数被引擎静默忽略 | `photocraft_describe` 核对字段名；`photocraft_run` 已做字段校验 |
| 调整层影响了整张图 | 建层时没有选区 | 先 `select.*` 建选区，再建调整层 |
| 选区为空 | 框太小或容差太小 | 放大框，或调 `fuzziness` / `tolerance` |
| 前置不满足 | 没有打开的文档、没有选区 | `photocraft_inspect`；`photocraft_describe` 的 `blocked` 会说明 |
| 产物"看起来没生效" | 只信返回码 | `photocraft_inspect` 看图层；出图复核 |
| 坐标对不上 | 中途裁剪或缩放 | 重新量，别复用旧坐标 |

## 十一、真实边界

- **没有生成式能力。** 这里不会凭空画出不存在的像素：换脸、扩图、只给一张图就换天空，都属于这一条。这种诉求交给 Image Studio。
- **不读相册。** 这一侧只处理这条消息里的图和工作区里的文件，不碰 AI 相册。
- **引擎的中间副本在一个文件夹里。** `photocraft-tmp/` 里是引擎要的中间文件，成品才落工作区；不要让用户去那里找结果。
- **处理永远用原始字节。** 引擎按全分辨率打开文件；不要让它先降采样，后面所有坐标和质量判断都依赖这个分辨率。
- **模型看到的是缩略图。** `previewSide` 只影响预览长边，不影响导出文件。

## 十二、错误翻译

| 工具说 | 告诉用户 |
|---|---|
| `这个账号还没有被授予任何目录` | 账号的数据授权没配，不是程序坏了（VOS 应用管理 → 数据访问授权） |
| `只能导入图片文件` / `找不到图片` / `图片超过 30MB` | 换一张图，或让用户重发一次 |
| `做海报需要一句文案（text）` | 先问用户要写什么字，不要自己编 |
| `选区为空` | 框太小了，让用户重新框一次 |
| `filters need a pixel layer` | 图层停在调整层上；先把活动图层切回像素层再跑滤镜 |
