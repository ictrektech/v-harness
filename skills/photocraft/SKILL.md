---
name: photocraft
description: Edit photos in natural language with PhotoCraft — colour grades, cutouts and background swaps, watermark and object removal, quality repair, poster layout, and batch variants. Reads a photo from the user's VOS directory or AI album and can write the result back to the album.
---

# PhotoCraft

PhotoCraft is a full image editor running as a service next to this harness. You drive it through the `photocraft_*` tools; every edit is a real document with layers, history and undo, not a one-shot filter.

The tools reach the engine through a socket the gateway owns. You never handle a credential and you cannot reach another user's files.

## When to use this skill

Reach for it when the user wants a photo **changed in a specific, describable way**:

| The user says | Recipe |
|---|---|
| 调成电影感 / 冷调 / 日系 / 胶片 / 高级感 | `film` |
| 抠图 / 换背景 / 白底图 / 证件照换底 | `cutout` |
| 把水印去掉 / 把路人去掉 / 抹掉这里的字 | `remove` |
| 太糊了 / 噪点 / 颜色发黄 / 修一下画质 | `enhance` |
| 加个标题 / 做张海报 / 批量出几张不同文案 | `poster` |

Reach for a **different** skill when the wish is generative: 换脸、凭空补出背景、扩图、把白天改成雪夜。PhotoCraft has no ML runtime, so those are not possible here — say so and point at Image Studio instead.

## Where the pictures live

A `<region>` tag names its picture twice. Use `img`, ignore `image`:

- `img="1"` is the **first** picture in the message, `img="2"` the second — exactly the
  order the pictures were attached in, which is the order you see them.
- `image="att_7f3c"` is a draft id that lives only in the composer's browser. It is not
  a path, not a hash, and it will never match anything you can see. Never try to resolve
  it, and never refuse a task because it does not match an attachment.

The pictures themselves are the message's image attachments, identified as
`sha256:<hex>`. The picture named by `img="2"` is the second attachment; pass its id
**exactly as the message shows it** as `source` (and as `assets[0]` for a material):

```text
source: "sha256:04a5784b204ec6390ab8a0539157f1d3e525d8c2c70e662809c37abc75718e4e"
```

An absolute path under `~/.dsh/attachments/…` also works. Do not copy the picture into
the workspace first — the copy is not what the engine opens, and the detour only
produces failures. `photocraft_open` takes the same ids.

## Two images, one call

A wish that needs a second picture — 换背景、换天空、贴素材、换脸 — is answered by
passing that picture as `assets`. The tool cuts the subject out of `source`,
places the supplied image behind it, and hides the original background layer
(instead of deleting it, so it can be brought back).

- 用户附了两张图：**第一张是主体，第二张是素材**。
- 说"换成这张背景/天空"时，把用户给的那张作为 `assets[0]`。
- 说"做张海报/加个标题"时，把用户要写的字放进 `text`；没有文案就先问一句。

## Boxes the user drew

When the user drags on an attached photo, the composer appends one tag per box:

```text
把这块的背景换成第二张
<region role="cut" n="1" img="1" image="att_7f3c" x="0.1410" y="0.6900" w="0.7100" h="0.1100"/>
<region role="place" n="1" img="2" image="att_9ab1" x="0.5000" y="0.5000" w="0.2500" h="0.2000"/>
```

Read them literally — the fractions are already `0..1`, so never rescale them:

- `img` says which picture the box was drawn on: `img="1"` is the first attachment, `img="2"` the second. That is the whole mapping; `image` is meaningless to you.
- `role="cut"` is a **red** box: the thing to act on or cut out. Send these, in `n` order, as `regions`.
- `role="place"` is a **green** box: where that piece should land. Send these, in `n` order, as `places`.
- Boxes pair by `n`: red `n="2"` is cut and dropped into green `n="2"`, and the green box also sets the size of the piece.
- With only red boxes, the wish repeats once per box on the same picture. With green boxes, the picture the red box sits on (`img` of the cut tag) is `source`, and the picture the green box sits on is the material — pass that one's attachment id as `assets[0]`.

Never invent a box, and never widen one "for safety": the user measured it on the picture they were looking at.

## The fixed sequence

1. **Open first.** `photocraft_open` with a workspace file name, or `album:<asset id>` to start from the user's album. Look at the returned preview before doing anything: it tells you the composition, where the watermark sits, whether the subject is centred.
2. **Ask for the recipe, do not invent commands.** `photocraft_recipe` with the user's own words returns the catalogue with parameters. Assemble raw command steps yourself only when no recipe fits, and prefer adjustment layers (`layer.newAdjustmentLayer.*`) over pixel ops so the user can still undo and retune.
3. **Confirm anything destructive.** Before `contentAwareFill`, `filter.liquify`, or a merge, call `photocraft_region`: it paints the target area red and returns the region in `0..1` fractions. Show that preview to the user (or check it yourself) before `photocraft_apply`.
4. **Look after every change.** `photocraft_apply` returns a preview. Read it. Iterate at most two or three times; if it is still wrong, say what is wrong instead of grinding.
5. **Export deliberately.** `photocraft_export` with `format: psd` when the user may want to keep editing, `png`/`jpg` for a finished picture, and `destination: album` when the result belongs in their AI album.

## Rules that come from real failures

- **A pixel filter needs a pixel layer selected.** `filter.*` refuses while an adjustment layer is the target. The recipes reselect the pixel layer for you; if you compose steps yourself, do the same.
- **`select.refineEdge` swallows the selection.** It returns a new masked layer instead of leaving a selection behind, so a following `select.inverse` or `select.deselect` fails with `no selection`. That failure is harmless — treat it as "nothing to clear", not as an error to report.
- **Crops and resizes invalidate coordinates.** After `image.crop` or `image.imageSize`, any region you measured earlier is wrong. Re-confirm.
- **Edits live in the session document, not on disk.** Reopening a file starts from the file's own pixels again, so pass the *recipe and parameters*, not "the file I fixed earlier".
- **Coordinates are fractions, never pixels.** A preview is 768px wide, the document may be 4000px. Give `0..1` and let the tool convert.
- **`select.sky` fails softly.** It answers `changed: false` with a message when it finds no sky. Fall back to a fixed region or to `select.colorRange`, and tell the user which way you went.
- **Some engine commands are disabled for automation.** `file.export.dataSetsAsFiles` refuses with "uses ambient filesystem paths"; the MCP methods (`doc_export_data_sets`, `doc_save`) are the automation-safe equivalents.

## Parameters worth knowing

- Grade strength is a percentage: `strength: 30` is a hint, `90` is a look.
- Vignette and grain are separate: `vignette: 0` removes the darkening, `grain: 0` (default) removes the noise.
- Cutout `shift` is an edge contraction. A subject cut from a dark background keeps a rim of it until `shift` reaches about `-25`.
- Removal wants a *little* margin (`0.01`) around the target, and a rectangle for a whole line of text — `select.object` locks onto a single object, which for text means one letter.
- Poster `variants` is a comma-separated list; each one becomes another exported PNG under `out/`.

## Sizes and cost

- **Processing always uses the original bytes.** The engine opens the file at full
  resolution; never ask it to downscale first just to make a call cheaper, because
  every later coordinate and quality decision depends on that resolution.
- **What the model sees is a thumbnail.** `photocraft_open` and
  `photocraft_apply` render at `previewSide` (700 by default). Pass a smaller
  `previewSide` (448) when iterating many times, and keep the default for a
  check you intend to judge.
- **The export preview is the exception.** `photocraft_export` renders one larger
  look (1024) so the final judgement is not made on a thumbnail.

## Boundaries

- One document at a time per conversation; `photocraft_open` replaces the active one.
- Preview images cost context: iterate at the default 768, and shrink with `previewSide` if the conversation is long.
- The service refuses paths outside the user's granted directory and reports `No authorized directory` when the VOS app has no data grant — report that as an account setting, not a bug.
