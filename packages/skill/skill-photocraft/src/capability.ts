/**
 * The engine's whole vocabulary, indexed and validated.
 *
 * The engine publishes 918 commands with their parameters, but it does not check
 * them: a misspelt field is accepted and quietly ignored, which looks like
 * success and does nothing. This module turns that list into something a caller
 * can search and that a call can be checked against — reach without guessing.
 *
 * @module @deepseek-ai/dsh-skill-photocraft/capability
 */

import type { EngineClient } from './client.ts'

/** One engine command as the engine describes it. */
export interface CommandSpec {
  readonly id: string
  readonly label: string
  /** The engine's own parameter description, verbatim. */
  readonly params: string
  /** Where the command sits in the app's menus, root first. */
  readonly menu: readonly string[]
  /** Whether the command can run right now, as the engine reports it. */
  readonly enabled: boolean
  /** The engine's own reason when `enabled` is false. */
  readonly disabledReason?: string
  /** Whether the command needs an open document at all. */
  readonly needsDocument: boolean
}

/** What a command needs before it can run, and whether that already holds. */
export interface CommandDoc extends CommandSpec {
  /** One sentence on why it is blocked, or absent when it can run now. */
  readonly blocked?: string
}

/** What a caller asked for, and what was wrong with it. */
export interface CommandCheck {
  readonly spec: CommandSpec
  /** Reasons the call would do nothing or something else than asked. */
  readonly problems: readonly string[]
}

/**
 * Chinese intent to engine vocabulary.
 *
 * The engine labels are English (`Hue/Saturation`), while the request arrives in
 * Chinese ("把花的色相调红"); without this a search for 色相 matches nothing.
 */
export const SYNONYMS: Readonly<Record<string, string>> = {
  色相: 'hue',
  饱和: 'saturation',
  饱和度: 'saturation',
  曲线: 'curves',
  色阶: 'levels',
  选区: 'selection',
  选择: 'selection',
  蒙版: 'mask',
  遮罩: 'mask',
  图层: 'layer',
  裁剪: 'crop',
  旋转: 'rotate',
  锐化: 'sharpen',
  锐度: 'sharpen',
  降噪: 'noise',
  噪点: 'noise',
  颗粒: 'noise',
  暗角: 'lens',
  文字: 'type',
  排版: 'type',
  抠图: 'subject',
  去背: 'subject',
  抠: 'subject',
  混合: 'blend',
  亮度: 'brightness',
  对比: 'contrast',
  饱和对比: 'vibrance',
  色彩平衡: 'balance',
  滤镜: 'filter',
  路径: 'path',
  形状: 'shape',
  变换: 'transform',
  变形: 'transform',
  导出: 'save',
  保存: 'save',
  颜色: 'color',
  范围: 'range',
  模糊: 'blur',
  皮肤: 'smooth',
  天空: 'sky',
  阴影: 'shadow',
  高光: 'highlight',
  填充: 'fill',
  渐变: 'gradient',
  描边: 'stroke',
  拼图: 'composite',
  水印: 'type',
}

const FIELD = /"([A-Za-z][A-Za-z0-9_]*)":/g
const RANGE = /"([A-Za-z][A-Za-z0-9_]*)"\s*:\s*(-?\d+)\.\.(-?\d+)/g

/** Every `field:` the engine's description mentions, nested included. */
function fieldsOf(params: string): Set<string> {
  const out = new Set<string>()
  for (const match of params.matchAll(FIELD)) out.add(match[1] as string)
  return out
}

/** Every `field: a..b` range the description declares. */
function rangesOf(params: string): Map<string, readonly [number, number]> {
  const out = new Map<string, readonly [number, number]>()
  for (const match of params.matchAll(RANGE)) {
    out.set(match[1] as string, [Number(match[2]), Number(match[3])])
  }
  return out
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
    .filter(part => part !== '')
}

/**
 * The engine words a query should be tried as.
 *
 * The engine's own filter matches one English word at a time, so a Chinese
 * request becomes the closest English word and an English request is passed
 * through as written.
 */
export function expand(query: string): string[] {
  const out = new Set<string>()
  for (const word of words(query)) {
    out.add(word)
    for (const [zh, en] of Object.entries(SYNONYMS)) {
      if (word.includes(zh)) out.add(en)
    }
  }
  return [...out]
}

/** One entry of the engine's command list, normalised. */
function toSpec(entry: unknown): CommandSpec {
  const item = entry as {
    id?: unknown
    label?: unknown
    params?: unknown
    description?: unknown
    menu?: unknown
    enabled?: unknown
    disabledReason?: unknown
    needsDocument?: unknown
  }
  return {
    id: String(item.id ?? ''),
    label: String(item.label ?? item.description ?? ''),
    params: typeof item.params === 'string' ? item.params : JSON.stringify(item.params ?? ''),
    menu: Array.isArray(item.menu) ? item.menu.map(String) : [],
    enabled: item.enabled !== false,
    ...(typeof item.disabledReason === 'string' && item.disabledReason !== ''
      ? { disabledReason: item.disabledReason }
      : {}),
    needsDocument: item.needsDocument === true,
  }
}

/**
 * The engine's command list, fetched once per client and searched locally.
 *
 * The list is 292 KB (≈93k tokens), far too much to put in a prompt, so it stays
 * here and only matches travel.
 */
export class CommandIndex {
  readonly #client: EngineClient
  #specs: CommandSpec[] | undefined
  #pending: Promise<CommandSpec[]> | undefined

  constructor(client: EngineClient) {
    this.#client = client
  }

  /** All commands, loading them on first use. */
  async all(): Promise<CommandSpec[]> {
    if (this.#specs !== undefined) return this.#specs
    this.#pending ??= this.#load()
    this.#specs = await this.#pending
    return this.#specs
  }

  async #load(): Promise<CommandSpec[]> {
    const raw = await this.#client.call('command_list') as unknown
    const list = Array.isArray(raw)
      ? raw
      : (raw as { commands?: unknown }).commands ?? (raw as { items?: unknown }).items
    if (!Array.isArray(list)) throw new Error('photocraft: command_list returned no array')
    return list.map(toSpec).filter(spec => spec.id !== '')
  }

  /**
   * The commands closest to a query, in the engine's own order.
   *
   * The engine already ranks a filter (`selection` puts Rectangular Selection
   * first), so this only widens a Chinese request into English words and merges
   * what comes back.
   */
  async search(query: string, limit = 8): Promise<CommandSpec[]> {
    const seen = new Map<string, CommandSpec>()
    for (const term of expand(query)) {
      if (seen.size >= limit) break
      for (const spec of await this.#filter(term)) {
        if (!seen.has(spec.id)) seen.set(spec.id, spec)
      }
    }
    return [...seen.values()].slice(0, limit)
  }

  /** One engine filter pass, parsed like the full list. */
  async #filter(term: string): Promise<CommandSpec[]> {
    const raw = await this.#client.call('command_list', { filter: term }) as unknown
    const list = Array.isArray(raw) ? raw : (raw as { commands?: unknown }).commands
    return Array.isArray(list) ? list.map(toSpec).filter(spec => spec.id !== '') : []
  }

  /**
   * Check one call against the engine's own description.
   *
   * Rejects a field the command does not declare, and a number outside the range
   * it declares — the two cases the engine accepts in silence.
   */
  async check(id: string, params: Record<string, unknown>): Promise<CommandCheck> {
    const spec = (await this.all()).find(entry => entry.id === id)
    if (spec === undefined) throw new Error(`unknown command \`${id}\``)
    const problems: string[] = []
    const declared = fieldsOf(spec.params)
    const ranges = rangesOf(spec.params)
    for (const key of Object.keys(params)) {
      if (!declared.has(key)) {
        problems.push(`\`${id}\` has no parameter \`${key}\` — declared: ${[...declared].slice(0, 12).join(', ')}`)
        continue
      }
      const range = ranges.get(key)
      const value = params[key]
      if (range !== undefined && typeof value === 'number') {
        const [min, max] = range
        if (value < min || value > max) problems.push(`\`${key}\` must be ${String(min)}..${String(max)}, got ${String(value)}`)
      }
    }
    return { spec, problems }
  }

  /**
   * What one command takes, and whether it can run right now.
   *
   * The engine publishes parameters but never readiness: a layer command with no
   * document open fails with a message about the document rather than the call.
   * Asking the document first turns that into a stated prerequisite.
   */
  async describe(id: string): Promise<CommandDoc> {
    const spec = (await this.all()).find(entry => entry.id === id)
    if (spec === undefined) throw new Error(`unknown command \`${id}\``)
    const blocked = spec.enabled
      ? undefined
      : spec.disabledReason
        ?? (spec.needsDocument ? 'needs an open document — call doc_open first' : 'the engine reports it as unavailable')
    return blocked === undefined ? spec : { ...spec, blocked }
  }
}
