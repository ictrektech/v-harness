/**
 * Web knowledge-base surface: the `@` scope pick, the `[n]` marks inside an
 * answer, and the passages card under it.
 *
 * There is no knowledge-base page. Choosing a library (or one of its
 * documents) happens in the message through `@`, and what the run actually
 * retrieved appears twice, from one array: as a numbered mark where the answer
 * cites it, and as the numbered row that opens the passage.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the Context merges these registrations land in.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { KnowledgeBaseChip, KnowledgeDocumentChip } from './KnowledgeChip.tsx'
import { en, NS, zh } from './locales.ts'
import { knowledgeMarks } from './marks.tsx'
import { baseScopeRule, documentScopeRule } from './markers.ts'
import { knowledgeSource } from './source.ts'
import { SourceCards } from './SourceCards.tsx'
import { knowledgeTurn } from './turn.ts'

/** Required services: the trigger registry, the copy, and the slot registry. */
export const inject = ['inputTriggers', 'locale', 'slots', 'uiConversation']

/** This plugin's identity in the turn-tail list. */
const TAIL_ID = '@deepseek-ai/dsh-client-ui-knowledge'

/**
 * Register every knowledge-base surface.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-knowledge: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.uiConversation.events.register(knowledgeTurn)
  ctx.uiConversation.userText.register(baseScopeRule)
  ctx.uiConversation.userText.register(documentScopeRule)

  ctx.slots.inject('conversation.user.text.node', function* () {
    yield ctx.slots.register({
      name: 'conversation.user.text.node',
      key: 'knowledgeBase',
      priority: 100,
      locale: NS,
    }, KnowledgeBaseChip)
    yield ctx.slots.register({
      name: 'conversation.user.text.node',
      key: 'knowledgeDocument',
      priority: 100,
      locale: NS,
    }, KnowledgeDocumentChip)
  })

  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(knowledgeSource(t)), 'ui-knowledge: @ source')

  ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: TAIL_ID,
    locale: NS,
  }, SourceCards)), 'ui-knowledge: source cards')

  // The prose side of the same facts: the chat view reaches this face through
  // ctx.get, so its absence — this plugin composed out — leaves every `[n]` as
  // the text the model wrote.
  ctx.provide('chatInlineMarks', knowledgeMarks())
}
