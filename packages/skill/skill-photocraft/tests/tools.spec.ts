/**
 * The two tools: what reaches the engine, what reaches the workspace, and what
 * the model is told when either refuses.
 */

import { mkdir, mkdtemp, open, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type ImageAttachmentRef, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BridgeClient, EngineClient, OpenedDocument } from '../src/client.ts'

/** The attachment digests this suite publishes under `$DSH_HOME/attachments`. */
const DIGEST = `ab${'c'.repeat(62)}`
const SUPPLY_DIGEST = `cd${'e'.repeat(62)}`
const EXTRA_DIGEST = `ef${'a'.repeat(62)}`
const SOURCE = `sha256:${DIGEST}`
const SUPPLY = `sha256:${SUPPLY_DIGEST}`
const EXTRA = `sha256:${EXTRA_DIGEST}`
const PNG = Buffer.from('PNGDATA')
const SUPPLY_PNG = Buffer.from('SKYDATA')
const EXTRA_PNG = Buffer.from('STONEDATA')

let root: string
let workspace: string
let tools: typeof import('../src/tools.ts')

/** One recorded engine call. */
interface Call {
  readonly name: string
  readonly args: Record<string, unknown>
}

/** The engine, the bridge, and what they were asked to do. */
interface Stage {
  readonly engine: EngineClient
  readonly bridge: BridgeClient
  readonly calls: Call[]
  readonly uploads: { name: string; data: Buffer }[]
  readonly downloads: string[]
  readonly previews: number[]
  readonly folders: string[]
}

/** The answers a recipe expects when a test does not care about them. */
function defaultAnswer(name: string): unknown {
  if (name === 'doc_inspect') return { width: 100, height: 50, activeLayer: 1, layers: [{ id: 1, kind: 'Pixel' }] }
  if (name === 'select.subject') return { selected: true, changed: true }
  return {}
}

/**
 * Build one recording stage.
 * @param answer - per-call answers; unlisted calls answer `{}`.
 * @returns the stage.
 */
function stageOf(answer: (name: string) => unknown = defaultAnswer): Stage {
  const calls: Call[] = []
  const uploads: { name: string; data: Buffer }[] = []
  const downloads: string[] = []
  const previews: number[] = []
  const folders: string[] = []
  const engine: EngineClient = {
    call: async (name, args = {}) => {
      calls.push({ name, args })
      return answer(name)
    },
    run: async (command, params = {}) => {
      calls.push({ name: command, args: params })
      return answer(command)
    },
    open: async (path: string): Promise<OpenedDocument> => {
      calls.push({ name: 'open', args: { path } })
      return { index: 0, name: path, width: 100, height: 50, layers: 1 }
    },
    preview: async (maxSide = 768) => {
      previews.push(maxSide)
      return PNG
    },
  }
  const bridge: BridgeClient = {
    upload: async (name, data) => {
      uploads.push({ name, data })
      return name
    },
    download: async (name) => {
      downloads.push(name)
      return PNG
    },
    mkdir: async (name) => { folders.push(name) },
  }
  return { engine, bridge, calls, uploads, downloads, previews, folders }
}

/** What the plugin registers against, with the two services it reads stubbed. */
function hostOf(stage: Stage, options: { keepImages?: boolean } = {}): { ctx: Context; definitions: ToolDefinition[] } {
  const definitions: ToolDefinition[] = []
  const ctx = new Context()
  ctx.provide('tools', {
    register: (definition: ToolDefinition) => {
      definitions.push(definition)
      return () => {}
    },
  } as never)
  ctx.provide('attachments', {
    saveImages: async (images: SaveImageAttachment[]): Promise<ImageAttachmentRef[]> => options.keepImages === false
      ? []
      : images.map(image => ({
        attachmentId: AttachmentId(SOURCE),
        mediaType: 'image/png' as const,
        bytes: image.data.byteLength,
        width: 64,
        height: 48,
        name: image.name ?? 'preview.png',
      })),
  } as never)
  ctx.provide('workingDirectory', { ensure: async () => workspace } as never)
  tools.registerPhotocraftTools(ctx, { mcp: stage.engine, bridge: stage.bridge, previewSide: 700 })
  return { ctx, definitions }
}

/**
 * One execution identity, as the registry would hand it to the tool.
 * @param agent - whether a session agent owns the call.
 * @returns the execution.
 */
function execOf(agent = true): ToolRunContext {
  const token = Symbol('photocraft-exec') as ToolExecutionToken
  return {
    callId: ToolCallId('call-1'),
    rootCallId: ToolCallId('call-1'),
    name: 'photocraft_edit',
    arguments: {},
    signal: new AbortController().signal,
    token,
    ...agent ? { agent: { id: SessionId('agent-1') } as Agent } : {},
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

/** One registered tool by name. */
function toolOf(definitions: ToolDefinition[], name: string): ToolDefinition {
  const definition = definitions.find(candidate => candidate.name === name)
  if (definition === undefined) throw new Error(`${name} was not registered`)
  return definition
}

/** Remove delivered pictures so a test controls which ones the fallback sees. */
async function clearWishes(): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  for (const name of await readdir(workspace)) {
    if (/^wish-.*\.(?:png|jpe?g|webp)$/iu.test(name)) await rm(join(workspace, name), { force: true })
  }
}

/** Run `photocraft_edit` against a fresh stage. */
async function edit(
  args: Record<string, unknown>,
  options: { answer?: (name: string) => unknown; agent?: boolean; keepImages?: boolean } = {},
): Promise<{ value: Record<string, unknown>; stage: Stage }> {
  const stage = stageOf(options.answer)
  const definition = toolOf(hostOf(stage, options.keepImages === undefined ? {} : { keepImages: options.keepImages }).definitions, 'photocraft_edit')
  const value = await definition.execute(args, execOf(options.agent ?? true))
  return { value: value as Record<string, unknown>, stage }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'photocraft-tools-'))
  workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  for (const [digest, bytes] of [[DIGEST, PNG], [SUPPLY_DIGEST, SUPPLY_PNG], [EXTRA_DIGEST, EXTRA_PNG]] as const) {
    const bucket = join(root, 'attachments', 'v1', 'objects', digest.slice(0, 2))
    await mkdir(bucket, { recursive: true })
    await writeFile(join(bucket, digest), bytes)
  }
  // The attachment root is fixed when the module is first evaluated.
  process.env.DSH_HOME = root
  tools = await import('../src/tools.ts')
})

afterAll(async () => {
  // A second evaluation without DSH_HOME covers the homedir() fallback.
  delete process.env.DSH_HOME
  vi.resetModules()
  await import('../src/tools.ts')
  process.env.DSH_HOME = root
  await rm(root, { recursive: true, force: true })
})

describe('photocraft_edit', () => {

  it('imports the picture the attachment id names and saves the result', async () => {
    const { value, stage } = await edit({ instruction: '调成电影感', intent: 'film', source: SOURCE })
    expect(stage.uploads).toHaveLength(1)
    expect(stage.uploads[0]?.data).toEqual(PNG)
    expect(stage.uploads[0]?.name).toMatch(/^wish-\d+-\d+\.png$/u)
    // Two deliverables: a flattened PNG to look at, a PSD to keep editing.
    expect(stage.downloads).toHaveLength(2)
    expect(value.source).toMatch(/^wish-\d+\.psd$/u)
    expect(value.bytes).toBe(PNG.length)
    expect(value.applied).toBe('edited: 调成电影感')
    expect(await readFile(join(workspace, String(value.file)))).toEqual(PNG)
    expect(value.preview).toMatchObject({ mediaType: 'image/png', width: 64, height: 48 })
  })

  it('shows the preview at the configured side, or at the one the call names', async () => {
    const sides = async (previewSide?: number): Promise<number[]> =>
      (await edit({ instruction: '调成电影感', intent: 'film', source: SOURCE, ...previewSide === undefined ? {} : { previewSide } })).stage.previews
    expect(await sides()).toEqual([700])
    expect(await sides(448)).toEqual([448])
    expect(await sides(1)).toEqual([64])
    expect(await sides(9000)).toEqual([2048])
    expect(await sides(500.6)).toEqual([501])
  })

  it('hands the named knobs to the recipe that reads them', async () => {
    const { stage } = await edit({
      instruction: '调成胶片感',
      source: SOURCE,
      look: 'warm',
      strength: 90,
      vignette: 0,
      grain: 30,
      shift: -40,
      margin: 0.02,
    })
    const curves = stage.calls.find(call => call.name === 'layer.newAdjustmentLayer.curves')
    // A warm look at 90% bends red up and blue down by 58 levels (64 at full strength).
    expect(curves?.args.red).toEqual([[0, 0], [128, 186], [255, 255]])
    expect(curves?.args.blue).toEqual([[0, 0], [128, 70], [255, 255]])
    expect(stage.calls.map(call => call.name)).not.toContain('filter.lensCorrection')
    expect(stage.calls.find(call => call.name === 'filter.noise.addNoise')?.args.amount).toBe(120)
  })

  it('puts a supplied picture behind the subject when no box says where', async () => {
    const { stage } = await edit({ instruction: '换成这张天空', source: SOURCE, assets: [SUPPLY] }, {
      answer: name => (name === 'doc_inspect' ? { width: 100, height: 50 }
        : name === 'layer.selectBottom' ? { selected: [1] }
          : name === 'select.subject' ? { selected: true } : { layer: 2 }),
    })
    // The backdrop is fitted to the canvas before the recipe runs, so the list
    // opens with the material being measured.
    expect(stage.calls.map(call => call.name)).toEqual([
      'open',
      'doc_inspect',
      'open',
      'image.crop',
      'doc_save',
      'open',
      'layer.selectBottom',
      'select.subject',
      'select.refineEdge',
      'doc_place',
      'layer.moveTo',
      'layer.setProps',
      'doc_save',
      'doc_save',
    ])
    // The backdrop is the canvas-sized copy, not the raw upload.
    expect(stage.calls.find(call => call.name === 'doc_place')?.args.path).toMatch(/^photocraft-tmp\/backdrop-\d+\.png$/u)
  })

  it('routes the caller\'s intent card, and takes the colour the caller names', async () => {
    const routed = async (intent: string, extra: Record<string, unknown> = {}): Promise<Call[]> => {
      const { stage } = await edit({ instruction: '随意的原话', intent, source: SOURCE, ...extra })
      return stage.calls
    }
    const filled = (calls: Call[]): unknown => calls.find(call => call.name === 'layer.newFillLayer.solidColor')?.args.color
    const box = { regions: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }] }
    expect((await routed('remove', box)).map(call => call.name)).toContain('edit.contentAwareFill')
    expect((await routed('enhance')).map(call => call.name)).toContain('filter.noise.reduceNoise')
    expect(filled(await routed('cutout', { background: '#3388ff' }))).toBe('#3388ff')
  })

  it('refuses a wish it cannot route without an intent card', async () => {
    await expect(edit({ instruction: '帮我弄好看点', source: SOURCE })).rejects.toThrow(/请选择 intent/u)
  })

  it('repeats the wish once per red box', async () => {
    const { stage } = await edit({
      instruction: '把水印去掉',
      intent: 'remove',
      source: SOURCE,
      regions: [
        { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
        { x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
      ],
    })
    expect(stage.calls.filter(call => call.name === 'select.rect')).toHaveLength(2)
    expect(stage.calls.filter(call => call.name === 'edit.contentAwareFill')).toHaveLength(2)
  })

  it('keeps the box the user drew inside the picture', async () => {
    const { stage } = await edit({
      instruction: '把水印去掉',
      intent: 'remove',
      source: SOURCE,
      regions: [{ x: 0.9, y: 0.9, w: 0.9, h: 0.9 }],
      margin: 0,
    })
    expect(stage.calls.find(call => call.name === 'select.rect')?.args).toEqual({ x: 90, y: 45, width: 10, height: 5 })
  })

  it('refuses a box with no area', async () => {
    await expect(edit({ instruction: '把水印去掉', intent: 'remove', source: SOURCE, regions: [{ x: 0, y: 0, w: 0, h: 0 }] }))
      .rejects.toThrow(/选区为空/u)
  })

  it('places the material as it is when the canvas cannot be measured', async () => {
    const { stage } = await edit({ instruction: '换成这张天空', source: SOURCE, assets: [SUPPLY] }, {
      answer: name => (name === 'doc_inspect' ? {}
        : name === 'layer.selectBottom' ? { selected: [1] }
          : name === 'select.subject' ? { selected: true } : { layer: 2 }),
    })
    expect(stage.calls.map(call => call.name)).not.toContain('image.crop')
    expect(stage.calls.find(call => call.name === 'doc_place')?.args.path).toMatch(/^photocraft-tmp\/wish-/u)
  })

  it('puts a material into each red box, paired by number', async () => {
    const { value, stage } = await edit({
      instruction: '把这两块换成素材',
      source: SOURCE,
      assets: [SUPPLY, EXTRA],
      regions: [
        { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { x: 0.5, y: 0.4, w: 0.2, h: 0.2 },
      ],
    })
    // The picture opens to measure its boxes, then each material is opened and
    // fitted, then the picture opens again to receive them.
    expect(stage.calls.filter(call => call.name === 'open')).toHaveLength(4)
    expect(stage.calls.filter(call => call.name === 'image.crop').map(call => call.args))
      .toEqual([
        { x: 0, y: 0, width: 100, height: 50, targetWidth: 20, targetHeight: 10 },
        { x: 0, y: 0, width: 100, height: 50, targetWidth: 20, targetHeight: 10 },
      ])
    const placed = stage.calls.filter(call => call.name === 'doc_place')
    expect(placed.map(call => call.args.center)).toEqual([[20, 10], [60, 25]])
    expect(placed.map(call => call.args.scale)).toEqual([100, 100])
    expect(value.applied).toBe('replaced: 把这两块换成素材')
    expect(stage.uploads.map(upload => upload.data)).toEqual([SUPPLY_PNG, EXTRA_PNG, PNG])
  })

  it('reuses the first material when there are fewer materials than boxes', async () => {
    const { stage } = await edit({
      instruction: '把这两块换成素材',
      source: SOURCE,
      assets: [SUPPLY],
      regions: [
        { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { x: 0.5, y: 0.4, w: 0.2, h: 0.2 },
      ],
    })
    // The picture, the single material twice, then the picture again.
    expect(stage.calls.filter(call => call.name === 'open')).toHaveLength(4)
    expect(stage.calls.filter(call => call.name === 'doc_place')).toHaveLength(2)
    expect(stage.uploads.map(upload => upload.data)).toEqual([SUPPLY_PNG, PNG])
  })

  it('refuses a material box it cannot measure', async () => {
    await expect(edit({
      instruction: '换成素材',
      source: SOURCE,
      assets: [SUPPLY],
      regions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
    }, { answer: () => ({}) })).rejects.toThrow(/量不出主图的尺寸/u)
  })

  it('cuts a poster only when the caller named the words', async () => {
    await expect(edit({ instruction: '做张海报', intent: 'poster', source: SOURCE })).rejects.toThrow(/需要一句文案/u)
    const { value, stage } = await edit({ instruction: '做张海报', intent: 'poster', source: SOURCE, text: '秋日', subline: '京都' })
    expect(stage.calls.filter(call => call.name === 'type.create')).toHaveLength(2)
    expect(value.notes).toEqual(['只做了这一张的排版'])
  })

  it('returns the recipe notes it was told to keep', async () => {
    const { value } = await edit({ instruction: '把背景去掉', intent: 'cutout', source: SOURCE })
    expect(value.notes).toEqual([
      '结果层带蒙版，导出 PNG 即为透明底',
      '没给框也没画笔，这版按画面里最显著的区域抠；回复时可以顺带说一句「框一下或涂一下会更准」',
      '主体边缘如果还带一圈原背景，把 shift 调到 -30 再跑一次',
      // The fake bridge delivers `PNG`, so the header check fires: that is the
      // behaviour a cutout that produced no transparency has to report.
      '抠图结果没有透明区域：选区可能没生效，导出的 PNG 不带 alpha',
    ])
  })

  it('needs a picture to work on', async () => {
    await clearWishes()
    await expect(edit({ instruction: '调成电影感' })).rejects.toThrow(/需要一张图/u)
    await expect(edit({ instruction: '调成电影感', source: '   ' })).rejects.toThrow(/需要一张图/u)
  })

  it('reads a file the agent already has by absolute path', async () => {
    const copy = join(root, 'copy.png')
    await writeFile(copy, PNG)
    const { stage } = await edit({ instruction: '调成电影感', intent: 'film', source: copy })
    expect(stage.uploads[0]?.data).toEqual(PNG)
  })

  it('refuses anything that is not an image', async () => {
    const text = join(root, 'notes.txt')
    await writeFile(text, 'hello')
    await expect(edit({ instruction: '调成电影感', intent: 'film', source: text })).rejects.toThrow(/只能导入图片文件/u)
  })

  it('refuses a picture that is not there', async () => {
    await expect(edit({ instruction: '调成电影感', intent: 'film', source: join(root, 'missing.png') })).rejects.toThrow(/找不到图片/u)
  })

  it('refuses a picture over the import limit', async () => {
    const huge = join(root, 'huge.png')
    const handle = await open(huge, 'w')
    await handle.truncate(31 * 1024 * 1024)
    await handle.close()
    await expect(edit({ instruction: '调成电影感', intent: 'film', source: huge })).rejects.toThrow(/图片超过 30MB/u)
  })

  it('leaves a workspace file name to the engine', async () => {
    const { stage } = await edit({ instruction: '调成电影感', intent: 'film', source: 'in-the-workspace.png' })
    expect(stage.uploads).toHaveLength(0)
    expect(stage.calls[0]).toEqual({ name: 'open', args: { path: 'in-the-workspace.png' } })
  })

  it('continues from the newest delivered picture when no source is named', async () => {
    const older = join(workspace, 'wish-1000.png')
    const newer = join(workspace, 'wish-2000.png')
    await clearWishes()
    await writeFile(older, PNG)
    await writeFile(newer, EXTRA_PNG)
    const now = Date.now()
    await utimes(older, new Date(now + 1_000), new Date(now + 1_000))
    await utimes(newer, new Date(now + 2_000), new Date(now + 2_000))
    try {
      const { stage } = await edit({ instruction: '再暖一点', intent: 'film' })
      expect(stage.uploads).toHaveLength(1)
      expect(stage.uploads[0]?.data.equals(EXTRA_PNG)).toBe(true)
    } finally {
      await rm(older, { force: true })
      await rm(newer, { force: true })
    }
  })

  it('refuses to report a result it could not store', async () => {
    await expect(edit({ instruction: '调成电影感', intent: 'film', source: SOURCE }, { keepImages: false }))
      .rejects.toThrow(/结果图保存失败/u)
  })

  it('refuses to write into a workspace it does not have', async () => {
    await expect(edit({ instruction: '调成电影感', intent: 'film', source: SOURCE }, { agent: false }))
      .rejects.toThrow(/没有可写入的工作区/u)
  })
})

describe('photocraft_run', () => {
  it('takes a session tool named as the single id, not just inside steps', async () => {
    const stage = stageOf()
    const definition = toolOf(hostOf(stage).definitions, 'photocraft_run')
    const value = await definition.execute({ id: 'doc_open', params: { path: 'wish.png' } }, execOf())
    expect(stage.calls).toEqual([{ name: 'doc_open', args: { path: 'wish.png' } }])
    expect(value).toMatchObject({ id: 'doc_open' })
  })

})

it('lands an export named by the caller in the workspace, not in the engine', async () => {
  const stage = stageOf()
  const definition = toolOf(hostOf(stage).definitions, 'photocraft_run')
  await definition.execute(
    { steps: [{ id: 'doc_export', params: { path: 'out/最终.png' } }] },
    execOf(),
  )
  // The engine writes to its own scratch; the workspace gets the name asked for.
  const saved = stage.calls.find(call => call.name === 'doc_save')
  expect(String(saved?.args.path)).toMatch(/^photocraft-tmp\//u)
  await expect(readFile(join(workspace, 'out', '最终.png'))).resolves.toEqual(PNG)
  await rm(join(workspace, 'out'), { recursive: true, force: true })
})

it('adds a closeup of the region a workflow touched', async () => {
  const stage = stageOf()
  // The engine's export has to be a real PNG for the crop to have pixels.
  stage.bridge.download = async () => Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAXElEQVR4nBXKMQEDQQgAsJPyUpCCFKQgBSk4acOQLe+9+n0ESdEMy3ufQJAUzbDfhRAIkqIZNi6kQJAUzbB5oQSCpGiGrQstECRFM2xfGIEgKZph58IKBEnRDMsf+pGXwQKipHUAAAAASUVORK5CYII=',
    'base64',
  )
  const definition = toolOf(hostOf(stage).definitions, 'photocraft_run')
  const value = await definition.execute({
    steps: [{ id: 'doc_export', params: { path: 'out/x.png', x: 2, y: 2, width: 4, height: 4 } }],
  }, execOf())
  expect(value).toMatchObject({ metrics: { target: '2,2 4×4px' } })
  expect(value).toHaveProperty('closeup')
  await rm(join(workspace, 'out'), { recursive: true, force: true })
})

describe('photocraft_look', () => {
  const SAMPLE = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAXElEQVR4nBXKMQEDQQgAsJPyUpCCFKQgBSk4acOQLe+9+n0ESdEMy3ufQJAUzbDfhRAIkqIZNi6kQJAUzbB5oQSCpGiGrQstECRFM2xfGIEgKZph58IKBEnRDMsf+pGXwQKipHUAAAAASUVORK5CYII=',
    'base64',
  )

  it('reports the canvas and the target, and changes nothing on disk', async () => {
    await writeFile(join(workspace, 'wish-look.png'), SAMPLE)
    try {
      const stage = stageOf()
      const definition = toolOf(hostOf(stage).definitions, 'photocraft_look')
      const value = await definition.execute({
        source: 'wish-look.png',
        region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      }, execOf())
      expect(value).toMatchObject({ canvas: '8×8', target: '2,2 4×4px' })
      // 1.5x the region, shifted so the region keeps the window's centre.
      expect(value).toMatchObject({ window: '1,1 6×6px' })
      expect(value).toHaveProperty('closeup')
      // A look is read-only: the engine is never asked to open anything.
      expect(stage.calls).toHaveLength(0)
    } finally {
      await rm(join(workspace, 'wish-look.png'), { force: true })
    }
  })

  it('decodes a JPEG source through the engine before cropping it', async () => {
    await writeFile(join(workspace, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
    const stage = stageOf()
    stage.bridge.download = async () => SAMPLE
    try {
      const definition = toolOf(hostOf(stage).definitions, 'photocraft_look')
      const value = await definition.execute({ source: 'photo.jpg' }, execOf())
      expect(value).toMatchObject({ canvas: '8×8' })
      // One open, one save: the engine is the only JPEG decoder in reach.
      expect(stage.calls.map(call => call.name)).toEqual(['doc_open', 'doc_save'])
    } finally {
      await rm(join(workspace, 'photo.jpg'), { force: true })
    }
  })
})

describe('toolbox cards', () => {
  it('brush paints the strokes the caller sent', async () => {
    const { stage } = await edit({
      instruction: '涂个腮红',
      intent: 'brush',
      source: SOURCE,
      strokes: [{ points: [[0.5, 0.5], [0.6, 0.5]] }],
      color: '#ff8888',
      size: 40,
    })
    const stroke = stage.calls.find(call => call.name === 'paint.stroke')
    expect(stroke?.args).toMatchObject({ points: [[50, 25], [60, 25]], size: 40, color: '#ff8888' })
  })

  it('brush erases when the caller says so', async () => {
    const { stage } = await edit({
      instruction: '擦掉这块',
      intent: 'brush',
      source: SOURCE,
      strokes: [{ points: [[0.5, 0.5]] }],
      erase: true,
    })
    expect(stage.calls.find(call => call.name === 'paint.stroke')?.args).toMatchObject({ erase: true })
  })

  it('retouch picks the tool the caller named and maps its strength', async () => {
    const { stage } = await edit({
      instruction: '这边加深一点',
      intent: 'retouch',
      source: SOURCE,
      tool: 'burn',
      strength: 30,
      strokes: [{ points: [[0.2, 0.2]] }],
    })
    expect(stage.calls.find(call => call.name === 'paint.burn')?.args).toMatchObject({ points: [[20, 10]], flow: 30 })
  })

  it('refuses a retouch call without a tool', async () => {
    await expect(edit({ instruction: '修一下', intent: 'retouch', source: SOURCE, strokes: [{ points: [[0.5, 0.5]] }] }))
      .rejects.toThrow(/retouch 需要 tool/u)
  })

  it('fill draws a gradient between the points', async () => {
    const { stage } = await edit({
      instruction: '从上往下拉个渐变',
      intent: 'fill',
      source: SOURCE,
      tool: 'gradient',
      from: [0.5, 0],
      to: [0.5, 1],
      color: '#3366ff',
    })
    const gradient = stage.calls.find(call => call.name === 'paint.gradient')
    expect(gradient?.args.from).toEqual([50, 0])
    expect(gradient?.args.to).toEqual([50, 50])
    expect(gradient?.args.colors).toEqual(['#ffffff', '#3366ff'])
  })

  it('transform rotates by quarter turns and resizes', async () => {
    const { stage } = await edit({ instruction: '转 90 度', intent: 'transform', source: SOURCE, action: 'rotate', angle: 90 })
    expect(stage.calls.find(call => call.name === 'edit.transform.rotate90Cw')).toBeDefined()
    await expect(edit({ instruction: '转 37 度', intent: 'transform', source: SOURCE, action: 'rotate', angle: 37 }))
      .rejects.toThrow(/旋转只支持/u)
    const { stage: resized } = await edit({ instruction: '宽 200', intent: 'transform', source: SOURCE, action: 'resize', width: 200 })
    expect(resized.calls.find(call => call.name === 'image.imageSize')?.args).toEqual({ width: 200, height: 100 })
  })

  it('gray desaturates and text writes the words', async () => {
    const { stage } = await edit({ instruction: '转黑白', intent: 'gray', source: SOURCE })
    expect(stage.calls.map(call => call.name)).toContain('image.adjustments.desaturate')
    const { stage: typed } = await edit({ instruction: '加字', intent: 'text', source: SOURCE, text: '你好' })
    expect(typed.calls.find(call => call.name === 'type.create')?.args).toMatchObject({ text: '你好', color: '#ffffff' })
  })
})

describe('photocraft_export', () => {
  /** Run the export tool with one argument set. */
  async function exportAs(args: Record<string, unknown>): Promise<{ value: Record<string, unknown>; stage: Stage }> {
    const stage = stageOf()
    const definition = toolOf(hostOf(stage).definitions, 'photocraft_export')
    const value = await definition.execute(args, execOf())
    return { value: value as Record<string, unknown>, stage }
  }

  it('keeps layers as PSD by default', async () => {
    const { value, stage } = await exportAs({})
    expect(stage.calls[0]?.args).toMatchObject({ format: 'psd' })
    expect(String(value.file)).toMatch(/^wish-\d+\.psd$/u)
    expect(await readFile(join(workspace, String(value.file)))).toEqual(PNG)
  })

  it('writes a named jpeg', async () => {
    const { value, stage } = await exportAs({ format: 'jpeg', file: 'final.jpg' })
    expect(stage.calls[0]?.args).toEqual({ path: 'photocraft-tmp/final.jpg', format: 'jpg' })
    expect(value).toEqual({ file: 'final.jpg', bytes: PNG.length })
  })

  it('names an unnamed jpeg with the extension the engine writes', async () => {
    const { value } = await exportAs({ format: 'jpeg' })
    expect(String(value.file)).toMatch(/^wish-\d+\.jpg$/u)
  })

  it('renders its own caption', () => {
    const definition = toolOf(hostOf(stageOf()).definitions, 'photocraft_export')
    expect(definition.output.render({}, { file: 'final.psd', bytes: 2048 })).toEqual([
      { type: 'text', text: '已导出 final.psd（2KB）' },
    ])
  })
})

describe('presentation', () => {
  /** The edit tool's pure projections. */
  function editTool(): ToolDefinition {
    return toolOf(hostOf(stageOf()).definitions, 'photocraft_edit')
  }

  /** One canonical result value. */
  function valueOf(extra: Record<string, unknown>): JsonValue {
    return { file: 'wish-1.png', source: 'wish-1.psd', bytes: 2048, applied: 'edited: 调成电影感', metrics: { canvas: '547×365' }, ...extra } as JsonValue
  }

  const preview = {
    attachmentId: SOURCE,
    mediaType: 'image/png',
    bytes: 12,
    width: 64,
    height: 48,
    name: 'p.png',
  }

  it('renders the caption, the notes, and the preview as an image block', () => {
    const blocks = editTool().output.render(
      { instruction: '调成电影感' },
      valueOf({ notes: ['只做了这一张的排版'], preview }),
    )
    expect(blocks).toHaveLength(4)
    expect(blocks[0]).toEqual({
      type: 'text',
      text: '已按「edited: 调成电影感」处理：wish-1.png（2KB，可直接查看）；可编辑源文件 wish-1.psd，图层保留可再调\n'
        + '给用户看成品就写 ![说明](wish-1.png)：工作区里只有这个文件，预览附件的名字（*-preview.png）只用于你查看，写成图片会加载失败。',
    })
    expect(blocks[1]).toEqual({ type: 'text', text: '只做了这一张的排版' })
    expect(blocks[2]).toEqual({ type: 'text', text: '画布 547×365' })
    expect(blocks[3]).toMatchObject({ type: 'image' })
  })

  it('renders a bare caption when there is nothing else to say', () => {
    expect(editTool().output.render({}, valueOf({}))).toHaveLength(2)
    expect(editTool().output.render({}, valueOf({ notes: [] }))).toHaveLength(2)
    expect(editTool().output.render({}, valueOf({ notes: ['a'] }))).toHaveLength(3)
    // A replayed transcript without metrics keeps the caption alone.
    expect(editTool().output.render({}, valueOf({ metrics: undefined }))).toHaveLength(1)
  })

  it('carries the edit kind and value for the transcript', () => {
    expect(editTool().output.presentationMeta?.({}, valueOf({ preview })))
      .toMatchObject({ kind: 'photocraft.edit', file: 'wish-1.png' })
  })
})
