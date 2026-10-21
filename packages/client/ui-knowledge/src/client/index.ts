/**
 * Web knowledge-base surface: the `@` scope pick, the source strip under an
 * answer, and the knowledge panel.
 *
 * Library lists, documents, models, search results, and answers all come from
 * the gateway (`/__vh/weknora/...`), which forwards the caller's own VOS token
 * upstream, so neither the browser nor the agent handles a knowledge-base
 * credential.
 *
 * A pick inserts an atomic reference: the model side sees
 * `<knowledge-base>name</knowledge-base>` and passes that name to the
 * `knowledge_search` tool, so "search this library" is a fact in the message
 * rather than a scope the user hopes the run remembers. The panel stays one
 * more row in the same menu — browsing is a place to look, not a second way to
 * ask.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  InputTriggerCandidate, InputTriggerServiceContract, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the Context merges these registrations land in.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { knowledgeDefinition } from './citations.ts'
import { CitationStrip, type CitationStripInjected } from './CitationStrip.tsx'
import { EVIDENCE_ID, EVIDENCE_KIND, evidenceDefinition } from './evidence-tab.ts'
import { EvidenceBody, EvidenceTitle } from './EvidenceBody.tsx'
import { KnowledgeReference } from './KnowledgeReference.tsx'
import { en, NS, zh, type KnowledgeKey } from './locales.ts'
import { knowledgeMarker, knowledgeReferenceRule } from './reference.ts'
import { libraries } from './weknora.ts'

/** Required services: the trigger registry, the copy, the slot registry, the timeline, and the column. */
export const inject = [
  'inputTriggers', 'locale', 'slots', 'uiConversation', 'sidebarRightTabs', 'sidebarRight',
]

/** This plugin's identity in the turn-tail list. */
const TAIL_ID = '@deepseek-ai/dsh-client-ui-knowledge'

/** Menu value that opens the panel instead of inserting a scope. */
const PANEL = 'panel'

/** Dictionary-bound translate. */
type Translate = (key: KnowledgeKey) => string

/**
 * Register every knowledge-base surface.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-knowledge: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.uiConversation.events.register(knowledgeDefinition)
  ctx.uiConversation.userText.register(knowledgeReferenceRule)
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node',
    key: 'knowledge',
    priority: 100,
  }, KnowledgeReference))

  const source: InputTriggerSource = {
    trigger: '@',
    name: 'knowledge',
    order: 10,
    showGroupTitle: false,
    candidates: (_session, { query, signal }) => candidates(query, signal, t),
    onPick({ candidate }) {
      if (candidate.value === PANEL) {
        // Browsing is the outcome: the panel shows libraries and documents
        // without inserting a scope or sending anything to the model.
        ctx.sidebarRight.openTab(EVIDENCE_KIND, { params: {} })
        return 'handled'
      }
      return { insert: { source: 'knowledge', ref: candidate.name, label: candidate.name, clipboardText: candidate.name } }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(knowledgeMarker(ref)),
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

/**
 * The "every library" row, then the visible libraries whose name matches the
 * query, then the row that opens the panel.
 *
 * A failed listing keeps both fixed rows, so the pick still means "ask the
 * knowledge service" and the tool reports the real failure.
 * @param query - text between `@` and the caret.
 * @param signal - aborted when the user keeps typing or closes the menu.
 * @param t - the knowledge dictionary.
 * @returns the menu rows.
 */
async function candidates(
  query: string,
  signal: AbortSignal,
  t: Translate,
): Promise<readonly InputTriggerCandidate[]> {
  const needle = query.toLowerCase()
  const rows = ((await libraries(signal)) ?? [])
    .filter(library => library.name.toLowerCase().includes(needle))
    .map(library => ({
      name: library.name,
      section: t('section'),
      icon: 'folder' as const,
      value: library.name,
    }))
  return [
    ...rows,
    {
      name: t('panel.label'),
      description: t('panel.description'),
      section: t('section'),
      icon: 'file' as const,
      value: PANEL,
    },
  ]
}
