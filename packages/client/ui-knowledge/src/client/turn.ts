/**
 * Turn-scoped knowledge citations: the passages this run actually retrieved.
 *
 * The source is the Session's own `tool/result` events, never the closing prose
 * and never a re-query. The `weknora` skill prints one JSON object per call,
 * and only its `citations` array is read here — a result carrying none
 * contributes nothing, so an unrelated command cannot invent a source, and a
 * re-run of the same search stays one card.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { indexOf, isRecord, snippetOf, text, type Citation } from './api.ts'

/** One passage with the sequence of the tool result that returned it. */
export interface RetrievedCitation extends Citation {
  readonly seq: number
}

/** Immutable knowledge facts published against one Turn. */
export interface KnowledgeTurnData {
  readonly citations: readonly RetrievedCitation[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Passages the run retrieved in this Turn, in first-seen order. */
    knowledge: KnowledgeTurnData
  }
}

interface KnowledgeState extends KnowledgeTurnData {
  readonly turn: number
}

/**
 * The passages retrieved before the closing reply.
 * @param data - engine-published knowledge data for one Turn.
 * @param seq - closing Assistant seq; later settlements are excluded.
 * @returns citations in first-seen order, keyed by chunk id.
 */
export function citationsForClosing(
  data: Readonly<KnowledgeTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
): readonly RetrievedCitation[] {
  if (data === undefined) return []
  const seen = new Set<string>()
  const citations: RetrievedCitation[] = []
  for (const citation of data.citations) {
    if (citation.seq > seq || seen.has(citation.chunkId)) continue
    seen.add(citation.chunkId)
    citations.push(citation)
  }
  return citations
}

/**
 * Claim the turn-tail chain only when the closing turn retrieved passages.
 * @param owner - turn-tail owner currency for the closing assistant.
 * @returns the citations as the component's match, or null to decline before mount.
 */
export function selectCitations(owner: TurnTailOwnerProps): readonly RetrievedCitation[] | null {
  const citations = citationsForClosing(owner.turn.data.get('knowledge'), owner.seq)
  return citations.length === 0 ? null : citations
}

/** Turn-local retrieval accumulator; it publishes no view Node. */
export const knowledgeTurn: ConversationNodeDefinition<KnowledgeState> = {
  kind: 'knowledge',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('knowledge start requires turn/start')
    return { turn: match.event.data.turn, citations: [] }
  },
  update: (context, match) => {
    if (match.event.type !== 'tool/result') return context.state
    if (match.event.data.message.isError === true) return context.state
    const printed = citationsInText(toolText(match.event.data.message.content))
    if (printed.length === 0) return context.state
    const known = new Set(context.state.citations.map(citation => citation.chunkId))
    const added: RetrievedCitation[] = []
    for (const citation of printed) {
      if (known.has(citation.chunkId)) continue
      known.add(citation.chunkId)
      added.push({ ...citation, seq: match.event.seq })
    }
    return added.length === 0 ? context.state : { ...context.state, citations: [...context.state.citations, ...added] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'knowledge'
      && previous.value.citations === context.state.citations) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'knowledge',
      value: { citations: context.state.citations },
    }
  },
}

/**
 * @param content - a tool result's blocks.
 * @returns the text a command printed, with non-text blocks left out.
 */
function toolText(content: readonly { readonly type: string }[]): string {
  const printed: string[] = []
  for (const block of content) {
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') printed.push(block.text)
  }
  return printed.join('\n')
}

/**
 * Every citation named by one printed tool result.
 * @param printed - the tool result text.
 * @returns the citations it names, in printed order.
 */
function citationsInText(printed: string): readonly Citation[] {
  const citations: Citation[] = []
  for (const value of jsonObjects(printed)) {
    if (!isRecord(value) || !Array.isArray(value.citations)) continue
    const rows: readonly unknown[] = value.citations
    for (const row of rows) {
      const citation = fromPrinted(row)
      if (citation === undefined || citations.some(item => item.chunkId === citation.chunkId)) continue
      citations.push(citation)
    }
  }
  return citations
}

/**
 * @param row - one printed `search` citation, whose fields are snake_case.
 * @returns the citation, or undefined when the row names no chunk.
 */
function fromPrinted(row: unknown): Citation | undefined {
  if (!isRecord(row)) return undefined
  const chunkId = text(row.chunk_id)
  if (chunkId === undefined) return undefined
  return {
    chunkId,
    knowledgeId: text(row.knowledge_id) ?? '',
    knowledgeBaseId: text(row.knowledge_base_id) ?? '',
    title: text(row.title) ?? '',
    chunkIndex: indexOf(row.chunk_index),
    score: typeof row.score === 'number' ? row.score : 0,
    snippet: snippetOf(row.snippet) ?? '',
  }
}

/**
 * Every JSON object embedded in printed text.
 *
 * A command's output can carry a status line around its payload, so the scan
 * walks brace pairs instead of parsing the whole string. Unterminated or
 * non-JSON spans are skipped: the text is a tool result, not a contract.
 * @param printed - one tool result text.
 * @returns the objects that parsed, in printed order.
 */
function jsonObjects(printed: string): readonly unknown[] {
  const found: unknown[] = []
  for (let index = 0; index < printed.length; index += 1) {
    if (printed[index] !== '{') continue
    const end = objectEnd(printed, index)
    if (end === -1) continue
    try {
      found.push(JSON.parse(printed.slice(index, end)) as unknown)
    } catch {
      // Ignored on purpose: a stray brace in prose must not hide later payloads.
    }
    index = end - 1
  }
  return found
}

/**
 * @param printed - text to scan.
 * @param start - index of an opening brace.
 * @returns the index just past its closing brace, or -1 when unbalanced.
 */
function objectEnd(printed: string, start: number): number {
  let depth = 0
  let quoted = false
  for (let index = start; index < printed.length; index += 1) {
    const char = printed[index]
    if (quoted) {
      if (char === '\\') index += 1
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}
