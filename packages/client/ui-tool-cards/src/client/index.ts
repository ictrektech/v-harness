/**
 * Product tool-card plugin, browser half: one keyed `tool.call.toolview` per
 * bundled product tool. Each card derives its view purely from the call's
 * persisted arguments and `presentationMeta`, so replay reproduces it without
 * live state; a card that cannot narrow its metadata renders the generic row.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { ProductToolCard } from './Cards.tsx'
import { en, NS, zh, type ToolCardsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The product tool cards' copy. */
    toolCards: ToolCardsKey
  }
}

/** Required services: the tool-row registry, locale, and workspace file reads. */
export const inject = ['slots', 'locale', 'remote', 'remote.workspaceFiles']

/** The tool names this plugin claims; every other name keeps the generic row. */
const TOOL_KEYS = [
  'image_studio_generate',
] as const

/**
 * Client plugin body: register the dictionaries and one keyed card per tool.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-tool-cards: dictionaries')
  const workspaceFiles = ctx.remote.workspaceFiles
  for (const key of TOOL_KEYS) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key,
      locale: NS,
      inject: () => ({ workspaceFiles }),
    }, ProductToolCard))
  }
}
