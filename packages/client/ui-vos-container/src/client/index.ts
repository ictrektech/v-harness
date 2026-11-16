/**
 * VOS containers in the composer, browser half.
 *
 * Registers one `@` source over the application containers the operations tool
 * may act on, plus the chip that renders a picked container in the sent
 * message. The source stays out of the menu unless this conversation carries
 * the operations preset and the gateway admits the reader as a VOS system
 * administrator: there is nothing to configure and nothing to discover, only an
 * entry that appears where the containers can actually be named.
 *
 * @module @deepseek-ai/dsh-client-ui-vos-container/client
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  ClientSessionContext, InputTriggerServiceContract,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the Context merges these registrations land in, including
// the session service whose `permissions` projection names the preset.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PermissionSelection } from '@deepseek-ai/dsh-permission-presets/client'
import { en, NS, zh } from './locales.ts'
import { containerRule } from './markers.ts'
import { vosContainerSource } from './source.ts'
import { VosContainerChip } from './VosContainerChip.tsx'

/** Required services: the trigger registry, the copy, slots, user text, sessions. */
export const inject = ['inputTriggers', 'locale', 'slots', 'uiConversation', 'sessions']

/**
 * Register the `@` source and the chip that renders its references.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-vos-container: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.uiConversation.userText.register(containerRule)
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node',
    key: 'vosContainer',
    priority: 100,
    locale: NS,
  }, VosContainerChip))

  // The Session's own projection is the only local source of truth for what
  // this conversation may do; a session that is not materialized yet answers
  // undefined, which keeps the source out of the menu until it is.
  const preset = (sessionId: ClientSessionContext['sessionId']): string | undefined => {
    const selection = ctx.sessions.binding(sessionId)?.session.projections
      .faceOf('permissions').getSnapshot() as PermissionSelection | undefined
    return selection?.currentValue
  }

  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(
    () => inputTriggers.registerSource(vosContainerSource(t, { preset })),
    'ui-vos-container: @ source',
  )
}
