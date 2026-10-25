/** Interactive AI-album tools backed by the bundled album CLI. */

import { statSync } from 'node:fs'
import { isSea } from 'node:sea'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges `ctx.workingDirectory` into the Context.
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { registerAlbumTools } from './tools.ts'

/** AI-album tool runtime: the bundled CLI plus the Node executable that runs it. */
export interface Config {
  /** Absolute `skills/` directory holding the album CLI; defaults to the repository's `skills/`. */
  assetRoot?: string
  /** Standalone Node executable; defaults to the current executable outside Electron and SEA. */
  node?: string
  /** Absolute album CLI entry; defaults to the script shipped in the skills directory. */
  cli?: string
}

/** Validated runtime configuration. */
export const Config: z<Config> = z.object({
  assetRoot: z.string().min(1),
  node: z.string().min(1),
  cli: z.string().min(1),
})

/** Cordis plugin identity. */
export const name = 'skill-album'

function requireAbsoluteFile(path: string, label: string): string {
  let isFile = false
  try {
    isFile = statSync(path).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) throw new Error(`skill-album: expected an absolute ${label} file: ${path}`)
  return path
}

function resolveRuntime(config: Config, assetRoot: string): { node: string; cli: string } {
  if (config.node === undefined && (isSea() || process.versions.electron !== undefined)) {
    throw new Error('skill-album: packaged applications must supply a standalone Node executable')
  }
  return {
    node: requireAbsoluteFile(config.node ?? process.execPath, 'Node executable'),
    cli: requireAbsoluteFile(
      config.cli ?? join(assetRoot, 'album', 'scripts', 'album.mjs'),
      'CLI',
    ),
  }
}

/**
 * Mount the interactive AI-album tools over the bundled CLI.
 *
 * The `SKILL.md` entry lives under the repository's `skills/` directory (and
 * `/opt/v-harness/skills` in the image), so the ordinary skill scanner
 * publishes it exactly like `voffice`; this plugin adds the typed tool calls
 * whose results carry the photo-grid card metadata.
 * @param ctx - Context carrying the tool and shell seams.
 * @param config - Optional asset root and executable overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const assetRoot = config.assetRoot ?? process.env.VH_SKILLS_DIR
    ?? fileURLToPath(new URL('../../../../skills/', import.meta.url))
  if (!assetRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(assetRoot)) {
    throw new Error('skill-album: assetRoot must be an absolute directory')
  }
  const runtime = resolveRuntime(config, assetRoot)
  // The tool needs the tool registry, the shell seam, and the session working
  // directory: the CLI writes thumbnails relative to its cwd and the card reads
  // them back through the workspace, so running in the dsh process directory
  // fails every download. A composition that only lists skills keeps the
  // catalog without any of them.
  ctx.inject(['tools', 'shell', 'workingDirectory'], (toolCtx) => {
    registerAlbumTools(toolCtx, runtime, async (exec) => {
      // PTC sub-dispatches and unowned registries carry no agent; fall back to
      // the shell's own default rather than inventing a directory.
      if (exec.agent === undefined) return undefined
      return toolCtx.workingDirectory.ensure(exec.agent, exec.signal)
    })
  })
}
