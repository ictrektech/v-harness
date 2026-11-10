/**
 * Forward one tenant capability request to the gateway's `/__vh/egress/*`.
 *
 * The plugin owns the socket, not the semantics: the gateway still applies the
 * route table, injects the VOS token, and talks to the upstream. This layer
 * only has to be unfaithful in no way that a skill could notice — method, path,
 * query, body, and the upstream's status and headers all pass through.
 *
 * It is also the first line of defence for the egress route: a forged request
 * line must not be able to address another capability, escape the
 * `/__vh/egress/<capability>` prefix, or pick an unexpected method.
 * @module @deepseek-ai/dsh-host-vh-capabilities/forward
 */

import { request as httpRequest } from 'node:http'

/** Request headers worth replaying; everything else is this proxy's business. */
const REQUEST_HEADERS = new Set([
  'accept',
  'content-type',
  'content-length',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
])

/** Response headers worth replaying; hop-by-hop headers stay with the upstream. */
const RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
  'mcp-session-id',
  'mcp-protocol-version',
  // V-Office answers control routes with the tenant-scoped document token; the
  // skill reads it from the response, so dropping it breaks the capability.
  'x-voffice-token',
])

/** Methods a skill can issue; anything else is not a capability call. */
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** A dot segment, raw or percent-encoded, would leave the capability prefix. */
const DOT_SEGMENT = /(?:^|\/)\.\.?(?:[/?#]|$)/

/** Base used only to parse a request target; never dialled. */
const PARSE_BASE = 'http://capability.invalid'

/**
 * Idle budget for one forwarded request. Skill upstreams stream, so this is a
 * stall detector rather than a total duration; a stuck upstream must not keep
 * the tenant's socket pinned forever.
 */
const FORWARD_TIMEOUT_MS = 10 * 60 * 1_000

/** Where and as which tenant one request is forwarded. */
export interface ForwardTarget {
  /** Gateway origin, e.g. `http://127.0.0.1:8080`. */
  readonly gatewayUrl: string
  /** Capability name; also the first egress path segment. */
  readonly capability: string
  /** Tenant capability key accepted by the gateway. */
  readonly key: string
  /** Idle budget for this request; deployment-tunable, defaulting to ten minutes. */
  readonly timeoutMs?: number | undefined
}

/**
 * Build the egress URL for one request target.
 *
 * `new URL` resolves dot segments silently, so the raw and decoded paths are
 * inspected before parsing. A protocol-relative target (`//host/...`) parses
 * with a different origin and is refused rather than turning this forwarder
 * into an open proxy.
 * @param capability - capability named by the listening socket.
 * @param raw - request target from the socket.
 * @returns the gateway path, or `undefined` when the target is not a path below
 *   this capability.
 */
export function egressPathFor(capability: string, raw: string | undefined): string | undefined {
  const value = raw ?? '/'
  const separator = value.search(/[?#]/)
  const beforeQuery = separator === -1 ? value : value.slice(0, separator)
  let decoded: string
  try {
    decoded = decodeURIComponent(beforeQuery)
  } catch {
    return undefined
  }
  if (beforeQuery.includes('\\') || beforeQuery.includes('\0')) return undefined
  if (decoded.includes('\\') || decoded.includes('\0')) return undefined
  if (DOT_SEGMENT.test(beforeQuery) || DOT_SEGMENT.test(decoded)) return undefined
  let parsed: URL
  try {
    parsed = new URL(value, PARSE_BASE)
  } catch {
    return undefined
  }
  if (parsed.origin !== PARSE_BASE) return undefined
  return `/__vh/egress/${capability}${parsed.pathname}${parsed.search}`
}

/**
 * Answer one request without contacting the gateway.
 * @param res - response for the tenant socket.
 * @param status - HTTP status.
 * @param error - machine-readable reason.
 */
function refuse(res: import('node:http').ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error }))
}

/**
 * Stream one request to the gateway and replay the answer.
 * @param target - gateway address, capability, and tenant key.
 * @param req - request accepted on the tenant socket.
 * @param res - response for that socket.
 */
export function forwardCapability(
  target: ForwardTarget,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): void {
  if (req.method === undefined || !METHODS.has(req.method)) {
    refuse(res, 405, 'method-not-allowed')
    return
  }
  const path = egressPathFor(target.capability, req.url)
  if (path === undefined) {
    refuse(res, 400, 'path-invalid')
    return
  }
  const headers: Record<string, string | string[]> = { 'x-vh-capability-key': target.key }
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name]
    if (value !== undefined) headers[name] = value
  }
  const upstream = httpRequest(
    `${target.gatewayUrl}${path}`,
    { method: req.method, headers },
    (answer) => {
      const responseHeaders: Record<string, string> = {}
      for (const [name, value] of Object.entries(answer.headers)) {
        if (typeof value === 'string' && RESPONSE_HEADERS.has(name)) responseHeaders[name] = value
      }
      /* v8 ignore next -- Node's parser always sets statusCode on a parsed response. */
      res.writeHead(answer.statusCode ?? 502, responseHeaders)
      answer.pipe(res)
    },
  )
  upstream.setTimeout(target.timeoutMs ?? FORWARD_TIMEOUT_MS, () => {
    upstream.destroy(new Error('capability forward timed out'))
  })
  upstream.on('error', () => {
    if (!res.headersSent) {
      refuse(res, 502, 'gateway-unreachable')
      return
    }
    res.destroy()
  })
  req.on('error', () => { upstream.destroy() })
  res.on('close', () => { upstream.destroy() })
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') {
    upstream.end()
    return
  }
  req.pipe(upstream)
}
