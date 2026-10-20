/**
 * Model-facing Image Studio entry: confirm the parameters in one form dialog,
 * then run the packaged CLI with the values the human accepted.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-shell'
import { buildFormFields, generateArguments, readConfirmed, type CatalogEntry } from './params.ts'

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
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('image_studio_generate needs an agent to confirm parameters with')
      const catalog = await runJson(ctx, runtime, ['models', '--ready'], CATALOG_TIMEOUT_MS, exec.signal) as { models?: CatalogEntry[] }
      const models = (catalog.models ?? []).filter(model => (model.capabilities ?? []).includes('txt2img'))
      if (models.length === 0) {
        throw new Error('no ready text-to-image model: load the image-studio-models skill and pull one first')
      }
      const answers = await ctx.userQuestions.ask({
        questions: buildFormFields(args, models),
        agent: exec.agent,
        signal: exec.signal,
      })
      const flags = ['generate', ...generateArguments(readConfirmed(answers, models))]
      const job = await runJson(ctx, runtime, flags, GENERATE_TIMEOUT_MS, exec.signal) as {
        job_id?: string
        status?: string
        seed?: number
        directory?: string
        files?: { path: string; filename: string; bytes: number }[]
      }
      return {
        job_id: job.job_id ?? '',
        status: job.status ?? 'unknown',
        seed: job.seed ?? -1,
        directory: job.directory ?? '',
        files: (job.files ?? []).map(file => ({ path: file.path, filename: file.filename, bytes: file.bytes })),
      } satisfies GenerateOutput
    },
  }))
}
