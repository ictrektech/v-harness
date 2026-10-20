/**
 * Web knowledge-base surface: the `@hybrag` pick, the source strip under an
 * answer, and the knowledge panel.
 *
 * Library lists, documents, models, search results, and answers all come from
 * the gateway (`/__vh/weknora/...`), which forwards the caller's own VOS token
 * upstream, so neither the browser nor the agent handles a knowledge-base
 * credential. Picking `@hybrag` opens the panel and inserts nothing — the whole
 * interaction is the panel, not a message.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  InputTriggerServiceContract, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the Context merges these registrations land in.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { knowledgeDefinition } from './citations.ts'
import { CitationStrip, type CitationStripInjected } from './CitationStrip.tsx'
import { EVIDENCE_ID, EVIDENCE_KIND, evidenceDefinition } from './evidence-tab.ts'
import { EvidenceBody, EvidenceTitle } from './EvidenceBody.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: the trigger registry, the copy, the slot registry, the timeline, and the column. */
export const inject = [
  'inputTriggers', 'locale', 'slots', 'uiConversation', 'sidebarRightTabs', 'sidebarRight',
]

/** This plugin's identity in the turn-tail list. */
const TAIL_ID = '@deepseek-ai/dsh-client-ui-knowledge'

/** The one thing this source offers: the knowledge surface itself, not a library. */
const HYBRAG = 'hybrag'

/**
 * Register every knowledge-base surface.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-knowledge: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.uiConversation.events.register(knowledgeDefinition)

  const source: InputTriggerSource = {
    trigger: '@',
    name: 'knowledge',
    order: 10,
    showGroupTitle: false,
    candidates: async () => [{
      name: HYBRAG,
      description: t('hybrag.description'),
      section: t('section'),
      icon: 'file' as const,
      value: HYBRAG,
    }],
    onPick() {
      // The surface is the outcome: opening the panel is the whole pick, so no
      // reference enters the draft and nothing is sent to the model.
      void ctx.sidebarRight.openTab(EVIDENCE_KIND, { params: {} })
      return 'handled'
    },
  }
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(source), 'ui-knowledge: @ source')

  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: TAIL_ID,
    locale: NS,
    inject: (): CitationStripInjected => ({
      openEvidence: (citations, focus) => {
        ctx.sidebarRight.openTab(EVIDENCE_KIND, { params: { citations, focus } })
      },
    }),
  }, CitationStrip))

  ctx.effect(() => ctx.sidebarRightTabs.register(evidenceDefinition(t)), 'ui-knowledge: evidence type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: EVIDENCE_ID, locale: NS }, EvidenceBody,
  )), 'ui-knowledge: evidence body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: EVIDENCE_ID, locale: NS }, EvidenceTitle,
  )), 'ui-knowledge: evidence title')
}
