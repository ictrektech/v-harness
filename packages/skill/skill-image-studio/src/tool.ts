/**
 * Model-facing Image Studio entry: confirm the parameters in one form dialog,
 * then run the packaged CLI with the values the human accepted.
 */

import { readFile } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type ImageAttachmentRef, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-shell'
import {
  buildFormFields, generateArguments, readConfirmed, withoutFormIntent, type CatalogEntry,
} from './params.ts'

/** Resolved Image Studio endpoints and executables the CLI needs on every call. */
export interface ImageStudioToolRuntime {
  readonly node: string
  readonly cli: string
  readonly baseUrl: string
  readonly authFile: string
  readonly requestTimeoutMs: number
}

/** How long the tool waits for a queued job, matching the skill's documented ceiling. */
const GENERATE_TIMEOUT_MS = 2_000_000
const CATALOG_TIMEOUT_MS = 30_000

/**
 * Whether a questions-service rejection is the intent validation refusing the batch.
 *
 * Runtimes released before the form intent existed validate every intent as a
 * plan review, which rejects a form before any surface can open it. The wire
 * preserves `code`, so the failure is recognisable without matching prose.
 * @param error - the rejection from `ctx.userQuestions.ask`.
 * @returns true when the request carried an intent this runtime cannot honour.
 */
function isBadIntent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'BAD_INTENT'
}

/**
 * Quote one argv entry for the mounted shell.
 * @param value - raw path or value.
 * @returns The entry as a single shell word.
 */
function quote(value: string): string {
  if (process.platform === 'win32') return `'${value.replaceAll("'", "''")}'`
  // POSIX: close the quote, escape the apostrophe, reopen it.
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Run one CLI invocation and parse its JSON stdout.
 * @param ctx - context carrying the shell executor.
 * @param runtime - resolved executables and endpoint.
 * @param args - CLI arguments after the connection flags.
 * @param timeoutMs - deadline for this invocation.
 * @param signal - cancellation lifetime of the tool call.
 * @returns The parsed stdout value.
 * @throws when the CLI exits non-zero, times out, or prints no JSON.
 */
async function runJson(
  ctx: Context,
  runtime: ImageStudioToolRuntime,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const command = [
    runtime.node, runtime.cli,
    '--base-url', runtime.baseUrl,
    '--auth-file', runtime.authFile,
    ...args,
  ].map(quote).join(' ')
  const spec = ctx.shell.resolve({ command, timeoutMs, ...(signal === undefined ? {} : { signal }) })
  const execution = await ctx.shell.execute(spec)
  const result = await execution.result()
  if (result.timedOut) throw new Error(`image-studio did not finish within ${String(timeoutMs)} ms`)
  if (result.aborted) throw new Error('image-studio was cancelled')
  if (result.exitCode !== 0) {
    const detail = result.stderr.text.trim()
    // The service calibrates a ceiling per model and GPU; say which field was
    // over it instead of handing the user a raw 422.
    const overLimit = /exceeds calibrated model limit: (\w+)/u.exec(detail)
    if (overLimit !== null) {
      throw new Error(`该模型的校准上限低于这次提交的 ${overLimit[1]}：把该字段留空用服务默认，或调小后重试`)
    }
    throw new Error(`image-studio exited ${String(result.exitCode)}${detail === '' ? '' : `: ${detail.slice(-500)}`}`)
  }
  const text = result.stdout.text.trim()
  if (text === '') throw new Error('image-studio printed no output')
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    // The CLI owns its own JSON contract; a non-JSON body is a broken build, not a model error.
    throw new Error('image-studio printed output that is not JSON', { cause: error })
  }
}

/** Generate tool output, exactly as the CLI reports the finished job. */
interface GenerateOutput {
  job_id: string
  status: string
  seed: number
  directory: string
  files: { path: string; filename: string; bytes: number }[]
  /** Generated pictures as durable attachments; the chat shows them directly. */
  images: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name: string
  }[]
}

/** Image extensions the answer carries as picture attachments. */
const IMAGE_MEDIA: Readonly<Record<string, 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * Save every generated picture as a durable attachment, so the tool result
 * itself carries the picture and the chat displays it — no card, no markdown
 * path, nothing the model can get wrong.
 * @param ctx - context owning the attachment store.
 * @param files - the job's downloaded files.
 * @returns one ref per picture that saved; failures skip that picture only.
 */
async function savePictures(
  ctx: Context,
  files: readonly { path: string; filename: string; bytes: number }[],
): Promise<GenerateOutput['images']> {
  const inputs: (SaveImageAttachment & { name: string })[] = []
  for (const file of files) {
    const mediaType = IMAGE_MEDIA[file.filename.split('.').pop()?.toLowerCase() ?? '']
    if (mediaType === undefined) continue
    try {
      inputs.push({ data: await readFile(file.path), mediaType, name: file.filename })
    } catch {
      // An unreadable download still has the card; skip the attachment only.
    }
  }
  if (inputs.length === 0) return []
  try {
    const refs = await ctx.attachments.saveImages(inputs)
    return refs.map((ref: ImageAttachmentRef, index: number) => ({
      attachmentId: String(ref.attachmentId),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      name: inputs[index]?.name ?? '',
    }))
  } catch {
    // The job itself succeeded; a refused attachment must not fail it.
    return []
  }
}

/**
 * Register the parameter-confirming generation tool.
 * @param ctx - context carrying tools, user questions, and the shell executor.
 * @param runtime - resolved executables and endpoint.
 */
export function registerImageStudioTool(ctx: Context, runtime: ImageStudioToolRuntime): void {
  ctx.tools.register(defineTool({
    name: 'image_studio_generate',
    description: 'Generate or edit an image with the local Image Studio service. Call it when the user asks for an image or a picture edit: it opens a parameter form the user confirms, then renders with the accepted values and returns the downloaded files.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Starting positive prompt; the user may edit it in the form.' },
      model_key: { type: 'string', description: 'Starting model; the user picks from the ready text-to-image models in the form.' },
      negative_prompt: { type: 'string', description: 'Starting negative prompt.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          job_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          seed: { type: 'number', required: true },
          directory: { type: 'string', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                filename: { type: 'string', required: true },
                bytes: { type: 'number', required: true },
              },
            },
          },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                bytes: { type: 'number', required: true },
                width: { type: 'number', required: true },
                height: { type: 'number', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
        },
      },
      presentationMeta: (_args, value) => ({ kind: 'image.studio', ...value }),
      render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value) },
        ...(value.images ?? []).map(image => ({
          type: 'image' as const,
          attachment: {
            attachmentId: AttachmentId(image.attachmentId),
            mediaType: image.mediaType as ImageAttachmentRef['mediaType'],
            bytes: image.bytes,
            width: image.width,
            height: image.height,
          },
        })),
      ],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('image_studio_generate needs an agent to confirm parameters with')
      const catalog = await runJson(ctx, runtime, ['models', '--ready'], CATALOG_TIMEOUT_MS, exec.signal) as { models?: CatalogEntry[] }
      const models = (catalog.models ?? []).filter(model => (model.capabilities ?? []).includes('txt2img'))
      if (models.length === 0) {
        throw new Error('no ready text-to-image model: run `models --ready`, then `pull <key>` for a text-to-image one')
      }
      const fields = buildFormFields(args, models)
      let answers: AskUserQuestionAnswer
      try {
        answers = await ctx.userQuestions.ask({ questions: fields, agent: exec.agent, signal: exec.signal })
      } catch (error) {
        if (!isBadIntent(error)) throw error
        // The dialog stays available on a runtime that predates the form intent:
        // the fields alone are what the form presentation reads.
        answers = await ctx.userQuestions.ask({
          questions: withoutFormIntent(fields),
          agent: exec.agent,
          signal: exec.signal,
        })
      }
      const flags = ['generate', ...generateArguments(readConfirmed(answers, models))]
      // A model whose calibrated ceiling sits below the service's own defaults
      // rejects a parameterless job; step down to the smallest legal size once
      // instead of handing the user a 422 on the confirmation they just made.
      const fallback = ['--width', '256', '--height', '256', '--steps', '1']
      let job: unknown
      try {
        job = await runJson(ctx, runtime, flags, GENERATE_TIMEOUT_MS, exec.signal)
      } catch (error) {
        if (!/calibrated model limit|校准上限/u.test(String(error))) throw error
        job = await runJson(ctx, runtime, [...flags, ...fallback], GENERATE_TIMEOUT_MS, exec.signal)
      }
      const jobValue = job as {
        job_id?: string
        status?: string
        seed?: number
        directory?: string
        files?: { path: string; filename: string; bytes: number }[]
      }
      const files = (jobValue.files ?? []).map(file => ({ path: file.path, filename: file.filename, bytes: file.bytes }))
      return {
        job_id: jobValue.job_id ?? '',
        status: jobValue.status ?? 'unknown',
        seed: jobValue.seed ?? -1,
        directory: jobValue.directory ?? '',
        files,
        images: await savePictures(ctx, files),
      } satisfies GenerateOutput
    },
  }))
}
