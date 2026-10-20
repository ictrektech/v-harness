/**
 * The source strip under a closing answer: one chip per passage the turn
 * retrieved, and one way to open the evidence page on exactly those passages.
 *
 * The strip claims a turn only when that turn retrieved something, so a turn
 * that never touched the knowledge bases keeps its tail unchanged. Copy stays
 * quiet — the chips are document titles and chunk positions, the facts a reader
 * checks a claim against.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import { selectRetrieved, type RetrievedCitation } from './citations.ts'
import css from './CitationStrip.module.css'

/** Chips shown before the rest collapse into one "more" chip. */
const STRIP_CHIPS = 6

/** What the plugin hands the strip. */
export interface CitationStripInjected {
  /** Open the evidence page on these passages, with one of them focused. */
  openEvidence: (citations: readonly RetrievedCitation[], focus: string | undefined) => void
}

/** The strip's composed props. */
export type CitationStripProps =
  PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<typeof NS> & InjectFace<CitationStripInjected>

/**
 * Render the source strip for a closing answer.
 * @param props - closing turn, the page opener, and localized copy.
 * @returns the chips, or null when the turn retrieved no passage.
 */
export function CitationStrip(props: CitationStripProps): ReactNode {
  const { openEvidence, t } = props
  const citations = selectRetrieved(props)
  if (citations === null) return null
  const shown = citations.slice(0, STRIP_CHIPS)
  const hidden = citations.length - shown.length
  return (
    <div className={css.root}>
      <span className={css.label}>{t('sources.label')}</span>
      {shown.map(citation => (
        <button
          className={css.chip}
          key={citation.chunkId}
          onClick={() => { openEvidence(citations, citation.chunkId) }}
          title={`${citation.title} #${String(citation.chunkIndex)}`}
          type="button"
        >
          <span className={css.title}>{citation.title}</span>
          <span className={css.index}>{`#${String(citation.chunkIndex)}`}</span>
        </button>
      ))}
      {hidden === 0 ? null : (
        <button className={css.chip} onClick={() => { openEvidence(citations, undefined) }} type="button">
          {t('sources.more', { count: String(hidden) })}
        </button>
      )}
    </div>
  )
}
