/**
 * The wish catalogue.
 *
 * Every recipe here was executed against a real PhotoCraft engine before it was
 * written down; each one encodes the two things a model reliably gets wrong when
 * it assembles commands itself:
 *
 * * **layer focus** — a pixel filter refuses to run while an adjustment layer is
 *   selected (`filters need a pixel layer`), so a recipe reselects the pixel
 *   layer before every filter;
 * * **selection consumption** — `select.refineEdge` consumes the selection and
 *   returns a new masked layer instead of leaving a selection behind, so the
 *   next step must not assume one.
 *
 * A recipe is code, not a data blob, because it has to feed one step's returned
 * layer id into the next step's parameters.
 *
 * @module @deepseek-ai/dsh-skill-photocraft/recipes
 */

import type { BridgeClient, EngineClient, StepResult } from './client.ts'
import { toPixels, type Region } from './coords.ts'

/** What one recipe run produced. */
export interface RecipeRun {
  readonly steps: StepResult[]
  readonly notes: string[]
}

/** One documented wish. */
export interface Recipe {
  readonly id: string
  /** One line the model shows the user before running it. */
  readonly title: string
  /** The wishes this recipe answers, in the words a user uses. */
  readonly when: string
  /** Parameters the model must supply, described for the model. */
  readonly parameters: Record<string, string>
  readonly run: (client: EngineClient, params: Record<string, unknown>, bridge: BridgeClient) => Promise<RecipeRun>
}

/** Collect results in order while keeping the code readable. */
async function step(
  client: EngineClient,
  steps: StepResult[],
  command: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await client.run(command, params)
  steps.push({ command, result })
  return result
}

/** Read the first id out of a `{selected: [n]}` reply. */
function selectedLayer(reply: unknown): number | undefined {
  if (typeof reply !== 'object' || reply === null) return undefined
  const selected = (reply as { selected?: unknown }).selected
  return Array.isArray(selected) && typeof selected[0] === 'number' ? selected[0] : undefined
}

/** One brush stroke, in document pixels. */
interface Painted {
  readonly points: readonly (readonly [number, number])[]
  readonly size: number
  readonly mode: 'add' | 'subtract'
}

/**
 * Read the user's brush strokes: fractions in, document pixels out.
 *
 * `size` is a percentage of the short edge so one setting works at any
 * resolution, and a stroke without points is dropped rather than sent as an
 * empty dab (the engine refuses those).
 * @param params - the call's parameters.
 * @param size - document size in pixels.
 * @returns the strokes the engine can use.
 */
function strokesOf(params: Record<string, unknown>, size: { width: number; height: number }): Painted[] {
  const raw = params.strokes
  if (!Array.isArray(raw)) return []
  const short = Math.max(1, Math.min(size.width, size.height))
  const out: Painted[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const stroke = entry as { points?: unknown; size?: unknown; mode?: unknown }
    const points = Array.isArray(stroke.points)
      ? stroke.points
        .filter((point): point is number[] => Array.isArray(point) && point.length >= 2)
        .map(point => [Number(point[0]) * size.width, Number(point[1]) * size.height] as const)
      : []
    if (points.length === 0) continue
    const width = Number(stroke.size ?? 2)
    out.push({
      points,
      size: Math.max(1, Math.round((Number.isFinite(width) ? width : 2) / 100 * short)),
      mode: stroke.mode === 'subtract' ? 'subtract' : 'add',
    })
  }
  return out
}

/** Whether a `select.*` command actually selected anything. */
function selectedAnything(reply: unknown): boolean {
  return typeof reply === 'object' && reply !== null && (reply as { selected?: unknown }).selected === true
}

/** [`selectedAnything`] under the name the cutout used to read. */
const subjectFound = selectedAnything

/** Read a `{layer: n}` reply without assuming the shape. */
function layerId(reply: unknown): number | undefined {
  if (typeof reply !== 'object' || reply === null) return undefined
  const id = (reply as { layer?: unknown }).layer
  return typeof id === 'number' ? id : undefined
}

/** One layer as `doc_inspect` reports it. */
interface LayerEntry {
  readonly id: number
  readonly kind?: string
  readonly name?: string
  readonly selected?: boolean
}

/** The part of `doc_inspect` a filter decision needs. */
interface DocumentState {
  readonly activeLayer?: number
  readonly layers?: readonly LayerEntry[]
}

/**
 * Make a pixel layer active before asking for a filter.
 *
 * The engine refuses filters on an adjustment layer (`filters need a pixel
 * layer`), and any grade leaves an adjustment layer selected. `doc_inspect`
 * reports the layer tree with each layer's kind and id, so the target is read
 * from the document instead of guessed from a name like "Background", which an
 * import is free not to use.
 * @returns whether a pixel layer exists to run a filter on.
 */
async function ensurePixelLayer(client: EngineClient, steps: StepResult[]): Promise<boolean> {
  let doc: DocumentState
  try {
    doc = await client.call('doc_inspect') as DocumentState
  } catch {
    // An unreadable document is not a reason to skip the filter.
    return true
  }
  const layers = doc.layers ?? []
  if (layers.find(layer => layer.id === doc.activeLayer)?.kind === 'Pixel') return true
  const pixel = layers.find(layer => layer.kind === 'Pixel')
  if (pixel === undefined) return false
  try {
    await step(client, steps, 'layer.select', { layer: pixel.id })
  } catch {
    // Failing to reselect is not a reason to drop the filter: the active layer
    // may already be a pixel layer, and skipping is worse than trying.
  }
  return true
}

/** Keep a computed curve inside the 0..255 the engine accepts. */
function level(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)))
}

/**
 * Run a step whose refusal must not abort the whole wish.
 *
 * A grade ends with adjustment layers selected, so a filter asked for
 * afterwards may be refused; the colour is still worth delivering.
 * @returns whether the engine accepted the command.
 */
async function attempt(
  client: EngineClient,
  steps: StepResult[],
  command: string,
  params: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    await step(client, steps, command, params)
    return true
  } catch {
    return false
  }
}

/**
 * How a look moves the colour, as directions rather than magnitudes.
 *
 * `command_list` declares `colorBalance` as `[cyan-red, magenta-green,
 * yellow-blue]` in -100..100 and `curves` as `[[in,out],…]` in 0..255. A look
 * only says which way each axis moves and how it treats saturation; every
 * magnitude is derived from `strength` below, so no number here is calibrated
 * against one particular picture.
 */
const LOOKS = {
  // Cool: toward cyan and blue. Saturation is left alone: a cool grade that
  // also desaturates is what turns skin grey.
  cool: { warmth: -1, lift: 0, saturation: 0, vibrance: 0 },
  // Warm: the same axis pair in the other direction, plus a little vibrance,
  // because warmth alone reads as "brighter".
  warm: { warmth: 1, lift: 0, saturation: 0, vibrance: 0.5 },
  // Bleach: lifted blacks, compressed whites, desaturated and slightly cool —
  // the faded print look, not a contrast punch.
  bleach: { warmth: -0.3, lift: 1, saturation: -2, vibrance: -1 },
} as const

/**
 * The engine ranges a look spends its strength on.
 *
 * Each number is a fraction of a range `command_list` declares, so the mapping
 * stays true at any strength instead of being tuned to one sample.
 */
const ENGINE = {
  /** `colorBalance` axes are -100..100; a full strength spends a quarter. */
  balance: 25,
  /** `curves` spans 0..255; a full strength moves a midtone by 40 levels. */
  curves: 40,
  /** `addNoise.amount` is 0.1..400, so the tool's 0..100 is this factor. */
  grain: 4,
} as const

const FILM: Recipe = {
  id: 'film',
  title: '电影感调色',
  when: '用户说“调成电影感 / 冷调 / 日系 / 胶片 / 复古 / 老照片”“颜色太闷了”“想要高级一点的色调”',
  parameters: {
    look: 'cool（冷调、青蓝）| warm（暖调、红黄）| bleach（褪色胶片、低饱和、提黑位），默认 cool',
    strength: '1..100，默认 50；这是唯一的力度来源，三个 look 都用它换算',
    vignette: '0..100，默认 30；直接对应引擎 -100..100 的 vignetteAmount',
    grain: '0..100，默认 0；映射到引擎 0.1..400 的 amount（×4）',
  },
  async run(client, params) {
    const steps: StepResult[] = []
    const notes: string[] = []
    const look = typeof params.look === 'string' ? params.look : 'cool'
    const table = LOOKS[look === 'warm' || look === 'bleach' ? look : 'cool']
    const strength = Math.min(100, Math.max(1, Number(params.strength ?? 50)))
    // One knob drives every axis; the look only chooses a direction.
    const axis = Math.round((strength / 100) * ENGINE.balance)
    const curve = Math.round((strength / 100) * ENGINE.curves)

    // Filters need a pixel layer. A grade leaves an adjustment layer selected,
    // so the target is read back from the document rather than remembered.
    const grain = Math.min(100, Math.max(0, Number(params.grain ?? 0)))
    if (grain > 0 && await ensurePixelLayer(client, steps)) {
      const ok = await attempt(client, steps, 'filter.noise.addNoise', {
        amount: Math.round(grain * ENGINE.grain * 10) / 10,
        distribution: 'gaussian',
        monochromatic: true,
      })
      if (!ok) notes.push('颗粒没加上：文档里没有可用的像素层')
    }
    const vignette = Math.min(100, Math.max(0, Number(params.vignette ?? 30)))
    if (vignette > 0 && await ensurePixelLayer(client, steps)) {
      const ok = await attempt(client, steps, 'filter.lensCorrection', {
        correctDistortion: false,
        correctCA: false,
        correctVignette: true,
        autoScale: false,
        vignetteAmount: -Math.round(vignette),
        vignetteMidpoint: 50,
        // Without this the corners only have the empty canvas behind them.
        edge: 'edgeExtension',
      })
      if (!ok) notes.push('暗角没加上：文档里没有可用的像素层')
    }

    const warm = table.warmth
    const lift = Math.round(table.lift * curve)
    await step(client, steps, 'layer.newAdjustmentLayer.curves', {
      points: [[0, level(lift)], [255, level(255 - lift / 2)]],
      red: [[0, 0], [128, level(128 + warm * curve)], [255, 255]],
      blue: [[0, 0], [128, level(128 - warm * curve)], [255, 255]],
    })
    await step(client, steps, 'layer.newAdjustmentLayer.colorBalance', {
      shadows: [Math.round(warm * axis), 0, Math.round(warm * axis)],
      midtones: [Math.round(warm * axis * 0.8), 0, Math.round(warm * axis * 0.8)],
      highlights: [Math.round(warm * axis * 0.4), 0, Math.round(warm * axis * 0.4)],
    })
    const vibrance = Math.round(table.vibrance * axis)
    const saturation = Math.round(table.saturation * axis)
    if (vibrance !== 0 || saturation !== 0) {
      await step(client, steps, 'layer.newAdjustmentLayer.vibrance', { vibrance, saturation })
    }

    notes.push(look === 'bleach'
      ? '褪色胶片：提黑位、压高光、降饱和，强度由 strength 统一换算'
      : '调色是调整层，可以单独关掉某一步看对比')
    return { steps, notes }
  },
}

const CUTOUT: Recipe = {
  id: 'cutout',
  title: '抠图换底',
  when: '用户说“把背景去掉 / 换个底色 / 抠出来”“做成白底图”“证件照换背景”',
  parameters: {
    background: '底色，形如 #ffffff；留空表示只要透明底、不加填充层',
    shift: '-100..100，默认 -20，负值收边；主体边缘带原背景时调小',
    soften: '0..100，默认 20，边缘平滑',
  },
  async run(client, params) {
    const steps: StepResult[] = []
    // The box is the range the user drew, and GrabCut inside it is what decides
    // the edge. Without one there is nothing to seed it with: Select Subject is
    // a saliency heuristic (`segment/subject.rs` says it is not a semantic
    // segmenter), so the honest answer is to ask for the box.
    const document = await client.call('doc_inspect', {}) as { width?: number; height?: number }
    const size = { width: document.width ?? 0, height: document.height ?? 0 }
    if (size.width === 0 || size.height === 0) throw new Error('photocraft: 当前没有打开的文档')
    // A brush beats a box: the user points at what belongs to the subject, so
    // Quick Selection grows from those dabs instead of from a rectangle that has
    // to contain the whole shape.
    const painted = strokesOf(params, size)
    const drawn = Number(params.w ?? 0) > 0 && Number(params.h ?? 0) > 0
    const box = drawn
      ? toPixels({
        x: Number(params.x ?? 0),
        y: Number(params.y ?? 0),
        w: Number(params.w ?? 0),
        h: Number(params.h ?? 0),
      }, size)
      : undefined
    let seeded = false
    if (painted.length > 0) {
      // Quick Selection floods by colour, so on a low-contrast picture it runs
      // over everything. The box is what stops it: the flood is grown first, then
      // intersected with the box's GrabCut, so a stray flood cannot leave it.
      for (const [index, stroke] of painted.entries()) {
        const picked = await step(client, steps, 'select.quick', {
          points: stroke.points,
          size: stroke.size,
          mode: index === 0 ? 'replace' : stroke.mode,
          enhanceEdge: true,
        })
        seeded = seeded || selectedAnything(picked)
      }
      if (seeded && box !== undefined) {
        await step(client, steps, 'select.object', {
          rect: [box.x, box.y, box.width, box.height],
          mode: 'intersect',
        })
      }
    }
    if (!seeded && box !== undefined) {
      const picked = await step(client, steps, 'select.object', { rect: [box.x, box.y, box.width, box.height] })
      seeded = selectedAnything(picked)
    }
    if (!seeded) {
      const subject = await step(client, steps, 'select.subject', {})
      if (!subjectFound(subject)) {
        throw new Error('photocraft: 这张图里没找到可抠的主体，请先框出要保留的部分再抠')
      }
    }
    await step(client, steps, 'select.refineEdge', {
      radius: 2,
      smartRadius: true,
      smooth: Number(params.soften ?? 20),
      feather: 0.6,
      shiftEdge: Number(params.shift ?? -20),
      decontaminate: true,
      output: 'newLayerWithMask',
      ...painted.length === 0 ? {} : {
        refineStrokes: painted.map(stroke => ({ points: stroke.points, size: stroke.size, mode: 'add' as const })),
      },
    })
    // refineEdge consumes the selection and yields a new masked layer; the
    // document keeps the original underneath, so the cutout is non-destructive.
    const background = typeof params.background === 'string' ? params.background : ''
    if (background !== '') {
      const fill = await step(client, steps, 'layer.newFillLayer.solidColor', { color: background })
      const fillId = layerId(fill)
      const cut = layerId(steps.at(-2)?.result)
      if (fillId !== undefined && cut !== undefined) {
        await step(client, steps, 'layer.moveTo', { layer: fillId, target: cut, position: 'below' })
      }
    }
    return {
      steps,
      notes: [
        background === '' ? '结果层带蒙版，导出 PNG 即为透明底' : `结果层带蒙版，底色 ${background} 在它下面一层`,
        ...drawn || painted.length > 0 ? [] : ['没给框也没画笔，这版按画面里最显著的区域抠；回复时可以顺带说一句「框一下或涂一下会更准」'],
        '主体边缘如果还带一圈原背景，把 shift 调到 -30 再跑一次',
      ],
    }
  },
}

const REMOVE: Recipe = {
  id: 'remove',
  title: '去水印 / 去杂物',
  when: '用户说“把水印去掉 / 把这个人去掉 / 把这里的字抹掉”并给出位置（或先框选）',
  parameters: {
    x: '0..1，选区左边界占文档宽度的比例',
    y: '0..1，选区上边界占文档高度的比例',
    w: '0..1，选区宽度比例',
    h: '0..1，选区高度比例',
    margin: '0..0.1，默认 0.01，向外扩的余量',
  },
  async run(client, params) {
    const steps: StepResult[] = []
    const region: Region = {
      x: Number(params.x ?? 0),
      y: Number(params.y ?? 0),
      w: Number(params.w ?? 0),
      h: Number(params.h ?? 0),
    }
    const margin = Math.min(0.1, Math.max(0, Number(params.margin ?? 0.01)))
    const document = await client.call('doc_inspect', {}) as { width?: number; height?: number }
    const size = { width: document.width ?? 0, height: document.height ?? 0 }
    if (size.width === 0 || size.height === 0) throw new Error('photocraft: 当前没有打开的文档')
    const box = toPixels(
      { x: region.x - margin, y: region.y - margin, w: region.w + margin * 2, h: region.h + margin * 2 },
      size,
    )
    await step(client, steps, 'select.rect', { ...box })
    await step(client, steps, 'edit.contentAwareFill', {
      sampling: 'auto',
      colorAdaptation: 'high',
      rotationAdaptation: 'medium',
      output: 'current',
      seed: 3,
    })
    await step(client, steps, 'select.deselect', {}).catch(() => {})
    return {
      steps,
      notes: ['内容感知填充会实际改写像素；不满意就 edit.undo 再调选区重试'],
    }
  },
}

const ENHANCE: Recipe = {
  id: 'enhance',
  title: '画质增强 / 偏色修复',
  when: '用户说“照片太糊 / 噪点多 / 颜色发黄发蓝 / 帮我修一下画质”',
  parameters: {
    denoise: '0..10，默认 4；直接对应引擎 reduceNoise.strength（引擎默认 6）',
    sharpen: '1..500，默认 50；直接对应引擎 unsharpMask.amount（引擎默认 50）',
    autoColor: 'true | false，默认 true，自动校正偏色',
  },
  async run(client, params) {
    const steps: StepResult[] = []
    const denoise = Math.min(10, Math.max(0, Number(params.denoise ?? 4)))
    const sharpen = Math.min(500, Math.max(1, Number(params.sharpen ?? 50)))
    // Both filters need a pixel layer; say so instead of letting the engine
    // answer with a bare refusal.
    if (!await ensurePixelLayer(client, steps)) {
      throw new Error('photocraft: 文档里没有像素层，无法降噪或锐化')
    }
    if (denoise > 0) await step(client, steps, 'filter.noise.reduceNoise', { strength: denoise })
    await step(client, steps, 'filter.sharpen.unsharpMask', { amount: sharpen })
    if (params.autoColor !== false) await step(client, steps, 'image.autoColor', {})
    return { steps, notes: ['降噪和锐化作用在像素层上，想保留原图可以先复制一层'] }
  },
}

const POSTER: Recipe = {
  id: 'poster',
  title: '海报标题 / 批量套版',
  when: '用户说“加个标题 / 做成海报”“批量出几张不同文案的图”',
  parameters: {
    headline: '主标题文字',
    subline: '副标题文字，可留空',
    x: '0..1，标题左边位置比例，默认 0.12',
    y: '0..1，标题基线位置比例，默认 0.82',
    size: '字号（磅），默认 110',
    color: '#rrggbb，默认 #ffffff',
    variants: '逗号分隔的若干套主标题；给了就按每套导出一张 PNG',
    dir: '导出到工作区下哪个目录，默认 out',
  },
  async run(client, params, bridge) {
    const steps: StepResult[] = []
    const document = await client.call('doc_inspect', {}) as { width?: number; height?: number }
    const size = { width: document.width ?? 0, height: document.height ?? 0 }
    const x = Math.round(Number(params.x ?? 0.12) * size.width)
    const y = Math.round(Number(params.y ?? 0.82) * size.height)
    const title = await step(client, steps, 'type.create', {
      x,
      y,
      text: typeof params.headline === 'string' ? params.headline : '',
      size: Number(params.size ?? 110),
      color: typeof params.color === 'string' ? params.color : '#ffffff',
      name: 'Headline',
    })
    const titleId = layerId(title)
    const subline = typeof params.subline === 'string' ? params.subline : ''
    if (subline !== '') {
      await step(client, steps, 'type.create', {
        x,
        y: y + Math.round(Number(params.size ?? 110) * 0.9),
        text: subline,
        size: Math.max(12, Math.round(Number(params.size ?? 110) * 0.38)),
        color: typeof params.color === 'string' ? params.color : '#ffffff',
        name: 'Subline',
      })
    }
    await step(client, steps, 'layer.layerStyle.dropShadow', { opacity: 75, angle: 120, distance: 10, size: 22, color: '#000000' })

    const variants = typeof params.variants === 'string' && params.variants !== ''
      ? params.variants.split(',').map(value => value.trim()).filter(value => value !== '')
      : []
    if (variants.length === 0 || titleId === undefined) {
      return { steps, notes: ['只做了这一张的排版'] }
    }
    await step(client, steps, 'image.variables.define', {
      defs: [{ name: 'headline', layer: titleId, type: 'textReplacement' }],
    })
    await step(client, steps, 'image.variables.dataSets', {
      dataSets: variants.map((value, index) => ({
        name: `v${String(index + 1)}`,
        values: [{ variable: 'headline', kind: 'text', value }],
      })),
    })
    const dir = typeof params.dir === 'string' && params.dir !== '' ? params.dir : 'out'
    // The export directory must already exist and the engine refuses an empty
    // one; creating it twice is harmless because the bridge reports a collision.
    await bridge.mkdir(dir).catch(() => {})
    await client.call('doc_export_data_sets', { dir, format: 'png', naming: 'poster-{index}' })
    return { steps, notes: [`已按 ${String(variants.length)} 套文案导出到 ${dir}/`] }
  },
}

/**
 * Put a supplied picture behind the subject.
 *
 * This is how "换个背景 / 换成这张天空" is answered: the subject is cut out with a
 * mask, the supplied image is placed as a smart object, the two are ordered, and
 * the original layer is hidden rather than deleted so the operation stays
 * reversible inside the engine's history.
 */
const COMPOSITE: Recipe = {
  id: 'composite',
  title: '换背景 / 贴素材',
  when: '用户额外提供了一张图，要把它当背景、天空或素材贴上去',
  parameters: {
    asset: '第二张图的工作区文件名',
    shift: '-100..100，默认 -25，主体收边',
  },
  async run(client, params) {
    const steps: StepResult[] = []
    // The bottom layer is the one to hide, whatever the file calls it: a PNG
    // opens as "Layer 0", a photo as "Background", and naming either one breaks
    // the other.
    const background = await step(client, steps, 'layer.selectBottom', {})
    const original = selectedLayer(background)
    const subject = await step(client, steps, 'select.subject', {})
    // Nothing to detect means there is no subject to keep: the material simply
    // becomes the picture.
    const refined = subjectFound(subject)
      ? layerId(await step(client, steps, 'select.refineEdge', {
        radius: 1,
        smooth: 20,
        feather: 0.4,
        shiftEdge: Number(params.shift ?? -25),
        decontaminate: true,
      }))
      : undefined
    const placed = await client.call('doc_place', { path: String(params.asset) })
    steps.push({ command: 'doc_place', result: placed })
    const placedLayer = layerId(placed)
    if (refined !== undefined && placedLayer !== undefined) {
      await step(client, steps, 'layer.moveTo', { layer: placedLayer, target: refined, position: 'below' })
    }
    if (original !== undefined) {
      await step(client, steps, 'layer.setProps', { layer: original, visible: false })
    }
    return {
      steps,
      notes: [refined === undefined
        ? '这张图没有可识别的主体，整张换成了素材'
        : '原背景层被隐藏而不是删除，想反悔就把它显示回来'],
    }
  },
}

/** Every recipe, in the order the skill presents them. */
export const RECIPES: readonly Recipe[] = [FILM, CUTOUT, REMOVE, ENHANCE, POSTER, COMPOSITE]

/**
 * Find one recipe by id.
 * @param id - recipe id.
 * @returns the recipe.
 * @throws when no recipe has that id.
 */
export function recipeFor(id: string): Recipe {
  const recipe = RECIPES.find(candidate => candidate.id === id)
  if (recipe === undefined) {
    throw new Error(`photocraft: 没有 ${id} 这条 recipe，可选：${RECIPES.map(item => item.id).join(', ')}`)
  }
  return recipe
}
