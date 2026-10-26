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
import { readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { AlbumClient, McpClient, type FileBridge } from './client.ts'
import { normalizeRegion, toPixels, type Region } from './coords.ts'
import { RECIPES } from './recipes.ts'

/** Everything the tools need to reach the two capabilities. */
export interface PhotocraftToolsRuntime {
  readonly mcp: McpClient
  readonly bridge: FileBridge
  readonly album: AlbumClient
  /** Long edge of the preview handed back with a result. */
  readonly previewSide: number
}

/**
 * Where uploaded chat attachments live. Readable by this process, never writable
 * by the agent's own shell — which is why the bytes are read here.
 */
const ATTACHMENT_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'attachments')

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
 * Pick the recipe an instruction is asking for.
 *
 * Deliberately a keyword table over four fixed recipes: a caller never chooses a
 * recipe, and an unknown wish gets the closest one rather than an error.
 * @param instruction - the user's own words.
 * @returns the recipe id.
 */
function recipeFor(instruction: string, hasAsset: boolean): string {
  const text = instruction.toLowerCase()
  if (hasAsset) return 'composite'
  if (/海报|标题|加字|文案|poster|title/.test(text)) return 'poster'
  if (/水印|杂物|路人|去掉|抹掉|remove/.test(text)) return 'remove'
  if (/抠|换底|白底|背景|证件照|cutout/.test(text)) return 'cutout'
  if (/模糊|噪点|清晰|锐化|偏色|画质|enhance/.test(text)) return 'enhance'
  return 'film'
}

/**
 * Read a background colour out of the instruction, when one is named.
 *
 * "换成浅蓝底" has to reach the engine as a colour; asking the caller for a hex
 * value would push our vocabulary back onto it.
 * @param instruction - the user's own words.
 * @returns a `#rrggbb` value, or `undefined` when no colour was named.
 */
function backgroundOf(instruction: string): string | undefined {
  const explicit = /#([0-9a-f]{6})\b/iu.exec(instruction)
  if (explicit !== null) return `#${explicit[1]}`
  if (/浅?蓝|blue/iu.test(instruction)) return '#438edb'
  if (/白|white/iu.test(instruction)) return '#ffffff'
  if (/红|red/iu.test(instruction)) return '#e2445c'
  if (/灰|gray|grey/iu.test(instruction)) return '#cccccc'
  if (/黑|black/iu.test(instruction)) return '#111111'
  return undefined
}


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
  const digest = /^sha256:([0-9a-f]{64})$/u.exec(source)
  if (digest !== null) {
    const hex = digest[1] ?? ''
    return join(ATTACHMENT_ROOT, 'v1', 'objects', hex.slice(0, 2), hex)
  }
  return source.startsWith('/') ? resolve(source) : undefined
}

/**
 * Bring a source into the engine's workspace.
 * @param bridge - file bridge of the capability.
 * @param source - attachment id, absolute path, or workspace file name.
 * @returns the workspace file name to open.
 */
async function importSource(bridge: FileBridge, source: string): Promise<string> {
  const absolute = localFileOf(source)
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
  await bridge.upload(name, await readFile(absolute))
  return name
}

/**
 * Cut one rectangle out of the opened picture into its own transparent file.
 * @param client - MCP client with a document open.
 * @param name - output file name.
 * @param region - fractions of the picture.
 * @param file - name of the file to save.
 * @returns the file name holding the piece.
 */
async function cutPiece(
  client: McpClient,
  name: string,
  region: Region,
  file: string,
): Promise<{ file: string; width: number; height: number }> {
  const document = await client.call('doc_inspect', {}) as { width?: number; height?: number }
  const box = toPixels(region, { width: document.width ?? 0, height: document.height ?? 0 })
  await client.run('select.rect', { ...box })
  await client.run('select.modify.feather', { radius: 2 })
  await client.run('edit.copy', {})
  // A fresh transparent canvas keeps the piece free of its old neighbours.
  await client.call('doc_new', { width: box.width, height: box.height, background: 'transparent' })
  await client.run('edit.paste', { center: [box.width / 2, box.height / 2] })
  await client.call('doc_save', { path: file, format: 'png' })
  void name
  return { file, width: box.width, height: box.height }
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
async function saveDeliverable(ctx: Context, exec: ToolExecution, name: string, bytes: Buffer): Promise<string> {
  const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  await writeFile(join(cwd, name), bytes)
  return name
}

async function finish(
  ctx: Context,
  client: McpClient,
  bridge: FileBridge,
  side: number,
  applied: string,
  verb: string,
  exec: ToolExecution,
): Promise<{ file: string; bytes: number; applied: string; preview: Preview }> {
  const file = `wish-${String(Date.now())}.png`
  await client.call('doc_save', { path: file, format: 'png' })
  const bytes = await bridge.download(file)
  await saveDeliverable(ctx, exec, file, bytes)
  return {
    file,
    bytes: bytes.length,
    applied: `${verb}: ${applied}`,
    preview: await keep(ctx, await client.preview(side), `${file}-preview.png`),
  }
}

/**
 * Register the two PhotoCraft tools.
 * @param ctx - context carrying tools and the attachment store.
 * @param runtime - capability clients and the preview budget.
 */
export function registerPhotocraftTools(ctx: Context, runtime: PhotocraftToolsRuntime): void {
  const { mcp, bridge, previewSide } = runtime

  ctx.tools.register(defineTool({
    name: 'photocraft_edit',
    description: 'Change a photo and get the result back as an image. Pass the instruction in the user\'s words and, when the user drew a box, that box as fractions of the image. Handles grading, cutouts, watermark/object removal, and quality repair in one call.',
    parameters: {
      instruction: { type: 'string', required: true, description: '用户的要求，原话即可，例如「把这块水印去掉」' },
      source: { type: 'string', description: '要改的图：聊天附件的绝对路径，或工作区里的文件名' },
      assets: {
        type: 'array',
        description: '用户额外提供的图（背景/天空/素材），按顺序贴上；给了就走合成',
        items: { type: 'string' },
      },
      text: { type: 'string', description: '海报上要写的字；做海报时必须给' },
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
      places: {
        type: 'array',
        description: '绿框：结果落点，按序号与 regions 一一对应；只有和红框一起用才有效',
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          applied: { type: 'string', required: true },
          preview: previewSchema,
        },
      },
      presentationMeta: (_args, value) => ({ kind: 'photocraft.edit', ...value }),
      render: (_args, value) => [
        { type: 'text', text: `已按「${value.applied}」处理，结果 ${value.file}（${String(Math.round(value.bytes / 1024))}KB）` },
        ...(value.preview === undefined ? [] : [{ type: 'image' as const, attachment: previewRef(value.preview) }]),
      ],
    },
    async execute(args, exec) {
      const source = (args.source ?? '').trim()
      if (source === '') throw new Error('photocraft: 需要一张图（聊天附件路径或工作区文件名）')
      // Materials are attachments as well, so they take the same upload bridge:
      // the engine only opens files that live in its own workspace.
      const assets: string[] = []
      for (const asset of args.assets ?? []) assets.push(await importSource(bridge, asset))
      const regions = args.regions ?? []
      const places = args.places ?? []
      const main = await importSource(bridge, source)

      // Green boxes present: cut each paired red box out and drop it on the
      // material. One loop, no per-region special cases.
      if (places.length > 0) {
        const [target] = assets
        if (target === undefined) throw new Error('photocraft: 有绿框但没有素材图')
        const pieces: { file: string; width: number; height: number }[] = []
        for (const [index, region] of regions.entries()) {
          if (index >= places.length) break
          // Each piece starts from the untouched source: cutting one piece
          // replaces the active document, so the next one reopens it.
          await mcp.open(main)
          pieces.push(await cutPiece(mcp, main, normalizeRegion(region), `piece-${String(index)}-${String(Date.now())}.png`))
        }
        if (pieces.length === 0) throw new Error('photocraft: 绿框需要配一个红框')
        await mcp.open(target)
        const canvas = await mcp.call('doc_inspect', {}) as { width?: number; height?: number }
        for (const [index, piece] of pieces.entries()) {
          const place = normalizeRegion(places[index] as Region)
          // The green box decides the size on the canvas, so the scale is the
          // ratio between that width and the piece's own pixels — not the box
          // width itself.
          const targetWidth = place.w * (canvas.width ?? 0)
          const scale = piece.width === 0 ? 100 : Number(((targetWidth / piece.width) * 100).toFixed(2))
          await mcp.call('doc_place', {
            path: piece.file,
            center: [
              Math.round((place.x + place.w / 2) * (canvas.width ?? 0)),
              Math.round((place.y + place.h / 2) * (canvas.height ?? 0)),
            ],
            scale,
          })
        }
        return await finish(ctx, mcp, bridge, previewSide, args.instruction, 'placed', exec)
      }

      await mcp.open(main)
      const id = recipeFor(args.instruction, assets.length > 0)
      if (id === 'poster' && (args.text ?? '') === '') throw new Error('photocraft: 做海报需要一句文案（text）')
      const recipe = RECIPES.find(candidate => candidate.id === id)
      if (recipe === undefined) throw new Error(`photocraft: 缺少配方 ${id}`)
      const background = id === 'cutout' ? backgroundOf(args.instruction) : undefined
      const base: Record<string, unknown> = {
        ...background === undefined ? {} : { background },
        ...assets.length === 0 || assets[0] === undefined ? {} : { asset: assets[0] },
        ...args.text === undefined ? {} : { headline: args.text },
      }
      // No red box: the wish applies to the whole picture. With red boxes, the
      // same wish is repeated at each of them, in order.
      const boxes = regions.length === 0 ? [undefined] : regions.map(region => normalizeRegion(region))
      for (const region of boxes) await recipe.run(mcp, { ...base, ...region ?? {} }, bridge)
      return await finish(ctx, mcp, bridge, previewSide, args.instruction, 'edited', exec)
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
      await mcp.call('doc_save', { path: name, format: format === 'jpeg' ? 'jpg' : format })
      const bytes = await bridge.download(name)
      return { file: await saveDeliverable(ctx, exec, name, bytes), bytes: bytes.length }
    },
  }))
}
