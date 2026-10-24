/**
 * Gateway client for the signed-in user's V-Office folder.
 *
 * The page holds neither the tenant's capability socket nor a VOS token, so
 * the listing comes from `/__vh/office/list`, where the gateway forwards the
 * caller's own identity upstream. A failed call returns undefined and leaves
 * the reason in {@link failureOf}, so the menu can name the cause instead of
 * showing an empty list.
 *
 * @module @deepseek-ai/dsh-client-ui-voffice/client
 */

/** Gateway route answering this user's document listing. */
const LIST_ENDPOINT = '/__vh/office/list'

/** Gateway route that redirects into an online editor session. */
const OPEN_ENDPOINT = '/__vh/office/open'

/** Longest failure text kept for the menu row. */
const FAILURE_CHARS = 120

/** One document in the user's folder; unknown upstream fields are ignored. */
export interface VofficeFile {
  readonly name: string
}

/** Why the last {@link listDocuments} call failed, when it did. */
let failure: string | undefined

/**
 * @returns the last listing failure's message, or undefined when it succeeded.
 */
export function failureOf(): string | undefined {
  return failure
}

/**
 * Read a failure message out of an unknown gateway body.
 * @param body - parsed response body, when it parsed.
 * @param status - HTTP status used when the body names no message.
 * @returns a short, user-readable reason.
 */
function reasonOf(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
    return body.message.slice(0, FAILURE_CHARS)
  }
  return `HTTP ${String(status)}`
}

/**
 * List the current user's documents.
 * @param signal - aborted when the user keeps typing or closes the menu.
 * @returns the documents, or undefined when the call failed.
 */
export async function listDocuments(signal: AbortSignal): Promise<readonly VofficeFile[] | undefined> {
  failure = undefined
  let response: Response
  try {
    response = await fetch(LIST_ENDPOINT, {
      signal,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    // A superseded request is not a failure worth showing: the user is typing.
    if (signal.aborted) return undefined
    failure = error instanceof Error ? error.message : String(error)
    return undefined
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    failure = reasonOf(body, response.status)
    return undefined
  }
  if (typeof body !== 'object' || body === null || !('files' in body) || !Array.isArray(body.files)) {
    failure = 'unexpected response'
    return undefined
  }
  return body.files.flatMap((row: unknown) =>
    typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string' && row.name !== ''
      ? [{ name: row.name }]
      : [])
}

/**
 * Open one document's online-editor session in a new tab.
 * @param name - the document's cloud name, exactly as the listing returned it.
 */
export function openDocument(name: string): void {
  window.open(`${OPEN_ENDPOINT}?name=${encodeURIComponent(name)}`, '_blank', 'noopener')
}
