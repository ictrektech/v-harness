/**
 * Turn-scoped knowledge citations: the passages this run actually retrieved.
 *
 * The source is the Session's own `tool/result` events, never the closing prose
 * and never a re-query. The `weknora` skill prints one JSON object per call, and
 * only the two shapes it prints are read here — `search`'s `citations` array and
 * `read`'s `chunks` array beside its `knowledge` header. A result carrying
 * neither contributes nothing, so an unrelated command cannot invent a source,
 * and a re-run of the same search stays one chip.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  indexOf, isRecord, snippetOf, text, type KnowledgeCitation, type Library,
} from './weknora.ts'

/** One passage with the sequence of the tool result that returned it. */
export interface RetrievedCitation extends KnowledgeCitation {
  readonly seq: number
}

/** Immutable knowledge facts published against one Turn. */
export interface KnowledgeTurnData {
  readonly citations: readonly RetrievedCitation[]
  /** Libraries the run listed, in first-seen order; a `health` call fills it. */
  readonly libraries: readonly Library[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Passages and libraries the run named in this Turn, in first-seen order. */
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
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns the citations as the component's match, or null to decline before mount.
 */
export function selectRetrieved(owner: TurnTailOwnerProps): readonly RetrievedCitation[] | null {
  const citations = citationsForClosing(owner.turn.data.get('knowledge'), owner.seq)
  return citations.length === 0 ? null : citations
}

/**
 * The libraries the closing turn listed.
 *
 * A `health` call prints them, so the tail can show "which libraries exist"
 * without the user opening any page — the answer names them, the card backs it.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns the libraries, empty when the turn listed none.
 */
export function selectLibraries(owner: TurnTailOwnerProps): readonly Library[] {
  return owner.turn.data.get('knowledge')?.libraries ?? []
}

/** Turn-local retrieval accumulator; it publishes no view Node. */
export const knowledgeDefinition: ConversationNodeDefinition<KnowledgeState> = {
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
    return { turn: match.event.data.turn, citations: [], libraries: [] }
  },
  update: (context, match) => {
    if (match.event.type !== 'tool/result') return context.state
    if (match.event.data.message.isError === true) return context.state
    const printed = knowledgeInText(toolText(match.event.data.message.content))
    if (printed.citations.length === 0 && printed.libraries.length === 0) return context.state
    const known = new Set(context.state.citations.map(citation => citation.chunkId))
    const added: RetrievedCitation[] = []
    for (const citation of printed.citations) {
      if (known.has(citation.chunkId)) continue
      known.add(citation.chunkId)
      added.push({ ...citation, seq: match.event.seq })
    }
    const knownLibraries = new Set(context.state.libraries.map(library => library.id))
    const addedLibraries = printed.libraries.filter(library => !knownLibraries.has(library.id))
    if (added.length === 0 && addedLibraries.length === 0) return context.state
    return {
      ...context.state,
      citations: [...context.state.citations, ...added],
      libraries: [...context.state.libraries, ...addedLibraries],
    }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'knowledge'
      && previous.value.citations === context.state.citations
      && previous.value.libraries === context.state.libraries) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'knowledge',
      value: { citations: context.state.citations, libraries: context.state.libraries },
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

/** Citations and libraries named by one printed tool result. */
interface PrintedKnowledge {
  readonly citations: readonly KnowledgeCitation[]
  readonly libraries: readonly Library[]
}

/**
 * Every knowledge fact printed in one tool result.
 * @param printed - the tool result text.
 * @returns the citations and libraries it names, in printed order.
 */
function knowledgeInText(printed: string): PrintedKnowledge {
  const citations: KnowledgeCitation[] = []
  const libraries: Library[] = []
  for (const value of jsonObjects(printed)) collect(value, citations, libraries)
  return { citations, libraries }
}

/**
 * Read one printed JSON object, accepting every shape the skill emits: `search`
 * citations, `read` chunks, and the `knowledge_bases` list a `health` call
 * prints. One result may name both, so the shapes are independent, not exclusive.
 * @param value - one parsed object.
 * @param citations - accumulator for the passages it names.
 * @param libraries - accumulator for the libraries it lists.
 */
function collect(value: unknown, citations: KnowledgeCitation[], libraries: Library[]): void {
  if (!isRecord(value)) return
  collectLibraries(value.knowledge_bases, libraries)
  if (Array.isArray(value.citations)) {
    const rows: readonly unknown[] = value.citations
    for (const row of rows) {
      const citation = searchCitation(row)
      if (citation === undefined || citations.some(item => item.chunkId === citation.chunkId)) continue
      citations.push(citation)
    }
  }
  if (!Array.isArray(value.chunks)) return
  const rows: readonly unknown[] = value.chunks
  const knowledge = isRecord(value.knowledge) ? value.knowledge : {}
  const title = text(knowledge.title) ?? ''
  const knowledgeId = text(knowledge.id)
  for (const row of rows) {
    const citation = readCitation(row, title, knowledgeId)
    if (citation !== undefined) citations.push(citation)
  }
}

/**
 * Read the `knowledge_bases` field of one printed object.
 * @param value - the field, which a failed `health` leaves out.
 * @param into - accumulator for the libraries it names.
 */
function collectLibraries(value: unknown, into: Library[]): void {
  if (!Array.isArray(value)) return
  for (const row of value) {
    if (!isRecord(row)) continue
    const id = text(row.id)
    const name = text(row.name)
    if (id === undefined || name === undefined) continue
    if (!into.some(library => library.id === id)) into.push({ id, name })
  }
}

/**
 * @param row - one `search` citation.
 * @returns the citation, or undefined when the row names no chunk.
 */
function searchCitation(row: unknown): KnowledgeCitation | undefined {
  if (!isRecord(row)) return undefined
  const chunkId = text(row.chunk_id)
  if (chunkId === undefined) return undefined
  return {
    chunkId,
    title: text(row.title) ?? '',
    chunkIndex: indexOf(row.chunk_index),
    knowledgeId: text(row.knowledge_id),
    snippet: snippetOf(row.snippet),
  }
}

/**
 * @param row - one `read` chunk, which carries its document in the header.
 * @param title - document title from the header.
 * @param knowledgeId - document id from the header.
 * @returns the citation, or undefined when the row names no chunk.
 */
function readCitation(
  row: unknown,
  title: string,
  knowledgeId: string | undefined,
): KnowledgeCitation | undefined {
  if (!isRecord(row)) return undefined
  const chunkId = text(row.chunk_id)
  if (chunkId === undefined) return undefined
  return {
    chunkId,
    title,
    chunkIndex: indexOf(row.chunk_index),
    knowledgeId,
    snippet: snippetOf(row.content),
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
    // A span that looks like an object but is not JSON is ordinary output.
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
