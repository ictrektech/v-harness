/**
 * The knowledge-base gateway client shared by the `@` menu, the evidence tab,
 * and the citation strip.
 *
 * Every request goes to `/__vh/weknora/...`, which forwards the signed-in
 * user's own VOS token upstream: neither the browser nor the agent holds a
 * knowledge-base credential, and every surface shows exactly the libraries
 * this user may read.
 */

/** Gateway prefix that forwards to WeKnora as the signed-in user. */
const ENDPOINT = '/__vh/weknora/api/v1'

/** How many passages one search may return. */
const MATCH_COUNT = 8

/** Longest passage text kept with a citation; the strip only needs a preview. */
const SNIPPET_CHARS = 400

/** One knowledge base the caller can search. */
export interface Library {
  readonly id: string
  readonly name: string
}

/**
 * One retrieved passage.
 *
 * The `weknora` skill prints the same five fields for the chunk it retrieved,
 * so a chip from the conversation and a row in the tab describe one thing with
 * one type rather than two look-alike shapes.
 */
export interface KnowledgeCitation {
  readonly chunkId: string
  readonly title: string
  readonly chunkIndex: number
  /** Document the chunk belongs to, when the source named it. */
  readonly knowledgeId?: string | undefined
  /** Passage text, capped at {@link SNIPPET_CHARS}. */
  readonly snippet?: string | undefined
}

/** Successful listings only; a failed attempt retries on the next call. */
let cached: readonly Library[] | undefined

/**
 * The libraries this caller can read, fetched once per page.
 * @param signal - cancellation of this attempt.
 * @returns the libraries, or undefined when the gateway cannot list them.
 */
export async function libraries(signal: AbortSignal): Promise<readonly Library[] | undefined> {
  // `??=` keeps a failed attempt uncached, so a service that comes back is
  // picked up without a reload.
  cached ??= await fetchLibraries(signal)
  return cached
}

/**
 * Search the given libraries (all of them when `scope` is empty), optionally
 * narrowed to individual documents.
 * @param query - the keywords to look for.
 * @param scope - library ids to search inside.
 * @param documents - document ids to search inside; empty means the whole library.
 * @param signal - cancellation of this attempt.
 * @returns the passages, or undefined when the gateway cannot search.
 */
export async function search(
  query: string,
  scope: readonly string[],
  documents: readonly string[] = [],
  signal?: AbortSignal,
): Promise<readonly KnowledgeCitation[] | undefined> {
  const response = await fetch(`${ENDPOINT}/knowledge-search`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      knowledge_base_ids: [...scope],
      ...(documents.length === 0 ? {} : { knowledge_ids: [...documents] }),
      match_count: MATCH_COUNT,
    }),
    ...(signal === undefined ? {} : { signal }),
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  const body = (await response.json()) as { data?: unknown }
  const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : []
  const found: KnowledgeCitation[] = []
  for (const row of rows) {
    const citation = citationOf(row)
    if (citation !== undefined) found.push(citation)
  }
  return found
}

/** One document a library contains. */
export interface KnowledgeDocument {
  readonly id: string
  readonly name: string
}

/**
 * The documents inside one library.
 * @param kbId - the library to list.
 * @param signal - cancellation of this attempt.
 * @returns the documents, or undefined when the gateway cannot list them.
 */
export async function documents(
  kbId: string,
  signal: AbortSignal,
): Promise<readonly KnowledgeDocument[] | undefined> {
  const response = await fetch(
    `${ENDPOINT}/knowledge-bases/${encodeURIComponent(kbId)}/knowledge?page=1&page_size=50`,
    { credentials: 'same-origin', signal },
  ).catch(() => undefined)
  if (!response?.ok) return undefined
  const body = (await response.json()) as { data?: unknown }
  const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : []
  const found: KnowledgeDocument[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = text(row.id)
    if (id === undefined) continue
    found.push({ id, name: text(row.title) ?? text(row.file_name) ?? id })
  }
  return found
}

/** One chunk of a document, in reading order. */
export interface DocumentChunk {
  readonly chunkIndex: number
  readonly content: string
}

/**
 * Every chunk of one document, so a citation can expand to the real text
 * instead of the truncated snippet a search returned.
 * @param knowledgeId - the document to read.
 * @param signal - cancellation of this attempt.
 * @returns the chunks in order, or undefined when the gateway cannot read them.
 */
export async function readDocument(
  knowledgeId: string,
  signal: AbortSignal,
): Promise<readonly DocumentChunk[] | undefined> {
  const response = await fetch(
    `${ENDPOINT}/chunks/${encodeURIComponent(knowledgeId)}?page=1&page_size=100`,
    { credentials: 'same-origin', signal },
  ).catch(() => undefined)
  if (!response?.ok) return undefined
  const body = (await response.json()) as { data?: unknown }
  const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : []
  const chunks: DocumentChunk[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const content = text(row.content)
    if (content === undefined) continue
    chunks.push({ chunkIndex: indexOf(row.chunk_index), content })
  }
  return chunks.sort((left, right) => left.chunkIndex - right.chunkIndex)
}

/** One chat model this workspace offers. */
export interface ModelOption {
  readonly id: string
  readonly name: string
}

/**
 * The workspace's chat models.
 * @param signal - cancellation of this attempt.
 * @returns the models, or undefined when the gateway cannot list them.
 */
export async function models(signal: AbortSignal): Promise<readonly ModelOption[] | undefined> {
  const response = await fetch(`${ENDPOINT}/models`, { credentials: 'same-origin', signal })
    .catch(() => undefined)
  if (!response?.ok) return undefined
  const body = (await response.json()) as { data?: unknown }
  const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : []
  const found: ModelOption[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = text(row.id)
    const name = text(row.name)
    if (id === undefined || name === undefined) continue
    found.push({ id, name })
  }
  return found
}

/** The answer one `ask` call produced, with the passages that grounded it. */
export interface AskResult {
  readonly answer: string
  readonly citations: readonly KnowledgeCitation[]
}

/**
 * Ask inside the given libraries through WeKnora's own RAG chat.
 *
 * Creates a session, then reads the SSE stream to completion and folds the
 * `answer` pieces into one string and the `references` event into citations.
 * @param query - the question.
 * @param scope - library ids and document ids to ground the answer in.
 * @param modelId - chat model override; empty keeps the workspace default.
 * @param signal - cancellation of this attempt.
 * @returns the answer and its citations, or undefined when the gateway cannot answer.
 */
export async function ask(
  query: string,
  scope: { readonly kbIds: readonly string[]; readonly docIds: readonly string[] },
  modelId: string,
  signal: AbortSignal,
): Promise<AskResult | undefined> {
  const created = await fetch(`${ENDPOINT}/sessions`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: query.slice(0, 40) }),
    signal,
  }).catch(() => undefined)
  if (!created?.ok) return undefined
  const session = (await created.json()) as { data?: unknown }
  const sessionId = isRecord(session.data) ? text(session.data.id) : undefined
  if (sessionId === undefined) return undefined

  const response = await fetch(`${ENDPOINT}/knowledge-chat/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      query,
      knowledge_base_ids: [...scope.kbIds],
      ...(scope.docIds.length === 0 ? {} : { knowledge_ids: [...scope.docIds] }),
      ...(modelId === '' ? {} : { model_id: modelId }),
    }),
    signal,
  }).catch(() => undefined)
  if (!response?.ok) return undefined

  const stream = await response.text()
  let answer = ''
  const citations: KnowledgeCitation[] = []
  for (const line of stream.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let event: unknown
    try {
      event = JSON.parse(payload) as unknown
    } catch {
      continue
    }
    if (!isRecord(event)) continue
    if (event.response_type === 'answer' && typeof event.content === 'string') answer += event.content
    if (event.response_type !== 'references') continue
    const references: readonly unknown[] = Array.isArray(event.knowledge_references) ? event.knowledge_references : []
    for (const row of references) {
      const citation = citationOf(row)
      if (citation !== undefined && !citations.some(item => item.chunkId === citation.chunkId)) {
        citations.push(citation)
      }
    }
  }
  return { answer, citations }
}

/**
 * @param signal - cancellation of this attempt.
 * @returns the libraries, or undefined when this attempt failed.
 */
async function fetchLibraries(signal: AbortSignal): Promise<readonly Library[] | undefined> {
  const response = await fetch(`${ENDPOINT}/knowledge-bases`, { credentials: 'same-origin', signal })
    .catch(() => undefined)
  if (!response?.ok) return undefined
  const body = (await response.json()) as { data?: unknown }
  const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : []
  const found: Library[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = text(row.id)
    const name = text(row.name)
    if (id === undefined || name === undefined) continue
    found.push({ id, name })
  }
  return found
}

/**
 * Read one upstream search row, whose fields are the same snake_case names the
 * `weknora` skill prints.
 * @param row - one entry of the search response's `data`.
 * @returns the citation, or undefined when the row identifies no chunk.
 */
function citationOf(row: unknown): KnowledgeCitation | undefined {
  if (!isRecord(row)) return undefined
  const chunkId = text(row.id)
  if (chunkId === undefined) return undefined
  return {
    chunkId,
    title: text(row.knowledge_title) ?? text(row.knowledge_filename) ?? '',
    chunkIndex: indexOf(row.chunk_index),
    knowledgeId: text(row.knowledge_id),
    snippet: snippetOf(row.content),
  }
}

/**
 * @param value - a parsed JSON value.
 * @returns whether it is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param value - a parsed JSON value.
 * @returns it when it is a non-empty string.
 */
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * @param value - a parsed JSON value.
 * @returns the chunk position, defaulting to the first one.
 */
export function indexOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : 0
}

/**
 * @param value - a parsed JSON value holding passage text.
 * @returns the passage, capped at {@link SNIPPET_CHARS}.
 */
export function snippetOf(value: unknown): string | undefined {
  const passage = text(value)
  if (passage === undefined) return undefined
  return passage.length > SNIPPET_CHARS ? `${passage.slice(0, SNIPPET_CHARS)}…` : passage
}
