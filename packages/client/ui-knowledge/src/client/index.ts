/**
 * Web knowledge-base surface: the `@knowledge` source, the source strip under an
 * answer, and the evidence page.
 *
 * Library lists, search results, and citations all come from the gateway
 * (`/__vh/weknora/...`), which forwards the caller's own VOS token upstream, so
 * neither the browser nor the agent handles a knowledge-base credential. A pick
 * inserts an atomic reference; the model side sees
 * `<knowledge-base>name</knowledge-base>` and passes that name to the `weknora`
 * skill's `--kb`.
 *
 * An unreachable gateway leaves only the "all knowledge bases" row. That is
 * deliberate: the pick still means "ask the knowledge service", and the skill
 * reports the real failure instead of the menu guessing at one.
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
import { en, NS, zh, type KnowledgeKey } from './locales.ts'
import { libraries } from './weknora.ts'

/** Required services: the trigger registry, the copy, the slot registry, the timeline, and the column. */
export const inject = [
  'inputTriggers', 'locale', 'slots', 'uiConversation', 'sidebarRightTabs', 'sidebarRight',
]

/** This plugin's identity in the turn-tail list. */
const TAIL_ID = '@deepseek-ai/dsh-client-ui-knowledge'

/** Sentinel reference meaning "every library the caller can see". */
const ALL = '*'

type Translate = (key: KnowledgeKey) => string

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
    candidates: (_session, { query, signal }) => candidates(query, signal, t),
    onPick({ candidate }) {
      const value = candidate.value ?? ALL
      const label = value === ALL ? t('all.label') : candidate.name
      return { insert: { source: 'knowledge', ref: value, label, clipboardText: label } }
    },
    codec: {
      clipboardText: ref => (ref === ALL ? t('all.label') : ref),
      serialize: async ref => `<knowledge-base>${ref === ALL ? t('all.label') : ref}</knowledge-base>`,
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
 * The "every library" row followed by the visible libraries whose name matches
 * the query.
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
    {
      name: t('all.label'),
      description: t('all.description'),
      section: t('section'),
      icon: 'file' as const,
      value: ALL,
    },
    ...rows,
  ]
}
