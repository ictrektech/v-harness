/**
 * The passages card under a closing answer.
 *
 * It is the whole knowledge surface after the question is asked: one row per
 * passage the run actually retrieved, with the document title, the chunk
 * position, and the opening of the text. Rows are numbered in retrieval order,
 * so the `[1]` an answer writes points at the first row of this card and at
 * nothing else. Clicking a row expands it to the real chunk in place — no side
 * panel, because the user is reading the answer and the source should open
 * where their eyes already are.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { readDocument, type Chunk, type Citation } from './api.ts'
import { selectCitations } from './turn.ts'
import badge from './MarkBadge.module.css'
import css from './SourceCards.module.css'

/** Passage rows shown before the rest collapse into one "more" row. */
const VISIBLE_ROWS = 6

/** The card's composed props. */
export type SourceCardsProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'knowledge'>

/**
 * Render the passages card for a closing answer.
 * @param props - closing turn and localized copy.
 * @returns the card, or null when the turn retrieved nothing.
 */
export function SourceCards(props: SourceCardsProps): ReactNode {
  const { t } = props
  const citations = selectCitations(props)
  const [open, setOpen] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  const [bodies, setBodies] = useState<Readonly<Record<string, readonly Chunk[]>>>({})

  if (citations === null) return null
  const shown = expanded ? citations : citations.slice(0, VISIBLE_ROWS)
  const hidden = citations.length - shown.length

  /**
   * Expand one passage to its full chunk, fetching the document once.
   * @param citation - the passage the user clicked.
   */
  async function toggle(citation: Citation): Promise<void> {
    if (open === citation.chunkId) {
      setOpen(undefined)
      return
    }
    setOpen(citation.chunkId)
    const id = citation.knowledgeId
    if (id === '' || bodies[id] !== undefined) return
    const chunks = await readDocument(id, new AbortController().signal)
    setBodies(current => ({ ...current, [id]: chunks ?? [] }))
  }

  /**
   * @param citation - the passage to show.
   * @returns its full text when expanded, otherwise the search snippet.
   */
  function bodyOf(citation: Citation): string {
    const id = citation.knowledgeId
    if (open !== citation.chunkId || id === '') return citation.snippet
    const chunk = bodies[id]?.find(item => item.chunkIndex === citation.chunkIndex)
    return chunk?.content ?? citation.snippet
  }

  return (
    <section className={css.card}>
      <header className={css.header}>
        <span className={css.title}>{t('sources.title')}</span>
        <span className={css.count}>{t('sources.count', { count: String(citations.length) })}</span>
      </header>
      <ul className={css.list}>
        {shown.map((citation, position) => (
          <li key={citation.chunkId}>
            <button
              className={open === citation.chunkId ? `${css.row} ${css.rowOpen}` : css.row}
              onClick={() => { void toggle(citation) }}
              type="button"
            >
              <span className={css.rowTitle}>
                <span className={badge.badge}>{String(position + 1)}</span>
                <span className={css.document}>{citation.title}</span>
                <span className={css.index}>{`#${String(citation.chunkIndex)}`}</span>
              </span>
              <span className={open === citation.chunkId ? css.body : css.snippet}>{bodyOf(citation)}</span>
            </button>
          </li>
        ))}
      </ul>
      {hidden === 0 ? null : (
        <button className={css.more} onClick={() => { setExpanded(true) }} type="button">
          {t('sources.more', { count: String(hidden) })}
        </button>
      )}
    </section>
  )
}
