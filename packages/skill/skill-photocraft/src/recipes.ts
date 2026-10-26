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

import type { FileBridge, McpClient, StepResult } from './client.ts'
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
  readonly run: (client: McpClient, params: Record<string, unknown>, bridge: FileBridge) => Promise<RecipeRun>
}

/** Collect results in order while keeping the code readable. */
async function step(
  client: McpClient,
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

/** Read a `{layer: n}` reply without assuming the shape. */
function layerId(reply: unknown): number | undefined {
  if (typeof reply !== 'object' || reply === null) return undefined
  const id = (reply as { layer?: unknown }).layer
  return typeof id === 'number' ? id : undefined
}

/**
 * Select the pixel layer filters need.
 *
 * A failed reselect is not fatal: on a document whose only layer is already
 * selected the command refuses, and the filter still runs.
 */
async function focusPixels(client: McpClient, steps: StepResult[], name = 'Background'): Promise<void> {
  try {
    await step(client, steps, 'layer.select', { layer: name })
  } catch {
    // Nothing to switch to; keep the current target.
  }
}

/** The colour-grade look, as curve points and balance shifts. */
const LOOKS = {
  cool: {
    points: [[0, 6], [64, 58], [192, 196], [255, 250]],
    blue: [[0, 16], [128, 134], [255, 255]],
    shadows: [-12, 2, 10],
    midtones: [-4, 0, 8],
    highlights: [8, 0, -10],
  },
  warm: {
    points: [[0, 4], [64, 62], [192, 200], [255, 252]],
    blue: [[0, 0], [128, 126], [255, 250]],
    shadows: [8, 0, -6],
    midtones: [6, 0, -4],
    highlights: [6, -2, -8],
  },
  bleach: {
    points: [[0, 0], [64, 48], [160, 190], [255, 255]],
    blue: [[0, 4], [128, 130], [255, 255]],
    shadows: [-4, 0, 2],
    midtones: [0, 0, 2],
    highlights: [2, 0, -2],
  },
} as const

const FILM: Recipe = {
  id: 'film',
  title: '电影感调色',
  when: '用户说“调成电影感 / 冷调 / 日系 / 胶片”“颜色太闷了”“想要高级一点的色调”',
  parameters: {
    look: 'cool | warm | bleach，默认 cool',
    strength: '1..100，默认 60，越小越轻',
    vignette: '0..100，默认 40，暗角强度；0 表示不要暗角',
    grain: '0..100，默认 0，颗粒强度',
  },
  async run(client, params) {
    const steps: StepResult[] = []
    const look = typeof params.look === 'string' ? params.look : 'cool'
    const table = LOOKS[look === 'warm' || look === 'bleach' ? look : 'cool']
    const strength = Math.min(100, Math.max(1, Number(params.strength ?? 60))) / 100
    const scale = (points: readonly (readonly number[])[]): number[][] => points.map(([input, output]) => [
      input as number,
      Math.round((input as number) + ((output as number) - (input as number)) * strength),
    ])

    await step(client, steps, 'layer.newAdjustmentLayer.curves', {
      points: scale(table.points),
      blue: scale(table.blue),
    })
    await step(client, steps, 'layer.newAdjustmentLayer.colorBalance', {
      shadows: table.shadows.map(value => Math.round(value * Math.max(0.5, strength))),
      midtones: table.midtones.map(value => Math.round(value * Math.max(0.5, strength))),
      highlights: table.highlights.map(value => Math.round(value * Math.max(0.5, strength))),
    })
    await step(client, steps, 'layer.newAdjustmentLayer.vibrance', {
      vibrance: Math.round(12 * strength),
      saturation: Math.round(-12 * strength),
    })

    const vignette = Number(params.vignette ?? 40)
    if (vignette > 0) {
      await focusPixels(client, steps)
      await step(client, steps, 'filter.lensCorrection', {
        correctDistortion: false,
        correctCA: false,
        correctVignette: true,
        autoScale: false,
        vignetteAmount: -Math.round(vignette),
        vignetteMidpoint: 55,
      })
    }
    const grain = Number(params.grain ?? 0)
    if (grain > 0) {
      await focusPixels(client, steps)
      await step(client, steps, 'filter.noise.addNoise', {
        amount: Math.max(0.1, grain / 10),
        distribution: 'gaussian',
        monochromatic: true,
        seed: 7,
      })
    }
    return { steps, notes: ['调色是三个调整层，可以单独关掉某一步看对比'] }
  },
}

const CUTOUT: Recipe = {
  id: 'cutout',
  title: '抠图换底',
  when: '用户说“把背景去掉 / 换个底色 / 抠出来”“做成白底图”“证件照换背景”',
  parameters: {
    background: '底色，形如 #ffffff；留空表示只要透明底、不加填充层',
    shift: '-100..100，默认 -12，负值收边；主体边缘带原背景时调小',
    soften: '0..100，默认 20，边缘平滑',
  },
  async run(client, params) {
    const steps: StepResult[] = []
    await step(client, steps, 'select.subject', {})
    await step(client, steps, 'select.refineEdge', {
      radius: 1,
      smooth: Number(params.soften ?? 20),
      feather: 0.4,
      shiftEdge: Number(params.shift ?? -25),
      decontaminate: true,
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
        '主体边缘如果还带一圈原背景，把 shift 调到 -25 再跑一次',
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
    denoise: '0..10，默认 4，降噪强度',
    sharpen: '0..500，默认 120，USM 锐化量',
    autoColor: 'true | false，默认 true，自动校正偏色',
  },
  async run(client, params) {
    const steps: StepResult[] = []
    await focusPixels(client, steps)
    await step(client, steps, 'filter.noise.reduceNoise', {
      strength: Math.min(10, Math.max(0, Number(params.denoise ?? 4))),
      preserveDetails: 70,
      reduceColorNoise: 40,
    })
    await step(client, steps, 'filter.sharpen.unsharpMask', {
      amount: Math.min(500, Math.max(1, Number(params.sharpen ?? 120))),
      radius: 1.2,
      threshold: 2,
    })
    if (params.autoColor !== false) await step(client, steps, 'image.autoColor', {})
    return { steps, notes: ['降噪和锐化都作用在像素层上，想保留原图可以先复制一层'] }
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
      return { steps, notes: ['只做了排版；要批量出图请再给 variants'] }
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
    const background = await step(client, steps, 'layer.select', { layer: 'Background' })
    const original = selectedLayer(background)
    await step(client, steps, 'select.subject', {})
    const refined = await step(client, steps, 'select.refineEdge', {
      radius: 1,
      smooth: 20,
      feather: 0.4,
      shiftEdge: Number(params.shift ?? -25),
      decontaminate: true,
    })
    const subject = layerId(refined)
    const placed = await client.call('doc_place', { path: String(params.asset) })
    steps.push({ command: 'doc_place', result: placed })
    const placedLayer = layerId(placed)
    if (subject !== undefined && placedLayer !== undefined) {
      await step(client, steps, 'layer.moveTo', { layer: placedLayer, target: subject, position: 'below' })
    }
    if (original !== undefined) {
      await step(client, steps, 'layer.setProps', { layer: original, visible: false })
    }
    return { steps, notes: ['原背景层被隐藏而不是删除，想反悔就把它显示回来'] }
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
