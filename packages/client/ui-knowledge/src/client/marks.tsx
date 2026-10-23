/**
 * The `[n]` marks an answer writes, resolved against what the Turn retrieved.
 *
 * The number is a position in the same list the source card renders — its
 * first row is `[1]` — so the mark in a sentence and the row beneath it are
 * one fact, read from one array. A number this Turn did not retrieve stays
 * literal text: the vocabulary never guesses, so a model that invents `[7]`
 * cannot point at a passage it never saw.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import type { ReactNode } from 'react'
import type { ChatInlineMarks, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MarkdownInlineMarks } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Citation } from './api.ts'
import { CitationMark } from './CitationMark.tsx'
import { citationsForClosing } from './turn.ts'

/** An authored marker: one to three digits between brackets. */
const MARK = /\[(\d{1,3})\]/gu

/** One piece of a prose run: the text as written, or a passage a number named. */
export type MarkPart = string | { readonly number: number; readonly citation: Citation }

/**
 * Split one prose run at the markers the retrieved passages answer for.
 * @param text - the run exactly as the answer wrote it.
 * @param citations - this Turn's passages, in the card's row order.
 * @returns the pieces, or undefined when the run names no retrieved passage —
 * a run with no markers, or only numbers outside the retrieved range.
 */
export function markParts(text: string, citations: readonly Citation[]): readonly MarkPart[] | undefined {
  if (!text.includes('[')) return undefined
  const parts: MarkPart[] = []
  let end = 0
  for (const match of text.matchAll(MARK)) {
    const number = Number(match[1])
    const citation = citations[number - 1]
    if (citation === undefined) continue
    const start = match.index
    if (start > end) parts.push(text.slice(end, start))
    parts.push({ number, citation })
    end = start + match[0].length
  }
  if (parts.length === 0) return undefined
  if (end < text.length) parts.push(text.slice(end))
  return parts
}

/**
 * @param parts - one split run.
 * @returns nodes for the run; text pieces stay strings, marks become badges.
 */
function renderParts(parts: readonly MarkPart[]): ReactNode[] {
  return parts.map((part, index) => typeof part === 'string'
    ? part
    : <CitationMark key={index} number={part.number} citation={part.citation} />)
}

/**
 * The Chat view's prose-mark provider for knowledge answers.
 *
 * Composing this plugin is the on switch: without it the chat view's `ctx.get`
 * finds no provider and every `[n]` stays the text the model wrote.
 * @returns the provider the chat view reaches through `ctx.chatInlineMarks`.
 */
export function knowledgeMarks(): ChatInlineMarks {
  return {
    forClosing(owner: TurnTailOwnerProps): MarkdownInlineMarks | undefined {
      const citations = citationsForClosing(owner.turn.data.get('knowledge'), owner.seq)
      if (citations.length === 0) return undefined
      return {
        resolve(text: string): ReactNode | undefined {
          const parts = markParts(text, citations)
          return parts === undefined ? undefined : renderParts(parts)
        },
      }
    },
  }
}
