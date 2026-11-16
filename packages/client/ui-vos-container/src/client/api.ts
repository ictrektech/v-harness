/**
 * Gateway client for the VOS application containers the composer may reference.
 *
 * The listing rides the operations route with the caller's own browser session:
 * the gateway answers only for a VOS system administrator whose conversation
 * carries the operations preset, and it returns the same narrowed container set
 * the in-session tool operates on. A refusal is an answer, not an error — it is
 * what keeps the source out of the menu for everyone else.
 *
 * @module @deepseek-ai/dsh-client-ui-vos-container/client
 */

/** Gateway route answering the application-container listing. */
const LIST_ENDPOINT = '/__vh/vos-ops/containers'

/** Rows this client is willing to keep from one answer. */
const MAX_ROWS = 500

/** One VOS application container; unknown upstream fields are ignored. */
export interface VosContainer {
  readonly id: string
  readonly name: string
  readonly appId: string
  readonly version: string
  readonly state: string
  readonly status: string
}

/** One listing attempt: the containers, or the reason the gateway refused. */
export type ListResult =
  | { readonly ok: true; readonly containers: readonly VosContainer[] }
  | { readonly ok: false; readonly reason: 'forbidden' | 'failed' }

/**
 * @param value - unknown parsed field.
 * @returns the field when it is a string, otherwise an empty string.
 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * @param value - unknown parsed value.
 * @returns whether the value can be read by key.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * @param value - one upstream row.
 * @returns the container, or undefined when the row cannot name a target.
 */
function containerOf(value: unknown): VosContainer | undefined {
  if (!isRecord(value)) return undefined
  const id = textOf(value.id)
  const name = textOf(value.name)
  if (id === '' || name === '') return undefined
  return {
    id,
    name,
    appId: textOf(value.appId),
    version: textOf(value.version),
    state: textOf(value.state),
    status: textOf(value.status),
  }
}

/**
 * List the VOS application containers this conversation may reference.
 * @param sessionId - the conversation whose operations preset authorizes the read.
 * @param signal - aborted when the menu closes for good.
 * @returns the containers, or the reason there are none.
 */
export async function listContainers(
  sessionId: string,
  signal: AbortSignal,
): Promise<ListResult> {
  let response: Response
  try {
    response = await fetch(`${LIST_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, {
      signal,
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'x-vh-ops': '1' },
    })
  } catch {
    return { ok: false, reason: 'failed' }
  }
  if (!response.ok) {
    return { ok: false, reason: response.status === 401 || response.status === 403 ? 'forbidden' : 'failed' }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body) || !Array.isArray(body.containers)) return { ok: false, reason: 'failed' }
  return {
    ok: true,
    containers: body.containers
      .flatMap((row: unknown) => {
        const container = containerOf(row)
        return container === undefined ? [] : [container]
      })
      .slice(0, MAX_ROWS),
  }
}
