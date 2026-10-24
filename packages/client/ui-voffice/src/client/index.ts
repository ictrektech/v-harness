/**
 * V-Office documents in the composer, browser half.
 *
 * Registers one `@` source over the signed-in user's own cloud folder, plus
 * the chip that renders a picked document in the sent message. There is no
 * settings page and no panel: the document picker lives where the documents
 * are used.
 *
 * @module @deepseek-ai/dsh-client-ui-voffice/client
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the Context merges these registrations land in.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, NS, zh } from './locales.ts'
import { documentRule } from './markers.ts'
import { vofficeSource } from './source.ts'
import { VofficeDocumentChip } from './VofficeDocumentChip.tsx'

/** Required services: the trigger registry, the copy, slots, and user text. */
export const inject = ['inputTriggers', 'locale', 'slots', 'uiConversation']

/**
 * Register the `@` source and the chip that renders its references.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voffice: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.uiConversation.userText.register(documentRule)
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node',
    key: 'vofficeDocument',
    priority: 100,
    locale: NS,
  }, VofficeDocumentChip))

  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(vofficeSource(t)), 'ui-voffice: @ source')
}
