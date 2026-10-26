/**
 * Two tools: change a photo, or write it out.
 *
 * The engine's own vocabulary (documents, sessions, previews, command ids) stays
 * inside this file. A caller says what it wants and gets the finished picture
 * back as an image, which is the whole product.
 *
 * @module @deepseek-ai/dsh-skill-photocraft/tools
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AlbumClient, McpClient, type FileBridge } from './client.ts'
import { normalizeRegion } from './coords.ts'
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
      place: {
        type: 'object',
        description: '绿框：结果要落到的位置和大小，0..1 的比例；只有和红框一起用时才有效',
        additionalProperties: false,
        properties: {
          x: { type: 'number', required: true },
          y: { type: 'number', required: true },
          w: { type: 'number', required: true },
          h: { type: 'number', required: true },
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
    async execute(args) {
      const source = (args.source ?? '').trim()
      if (source === '') throw new Error('photocraft: 需要一张图（聊天附件路径或工作区文件名）')

      // One branch: an absolute path is a chat attachment, whose bytes this
      // process may read but the agent's shell may not write.
      let target = source
      if (source.startsWith('/')) {
        const absolute = resolve(source)
        if (!absolute.startsWith(`${resolve(ATTACHMENT_ROOT)}/`)) {
          throw new Error(`photocraft: 只能导入附件目录里的图片（${ATTACHMENT_ROOT}）`)
        }
        target = `wish-${String(Date.now())}.png`
        await bridge.upload(target, await readFile(absolute))
      }

      await mcp.open(target)
      // Recipes take fractions; the engine conversion happens there, once.
      const assets = args.assets ?? []
      const id = recipeFor(args.instruction, assets.length > 0)
      if (id === 'poster' && (args.text ?? '') === '') {
        throw new Error('photocraft: 做海报需要一句文案（text）')
      }
      const background = id === 'cutout' ? backgroundOf(args.instruction) : undefined
      const params: Record<string, unknown> = {
        ...args.region === undefined ? {} : normalizeRegion(args.region),
        ...background === undefined ? {} : { background },
        ...assets.length === 0 ? {} : { asset: assets[0] },
        ...args.text === undefined ? {} : { headline: args.text },
      }

      const recipe = RECIPES.find(candidate => candidate.id === id)
      if (recipe === undefined) throw new Error(`photocraft: 缺少配方 ${id}`)
      await recipe.run(mcp, params, bridge)

      const name = `wish-${String(Date.now())}.png`
      await mcp.call('doc_save', { path: name, format: 'png' })
      const bytes = await bridge.download(name)
      return {
        file: name,
        bytes: bytes.length,
        applied: args.instruction,
        preview: await keep(ctx, await mcp.preview(previewSide), `${name}-preview.png`),
      }
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
    async execute(args) {
      const format = (args.format ?? 'psd').toLowerCase()
      const name = args.file ?? `wish-${String(Date.now())}.${format === 'jpeg' ? 'jpg' : format}`
      await mcp.call('doc_save', { path: name, format: format === 'jpeg' ? 'jpg' : format })
      const bytes = await bridge.download(name)
      return { file: name, bytes: bytes.length }
    },
  }))
}
