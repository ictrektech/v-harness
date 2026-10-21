/** V-Office tool definitions. Each result carries the card metadata the Web client renders. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges `ctx.shell` into the Context.
import type {} from '@deepseek-ai/dsh-shell'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Shared runner: spawn the bundled CLI and parse its JSON answer. */
function cliRunner(ctx: Context, runtime: { node: string; cli: string }) {
  return async function run(args: readonly string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    const spec = ctx.shell.resolve({ command: [runtime.node, runtime.cli, ...args].join(' '), ...(signal === undefined ? {} : { signal }) })
    const execution = await ctx.shell.execute(spec)
    const result = await execution.result()
    if (result.timedOut) throw new Error('voffice did not finish within the time limit')
    if (result.aborted) throw new Error('voffice was cancelled')
    if (result.exitCode !== 0) {
      const detail = result.stderr.text.trim()
      throw new Error(`voffice exited ${String(result.exitCode)}${detail === '' ? '' : `: ${detail.slice(-500)}`}`)
    }
    const text = result.stdout.text.trim()
    if (text === '') throw new Error('voffice printed no output')
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('voffice printed an unexpected payload')
    }
    return parsed as Record<string, unknown>
  }
}

/**
 * Register the interactive V-Office tools. Every `presentationMeta` value is
 * persisted with the result so the Web card replays identically.
 * @param ctx - Context carrying the tool and shell seams.
 * @param runtime - resolved executables.
 */
export function registerVofficeTools(ctx: Context, runtime: { node: string; cli: string }): void {
  const run = cliRunner(ctx, runtime)

  const fileSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true },
      size: { type: 'number', required: true },
      modified: { type: 'number', required: true },
      viewUrl: { type: 'string' },
    },
  } as const

  ctx.tools.register(defineTool({
    name: 'voffice_list',
    description: 'List the documents in the user\'s V-Office workspace. The result renders as a document card with per-document open actions.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          files: { type: 'array', required: true, items: fileSchema },
        },
      },
      presentationMeta: (_args, value) => ({ kind: 'voffice.list', ...value }),
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const value = await run(['list'], exec.signal)
      const rows = Array.isArray(value.files) ? value.files : []
      const files = rows.map((row) => {
        const viewUrl = row.viewUrl
        return {
          name: String(row.name ?? ''),
          size: Number(row.size ?? 0),
          modified: Number(row.modified ?? 0),
          ...(typeof viewUrl === 'string' && viewUrl !== '' ? { viewUrl } : {}),
        }
      })
      return { total: files.length, files }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voffice_open',
    description: 'Open a V-Office document in the online editor and return the absolute editor link for the user. The link stays valid for a limited time; request a fresh one when it expires.',
    parameters: {
      name: { type: 'string', required: true, description: 'Document name, exactly as `voffice_list` reported it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          url: { type: 'string', required: true },
          canWrite: { type: 'boolean', required: true },
          expiresIn: { type: 'number', required: true },
        },
      },
      presentationMeta: (args, value) => ({
        kind: 'voffice.open', name: args.name, url: value.url, canWrite: value.canWrite, expiresIn: value.expiresIn,
      }),
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const value = await run(['open', args.name], exec.signal)
      return {
        name: String(value.name ?? args.name),
        url: String(value.url ?? ''),
        canWrite: value.canWrite !== false,
        expiresIn: Number(value.expiresIn ?? 3600),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voffice_rename',
    description: 'Rename a V-Office document. Confirm the target document with the user when several documents match, then report the old and new names.',
    parameters: {
      name: { type: 'string', required: true, description: 'Current document name.' },
      new_name: { type: 'string', required: true, description: 'New document name, including the extension.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
        },
      },
      presentationMeta: args => ({ kind: 'voffice.rename', from: args.name, to: args.new_name }),
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      await run(['rename', args.name, args.new_name], exec.signal)
      return { from: args.name, to: args.new_name }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voffice_upload',
    description: 'Upload a workspace file into the user\'s V-Office workspace. Same-name uploads replace the cloud copy atomically.',
    parameters: {
      file: { type: 'string', required: true, description: 'Absolute workspace path of the file to upload.' },
      name: { type: 'string', description: 'Cloud document name; defaults to the file name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          size: { type: 'number', required: true },
        },
      },
      presentationMeta: (_args, value) => ({ kind: 'voffice.upload', name: value.name, size: value.size }),
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const argv = ['upload', args.file, ...(args.name === undefined ? [] : ['--name', args.name])]
      const value = await run(argv, exec.signal)
      return { name: String(value.name ?? ''), size: Number(value.size ?? 0) }
    },
  }))
}
