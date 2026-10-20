/** Bundled Image Studio generation, model preparation, and reference-image workflows. */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerImageStudioTool } from './tool.ts'

const DEFAULT_BASE_URL = 'http://image-studio-backend:5000'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Image Studio skill resource location and service endpoint. */
export interface Config {
  /** Absolute `skills/` directory holding the image-studio folders and the CLI; defaults to the repository's `skills/`. */
  assetRoot?: string
  /** Standalone Node executable; defaults to the current executable outside Electron and SEA. */
  node?: string
  /** Absolute Image Studio CLI entry; defaults to the script shipped in the assets directory. */
  cli?: string
  /** Image Studio backend or VOS gateway prefix; defaults to the in-network backend service. */
  baseUrl?: string
  /** Absolute JSON file holding `{ "baseUrl"?: string, "token"?: string }`; defaults to the user config directory. */
  authFile?: string
  /** Per-request HTTP timeout for CLI calls. */
  requestTimeoutMs?: number
}

/** Validated resource configuration. */
export const Config: z<Config> = z.object({
  assetRoot: z.string().min(1),
  node: z.string().min(1),
  cli: z.string().min(1),
  baseUrl: z.string().min(1),
  authFile: z.string().min(1),
  requestTimeoutMs: z.natural().min(1),
})

/** Cordis plugin identity. */
export const name = 'skill-image-studio'

interface StudioRuntime {
  node: string
  cli: string
  baseUrl: string
  authFile: string
  requestTimeoutMs: number
}

function defaultAuthFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'dsh', 'image-studio.json')
}

function requireAbsoluteFile(path: string, label: string): string {
  let isFile = false
  try {
    isFile = statSync(path).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) throw new Error(`skill-image-studio: expected an absolute ${label} file: ${path}`)
  return path
}

function resolveRuntime(config: Config, assetRoot: string): StudioRuntime {
  const baseUrl = (config.baseUrl ?? process.env.IMAGE_STUDIO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/u, '')
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`skill-image-studio: baseUrl must be an absolute http(s) URL: ${baseUrl}`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`skill-image-studio: baseUrl must be an absolute http(s) URL: ${baseUrl}`)
  }
  if (config.node === undefined && (isSea() || process.versions.electron !== undefined)) {
    throw new Error('skill-image-studio: packaged applications must supply a standalone Node executable')
  }
  const node = requireAbsoluteFile(config.node ?? process.execPath, 'Node executable')
  const cli = requireAbsoluteFile(
    config.cli ?? join(assetRoot, 'image-studio', 'scripts', 'image-studio.mjs'),
    'CLI',
  )
  const authFile = config.authFile ?? process.env.IMAGE_STUDIO_AUTH_FILE ?? defaultAuthFile()
  if (!authFile.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(authFile)) {
    throw new Error(`skill-image-studio: authFile must be an absolute path: ${authFile}`)
  }
  return { node, cli, baseUrl, authFile, requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS }
}

/**
 * Mount the generation tool over the skill's own CLI.
 *
 * The three `SKILL.md` entries live under the repository's `skills/` directory
 * (and `/opt/v-harness/skills` in the image), so the ordinary skill scanner
 * publishes them exactly like `weknora` and `voffice`; this plugin only needs
 * the CLI runtime for the tool.
 * @param ctx - Context carrying the tool, question, and shell seams.
 * @param config - Optional asset root and service endpoint overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const assetRoot = config.assetRoot ?? process.env.VH_SKILLS_DIR
    ?? fileURLToPath(new URL('../../../../skills/', import.meta.url))
  if (!assetRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(assetRoot)) {
    throw new Error('skill-image-studio: assetRoot must be an absolute directory')
  }
  const runtime = resolveRuntime(config, assetRoot)
  // The tool needs the shell, the tool registry, and the question seam; a
  // composition that only lists skills keeps the catalog without it.
  ctx.inject(['tools', 'userQuestions', 'shell'], (toolCtx) => {
    registerImageStudioTool(toolCtx, runtime)
  })
}
