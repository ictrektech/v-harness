/** Bundled Image Studio generation, model preparation, and reference-image workflows. */

import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import { registerImageStudioTool } from './tool.ts'

const SKILL_NAMES = ['image-studio', 'image-studio-generate', 'image-studio-models'] as const

const DEFAULT_BASE_URL = 'http://image-studio-backend:5000'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Image Studio skill resource location and service endpoint. */
export interface Config {
  /** Absolute assets directory containing skill folders and the CLI; defaults to packaged assets. */
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
/** Registry used by the bundled provider. */
export const inject = ['skills']

function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`skill-image-studio: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description : undefined
  if (typeof description !== 'string' || description.length === 0) throw new Error(`skill-image-studio: ${path} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

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
  const cli = requireAbsoluteFile(config.cli ?? join(assetRoot, 'scripts', 'image-studio.mjs'), 'CLI')
  const authFile = config.authFile ?? process.env.IMAGE_STUDIO_AUTH_FILE ?? defaultAuthFile()
  if (!authFile.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(authFile)) {
    throw new Error(`skill-image-studio: authFile must be an absolute path: ${authFile}`)
  }
  return { node, cli, baseUrl, authFile, requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS }
}

function studioRuntime(runtime: ReturnType<typeof resolveRuntime>): string {
  return `\n\n## Image Studio runtime\n\nInvoke this CLI through the shell with the absolute paths below. Do not install packages, start another client, or call a different host. Authentication lives in the auth file (never print or pass its token to the model).\n\n${JSON.stringify({ imageStudio: runtime }, undefined, 2)}`
}

/**
 * Register Image Studio skills with resources readable by the script interpreter.
 * @param ctx - Context carrying the skill registry.
 * @param config - Optional external assets directory and service endpoint for packaged applications.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const assetRoot = config.assetRoot ?? fileURLToPath(new URL('../assets/', import.meta.url))
  if (!assetRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(assetRoot)) {
    throw new Error('skill-image-studio: assetRoot must be an absolute directory')
  }
  const runtime = resolveRuntime(config, assetRoot)
  const candidates: SkillCandidate[] = SKILL_NAMES.map((skillName) => {
    const directory = join(assetRoot, skillName)
    const path = join(directory, 'SKILL.md')
    const { description } = parseSkill(readFileSync(path, 'utf8'), path)
    return {
      name: skillName, description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-image-studio', source: 'bundled', rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory.split(sep).join('/') }, locator: path,
    }
  })
  const provider: SkillProvider = {
    name: 'dsh-image-studio',
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      const content = parseSkill(raw, locator as string).content + studioRuntime(runtime)
      return { ...summary, content }
    },
  }
  ctx.skills.registerProvider(() => provider)
  // The tool needs the shell, the tool registry, and the question seam; a
  // composition that only lists skills keeps the catalog without it.
  ctx.inject(['tools', 'userQuestions', 'shell'], (toolCtx) => {
    registerImageStudioTool(toolCtx, runtime)
  })
}
