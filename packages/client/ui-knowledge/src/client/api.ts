/**
 * Gateway client for the knowledge-base surfaces.
 *
 * Every request goes to `/__vh/weknora/...`, which forwards the signed-in
 * user's own VOS token upstream: neither the browser nor the agent holds a
 * knowledge-base credential, and every surface shows exactly the libraries
 * this user may read. A failed call returns undefined and leaves the reason in
 * {@link failureOf}, so a surface can name the cause instead of showing an
 * empty list.
 */

/** Gateway prefix that forwards to HybRAG as the signed-in user. */
const ENDPOINT = '/__vh/weknora/api/v1'

/** Passages one search may return. */
const MATCH_COUNT = 8

/** Longest passage text kept with a citation; the card only needs a preview. */
const SNIPPET_CHARS = 400

/** Documents listed per library when the panel opens one. */
const DOCUMENT_PAGE_SIZE = 100

/** One knowledge base the caller can read. */
export interface Library {
  readonly id: string
  readonly name: string
  /** `document`, `faq` or `wiki`; drives the row glyph. */
  readonly type: string
}

/** One document inside a library. */
export interface Document {
  readonly id: string
  readonly name: string
  /** Canonical folder path; empty at the library root. */
  readonly folder: string
}

/** One retrieved passage. */
export interface Citation {
  readonly chunkId: string
  readonly knowledgeId: string
  readonly title: string
  readonly chunkIndex: number
  readonly score: number
  /** Passage text, capped at {@link SNIPPET_CHARS}. */
  readonly snippet: string
}

/** One chunk of a document, in reading order. */
export interface Chunk {
  readonly chunkIndex: number
  readonly content: string
}

/** Why the last call failed, so a surface can print the gateway's own words. */
let lastFailure: string | undefined

/**
 * @returns why the last call failed, or undefined when it worked.
 */
export function failureOf(): string | undefined {
  return lastFailure
}

/** Successful library listings only; a failed attempt retries on the next call. */
let cachedLibraries: readonly Library[] | undefined

/**
 * Drop the cached library list so the next call retries the gateway.
 * @returns nothing.
 */
export function forgetLibraries(): void {
  cachedLibraries = undefined
}

/**
 * @param response - the gateway's answer, or undefined when the request never left.
 * @returns status plus the gateway's error code and message.
 */
async function describeFailure(response: Response | undefined): Promise<string> {
  if (response === undefined) return '网关不可达'
  const body = (await response.json().catch(() => undefined)) as unknown
  const fields = isRecord(body) ? [text(body.error), text(body.message)] : []
  return [`HTTP ${String(response.status)}`, ...fields].filter(part => part !== undefined && part !== '').join(' ')
}

/**
 * One GET returning parsed JSON, or undefined with {@link failureOf} set.
 * @param path - path after the endpoint prefix.
 * @param signal - cancellation of this attempt.
 * @returns the parsed body, or undefined on failure.
 */
async function get(path: string, signal: AbortSignal): Promise<{ data?: unknown } | undefined> {
  const response = await fetch(`${ENDPOINT}${path}`, { credentials: 'same-origin', signal })
    .catch(() => undefined)
  if (!response?.ok) {
    lastFailure = await describeFailure(response)
    return undefined
  }
  lastFailure = undefined
  return (await response.json()) as { data?: unknown }
}

/**
 * The libraries this caller can read, fetched once per page.
 * @param signal - cancellation of this attempt.
 * @returns the libraries, or undefined when the gateway cannot list them.
 */
export async function libraries(signal: AbortSignal): Promise<readonly Library[] | undefined> {
  if (cachedLibraries !== undefined) return cachedLibraries
  const body = await get('/knowledge-bases', signal)
  if (body === undefined) return undefined
  const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : []
  const found: Library[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = text(row.id)
    const name = text(row.name)
    if (id === undefined || name === undefined) continue
    found.push({ id, name, type: text(row.type) ?? 'document' })
  }
  cachedLibraries = found
  return found
}

/**
 * The documents inside one library.
 * @param kbId - the library to list.
 * @param keyword - optional server-side filter.
 * @param signal - cancellation of this attempt.
 * @returns the documents, or undefined when the gateway cannot list them.
 */
export async function documents(
  kbId: string,
  keyword: string,
  signal: AbortSignal,
): Promise<readonly Document[] | undefined> {
  const query = new URLSearchParams({ page: '1', page_size: String(DOCUMENT_PAGE_SIZE) })
  if (keyword !== '') query.set('keyword', keyword)
  const body = await get(`/knowledge-bases/${encodeURIComponent(kbId)}/knowledge?${query.toString()}`, signal)
  if (body === undefined) return undefined
  const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : []
  const found: Document[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = text(row.id)
    if (id === undefined) continue
    found.push({
      id,
      name: text(row.title) ?? text(row.file_name) ?? id,
      folder: text(row.folder_path) ?? '',
    })
  }
  return found
}

/**
 * Search the given scope.
 * @param query - the keywords to look for.
 * @param scope - library ids and document ids; at least one must be present.
 * @param signal - cancellation of this attempt.
 * @returns the passages, or undefined when the gateway cannot search.
 */
export async function search(
  query: string,
  scope: { readonly libraries: readonly string[]; readonly documents: readonly string[] },
  signal: AbortSignal,
): Promise<readonly Citation[] | undefined> {
  const response = await fetch(`${ENDPOINT}/knowledge-search`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      knowledge_base_ids: [...scope.libraries],
      ...(scope.documents.length === 0 ? {} : { knowledge_ids: [...scope.documents] }),
      match_count: MATCH_COUNT,
    }),
    signal,
  }).catch(() => undefined)
  if (!response?.ok) {
    lastFailure = await describeFailure(response)
    return undefined
  }
  lastFailure = undefined
  const body = (await response.json()) as { data?: unknown }
  const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : []
  const found: Citation[] = []
  for (const row of rows) {
    const citation = citationOf(row)
    if (citation !== undefined) found.push(citation)
  }
  return found
}

/**
 * Every chunk of one document, so a snippet can expand to the real text.
 * @param knowledgeId - the document to read.
 * @param signal - cancellation of this attempt.
 * @returns the chunks in order, or undefined when the gateway cannot read them.
 */
export async function readDocument(
  knowledgeId: string,
  signal: AbortSignal,
): Promise<readonly Chunk[] | undefined> {
  const body = await get(
    `/chunks/${encodeURIComponent(knowledgeId)}?page=1&page_size=${String(DOCUMENT_PAGE_SIZE)}`,
    signal,
  )
  if (body === undefined) return undefined
  const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : []
  const chunks: Chunk[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const content = text(row.content)
    if (content === undefined) continue
    chunks.push({ chunkIndex: indexOf(row.chunk_index), content })
  }
  return chunks.sort((left, right) => left.chunkIndex - right.chunkIndex)
}

/**
 * Read one upstream search row, whose fields are the snake_case names the
 * server returns.
 * @param row - one entry of the search response's `data`.
 * @returns the citation, or undefined when the row identifies no chunk.
 */
export function citationOf(row: unknown): Citation | undefined {
  if (!isRecord(row)) return undefined
  const chunkId = text(row.id)
  if (chunkId === undefined) return undefined
  return {
    chunkId,
    knowledgeId: text(row.knowledge_id) ?? '',
    title: text(row.knowledge_title) ?? '',
    chunkIndex: indexOf(row.chunk_index),
    score: typeof row.score === 'number' ? row.score : 0,
    snippet: snippetOf(row.content) ?? '',
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

/** One chat model the workspace offers. */
export interface ModelOption {
  readonly id: string
  readonly name: string
}

/**
 * The workspace's chat models, used for the answer mode's model picker.
 * @param signal - cancellation of this attempt.
 * @returns the models, or undefined when the gateway cannot list them.
 */
export async function models(signal: AbortSignal): Promise<readonly ModelOption[] | undefined> {
  const body = await get('/models', signal)
  if (body === undefined) return undefined
  const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : []
  const found: ModelOption[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = text(row.id)
    if (id === undefined) continue
    found.push({ id, name: text(row.name) ?? text(row.model_name) ?? id })
  }
  return found
}

/** The answer one `ask` call produced, with the passages that grounded it. */
export interface AskResult {
  readonly answer: string
  readonly citations: readonly Citation[]
}

/**
 * Ask inside the given scope through HybRAG's own RAG chat.
 *
 * Creates a session, then reads the SSE stream to completion and folds the
 * `answer` pieces into one string and the `references` event into citations.
 * @param query - the question.
 * @param scope - library ids and document ids to ground the answer in.
 * @param modelId - summary model override; empty keeps the workspace default.
 * @param signal - cancellation of this attempt.
 * @returns the answer and its citations, or undefined when the gateway cannot answer.
 */
export async function ask(
  query: string,
  scope: { readonly libraries: readonly string[]; readonly documents: readonly string[] },
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
  if (!created?.ok) {
    lastFailure = await describeFailure(created)
    return undefined
  }
  const session = (await created.json()) as { data?: unknown }
  const sessionId = isRecord(session.data) ? text(session.data.id) : text(session.data)
  if (sessionId === undefined) {
    lastFailure = '会话创建失败'
    return undefined
  }

  const response = await fetch(`${ENDPOINT}/knowledge-chat/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      query,
      knowledge_base_ids: [...scope.libraries],
      ...(scope.documents.length === 0 ? {} : { knowledge_ids: [...scope.documents] }),
      ...(modelId === '' ? {} : { summary_model_id: modelId }),
    }),
    signal,
  }).catch(() => undefined)
  if (!response?.ok) {
    lastFailure = await describeFailure(response)
    return undefined
  }

  const stream = await response.text()
  let answer = ''
  const citations: Citation[] = []
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
    if (event.response_type !== 'references' || !Array.isArray(event.knowledge_references)) continue
    for (const row of event.knowledge_references) {
      const citation = citationOf(row)
      if (citation === undefined || citations.some(item => item.chunkId === citation.chunkId)) continue
      citations.push(citation)
    }
  }
  return { answer, citations }
}
