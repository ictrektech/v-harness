/**
 * The gateway faces the browser with JSON only, under `/__vh/mcphub/*`. Nothing
 * here names the tenant — the browser carries the portal cookie, and the
 * gateway resolves the user from it before attaching that user's VOS token
 * upstream.
 */

/** One MCPHub service, as the gateway's rebuilt answer returns it. */
export interface McphubServer {
  readonly name: string
  readonly description: string
  /** `private`, `public`, `group`, or a value a newer MCPHub introduced. */
  readonly visibility: string
  /** `running`, `stopped`, `disconnected`, or a value a newer MCPHub introduced. */
  readonly status: string
}

/** One read of the service list, including why it may be empty. */
export interface McphubSnapshot {
  /** Whether the sibling MCPHub answered at all. */
  readonly available: boolean
  /** Whether the gateway held a VOS token for this user. */
  readonly authorized: boolean
  readonly servers: readonly McphubServer[]
  /** `all` (every visible service) or `smart` (MCPHub's vector router). */
  readonly routing: string
  /** A transport or upstream status code, when the read itself failed. */
  readonly error?: string
}

/** One tool a service exposes, as the preview shows it. */
export interface McphubTool {
  readonly name: string
  readonly description: string
  readonly enabled: boolean
}

/** A management action the page may take on one service. */
export type McphubServerAction = 'toggle' | 'reload'

/** One service and the tools behind it. */
export interface McphubToolServer {
  readonly name: string
  readonly tools: readonly McphubTool[]
}

/** One read of every service's tools. */
export interface McphubToolsSnapshot {
  readonly available: boolean
  readonly authorized: boolean
  readonly servers: readonly McphubToolServer[]
  /** A transport or upstream status code, when the read itself failed. */
  readonly error?: string
}

/** What the page calls; the gateway owns every upstream detail. */
export interface McphubFace {
  /**
   * Read the services this user may use.
   * @param signal - aborts the read when the page unmounts.
   * @returns the snapshot, or throws when the gateway itself refused the read.
   */
  readonly load: (signal?: AbortSignal) => Promise<McphubSnapshot>
  /**
   * Read the tools behind those services.
   * @param signal - aborts the read when the page unmounts.
   * @returns the preview, or throws when the gateway itself refused the read.
   */
  readonly loadTools: (signal?: AbortSignal) => Promise<McphubToolsSnapshot>
  /**
   * Read which services the Agent currently mounts.
   * @param signal - aborts the read when the page unmounts.
   * @returns the chosen names, or null when the Agent follows every service.
   */
  readonly loadSelection: (signal?: AbortSignal) => Promise<readonly string[] | null>
  /**
   * Record the services the Agent should mount on the next launch.
   * @param names - the chosen services, or null for every visible service.
   * @returns resolves once the gateway recorded the choice.
   */
  readonly saveSelection: (names: readonly string[] | null) => Promise<void>
  /**
   * Start, stop or reload one service in MCPHub.
   * @param name - the service to act on.
   * @param action - what to do; `toggle` carries the desired state.
   * @param enabled - the desired state, for `toggle`.
   * @returns resolves once MCPHub accepted the action.
   */
  readonly act: (name: string, action: McphubServerAction, enabled?: boolean) => Promise<void>
}

/**
 * Read a JSON object body, or an empty record when the gateway sent none.
 * @param response - the gateway's answer.
 * @returns the parsed body.
 */
async function objectBody(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const body: unknown = await response.json().catch(() => undefined)
  return body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
}

/**
 * Whether a wire value has the fields the row needs.
 * @param value - one entry of the gateway's `servers` array.
 * @returns whether the entry is a displayable service.
 */
function isServer(value: unknown): value is McphubServer {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.name === 'string'
    && typeof entry.description === 'string'
    && typeof entry.visibility === 'string'
    && typeof entry.status === 'string'
}

/**
 * Whether a wire value has the fields one tool line needs.
 * @param value - one entry of a service's `tools` array.
 * @returns whether the entry is a displayable tool.
 */
function isTool(value: unknown): value is McphubTool {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.name === 'string'
    && typeof entry.description === 'string'
    && typeof entry.enabled === 'boolean'
}

/**
 * Whether a wire value has the fields a tool section needs.
 * @param value - one entry of the gateway's tool `servers` array.
 * @returns whether the entry is a displayable service.
 */
function isToolServer(value: unknown): value is McphubToolServer {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.name === 'string'
    && Array.isArray(entry.tools)
    && entry.tools.every(isTool)
}

/**
 * Read the current user's MCPHub services.
 * @param signal - aborts the request when the page unmounts.
 * @returns the snapshot; an absent MCPHub is `available: false`, not an error.
 */
export async function fetchMcphubServices(signal?: AbortSignal | null): Promise<McphubSnapshot> {
  const response = await fetch('/__vh/mcphub/services', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: signal ?? null,
  })
  const record = await objectBody(response)
  const raw = record.servers
  return {
    available: record.available === true,
    authorized: record.authorized === true,
    servers: Array.isArray(raw) ? raw.filter(isServer) : [],
    routing: typeof record.routing === 'string' ? record.routing : 'all',
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}

/**
 * Read the tools behind the current user's services.
 * @param signal - aborts the request when the page unmounts.
 * @returns the preview; an absent MCPHub is `available: false`, not an error.
 */
export async function fetchMcphubTools(signal?: AbortSignal | null): Promise<McphubToolsSnapshot> {
  const response = await fetch('/__vh/mcphub/tools', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: signal ?? null,
  })
  const record = await objectBody(response)
  const raw = record.servers
  return {
    available: record.available === true,
    authorized: record.authorized === true,
    servers: Array.isArray(raw) ? raw.filter(isToolServer) : [],
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}

/**
 * Read which services the Agent mounts.
 * @param signal - aborts the request when the page unmounts.
 * @returns the chosen names, or null when the Agent follows every service.
 */
export async function fetchMcphubSelection(signal?: AbortSignal | null): Promise<readonly string[] | null> {
  const response = await fetch('/__vh/mcphub/selection', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: signal ?? null,
  })
  const record = await objectBody(response)
  const raw = record.selected
  return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string') : null
}

/**
 * Record which services the Agent mounts on its next launch.
 * @param names - the chosen services, or null for every visible service.
 * @returns resolves once the gateway recorded the choice.
 */
export async function saveMcphubSelection(names: readonly string[] | null): Promise<void> {
  const response = await fetch('/__vh/mcphub/selection', {
    method: 'PUT',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ names }),
  })
  await objectBody(response)
}

/**
 * The error a refused action carries, preferring the gateway's own message —
 * it is MCPHub's verdict (missing service, or one this user may not act on),
 * which is what the row should show.
 * @param response - the gateway's answer.
 * @returns the error to surface.
 */
async function actionFailure(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined)
  const verdict = body !== null && typeof body === 'object'
    && typeof (body as Record<string, unknown>).message === 'string'
    ? (body as Record<string, unknown>).message as string
    : `HTTP ${String(response.status)}`
  return new Error(verdict)
}

/**
 * Start, stop or reload one service, through the gateway's management route.
 * @param name - the service to act on.
 * @param action - what to do; `toggle` carries the desired state.
 * @param enabled - the desired state, for `toggle`.
 * @returns resolves once MCPHub accepted the action.
 */
export async function actOnMcphubServer(
  name: string,
  action: McphubServerAction,
  enabled?: boolean,
): Promise<void> {
  const response = await fetch(`/__vh/mcphub/servers/${encodeURIComponent(name)}/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(enabled === undefined ? {} : { enabled }),
  })
  if (!response.ok) throw await actionFailure(response)
  await response.json().catch(() => undefined)
}
