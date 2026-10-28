/**
 * Two tools: change a photo, or write it out.
 *
 * The engine's own vocabulary (documents, sessions, previews, command ids) stays
 * inside this file. A caller says what it wants and gets the finished picture
 * back as an image, which is the whole product.
 *
 * @module @deepseek-ai/dsh-skill-photocraft/tools
 */

import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { CommandIndex } from './capability.ts'
import { cropPng, fitPng, guidesPng, pngSize, type PngFraction } from './png.ts'
import type { BridgeClient, EngineClient } from './client.ts'
import { centreCrop, normalizeRegion, toPixels, type PixelBox } from './coords.ts'
import { RECIPES, recipeFor as recipeById } from './recipes.ts'

/** Everything the tools need to reach the capability. */
export interface PhotocraftToolsRuntime {
  readonly mcp: EngineClient
  readonly bridge: BridgeClient
  /** Long edge of the preview handed back with a result. */
  readonly previewSide: number
}

/**
 * Where uploaded chat attachments live. Readable by this process, never writable
 * by the agent's own shell — which is why the bytes are read here.
 */
const ATTACHMENT_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'attachments')

/** Long-edge bounds of a preview, shared with the plugin config's own range. */
export const PREVIEW_SIDE_MIN = 64
export const PREVIEW_SIDE_MAX = 2048
/** Long edge of the enlarged closeup a card returns beside the whole frame. */
const CLOSEUP_SIDE = 384
/** Pixels the closeup is cut from: enough detail to survive the enlargement. */
const CLOSEUP_SOURCE_SIDE = 1024

/** The preview a result carries. */
interface Preview {
  readonly attachmentId: string
  readonly mediaType: 'image/png'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name: string
}

/**
 * Save one PNG as a durable attachment so the answer carries the picture.
 * @param ctx - context owning the attachment store.
 * @param png - encoded bytes.
 * @param name - display name.
 * @returns the reference fields the tool value carries.
 */
async function keep(ctx: Context, png: Buffer, name: string): Promise<Preview> {
  const [ref] = await ctx.attachments.saveImages([{ data: png, mediaType: 'image/png', name }])
  if (ref === undefined) throw new Error('photocraft: 结果图保存失败')
  return {
    attachmentId: ref.attachmentId,
    mediaType: 'image/png',
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    name,
  }
}

/** The fields a persisted preview carries; the schema widens `mediaType`. */
interface PersistedPreview {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name: string
}

/** Rebuild the durable reference a persisted preview names. */
function previewRef(preview: PersistedPreview): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(preview.attachmentId),
    mediaType: 'image/png',
    bytes: preview.bytes,
    width: preview.width,
    height: preview.height,
    name: preview.name,
  }
}

/** The schema every result shares. */
const previewSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' as const, required: true },
    mediaType: { type: 'string' as const, required: true },
    bytes: { type: 'number' as const, required: true },
    width: { type: 'number' as const, required: true },
    height: { type: 'number' as const, required: true },
    name: { type: 'string' as const, required: true },
  },
} as const

/**
 * Resolve the recipe for one edit call.
 *
 * Language understanding belongs to the caller: the model reads the wish and
 * names the card in `intent`, and this function only validates the choice.
 * Structural knobs decide without any wording — a supplied picture is a
 * composite, a headline is a poster, a named look is a grade — because those
 * are typed parameters, not text to parse. Everything else refuses loud with
 * the card list rather than guessing from keywords.
 * @param intent - the caller's chosen card, or undefined.
 * @param hasAsset - whether the caller supplied a second picture.
 * @param named - knobs the caller filled in.
 * @returns the recipe id.
 */
function recipeFor(
  intent: string | undefined,
  hasAsset: boolean,
  named: { text?: unknown; look?: unknown },
): string {
  if (intent !== undefined && intent !== 'auto' && RECIPES.some(recipe => recipe.id === intent)) return intent
  if (hasAsset) return 'composite'
  if (named.text !== undefined && named.text !== '') return 'poster'
  if (named.look !== undefined) return 'film'
  throw new Error(
    'photocraft: 请选择 intent——film 调色 | cutout 抠图换底 | remove 擦除去物 | enhance 画质修复 | poster 海报文字 | composite 贴素材',
  )
}

/**
 * Where the engine's copies live inside the caller's own directory.
 *
 * Every round trip through the engine needs a file (`doc_save`, `doc_place`), and
 * the capability has no delete, so they go in one hidden folder the user can
 * drop as a whole instead of finding `wish-*` between their photos.
 */
const SCRATCH_DIR = 'photocraft-tmp'

/** Disambiguates two imports that land in the same millisecond. */
let uploaded = 0

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']
const MAX_IMPORT_BYTES = 30 * 1024 * 1024

/**
 * Turn whatever the model was given into a file on this machine.
 *
 * The picture in a chat message is identified as `sha256:<hex>`, and that is the
 * one identifier a model always has in hand; asking it for a path made every run
 * fail on a location it could only guess. Absolute paths are still taken (the
 * agent may legitimately point at a copy it made), and a bare workspace name is
 * passed through for the engine to resolve itself.
 * @param source - attachment id, absolute path, or workspace file name.
 * @returns absolute path to read, or undefined when the engine owns the name.
 */
function localFileOf(source: string): string | undefined {
  const hex = /^sha256:([0-9a-f]{64})$/u.exec(source)?.[1]
  if (hex !== undefined) return join(ATTACHMENT_ROOT, 'v1', 'objects', hex.slice(0, 2), hex)
  return source.startsWith('/') ? resolve(source) : undefined
}

/**
 * Resolve a bare workspace name against the agent's own directory.
 *
 * A model that just exported `wish-123.png` naturally writes that name back.
 * The engine reads its own volume, so handing the bare name over makes every
 * follow-up edit fail with NotFound; resolving it here first is what lets the
 * same name work whether it points at the workspace or at the engine's scratch
 * folder (a name that is not there is left for the engine to resolve).
 * @param cwd - the agent's working directory.
 * @param source - whatever the model wrote as `source`.
 * @returns absolute path when the file is really in the workspace.
 */
async function workspaceFile(cwd: string | undefined, source: string): Promise<string | undefined> {
  if (cwd === undefined || source.startsWith('/') || source.startsWith('sha256:')) return undefined
  const candidate = resolve(cwd, source)
  const info = await stat(candidate).catch(() => undefined)
  return info?.isFile() === true ? candidate : undefined
}

/**
 * Name the pictures a caller most likely meant.
 *
 * A missing `source` used to fall through to the engine, which answered
 * "automation read X failed (NotFound)" without saying what the workspace
 * holds; listing the newest pictures turns a guessing loop into one retry.
 * @param cwd - session working directory.
 * @param limit - how many names to keep.
 * @returns the newest image file names, newest first.
 */
async function recentPictures(cwd: string | undefined, limit = 5): Promise<string[]> {
  if (cwd === undefined) return []
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => [])
  const pictures = await Promise.all(entries
    .filter(entry => entry.isFile() && IMAGE_EXTENSIONS.includes(extname(entry.name).toLowerCase()))
    .map(async (entry) => {
      const info = await stat(join(cwd, entry.name)).catch(() => undefined)
      return { name: entry.name, at: info?.mtimeMs ?? 0 }
    }))
  return pictures.sort((left, right) => right.at - left.at).slice(0, limit).map(picture => picture.name)
}

/**
 * Bring a source into the engine's workspace.
 * @param bridge - file bridge of the capability.
 * @param source - attachment id, absolute path, or workspace file name.
 * @returns the workspace file name to open.
 */
async function importSource(bridge: BridgeClient, source: string, cwd?: string): Promise<string> {
  const absolute = localFileOf(source) ?? await workspaceFile(cwd, source)
  // Not found locally is not a verdict: the engine's own volume may already hold
  // that name, so the name goes through and a missing picture is reported there.
  if (absolute === undefined) return source
  // A picture may arrive as a chat attachment or as a file the agent already
  // copied into the workspace, so either root is accepted — but only for image
  // files, and only when they are actually there.
  const insideAttachments = absolute.startsWith(`${resolve(ATTACHMENT_ROOT)}/`)
  if (!insideAttachments) {
    if (!IMAGE_EXTENSIONS.includes(extname(absolute).toLowerCase())) {
      throw new Error(`photocraft: 只能导入图片文件（${IMAGE_EXTENSIONS.join(' ')}）`)
    }
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new Error(`photocraft: 找不到图片 ${source}`)
    if (info.size > MAX_IMPORT_BYTES) throw new Error(`photocraft: 图片超过 ${String(MAX_IMPORT_BYTES / 1024 / 1024)}MB`)
  }
  uploaded += 1
  const name = `wish-${String(Date.now())}-${String(uploaded)}.png`
  await bridge.upload(name, await readFile(absolute), SCRATCH_DIR)
  return `${SCRATCH_DIR}/${name}`
}

/**
 * The newest picture this skill delivered into a workspace.
 *
 * Every finished edit lands as `wish-<stamp>.png`, so a request that names no
 * source almost always means "the one we were just looking at". Picking only
 * names this skill produces keeps an unrelated workspace image out of it.
 * @param cwd - session working directory.
 * @returns the newest delivered file name, or undefined when there is none.
 */
async function latestWish(cwd: string): Promise<string | undefined> {
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => [])
  const wishes = await Promise.all(entries
    .filter(entry => entry.isFile() && /^wish-.*\.(?:png|jpe?g|webp)$/iu.test(entry.name))
    .map(async (entry) => {
      const info = await stat(join(cwd, entry.name)).catch(() => undefined)
      return { name: entry.name, at: info?.mtimeMs ?? 0 }
    }))
  return wishes.sort((left, right) => right.at - left.at)[0]?.name
}

/**
 * Make sure the scratch folder exists; a second call finding it already there is
 * the normal case, not an error.
 * @param bridge - file bridge of the capability.
 */
async function ensureScratch(bridge: BridgeClient): Promise<void> {
  try {
    await bridge.mkdir(SCRATCH_DIR)
  } catch {
    // "already exists": every call after the first one.
  }
}

/**
 * Resize the open document to the box's exact pixels and save it as a piece.
 *
 * @param client - MCP client with the piece document open.
 * @param file - file name to save under the scratch folder.
 * @param size - pixel size of the box the piece must fill.
 * @param current - the piece's size right now, as the command that made it reported.
 * @returns the path the piece was saved to.
 */
async function fitPiece(
  client: EngineClient,
  file: string,
  size: { width: number; height: number },
  current: { width: number; height: number },
): Promise<string> {
  await client.run('image.crop', {
    ...centreCrop(current, size),
    targetWidth: size.width,
    targetHeight: size.height,
  })
  const path = `${SCRATCH_DIR}/${file}`
  await client.call('doc_save', { path, format: 'png' })
  return path
}

/**
 * Save the active document, read it back, and return the picture to the caller.
 * @param ctx - context owning the attachment store.
 * @param client - MCP client with the finished document open.
 * @param bridge - file bridge of the capability.
 * @param side - preview long edge.
 * @param applied - the wish this result answers.
 * @param verb - what happened, for the caption.
 * @returns the tool value.
 */
/**
 * Put finished bytes where the session can reach them.
 *
 * The download bridge only hands back memory, so a result that is never written
 * is a file name that exists nowhere — `present` then fails with FS_NOT_FOUND on
 * a file the agent was just told it had.
 *
 * @param ctx - context carrying the working directory.
 * @param exec - the call being served, which owns the target workspace.
 * @param name - file name the caller will use to refer to the result.
 * @param bytes - encoded picture.
 * @returns the same name, now resolvable from the session workspace.
 */
/**
 * Where an export should land inside the workspace.
 *
 * `path` is the reader's name for the file, not the engine's: an engine path is
 * invisible to the workspace, so handing it through produced a file nobody could
 * open. A bare name keeps its extension, an absolute path keeps only its last
 * segment, and a relative directory is honoured.
 * @param requested - the caller's `path`, possibly empty.
 * @param format - the caller's `format`, used when the name carries none.
 * @returns a workspace-relative file name.
 */
function deliveredNameOf(requested: string, format: string): string {
  const fallback = format === '' ? 'png' : format.toLowerCase()
  if (requested === '') return `wish-${String(Date.now())}.${fallback === 'jpeg' ? 'jpg' : fallback}`
  const cleaned = (requested.startsWith('/') ? basename(requested) : requested).replace(/^\.\//u, '')
  if (cleaned === '' || cleaned.split('/').includes('..')) {
    throw new Error(`photocraft: 导出路径必须是工作区内的相对路径：${requested}`)
  }
  if (extname(cleaned) !== '') return cleaned
  return `${cleaned}.${fallback === 'jpeg' ? 'jpg' : fallback}`
}

/**
 * The agent a call runs under.
 *
 * PTC sub-dispatches carry no agent, and without one there is no session
 * workspace to work in — fail loud instead of touching a cwd the agent cannot
 * see.
 * @param exec - the running call.
 * @returns the agent the call belongs to.
 */
function agentOf(exec: ToolExecution): NonNullable<ToolExecution['agent']> {
  if (exec.agent === undefined) throw new Error('photocraft: 没有可写入的工作区（无会话代理）')
  return exec.agent
}

async function saveDeliverable(ctx: Context, exec: ToolExecution, name: string, bytes: Buffer): Promise<string> {
  const cwd = await ctx.workingDirectory.ensure(agentOf(exec), exec.signal)
  const target = join(cwd, name)
  // A caller may name a folder (`out/final.png`); the workspace is the reader's
  // own tree, so the folder is created instead of failing the export.
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return name
}

/**
 * How far a placed piece should fade into its material.
 *
 * Defaults to 2% of the box's short edge and never reaches past its middle: a
 * fade wider than the piece would erase what was just pasted.
 * @param requested - the caller's own radius, when it named one.
 * @param box - the rectangle the piece fills, in document pixels.
 * @returns the radius in pixels, or 0 for a hard edge.
 */
function featherOf(requested: number | undefined, box: PixelBox): number {
  const wanted = requested ?? Math.min(box.width, box.height) * 0.02
  const ceiling = Math.max(0, Math.floor((Math.min(box.width, box.height) - 1) / 2))
  return Math.min(ceiling, Math.max(0, Math.round(wanted)))
}

/**
 * The rectangle a placed layer actually occupies.
 *
 * `doc_place` reports where it put the layer; trusting that over the request is
 * what makes a wrong placement visible instead of silently accepted.
 * @param placed - the engine's reply.
 * @param requested - the box the caller asked for.
 * @returns the measured rectangle, or the request when the reply carries none.
 */
function placedBox(placed: unknown, requested: PixelBox): PixelBox {
  const bounds = (placed as { bounds?: unknown }).bounds
  if (!Array.isArray(bounds) || bounds.length !== 4) return requested
  // Four corners, as the engine reports them; the length check above is what the
  // tuple type says out loud.
  const [x0, y0, x1, y1] = bounds as [number, number, number, number]
  const width = Math.round(x1 - x0)
  const height = Math.round(y1 - y0)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return requested
  return { x: Math.round(x0), y: Math.round(y0), width, height }
}

/**
 * Drop prepared pieces into their boxes and fade their edges.
 * @param client - MCP client with the target document open.
 * @param pieces - piece file, centre, and the box size it must fill.
 * @param feather - the caller's own edge radius, when it named one.
 * @returns what the engine reported that the caller should know about.
 */
async function placeAll(
  client: EngineClient,
  pieces: readonly { file: string; centre: [number, number]; size: { width: number; height: number } }[],
  feather: number | undefined,
): Promise<string[]> {
  const notes: string[] = []
  for (const piece of pieces) {
    const requested: PixelBox = {
      x: Math.round(piece.centre[0] - piece.size.width / 2),
      y: Math.round(piece.centre[1] - piece.size.height / 2),
      ...piece.size,
    }
    // The piece was made the box's exact pixels, so it is placed as it is: no
    // percentage stands between the measurement and the result.
    const placed = await client.call('doc_place', { path: piece.file, center: piece.centre, scale: 100 })
    const box = placedBox(placed, requested)
    const off = Math.max(Math.abs(box.width - piece.size.width), Math.abs(box.height - piece.size.height))
    if (off > 1) {
      notes.push(`贴图实际 ${String(box.width)}×${String(box.height)}，框 ${String(piece.size.width)}×${String(piece.size.height)}`)
    }
    const radius = featherOf(feather, box)
    if (radius === 0) continue
    // A selection inset by its own radius puts the fade inside the layer:
    // feathering right up to the canvas edge is measured to do nothing.
    await client.run('select.rect', {
      x: box.x + radius,
      y: box.y + radius,
      width: box.width - radius * 2,
      height: box.height - radius * 2,
      feather: radius,
    })
    await client.run('layer.layerMask.revealSelection', {})
  }
  return notes
}

/**
 * Keep one call's preview inside the range the plugin config declares.
 * @param requested - the long edge the caller asked for, when it asked.
 * @param fallback - the plugin's configured default.
 * @returns the long edge to render at.
 */
function previewSideOf(requested: number | undefined, fallback: number): number {
  if (requested === undefined) return fallback
  return Math.min(PREVIEW_SIDE_MAX, Math.max(PREVIEW_SIDE_MIN, Math.round(requested)))
}

/** Which pictures one edit returns, and where the closeup looks. */
export interface FinishView {
  /** `both` keeps the whole frame and the closeup; `off` returns neither. */
  mode: 'both' | 'full' | 'focus' | 'off'
  /** Long edge of the whole-frame preview. */
  side: number
  /** Window to enlarge, as fractions of the picture. */
  focus?: PngFraction | undefined
}

/**
 * The window an edit's closeup should show.
 *
 * The rectangle comes from the caller's own marks, never from a choice of what
 * looks interesting: the same target must crop to the same window on every round,
 * or a "fixed" edge cannot be compared with the one that was broken. Context is
 * added at four to six radii of the target — enough to judge an edge, far less
 * than the whole frame.
 * @param args - the call's marks: boxes, strokes, or a single point.
 * @returns the window as fractions of the picture, or undefined when the edit
 *   has no target (a whole-frame change).
 */
function focusWindowOf(args: {
  regions?: readonly { x: number; y: number; w: number; h: number }[] | undefined
  strokes?: readonly { points: readonly (readonly number[])[] }[] | undefined
  x?: number | undefined
  y?: number | undefined
}): PngFraction | undefined {
  const xs: number[] = []
  const ys: number[] = []
  for (const region of args.regions ?? []) {
    xs.push(region.x, region.x + region.w)
    ys.push(region.y, region.y + region.h)
  }
  for (const stroke of args.strokes ?? []) {
    for (const point of stroke.points) {
      xs.push(point[0] ?? 0)
      ys.push(point[1] ?? 0)
    }
  }
  if (xs.length === 0 && typeof args.x === 'number' && typeof args.y === 'number') {
    xs.push(args.x)
    ys.push(args.y)
  }
  if (xs.length === 0) return undefined
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  const width = Math.max(right - left, 0.04)
  const height = Math.max(bottom - top, 0.04)
  const padX = Math.max(0.04, width * 1.2)
  const padY = Math.max(0.04, height * 1.2)
  return {
    x: left - padX,
    y: top - padY,
    w: width + padX * 2,
    h: height + padY * 2,
  }
}


async function finish(
  ctx: Context,
  client: EngineClient,
  bridge: BridgeClient,
  side: number,
  applied: string,
  verb: string,
  exec: ToolExecution,
  notes: string[],
  view: FinishView = { mode: 'full', side },
): Promise<{
  file: string
  source: string
  bytes: number
  applied: string
  notes: string[]
  metrics: { canvas: string; focus?: string }
  preview?: Preview
  closeup?: Preview
}> {
  const stamp = String(Date.now())
  const file = `wish-${stamp}.png`
  const source = `wish-${stamp}.psd`
  // Two files, because one cannot do both jobs: the PSD keeps the adjustment
  // layers the recipe built, while only a PNG can be shown in a chat — a PSD
  // has no inline preview, whatever its extension promises.
  const layered = await client.call('doc_save', { path: `${SCRATCH_DIR}/${source}`, format: 'psd' }) as { warnings?: readonly string[] }
  for (const warning of layered.warnings ?? []) notes.push(warning)
  await saveDeliverable(ctx, exec, source, await bridge.download(`${SCRATCH_DIR}/${source}`))
  // Flattening is the whole point of this copy: it exists to be looked at.
  await client.call('doc_save', { path: `${SCRATCH_DIR}/${file}`, format: 'png' })
  const bytes = await bridge.download(`${SCRATCH_DIR}/${file}`)
  await saveDeliverable(ctx, exec, file, bytes)
  const size = pngSize(bytes)
  const wantsFull = view.mode === 'both' || view.mode === 'full'
  const wantsCloseup = (view.mode === 'both' || view.mode === 'focus') && view.focus !== undefined
  let preview: Preview | undefined
  let closeup: Preview | undefined
  if (wantsFull || wantsCloseup) {
    // One render serves both: the closeup needs more pixels than the whole-frame
    // thumbnail, and scaling down locally costs nothing next to a second render.
    const raw = await client.preview(wantsCloseup ? CLOSEUP_SOURCE_SIDE : view.side)
    if (wantsFull) {
      preview = await keep(ctx, wantsCloseup ? fitPng(raw, view.side) : raw, `wish-${stamp}-preview.png`)
    }
    if (wantsCloseup) {
      const box = view.focus as PngFraction
      closeup = await keep(ctx, guidesPng(fitPng(cropPng(raw, box), CLOSEUP_SIDE)), `wish-${stamp}-closeup.png`)
    }
  }
  const focusText = view.focus === undefined || size === undefined
    ? undefined
    : `${String(Math.round(view.focus.x * size.width))},${String(Math.round(view.focus.y * size.height))} `
      + `${String(Math.round(view.focus.w * size.width))}×${String(Math.round(view.focus.h * size.height))}px`
  return {
    file,
    source,
    bytes: bytes.length,
    applied: `${verb}: ${applied}`,
    notes,
    metrics: {
      canvas: size === undefined ? '' : `${String(size.width)}×${String(size.height)}`,
      ...focusText === undefined ? {} : { focus: focusText },
    },
    ...preview === undefined ? {} : { preview },
    ...closeup === undefined ? {} : { closeup },
  }
}

/**
 * Register the two PhotoCraft tools.
 * @param ctx - context carrying tools and the attachment store.
 * @param runtime - capability clients and the preview budget.
 */
/**
 * The engine's session tools, as opposed to its 918 drawing commands.
 *
 * A workflow mixes both — open the file, draw, export — so a step list is walked
 * in order and only the drawing commands are batched.
 */
const SESSION_TOOLS = new Set([
  'command_batch',
  'command_list',
  'command_run',
  'control_call',
  'doc_close',
  'doc_export',
  'doc_export_data_sets',
  'doc_export_layers',
  'doc_import_data_sets',
  'doc_inspect',
  'doc_new',
  'doc_open',
  'doc_place',
  'doc_render_preview',
  'doc_save',
  'doc_select',
  'jobs_cancel',
  'jobs_list',
  'render_preview',
  'session_list',
  'ui_inspect',
  'ui_menu_invoke',
  'ui_pointer',
  'ui_screenshot',
  'ui_set',
])

export function registerPhotocraftTools(ctx: Context, runtime: PhotocraftToolsRuntime): void {
  const { mcp, bridge, previewSide } = runtime
  // The engine's 918 commands, indexed once and searched locally.
  const index = new CommandIndex(mcp)

  // The capability as the engine publishes it: 918 commands, searched rather
  // than pre-selected. A recipe is a shortcut through this, never a fence.
  ctx.tools.register(defineTool({
    name: 'photocraft_search',
    description: 'Search all 918 engine commands by what the user wants done, in Chinese or English. Returns each match with its full parameter list and menu path. Use it for anything beyond a plain grade or cutout — local edits, colour ranges, masks, paths, type, actions, batch — instead of assuming the engine cannot do it.',
    parameters: {
      query: { type: 'string', required: true, description: '想做的事：用户原话或英文关键词，例如「只把天空调蓝」「按颜色选区域」「加暗角」' },
      limit: { type: 'number', description: '返回条数 1..20，默认 8' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                params: { type: 'string', required: true },
                menu: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.matches.length === 0
          ? `没有匹配（共 ${String(value.total)} 条命令，换个说法再搜）`
          : value.matches.map(m => `\`${m.id}\` ${m.label}${m.menu === '' ? '' : ` · ${m.menu}`}\n    ${m.params}`).join('\n'),
      }],
    },
    async execute(args) {
      const limit = Math.min(20, Math.max(1, Math.round(args.limit ?? 8)))
      const matches = await index.search(args.query, limit)
      return {
        total: (await index.all()).length,
        matches: matches.map(spec => ({
          id: spec.id,
          label: spec.label,
          params: spec.params,
          menu: spec.menu.slice(1).join(' › '),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'photocraft_describe',
    description: 'Show one command\'s parameters, menu path, and whether it can run right now — with the reason when it cannot. Call it when a command failed, when a parameter is unclear, or before a multi-step edit.',
    parameters: {
      id: { type: 'string', required: true, description: '命令 id，例如 select.colorRange' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          label: { type: 'string', required: true },
          params: { type: 'string', required: true },
          menu: { type: 'string', required: true },
          blocked: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `\`${value.id}\` ${value.label}${value.menu === '' ? '' : ` · ${value.menu}`}\n    ${value.params}${value.blocked === undefined ? '' : `\n    当前不可用：${value.blocked}`}`,
      }],
    },
    async execute(args) {
      const doc = await index.describe(args.id)
      const menu = doc.menu.slice(1).join(' › ')
      return doc.blocked === undefined
        ? { id: doc.id, label: doc.label, params: doc.params, menu }
        : { id: doc.id, label: doc.label, params: doc.params, menu, blocked: doc.blocked }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'photocraft_run',
    description: 'Run engine commands on the open document. Pass `steps` to run a whole workflow in one call — doc_open, then the drawing commands, then doc_export — or `id` + `params` for a single command. Session tools (doc_open, doc_save, doc_export, doc_inspect, doc_new, doc_close) are not drawing commands: `doc_open` takes `{ path }` — a workspace file name or a `sha256:<hex>` attachment id, never an arbitrary local path — and the engine only opens documents it manages. A document session expires on idle and on restart, and a reopened document loses its edit history, so run one workflow per call instead of chaining edits across calls. Parameters are checked against the engine\'s own declaration first, so a misspelt field is refused instead of silently ignored.',
    parameters: {
      id: { type: 'string', description: '单条 id：绘图命令（来自 photocraft_search）或会话工具 doc_open / doc_save / doc_export。要连续操作同一个文档就用 steps，一个工作流一次跑完。用 steps 时不要传' },
      params: {
        type: 'object',
        additionalProperties: true,
        description: '该命令的参数对象，形状见 photocraft_describe 返回的 params',
      },
      steps: {
        type: 'array',
        description: '整个工作流：按顺序执行的 {id, params} 列表。会话工具（doc_open、doc_save、doc_export、doc_inspect）和绘图命令可以混在一起，一次调用跑完。doc_open 的参数是 {path}：工作区文件名或 sha256:<hex> 附件 id，不是任意本地路径；doc_export 不给 path 就直接写进工作区并交付。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            params: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          result: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `\`${value.id}\` → ${value.result}` }],
    },
    async execute(args, exec) {
      const steps = args.steps as readonly { id?: unknown; params?: unknown }[] | undefined
      const cwd = await ctx.workingDirectory.ensure(agentOf(exec), exec.signal)
      // One session tool behaves the same whether it arrives inside `steps` or
      // as the tool's single `id`: `doc_open` must place the picture inside the
      // engine's volume, and an export must come back as a deliverable.
      const runSessionStep = async (id: string, params: Record<string, unknown>): Promise<string> => {
        // An export step is the delivery point of the workflow, and its `path`
        // names where the reader wants the file — never a path inside the
        // engine's volume, which the workspace reader cannot see. Every export
        // therefore lands in scratch first and is downloaded back here, so the
        // file the caller asked for is the file that exists.
        if (id === 'doc_export' || id === 'doc_save') {
          const requested = typeof params.path === 'string' ? params.path.trim() : ''
          const name = deliveredNameOf(requested, String(params.format ?? ''))
          const format = extname(name).slice(1).toLowerCase() || 'png'
          await ensureScratch(bridge)
          const scratch = `wish-${String(Date.now())}.${format === 'jpeg' ? 'jpg' : format}`
          await mcp.call('doc_save', { path: `${SCRATCH_DIR}/${scratch}`, format: format === 'jpeg' ? 'jpg' : format })
          const bytes = await bridge.download(`${SCRATCH_DIR}/${scratch}`)
          return `已交付 ${await saveDeliverable(ctx, exec, name, bytes)}`
        }
        // A local picture has to reach the engine's own volume first; the
        // engine refuses absolute paths outside its automation root.
        const call = id === 'doc_open' && typeof params.path === 'string'
          ? { ...params, path: await importSource(bridge, params.path, cwd) }
          : params
        try {
          await mcp.call(id, call)
        } catch (error) {
          // The engine's NotFound names only the missing path, which sends a
          // caller guessing; name the pictures that are actually here instead.
          const text = error instanceof Error ? error.message : String(error)
          if (id !== 'doc_open' || !/NotFound|No such file/iu.test(text)) throw error
          const available = await recentPictures(cwd)
          throw new Error(available.length === 0 ? text : `${text}；工作区最近的图片：${available.join('、')}`)
        }
        return id
      }
      if (Array.isArray(steps) && steps.length > 0) {
        const report: string[] = []
        let batch: { id: string; params: Record<string, unknown> }[] = []
        const flush = async (): Promise<void> => {
          if (batch.length === 0) return
          const outcome = await mcp.call('command_batch', { steps: batch }) as { completed?: unknown; failed?: unknown }
          report.push(`命令 ${String(batch.length)} 条：完成 ${String(outcome.completed ?? '?')}，失败 ${String(outcome.failed ?? '?')}`)
          batch = []
        }
        for (const step of steps) {
          const id = String(step.id ?? '')
          if (id === '') throw new Error('photocraft: every step needs an `id`')
          const params = (step.params ?? {}) as Record<string, unknown>
          if (SESSION_TOOLS.has(id)) {
            await flush()
            report.push(await runSessionStep(id, params))
            continue
          }
          const { problems } = await index.check(id, params)
          if (problems.length > 0) throw new Error(`photocraft: ${problems.join('; ')}`)
          batch.push({ id, params })
        }
        await flush()
        return { id: `${String(steps.length)} 步`, result: report.join('；') }
      }
      const id = args.id
      if (typeof id !== 'string' || id === '') throw new Error('photocraft: 传 `steps` 跑工作流，或传 `id` 跑单条命令')
      const params = (args.params ?? {}) as Record<string, unknown>
      // A session tool named as the single `id` used to fall through to the
      // drawing-command path, where the engine answers "unknown command".
      if (SESSION_TOOLS.has(id)) return { id, result: await runSessionStep(id, params) }
      const { problems } = await index.check(id, params)
      if (problems.length > 0) throw new Error(`photocraft: ${problems.join('; ')}`)
      const result = await mcp.run(id, params)
      return { id, result: JSON.stringify(result ?? null).slice(0, 1200) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'photocraft_inspect',
    description: 'Read the open document: size, depth, the layer tree with kinds and visibility, the current selection, the active layer and history. Call it before a command whose effect depends on what is selected, and after one to confirm it changed something.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.state }],
    },
    async execute() {
      const state = await mcp.call('doc_inspect')
      return { state: JSON.stringify(state ?? null).slice(0, 2400) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'photocraft_edit',
    description: 'Change a photo and get the result back as an image. Decide what pixel result the user wants and say it in `intent`, pass the instruction in the user\'s words, any adjustment the user named (strength, shift, margin, previewSide…), each box the user drew as fractions of the image, and any material picture as `assets`. With a box, a material replaces what the box covers; without one it goes behind the subject. Handles grading, cutouts, watermark/object removal, quality repair, and poster titles in one call.',
    parameters: {
      instruction: { type: 'string', required: true, description: '用户的要求，原话即可，例如「把这块水印去掉」' },
      intent: {
        type: 'string',
        enum: ['film', 'cutout', 'remove', 'enhance', 'poster', 'composite', 'brush', 'retouch', 'fill', 'transform', 'gray', 'text'],
        description: [
          '意图卡——由你判断用户想要的像素结果后选择：',
          'film 整图调色风格；cutout 把主体从背景抠出/换底色；remove 让某块东西消失（水印/路人/字迹/魔术橡皮擦）；',
          'enhance 降噪锐化修画质；poster 海报排版；composite 把另一张图贴进来；',
          'brush 画笔/橡皮擦涂画；retouch 修图笔刷（tool 选：dodge 加深 burn 减淡 sponge 海绵 blur 涂糊 sharpen 锐化涂抹 smudge clone 仿制图章 spotHeal 污点修复 heal 修复画笔 patch 修补）；',
          'fill 填充（tool 选 bucket 油漆桶 / gradient 渐变）；transform 几何（action 选 crop/rotate/flipH/flipV/trim/resize）；gray 转黑白；text 加一段文字。',
          '留空时仅在提供了 assets/text/look 的场景自动判定，否则拒绝',
        ].join(''),
      },
      source: { type: 'string', description: '要改的图：聊天附件的绝对路径，或工作区里的文件名。省略表示接着改最近一次交付的 wish-*.png（用户在这张上继续提要求时就这样）' },
      assets: {
        type: 'array',
        description: '用户额外提供的图（素材/背景/天空）。有红框时按序号填进红框（第 i 个框用第 i 张，不够就用第一张）；没有框时贴到主体后面',
        items: { type: 'string' },
      },
      text: { type: 'string', description: '海报上要写的字；做海报时必须给' },
      subline: { type: 'string', description: '海报副标题；不写就不加' },
      look: { type: 'string', enum: ['cool', 'warm', 'bleach'], description: '调色风格：cool 冷调（默认）、warm 暖调、bleach 漂白' },
      strength: { type: 'number', description: '调色力度 1..100，默认 50；25 轻、75 明显、100 满量程' },
      vignette: { type: 'number', description: '暗角 0..100，默认 30；0 表示不要暗角' },
      grain: { type: 'number', description: '颗粒 0..100，默认 0' },
      shift: { type: 'number', description: '抠图/合成的收边 -100..100，默认 -25；主体边缘带一圈原背景时调小' },
      soften: { type: 'number', description: '抠图边缘平滑 0..100，默认 20' },
      margin: { type: 'number', description: '去水印/去杂物向外扩的余量 0..0.1，默认 0.01' },
      denoise: { type: 'number', description: '降噪 0..10，默认 4' },
      sharpen: { type: 'number', description: '锐化 1..500（unsharpMask.amount），默认 50' },
      autoColor: { type: 'boolean', description: '自动校正偏色（会改写白平衡）；仅当用户抱怨发黄/发蓝/偏色时给 true，默认不做' },
      background: { type: 'string', description: '换底目标色 #rrggbb；用户要换底色时由你把颜色翻译成色值，留空表示只要透明底' },
      tool: { type: 'string', description: 'retouch/fill 卡内部的具体工具，取值见 intent 描述' },
      action: { type: 'string', description: 'transform 卡的具体动作：crop | rotate | flipH | flipV | trim | resize' },
      x: { type: 'number', description: 'fill=bucket 的落点 x，0..1 比例' },
      y: { type: 'number', description: 'fill=bucket 的落点 y，0..1 比例' },
      color: { type: 'string', description: '#rrggbb：画笔/填充/文字的颜色，由你把用户说的颜色翻译成色值' },
      size: { type: 'number', description: '笔刷直径 px；用户没说就别传' },
      opacity: { type: 'number', description: '1..100，画笔/填充的不透明度；用户没说就别传' },
      erase: { type: 'boolean', description: 'brush 卡：true 表示橡皮擦' },
      from: { type: 'array', description: '仿制图章取样点 [x, y] 或渐变起点，0..1 比例', items: { type: 'number' } },
      to: { type: 'array', description: '渐变终点 [x, y]，0..1 比例', items: { type: 'number' } },
      angle: { type: 'number', description: 'transform=rotate 的角度，度，顺时针为正' },
      width: { type: 'number', description: 'transform=resize 的目标宽 px，高按比例跟随' },
      previewSide: { type: 'number', description: '整图预览的长边 64..2048，默认取插件配置；反复迭代时给 448' },
      preview: {
        type: 'string',
        enum: ['both', 'full', 'focus', 'off'],
        description: [
          '返回哪些图，默认 both：',
          'both 整图缩略 + 改动局部放大（带十字网格，用来判断细节有没有改对；整图用来看色偏、接缝、遮挡）；',
          'full 只给整图（整图类改动：调色、翻转、整图擦除）；',
          'focus 只给局部放大（连续微调同一块时最省）；',
          'off 不给图，只看数值。',
        ].join(''),
      },
      feather: { type: 'number', description: '红框裁下来的边缘羽化像素，默认取碎片短边的 2%（至少 1px）；0 表示硬边' },
      regions: {
        type: 'array',
        description: '红框：用户框出的各处位置，按编号顺序，0..1 的比例；同一个动作会对每个框各做一次',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            x: { type: 'number', required: true },
            y: { type: 'number', required: true },
            w: { type: 'number', required: true },
            h: { type: 'number', required: true },
          },
        },
      },
      strokes: {
        type: 'array',
        description: '画笔：用户涂过的轨迹，比框精确。每笔 {points: [[x,y],…] 0..1 比例, size?: 笔宽占短边百分比, mode?: add|subtract}；第一笔建立选区，后续 add/subtract',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            points: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } } },
            size: { type: 'number' },
            mode: { type: 'string', enum: ['add', 'subtract'] },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          source: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          applied: { type: 'string', required: true },
          notes: { type: 'array', items: { type: 'string' } },
          metrics: {
            type: 'object',
            additionalProperties: false,
            properties: {
              canvas: { type: 'string', required: true },
              focus: { type: 'string' },
            },
          },
          preview: previewSchema,
          closeup: previewSchema,
        },
      },
      presentationMeta: (_args, value) => ({ kind: 'photocraft.edit', ...value }),
      render: (_args, value) => [
        // The picture below arrives as an attachment named `…-preview.png`, a
        // name that exists nowhere on disk. A model that copies it into
        // `![](…)` produces a broken image, so the text names the real file and
        // spells out the markdown that actually resolves.
        {
          type: 'text',
          text: `已按「${value.applied}」处理：${value.file}（${String(Math.round(value.bytes / 1024))}KB，可直接查看）；可编辑源文件 ${value.source}，图层保留可再调\n`
            + `给用户看成品就写 ![说明](${value.file})：工作区里只有这个文件，预览附件的名字（*-preview.png）只用于你查看，写成图片会加载失败。`,
        },
        ...value.notes === undefined || value.notes.length === 0 ? [] : [{ type: 'text' as const, text: value.notes.join('\n') }],
        // A replayed transcript can predate the metrics; the caption above still
        // stands on its own, so the line is omitted rather than filled with noise.
        ...value.metrics === undefined ? [] : [{
          type: 'text' as const,
          text: `画布 ${value.metrics.canvas}`
            + (value.metrics.focus === undefined ? '' : `；局部窗口 ${value.metrics.focus}（放大 ${String(CLOSEUP_SIDE)} 长边，十字与网格是标尺）`),
        }],
        ...(value.preview === undefined ? [] : [{ type: 'image' as const, attachment: previewRef(value.preview) }]),
        ...(value.closeup === undefined ? [] : [{ type: 'image' as const, attachment: previewRef(value.closeup) }]),
      ],
    },
    async execute(args, exec) {
      await ensureScratch(bridge)
      const cwd = await ctx.workingDirectory.ensure(agentOf(exec), exec.signal)
      // A follow-up edit that names no picture means the one the last round
      // produced: the reply already handed that file over, so asking the user to
      // name it again — or failing outright — is a gap, not a safety check.
      const source = (args.source ?? '').trim() || await latestWish(cwd)
      if (source === undefined) {
        throw new Error('photocraft: 需要一张图（聊天附件路径、工作区文件名，或先让上一轮生成一张）')
      }
      // Materials are attachments as well, so they take the same upload bridge:
      // the engine only opens files that live in its own workspace.
      const assets: string[] = []
      for (const asset of args.assets ?? []) assets.push(await importSource(bridge, asset, cwd))
      const regions = args.regions ?? []
      const side = previewSideOf(args.previewSide, previewSide)
      const main = await importSource(bridge, source, cwd)

      // A red box plus a material is a replacement: the material goes into the
      // box, paired by number, on the picture the box was drawn on. Without a
      // box, a material is a background swap instead.
      const [fallback] = assets
      if (regions.length > 0 && fallback !== undefined) {
        await mcp.open(main)
        const canvas = await mcp.call('doc_inspect', {}) as { width?: number; height?: number }
        const canvasSize = { width: canvas.width ?? 0, height: canvas.height ?? 0 }
        if (canvasSize.width === 0 || canvasSize.height === 0) throw new Error('photocraft: 量不出主图的尺寸')
        const pieces: { file: string; centre: [number, number]; size: { width: number; height: number } }[] = []
        for (const [index, region] of regions.entries()) {
          const box = toPixels(normalizeRegion(region), canvasSize)
          // Boxes pair with materials by number; a caller that supplies one
          // material for several boxes gets it in all of them.
          const opened = await mcp.open(assets[index] ?? fallback)
          pieces.push({
            file: await fitPiece(
              mcp,
              `piece-${String(index)}-${String(Date.now())}.png`,
              box,
              { width: opened.width, height: opened.height },
            ),
            centre: [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)],
            size: { width: box.width, height: box.height },
          })
        }
        await mcp.open(main)
        return await finish(
          ctx, mcp, bridge, side, args.instruction, 'replaced', exec,
          await placeAll(mcp, pieces, args.feather),
        )
      }

      await mcp.open(main)
      const id = recipeFor(args.intent, assets.length > 0, args)
      if (id === 'poster' && (args.text ?? '') === '') throw new Error('photocraft: 做海报需要一句文案（text）')
      const recipe = recipeById(id)
      // A backdrop has to cover the picture: a material smaller than the canvas
      // would leave the corners empty, so it is scaled to the canvas first.
      let backdrop = assets[0]
      if (id === 'composite' && backdrop !== undefined) {
        const canvas = await mcp.call('doc_inspect', {}) as { width?: number; height?: number }
        const canvasSize = { width: canvas.width ?? 0, height: canvas.height ?? 0 }
        if (canvasSize.width > 0 && canvasSize.height > 0) {
          const opened = await mcp.open(backdrop)
          backdrop = await fitPiece(
            mcp,
            `backdrop-${String(Date.now())}.png`,
            canvasSize,
            { width: opened.width, height: opened.height },
          )
          // The recipe edits the picture, and opening the material made it active.
          await mcp.open(main)
        }
      }
      // Every knob the caller may name, in the recipes' own parameter spelling.
      // A recipe reads only what it knows, so an unused one is ignored rather
      // than refused — the wish stays one call.
      const params: Record<string, unknown> = {
        strokes: args.strokes,
        headline: args.text,
        subline: args.subline,
        background: args.background,
        asset: backdrop,
        look: args.look,
        strength: args.strength,
        vignette: args.vignette,
        grain: args.grain,
        shift: args.shift,
        soften: args.soften,
        margin: args.margin,
        denoise: args.denoise,
        sharpen: args.sharpen,
        autoColor: args.autoColor,
        tool: args.tool,
        action: args.action,
        color: args.color,
        size: args.size,
        opacity: args.opacity,
        erase: args.erase,
        from: args.from,
        to: args.to,
        angle: args.angle,
        width: args.width,
        text: args.text,
        x: args.x,
        y: args.y,
      }
      // No red box: the wish applies to the whole picture. With red boxes, the
      // same wish is repeated at each of them, in order.
      const boxes = regions.length === 0 ? [undefined] : regions.map(region => normalizeRegion(region))
      const notes: string[] = []
      for (const region of boxes) {
        const run = await recipe.run(mcp, { ...params, ...region ?? {} }, bridge)
        // The recipes carry the fixes a model gets wrong on its own ("shift 调到
        // -25 再跑一次"); dropping them here is how that knowledge used to die.
        for (const note of run.notes) if (!notes.includes(note)) notes.push(note)
      }
      const mode = (['both', 'full', 'focus', 'off'] as const).find(candidate => candidate === args.preview)
        ?? (regions.length === 0 && args.strokes === undefined ? 'full' : 'both')
      return await finish(ctx, mcp, bridge, side, args.instruction, 'edited', exec, notes, {
        mode,
        side,
        focus: focusWindowOf(args),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'photocraft_export',
    description: 'Write the picture out again, optionally keeping layers as PSD for further editing in a real editor. Use it only when the user asks for a file other than the PNG that photocraft_edit already saved.',
    parameters: {
      format: { type: 'string', description: 'png | jpg | psd，默认 psd（保留图层）' },
      file: { type: 'string', description: '要导出的工作区文件名，默认取当前文档' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已导出 ${value.file}（${String(Math.round(value.bytes / 1024))}KB）`,
      }],
    },
    async execute(args, exec) {
      const format = (args.format ?? 'psd').toLowerCase()
      const name = args.file ?? `wish-${String(Date.now())}.${format === 'jpeg' ? 'jpg' : format}`
      await ensureScratch(bridge)
      await mcp.call('doc_save', { path: `${SCRATCH_DIR}/${name}`, format: format === 'jpeg' ? 'jpg' : format })
      const bytes = await bridge.download(`${SCRATCH_DIR}/${name}`)
      return { file: await saveDeliverable(ctx, exec, name, bytes), bytes: bytes.length }
    },
  }))
}
