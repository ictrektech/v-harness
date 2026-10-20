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
 * Search the given libraries (all of them when `scope` is empty).
 * @param query - the keywords to look for.
 * @param scope - library ids to search inside.
 * @param signal - cancellation of this attempt.
 * @returns the passages, or undefined when the gateway cannot search.
 */
export async function search(
  query: string,
  scope: readonly string[],
  signal?: AbortSignal,
): Promise<readonly KnowledgeCitation[] | undefined> {
  const response = await fetch(`${ENDPOINT}/knowledge-search`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, knowledge_base_ids: [...scope], match_count: MATCH_COUNT }),
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
