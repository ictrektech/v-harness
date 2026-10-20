/**
 * Stage one of this package's registration: what the `evidence` tab type IS,
 * and what a caller hands it when opening one.
 *
 * A page type, not a viewer: it claims no resource address. It is opened from
 * the guide page, from a citation chip under an answer, and searches on its own
 * when the user types instead of arriving with passages.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import type {
  SidebarRightNavigationParams, SidebarRightTabDefinition,
} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'
import type { KnowledgeCitation } from './weknora.ts'

/** The tab kind this package owns. */
export const EVIDENCE_KIND = 'evidence'

/** This implementation's identity, and the key its body registers under. */
export const EVIDENCE_ID = '@deepseek-ai/dsh-client-ui-knowledge/evidence'

/** What a caller may hand the evidence page. */
export interface EvidenceParams {
  /** Passages an answer used; shown instead of a search result. */
  readonly citations?: readonly KnowledgeCitation[] | undefined
  /** Chunk id to show as the one the user clicked. */
  readonly focus?: string | undefined
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Passages an answer relied on, so the tab can open on evidence rather than on a search box. */
    evidence: EvidenceParams
  }
}

/**
 * The evidence type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function evidenceDefinition(t: TranslateNS<'knowledge'>): SidebarRightTabDefinition {
  return {
    id: EVIDENCE_ID,
    kind: EVIDENCE_KIND,
    priority: 'builtin',
    title: () => t('tab.label'),
    guide: [{
      id: 'evidence',
      order: 40,
      title: () => t('tab.guide.title'),
      description: () => t('tab.guide.description'),
    }],
  }
}

/**
 * Narrow what a page was opened with to this package's own parameters.
 * @param params - the page's navigation parameters, which another kind may own.
 * @returns the evidence parameters, or undefined when this page opened without any.
 */
export function evidenceParams(params: SidebarRightNavigationParams): EvidenceParams | undefined {
  if (params === undefined) return undefined
  if (!('citations' in params) && !('focus' in params)) return undefined
  return params
}
