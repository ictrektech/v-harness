/**
 * One `[n]` in an answer, wearing the badge its source row wears.
 *
 * It carries the source as a tooltip and nothing else: the row below is where
 * the passage opens, and a second interactive surface in the middle of a
 * sentence would fight the text selection it lives in.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import type { ReactNode } from 'react'
import type { Citation } from './api.ts'
import badge from './MarkBadge.module.css'

/** The mark's composed props: its authored number and the passage it names. */
export interface CitationMarkProps {
  readonly number: number
  readonly citation: Citation
}

/**
 * Render one citation mark.
 * @param props - the number as the answer wrote it, and the passage it named.
 * @returns the badge, with the document title and passage position as its tooltip.
 */
export function CitationMark({ number, citation }: CitationMarkProps): ReactNode {
  const position = `#${String(citation.chunkIndex)}`
  const title = citation.title === '' ? position : `${citation.title} ${position}`
  return <span className={`${badge.badge} ${badge.prose}`} title={title}>{String(number)}</span>
}
