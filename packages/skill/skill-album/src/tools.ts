/** AI-album tool definitions. Each result carries the photo-grid card metadata. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges `ctx.shell` into the Context.
import type {} from '@deepseek-ai/dsh-shell'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'

/** Resolve the calling session's workspace, or undefined when no agent owns the call. */
export type WorkingDirectoryResolver = (exec: ToolExecution) => Promise<string | undefined>

/** What both photo-grid tools return. */
export interface SearchValue {
  total: number
  photos: PhotoRow[]
}

/** One photo row the cards render. */
export interface PhotoRow {
  id: string
  filename: string
  type: string
  takenAt: string
  city: string
  favorite: boolean
  thumbPath: string
}

/**
 * Quote one argv entry for the mounted shell.
 *
 * A description or album name is user text: one with a space would otherwise
 * split into extra arguments and reach the CLI as a different query.
 * @param value - raw path or name.
 * @returns The entry as a single shell word.
 */
function quote(value: string): string {
  if (process.platform === 'win32') return `'${value.replaceAll("'", "''")}'`
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Shared runner: spawn the bundled CLI in the session workspace and parse its JSON answer. */
function cliRunner(
  ctx: Context,
  runtime: { node: string; cli: string },
  resolveWorkdir: WorkingDirectoryResolver,
) {
  return async function run(args: readonly string[], exec: ToolExecution): Promise<Record<string, unknown>> {
    // The CLI resolves `album-thumbs` against its own cwd and the card reads the
    // bytes back through the session workspace, so the process has to start
    // there; the dsh process directory is neither writable nor in the workspace.
    const workdir = await resolveWorkdir(exec)
    const command = [runtime.node, runtime.cli, ...args].map(quote).join(' ')
    const spec = ctx.shell.resolve({
      command,
      signal: exec.signal,
      ...(workdir === undefined ? {} : { workdir }),
    })
    const execution = await ctx.shell.execute(spec)
    const result = await execution.result()
    if (result.timedOut) throw new Error('album did not finish within the time limit')
    if (result.aborted) throw new Error('album was cancelled')
    if (result.exitCode !== 0) {
      const detail = result.stderr.text.trim()
      throw new Error(`album exited ${String(result.exitCode)}${detail === '' ? '' : `: ${detail.slice(-500)}`}`)
    }
    const text = result.stdout.text.trim()
    if (text === '') throw new Error('album printed no output')
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('album printed an unexpected payload')
    }
    return parsed as Record<string, unknown>
  }
}

/**
 * Shape the CLI's photo-listing answer.
 *
 * A row without a downloaded thumbnail is dropped: the Web card rejects the
 * whole result when any row lacks `thumbPath`, so one failed download would
 * otherwise blank the card. `total` stays the CLI's own count.
 * @param value - the CLI's JSON answer.
 * @returns the rows the card can render plus the CLI's total.
 */
export function photoList(value: Record<string, unknown>): SearchValue {
  const rows = Array.isArray(value.assets) ? value.assets : []
  const photos = rows.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>
    return {
      id: String(record.id ?? ''),
      filename: String(record.filename ?? ''),
      type: String(record.type ?? 'image'),
      takenAt: String(record.takenAt ?? ''),
      city: String(record.city ?? ''),
      favorite: record.favorite === true,
      thumbPath: String(record.thumbPath ?? ''),
    }
  }).filter(photo => photo.thumbPath !== '')
  return { total: Number(value.total ?? photos.length), photos }
}

const photoSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    filename: { type: 'string', required: true },
    type: { type: 'string', required: true },
    takenAt: { type: 'string', required: true },
    city: { type: 'string', required: true },
    favorite: { type: 'boolean', required: true },
    thumbPath: { type: 'string', required: true },
  },
} as const

/**
 * Register the interactive AI-album tools. Every `presentationMeta` value is
 * persisted with the result so the Web photo-grid card replays identically.
 * @param ctx - Context carrying the tool and shell seams.
 * @param runtime - resolved executables.
 * @param resolveWorkdir - the calling session's workspace, so thumbnails land where the card reads them.
 */
export function registerAlbumTools(
  ctx: Context,
  runtime: { node: string; cli: string },
  resolveWorkdir: WorkingDirectoryResolver,
): void {
  const run = cliRunner(ctx, runtime, resolveWorkdir)

  const searchOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total: { type: 'number', required: true },
        photos: { type: 'array', required: true, items: photoSchema },
      },
    },
    // The grid card owns the thumbnails and the open action; the model gets the
    // ids and descriptions it needs for a follow-up and nothing to restate.
    render: (_args: unknown, value: SearchValue) => [{
      type: 'text' as const,
      text: JSON.stringify({
        total: value.total,
        photos: value.photos.map(photo => ({
          id: photo.id, filename: photo.filename, takenAt: photo.takenAt, city: photo.city,
        })),
      }),
    }],
  } as const

  ctx.tools.register(defineTool({
    name: 'album_search',
    description: 'Semantic photo search over the user\'s AI album: describe the scene in natural language. The result renders as a photo grid the user can pick from.',
    parameters: {
      query: { type: 'string', required: true, description: 'Scene description, e.g. "sunset at the beach last summer".' },
      size: { type: 'number', description: 'Maximum number of photos to return (1-100).' },
    },
    output: {
      ...searchOutput,
      presentationMeta: (_args, value) => ({ kind: 'album.search', ...value }),
    },
    async execute(args, exec) {
      const argv = ['search', args.query, '--thumbs', '6', ...(args.size === undefined ? [] : ['--size', String(args.size)])]
      return photoList(await run(argv, exec))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'album_photos',
    description: 'List album photos by structured filters: date range, city, media type, favorite, rating, person, or album. The result renders as a photo grid.',
    parameters: {
      city: { type: 'string', description: 'City name filter.' },
      country: { type: 'string', description: 'Country name filter.' },
      from: { type: 'string', description: 'Taken-after date, YYYY-MM-DD.' },
      to: { type: 'string', description: 'Taken-before date, YYYY-MM-DD.' },
      type: { type: 'string', description: 'image or video.' },
      favorite: { type: 'boolean', description: 'Only favorites.' },
      rating: { type: 'number', description: 'Rating filter, 1-5.' },
      person: { type: 'string', description: 'Person id from `album_person`.' },
      album: { type: 'string', description: 'Album id from `album_albums`.' },
      size: { type: 'number', description: 'Maximum number of photos to return (1-100).' },
    },
    output: {
      ...searchOutput,
      presentationMeta: (_args, value) => ({ kind: 'album.photos', ...value }),
    },
    async execute(args, exec) {
      const argv = ['photos', '--thumbs', '6']
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) argv.push(`--${key}`, String(value))
      }
      return photoList(await run(argv, exec))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'album_person',
    description: 'Resolve a recognized person by name. The result lists matching people with their photo counts; use the id with `album_photos --person`.',
    parameters: {
      name: { type: 'string', required: true, description: 'Person name to resolve.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          people: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                assets: { type: 'number', required: true },
              },
            },
          },
        },
      },
      presentationMeta: (args, value) => ({ kind: 'album.person', name: args.name, ...value }),
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const value = await run(['person', args.name], exec)
      const rows = Array.isArray(value.people) ? value.people : []
      return {
        people: rows.map(row => ({
          id: String(row.id ?? ''),
          name: String(row.name ?? ''),
          assets: Number(row.assets ?? 0),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'album_albums',
    description: 'List the user\'s photo albums. The result renders as an album list card.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          albums: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                assets: { type: 'number', required: true },
              },
            },
          },
        },
      },
      presentationMeta: (_args, value) => ({ kind: 'album.albums', ...value }),
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const value = await run(['albums'], exec)
      const rows = Array.isArray(value.albums) ? value.albums : []
      return {
        albums: rows.map(row => ({
          id: String(row.id ?? ''),
          name: String(row.name ?? ''),
          assets: Number(row.assets ?? 0),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'album_upload',
    description: 'Upload one workspace photo or video into the AI album. Identical content is deduplicated by checksum. Never overwrites an existing photo.',
    parameters: {
      file: { type: 'string', required: true, description: 'Absolute workspace path of the file to upload.' },
      album: { type: 'string', description: 'Album id to add the upload to.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          duplicate: { type: 'boolean', required: true },
          album: { type: 'string' },
        },
      },
      presentationMeta: (args, value) => ({
        kind: 'album.upload', id: value.id, name: value.name, duplicate: value.duplicate,
        ...(args.album === undefined ? {} : { album: args.album }),
      }),
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const argv = ['upload', args.file, ...(args.album === undefined ? [] : ['--album', args.album])]
      const value = await run(argv, exec)
      return {
        id: String(value.id ?? ''),
        name: String(value.name ?? ''),
        duplicate: value.duplicate === true,
        ...(args.album === undefined ? {} : { album: args.album }),
      }
    },
  }))
}
