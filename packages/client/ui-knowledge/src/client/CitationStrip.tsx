/**
 * The knowledge cards under a closing answer.
 *
 * Two cards, each claiming its own facts: the libraries the turn listed, and
 * the passages it retrieved. A passage card shows the title, chunk position,
 * and the opening of the text, and opens the evidence page focused on it. The
 * strip claims a turn only when that turn named a library or retrieved
 * something, so a turn that never touched the knowledge bases keeps its tail
 * unchanged.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import { selectLibraries, selectRetrieved, type RetrievedCitation } from './citations.ts'
import css from './CitationStrip.module.css'

/** Passage rows shown before the rest collapse into one "more" row. */
const STRIP_ROWS = 6

/** What the plugin hands the cards. */
export interface CitationStripInjected {
  /** Open the evidence page on these passages, with one of them focused. */
  openEvidence: (citations: readonly RetrievedCitation[], focus: string | undefined) => void
}

/** The cards' composed props. */
export type CitationStripProps =
  PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<typeof NS> & InjectFace<CitationStripInjected>

/**
 * Render the knowledge cards for a closing answer.
 * @param props - closing turn, the page opener, and localized copy.
 * @returns the library card and the result card, or null when the turn named neither.
 */
export function CitationStrip(props: CitationStripProps): ReactNode {
  const { openEvidence, t } = props
  const libraries = selectLibraries(props)
  const citations = selectRetrieved(props)
  if (citations === null && libraries.length === 0) return null
  const shown = citations?.slice(0, STRIP_ROWS) ?? []
  const hidden = citations === null ? 0 : citations.length - shown.length
  return (
    <div className={css.cards}>
      {libraries.length === 0 ? null : (
        <section className={css.card}>
          <header className={css.header}>
            <span className={css.title}>{t('libraries.title')}</span>
            <span className={css.count}>{t('libraries.count', { count: String(libraries.length) })}</span>
          </header>
          <ul className={css.list}>
            {libraries.map(library => (
              <li className={css.row} key={library.id}>
                <span className={css.icon} aria-hidden="true">▤</span>
                <span className={css.name}>{library.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {citations === null ? null : (
        <section className={css.card}>
          <header className={css.header}>
            <span className={css.title}>{t('sources.title')}</span>
            <span className={css.count}>{t('sources.count', { count: String(citations.length) })}</span>
          </header>
          <ul className={css.list}>
            {shown.map(citation => (
              <li key={citation.chunkId}>
                <button
                  className={css.result}
                  onClick={() => { openEvidence(citations, citation.chunkId) }}
                  type="button"
                >
                  <span className={css.resultTitle}>
                    <span>{citation.title}</span>
                    <span className={css.index}>{`#${String(citation.chunkIndex)}`}</span>
                  </span>
                  {citation.snippet === undefined ? null : <span className={css.snippet}>{citation.snippet}</span>}
                </button>
              </li>
            ))}
          </ul>
          {hidden === 0 ? null : (
            <button className={css.more} onClick={() => { openEvidence(citations, undefined) }} type="button">
              {t('sources.count', { count: String(hidden) })}
            </button>
          )}
        </section>
      )}
    </div>
  )
}
