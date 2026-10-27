/**
 * The wish catalogue: what each recipe sends to the engine, in what order, and
 * how it threads one step's layer id into the next.
 */

import { describe, expect, it } from 'vitest'
import type { BridgeClient, EngineClient, OpenedDocument } from '../src/client.ts'
import { RECIPES, recipeFor } from '../src/recipes.ts'

/** One engine call, in order. */
interface Call {
  readonly name: string
  readonly args: Record<string, unknown>
}

/** An engine whose answers come from a table and whose calls are recorded. */
const found = (name: string): unknown => (name === 'select.subject' ? { selected: true, changed: true } : {})

function engineOf(answer: (name: string) => unknown = found, reject?: (name: string) => boolean): {
  engine: EngineClient
  calls: Call[]
} {
  const calls: Call[] = []
  const track = (name: string, args: Record<string, unknown>): unknown => {
    calls.push({ name, args })
    if (reject?.(name) === true) throw new Error(`photocraft ${name}: refused`)
    return answer(name)
  }
  const engine: EngineClient = {
    call: async (name, args = {}) => track(name, args),
    run: async (command, params = {}) => track(command, params),
    open: async (path: string): Promise<OpenedDocument> => {
      track('open', { path })
      return { index: 0, name: path, width: 100, height: 50, layers: 1 }
    },
    preview: async () => Buffer.from('PNG'),
  }
  return { engine, calls }
}

/** A bridge that records created folders. */
function bridgeOf(options: { failMkdir?: boolean } = {}): { bridge: BridgeClient; folders: string[] } {
  const folders: string[] = []
  const bridge: BridgeClient = {
    upload: async (name: string) => name,
    download: async () => Buffer.from('PNG'),
    mkdir: async (name: string) => {
      if (options.failMkdir === true) throw new Error('already exists')
      folders.push(name)
    },
  }
  return { bridge, folders }
}

/** Run one recipe by id against a fresh engine and bridge. */
async function run(
  id: string,
  params: Record<string, unknown> = {},
  options: { answer?: (name: string) => unknown; reject?: (name: string) => boolean; failMkdir?: boolean } = {},
): Promise<{ calls: Call[]; notes: string[]; folders: string[] }> {
  const { engine, calls } = engineOf(options.answer, options.reject)
  const { bridge, folders } = bridgeOf({ failMkdir: options.failMkdir })
  const recipe = recipeFor(id)
  const { notes } = await recipe.run(engine, params, bridge)
  return { calls, notes, folders }
}

/** Every command name the recipe sent, in order. */
function names(calls: Call[]): string[] {
  return calls.map(call => call.name)
}

describe('recipeFor', () => {
  it('finds every published recipe by id', () => {
    expect(RECIPES.map(recipe => recipe.id)).toEqual([
      'film', 'cutout', 'remove', 'enhance', 'poster', 'composite',
      'brush', 'retouch', 'fill', 'transform', 'gray', 'text',
    ])
    for (const recipe of RECIPES) expect(recipeFor(recipe.id)).toBe(recipe)
  })

  it('names the alternatives when an id is unknown', () => {
    expect(() => recipeFor('sepia')).toThrow(/没有 sepia 这条 recipe，可选：film, cutout, remove, enhance, poster, composite, brush, retouch, fill, transform, gray, text/u)
  })
})

/** A document whose active layer is the pixel layer the filters need. */
const pixelDoc = (name: string): unknown =>
  name === 'doc_inspect'
    ? { width: 100, height: 50, activeLayer: 1, layers: [{ id: 1, kind: 'Pixel' }] }
    : {}

/** The curves step, wherever the optional filters pushed it. */
const curvesOf = (calls: Call[]): { points?: number[][]; red?: number[][]; blue?: number[][] } | undefined =>
  calls.find(call => call.name === 'layer.newAdjustmentLayer.curves')?.args as
    { points?: number[][]; red?: number[][]; blue?: number[][] } | undefined

describe('film', () => {
  it('vignettes first, then stacks the adjustment layers', async () => {
    const { calls, notes } = await run('film', {}, { answer: pixelDoc })
    expect(names(calls)).toEqual([
      'doc_inspect',
      'filter.lensCorrection',
      'layer.newAdjustmentLayer.curves',
      'layer.newAdjustmentLayer.colorBalance',
    ])
    // Half strength of the cool look: ±32 levels on red and blue.
    expect(curvesOf(calls)).toMatchObject({
      points: [[0, 0], [255, 255]],
      red: [[0, 0], [128, 96], [255, 255]],
      blue: [[0, 0], [128, 160], [255, 255]],
    })
    expect(calls[3]?.args).toEqual({
      shadows: [-20, 0, -20],
      midtones: [-16, 0, -16],
      highlights: [-8, 0, -8],
    })
    expect(calls[1]?.args.vignetteAmount).toBe(-30)
    expect(notes).toEqual(['调色是调整层，可以单独关掉某一步看对比'])
  })

  it('masks a regional grade with a feathered selection', async () => {
    const { calls, notes } = await run('film', { look: 'cool', vignette: 0, x: 0.2, y: 0.3, w: 0.2, h: 0.2 }, { answer: pixelDoc })
    expect(names(calls)).not.toContain('filter.lensCorrection')
    expect(names(calls)).not.toContain('filter.noise.addNoise')
    expect(calls[1]?.args).toMatchObject({ x: 20, y: 15, width: 20, height: 10, feather: 2 })
    expect(names(calls)).toContain('layer.newAdjustmentLayer.curves')
    expect(names(calls)).toContain('select.deselect')
    expect(notes).toContain('局部调色：调整层带羽化蒙版，只落在选区里')
  })

  it('grows a regional grade from a pointed stroke instead of a rectangle', async () => {
    const { calls } = await run('film', { look: 'cool', vignette: 0, strokes: [{ points: [[0.3, 0.5]] }] }, { answer: pixelDoc })
    expect(names(calls)).not.toContain('select.rect')
    expect(calls[1]?.name).toBe('select.quick')
    expect(calls[1]?.args).toMatchObject({ points: [[30, 25]], mode: 'replace' })
    expect(names(calls)).toContain('layer.newAdjustmentLayer.curves')
  })

  it('reads a look by name and clamps the strength', async () => {
    const warm = await run('film', { look: 'warm', strength: 100 }, { answer: pixelDoc })
    expect(curvesOf(warm.calls)?.red?.[1]).toEqual([128, 192])
    expect(curvesOf(warm.calls)?.blue?.[1]).toEqual([128, 64])
    const bleach = await run('film', { look: 'bleach', strength: 100 }, { answer: pixelDoc })
    expect(curvesOf(bleach.calls)?.points).toEqual([[0, 64], [255, 223]])
    const unknown = await run('film', { look: 'sepia', strength: 100 }, { answer: pixelDoc })
    expect(curvesOf(unknown.calls)?.red?.[1]).toEqual([128, 64])
    const notAString = await run('film', { look: 42, strength: 100 }, { answer: pixelDoc })
    expect(curvesOf(notAString.calls)?.red?.[1]).toEqual([128, 64])
    // Both ends clamp: 0 becomes a 1% hint, 500 becomes the full look.
    const floor = await run('film', { strength: 0 }, { answer: pixelDoc })
    expect(curvesOf(floor.calls)?.red?.[1]).toEqual([128, 127])
    const ceiling = await run('film', { strength: 500 }, { answer: pixelDoc })
    expect(curvesOf(ceiling.calls)?.red?.[1]).toEqual([128, 64])
  })

  it('skips the vignette at 0 and adds grain when asked', async () => {
    const { calls } = await run('film', { vignette: 0, grain: 20 }, { answer: pixelDoc })
    expect(names(calls)).not.toContain('filter.lensCorrection')
    const noise = calls.find(call => call.name === 'filter.noise.addNoise')
    expect(noise?.args).toEqual({ amount: 80, distribution: 'gaussian', monochromatic: true })
  })

  it('still filters when the pixel layer cannot be reselected', async () => {
    const { calls } = await run('film', { grain: 1 }, {
      answer: name => (name === 'doc_inspect'
        ? { width: 100, height: 50, activeLayer: 2, layers: [{ id: 1, kind: 'Pixel' }, { id: 2, kind: 'Text' }] }
        : {}),
      reject: name => name === 'layer.select',
    })
    expect(names(calls)).toContain('filter.noise.addNoise')
  })
})

describe('cutout', () => {
  const cutoutAnswers = (name: string): unknown => {
    if (name === 'doc_inspect') return { width: 100, height: 50, activeLayer: 1, layers: [{ id: 1, kind: 'Pixel' }] }
    if (name === 'select.subject') return { selected: true }
    return {}
  }

  it('refines the subject selection and leaves the background alone', async () => {
    const { calls, notes } = await run('cutout', {}, { answer: cutoutAnswers })
    expect(names(calls)).toEqual(['doc_inspect', 'select.subject', 'select.refineEdge'])
    expect(calls[2]?.args).toMatchObject({
      radius: 2,
      smartRadius: true,
      smooth: 20,
      feather: 0.6,
      shiftEdge: -25,
      decontaminate: true,
      output: 'newLayerWithMask',
    })
    expect(notes[0]).toBe('结果层带蒙版，导出 PNG 即为透明底')
  })

  it('puts a fill layer under the cut when a colour is named', async () => {
    const { calls, notes } = await run('cutout', { background: '#ffffff', shift: -60, soften: 40 }, {
      answer: name => (name === 'doc_inspect'
        ? { width: 100, height: 50, activeLayer: 1, layers: [{ id: 1, kind: 'Pixel' }] }
        : name === 'select.subject' ? { selected: true }
          : name === 'select.refineEdge' ? { layer: 5 }
            : name === 'layer.newFillLayer.solidColor' ? { layer: 9 } : {}),
    })
    expect(names(calls)).toEqual([
      'doc_inspect',
      'select.subject',
      'select.refineEdge',
      'layer.newFillLayer.solidColor',
      'layer.moveTo',
    ])
    expect(calls[2]?.args).toMatchObject({ shiftEdge: -60, smooth: 40 })
    expect(calls[4]?.args).toEqual({ layer: 9, target: 5, position: 'below' })
    expect(notes[0]).toBe('结果层带蒙版，底色 #ffffff 在它下面一层')
  })

  it('skips the ordering when the engine reports no layer ids', async () => {
    const { calls } = await run('cutout', { background: '#111111' }, {
      answer: name => (name === 'doc_inspect'
        ? { width: 100, height: 50 }
        : name === 'select.subject' ? { selected: true } : 'not a layer'),
    })
    expect(names(calls)).not.toContain('layer.moveTo')
  })
})

describe('remove', () => {
  it('fills the box plus the margin and clears the selection', async () => {
    const { calls, notes } = await run('remove', { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, {
      answer: name => (name === 'doc_inspect' ? { width: 100, height: 50 } : {}),
    })
    // margin 0.01 each way: 19%..41% of 100px by 19%..41% of 50px.
    expect(calls[0]?.name).toBe('doc_inspect')
    expect(calls[1]).toEqual({ name: 'select.rect', args: { x: 19, y: 10, width: 22, height: 11 } })
    expect(calls[2]?.name).toBe('edit.contentAwareFill')
    expect(calls[3]?.name).toBe('select.deselect')
    expect(notes).toEqual(['内容感知填充会实际改写像素；不满意就 edit.undo 再调选区重试'])
  })

  it('clamps the margin to a tenth of the picture', async () => {
    const { calls } = await run('remove', { x: 0.5, y: 0.5, w: 0.1, h: 0.1, margin: 5 }, {
      answer: name => (name === 'doc_inspect' ? { width: 100, height: 100 } : {}),
    })
    expect(calls[1]?.args).toEqual({ x: 40, y: 40, width: 30, height: 30 })
    const negative = await run('remove', { x: 0.5, y: 0.5, w: 0.1, h: 0.1, margin: -1 }, {
      answer: name => (name === 'doc_inspect' ? { width: 100, height: 100 } : {}),
    })
    expect(negative.calls[1]?.args).toEqual({ x: 50, y: 50, width: 10, height: 10 })
  })

  it('says so when there is no subject to cut', async () => {
    await expect(run('cutout', {}, {
      answer: name => (name === 'doc_inspect' ? { width: 100, height: 50 } : { selected: false }),
    })).rejects.toThrow(/没找到可抠的主体/u)
  })

  it('refuses without an open document', async () => {
    await expect(run('remove', { x: 0, y: 0, w: 0.1, h: 0.1 })).rejects.toThrow(/当前没有打开的文档/u)
  })

  it('fills only the margin when no box is named', async () => {
    const { calls } = await run('remove', {}, { answer: () => ({ width: 100, height: 100 }) })
    expect(calls[1]?.args).toEqual({ x: 0, y: 0, width: 2, height: 2 })
  })

  it('treats a missing selection as already clear', async () => {
    const { calls } = await run('remove', { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, {
      answer: name => (name === 'doc_inspect' ? { width: 100, height: 100 } : {}),
      reject: name => name === 'select.deselect',
    })
    expect(names(calls).at(-1)).toBe('select.deselect')
  })
})

describe('enhance', () => {
  it('denoises and sharpens; colour repair only when asked', async () => {
    const { calls } = await run('enhance', {}, { answer: pixelDoc })
    expect(names(calls)).toEqual([
      'doc_inspect',
      'filter.noise.reduceNoise',
      'filter.sharpen.unsharpMask',
    ])
    expect(calls[1]?.args).toEqual({ strength: 4 })
    expect(calls[2]?.args).toEqual({ amount: 50 })
    const repaired = await run('enhance', { autoColor: true }, { answer: pixelDoc })
    expect(names(repaired.calls)).toContain('image.autoColor')
  })

  it('honours explicit amounts and can skip the colour pass', async () => {
    const { calls } = await run('enhance', { denoise: 9, sharpen: 300, autoColor: false }, { answer: pixelDoc })
    expect(calls.find(call => call.name === 'filter.noise.reduceNoise')?.args.strength).toBe(9)
    expect(calls.find(call => call.name === 'filter.sharpen.unsharpMask')?.args.amount).toBe(300)
    expect(names(calls)).not.toContain('image.autoColor')
  })
})

describe('poster', () => {
  /** The two answers the poster layout needs: the canvas size and a text layer. */
  const posterAnswers = (name: string): unknown => {
    if (name === 'doc_inspect') return { width: 100, height: 50 }
    if (name === 'type.create') return { layer: 4 }
    return {}
  }

  it('sets a headline over the picture', async () => {
    const { calls, notes } = await run('poster', { headline: '秋日' }, { answer: posterAnswers })
    expect(names(calls)).toEqual(['doc_inspect', 'type.create', 'layer.layerStyle.dropShadow'])
    expect(calls[1]?.args).toMatchObject({ x: 12, y: 41, text: '秋日', size: 110, color: '#ffffff', name: 'Headline' })
    expect(notes).toEqual(['只做了这一张的排版'])
  })

  it('adds a subline under the headline', async () => {
    const { calls } = await run('poster', { headline: '秋日', subline: '京都', size: 100, color: '#000000', x: 0.5, y: 0.5 }, { answer: posterAnswers })
    const subline = calls.filter(call => call.name === 'type.create')[1]?.args
    expect(subline).toMatchObject({ text: '京都', size: 38, color: '#000000', name: 'Subline', x: 50 })
    // 0.5 of a 50px canvas, then one size step (0.9 × 100) below the headline.
    expect(subline?.y).toBe(25 + 90)
  })

  it('exports one PNG per variant when the data set is defined', async () => {
    const { calls, notes, folders } = await run('poster', { headline: '秋日', variants: ' 甲 , 乙 ,' }, {
      answer: name => (name === 'type.create' ? { layer: 4 } : {}),
    })
    expect(names(calls)).toEqual([
      'doc_inspect',
      'type.create',
      'layer.layerStyle.dropShadow',
      'image.variables.define',
      'image.variables.dataSets',
      'doc_export_data_sets',
    ])
    expect(calls[3]?.args).toEqual({ defs: [{ name: 'headline', layer: 4, type: 'textReplacement' }] })
    expect(calls[4]?.args.dataSets).toEqual([
      { name: 'v1', values: [{ variable: 'headline', kind: 'text', value: '甲' }] },
      { name: 'v2', values: [{ variable: 'headline', kind: 'text', value: '乙' }] },
    ])
    expect(folders).toEqual(['out'])
    expect(notes).toEqual(['已按 2 套文案导出到 out/'])
  })

  it('exports into a named folder', async () => {
    const { calls } = await run('poster', { headline: '秋日', variants: '甲', dir: 'posters' }, {
      answer: name => (name === 'type.create' ? { layer: 4 } : {}),
    })
    expect(calls.at(-1)?.args).toMatchObject({ dir: 'posters', format: 'png', naming: 'poster-{index}' })
  })

  it('stops at layout when the text layer has no id', async () => {
    const { calls, notes } = await run('poster', { headline: '秋日', variants: '甲' }, { answer: () => 'no layer' })
    expect(names(calls)).not.toContain('image.variables.define')
    expect(notes).toEqual(['只做了这一张的排版'])
  })

  it('survives a folder that is already there', async () => {
    const { notes } = await run('poster', { headline: '秋日', variants: '甲' }, {
      answer: name => (name === 'type.create' ? { layer: 4 } : {}),
      failMkdir: true,
    })
    expect(notes).toEqual(['已按 1 套文案导出到 out/'])
  })

  it('takes an empty headline when the caller only supplies a subline', async () => {
    const { calls } = await run('poster', { subline: '京都' }, {
      answer: name => (name === 'doc_inspect' ? { width: 100, height: 50 } : { layer: 4 }),
    })
    expect(calls.filter(call => call.name === 'type.create')[0]?.args).toMatchObject({ text: '' })
  })
})

describe('composite', () => {
  it('cuts the subject and hides the original background', async () => {
    const { calls, notes } = await run('composite', { asset: 'sky.png' }, {
      answer: name => (name === 'layer.selectBottom' ? { selected: [1] }
        : name === 'select.subject' ? { selected: true }
          : name === 'select.refineEdge' ? { layer: 2 } : { layer: 3 }),
    })
    expect(names(calls)).toEqual(['layer.selectBottom', 'select.subject', 'select.refineEdge', 'doc_place', 'layer.moveTo', 'layer.setProps'])
    expect(calls[3]?.args).toEqual({ path: 'sky.png' })
    expect(calls[4]?.args).toEqual({ layer: 3, target: 2, position: 'below' })
    expect(calls[5]?.args).toEqual({ layer: 1, visible: false })
    expect(notes).toEqual(['原背景层被隐藏而不是删除，想反悔就把它显示回来'])
  })

  it('replaces the picture when it has no subject to keep', async () => {
    const { calls, notes } = await run('composite', { asset: 'sky.png' }, {
      answer: name => (name === 'select.subject' ? { selected: false, changed: false } : null),
    })
    expect(names(calls)).toEqual(['layer.selectBottom', 'select.subject', 'doc_place'])
    expect(notes).toEqual(['这张图没有可识别的主体，整张换成了素材'])
  })

  it('hides the original without moving the material below nothing', async () => {
    const { calls } = await run('composite', { asset: 'sky.png', shift: -40 }, { answer: name => (name === 'select.subject' ? { selected: true } : null) })
    expect(names(calls)).toEqual(['layer.selectBottom', 'select.subject', 'select.refineEdge', 'doc_place'])
    expect(calls[2]?.args).toMatchObject({ shiftEdge: -40 })
  })

  it('ignores a selection that does not name a layer number', async () => {
    const { calls } = await run('composite', { asset: 'sky.png' }, {
      answer: name => (name === 'layer.selectBottom' ? { selected: ['Background'] }
        : name === 'select.subject' ? { selected: true } : { layer: 3 }),
    })
    expect(names(calls)).not.toContain('layer.setProps')
  })
})
