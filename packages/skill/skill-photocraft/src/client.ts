/**
 * Wire client for the per-tenant PhotoCraft capability socket.
 *
 * The capability speaks two things and this module wraps both of them:
 *
 * * **MCP over Streamable HTTP** on `/mcp` — one session per client instance,
 *   so the documents it opens stay alive across tool calls. Replies may arrive
 *   as `application/json` or as a `text/event-stream`; both are read here.
 * * **The file bridge** on `/volumes`, `/index`, `/download`, `/upload` — the
 *   only way bytes enter or leave the engine.
 *
 * A capability socket is a unix socket owned by the tenant user; an `http(s)`
 * endpoint is accepted for local development against the dev server.
 *
 * @module @deepseek-ai/dsh-skill-photocraft/client
 */

import { request as httpRequest } from 'node:http'

/** Where one capability endpoint lives. */
export interface Endpoint {
  /** `unix:/path/to.sock` or an absolute `http(s)://host[:port]/prefix`. */
  readonly url: string
}

/** One HTTP reply, body fully read. */
export interface Reply {
  readonly status: number
  readonly headers: Record<string, string | undefined>
  readonly body: Buffer
}

/** PhotoCraft's own view of one open document. */
export interface OpenedDocument {
  readonly index: number
  readonly name: string
  readonly width: number
  readonly height: number
  readonly layers: number
}

/** One command result as the engine reports it. */
export interface StepResult {
  readonly command: string
  readonly result: unknown
}

/** Where one request goes: a tenant socket, or an http origin with a path prefix. */
type Target =
  | { readonly kind: 'socket'; readonly socketPath: string }
  | { readonly kind: 'url'; readonly base: URL }

/** Split `unix:/x.sock` and `http://host/prefix` into what `http.request` wants. */
function parseEndpoint(endpoint: Endpoint): Target {
  const { url } = endpoint
  if (url.startsWith('unix:')) return { kind: 'socket', socketPath: url.slice('unix:'.length) }
  const base = new URL(url)
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`photocraft: endpoint must be unix: or http(s):, got ${url}`)
  }
  return { kind: 'url', base }
}

/**
 * Send one request to a capability endpoint and read the whole reply.
 * @param endpoint - socket or http endpoint.
 * @param method - HTTP method.
 * @param path - path with query, starting at `/`.
 * @param options - extra headers, body, and whether the reply is streamed.
 * @returns The reply with its body buffered.
 */
export async function send(
  endpoint: Endpoint,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: Buffer | string; timeoutMs?: number } = {},
): Promise<Reply> {
  const target = parseEndpoint(endpoint)
  const body = options.body === undefined
    ? undefined
    : typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : options.body
  const headers: Record<string, string | number> = { ...options.headers }
  if (body !== undefined) headers['content-length'] = body.byteLength
  // Node reads an empty port as "the protocol default", so the URL's own value
  // needs no normalising here.
  const connection = target.kind === 'socket'
    ? { socketPath: target.socketPath }
    : { protocol: target.base.protocol, hostname: target.base.hostname, port: target.base.port }

  return await new Promise<Reply>((resolve, reject) => {
    const request = httpRequest({
      ...connection,
      method,
      path: target.kind === 'socket' ? path : `${target.base.pathname.replace(/\/+$/u, '')}${path}`,
      headers,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        resolve({
          /* v8 ignore next -- Node sets statusCode on every completed response; the fallback only satisfies the type. */
          status: response.statusCode ?? 0,
          headers: response.headers as Record<string, string | undefined>,
          body: Buffer.concat(chunks),
        })
      })
      response.on('error', reject)
    })
    request.setTimeout(options.timeoutMs ?? 300_000, () => {
      request.destroy(new Error('photocraft capability request timed out'))
    })
    request.on('error', reject)
    if (body !== undefined) request.end(body)
    else request.end()
  })
}

/** Read one JSON reply, reporting the service's own message on failure. */
function jsonReply(reply: Reply, what: string): Record<string, unknown> {
  const text = reply.body.toString('utf8')
  if (reply.status < 200 || reply.status >= 300) {
    throw new Error(`photocraft ${what} failed: HTTP ${String(reply.status)} ${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw new Error(`photocraft ${what} answered with non-JSON`, { cause: error })
  }
}

/** One JSON-RPC frame or an SSE error frame. */
interface RpcFrame {
  jsonrpc?: string
  id?: number
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

/** Parse an MCP reply that may be JSON or SSE. */
function parseRpc(reply: Reply, id: number): RpcFrame {
  const text = reply.body.toString('utf8')
  const type = reply.headers['content-type'] ?? ''
  if (!type.includes('text/event-stream')) {
    const parsed = JSON.parse(text) as RpcFrame
    if (parsed.error !== undefined) throw new Error(`photocraft MCP: ${parsed.error.message ?? 'error'}`)
    return parsed
  }
  for (const block of text.split('\n\n')) {
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trim())
      .join('')
    if (data === '') continue
    const frame = JSON.parse(data) as RpcFrame
    if (frame.id !== id) continue
    if (frame.error !== undefined) throw new Error(`photocraft MCP: ${frame.error.message ?? 'error'}`)
    return frame
  }
  throw new Error('photocraft MCP: the reply carried no matching frame')
}

/**
 * What a recipe or a tool needs from the engine.
 *
 * The concrete provider is `McpClient`; the recipes and tools only see this face,
 * which is what lets their tests run without a socket.
 */
export interface EngineClient {
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  run(command: string, params?: Record<string, unknown>): Promise<unknown>
  open(path: string): Promise<OpenedDocument>
  preview(maxSide?: number): Promise<Buffer>
}

/** One MCP session against the capability. */
export class McpClient {
  #session: string | undefined
  #nextId = 1

  /**
   * @param endpoint - the capability endpoint.
   * @param timeoutMs - per-call deadline.
   */
  constructor(private readonly endpoint: Endpoint, private readonly timeoutMs = 300_000) {}

  /** Open the session if it is not open yet. */
  async #ensureSession(): Promise<void> {
    if (this.#session !== undefined) return
    await this.#rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-skill-photocraft', version: '0' },
    })
    await this.#notify('notifications/initialized', {})
  }

  async #notify(method: string, params: Record<string, unknown>): Promise<void> {
    await send(this.endpoint, 'POST', '/mcp', {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.#session === undefined ? {} : { 'mcp-session-id': this.#session },
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      timeoutMs: this.timeoutMs,
    })
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.#nextId++
    const reply = await send(this.endpoint, 'POST', '/mcp', {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.#session === undefined ? {} : { 'mcp-session-id': this.#session },
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      timeoutMs: this.timeoutMs,
    })
    const session = reply.headers['mcp-session-id']
    // The session id is routing, never authorisation: it only keeps this
    // conversation's documents resident on the service.
    if (session !== undefined && session !== '') this.#session = session
    const frame = parseRpc(reply, id)
    return frame.result ?? {}
  }

  /**
   * Call one engine tool.
   * @param name - MCP tool name, e.g. `doc_open`.
   * @param args - its arguments.
   * @returns The tool's text payload, parsed as JSON when it is JSON.
   */
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.#ensureSession()
    const result = await this.#rpc('tools/call', { name, arguments: args })
    const content = result.content
    if (!Array.isArray(content)) throw new Error(`photocraft ${name}: no content in reply`)
    const texts = content
      .filter((block): block is { type: string; text: string } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
      .map(block => block.text)
    if (result.isError === true) throw new Error(`photocraft ${name}: ${texts.join(' ')}`)
    const image = content.find((block): block is { type: 'image'; data: string; mimeType: string } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image')
    const text = texts.join('\n')
    const parsed = text === '' ? undefined : tryJson(text)
    return image === undefined ? parsed : { value: parsed, image }
  }

  /** Run one engine command, returning its raw result. */
  async run(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return await this.call('command_run', { id: command, params })
  }

  /** Open one document from a workspace-relative path. */
  async open(path: string): Promise<OpenedDocument> {
    const value = await this.call('doc_open', { path }) as OpenedDocument
    return value
  }

  /** Render the active document and return its PNG bytes. */
  async preview(maxSide = 768): Promise<Buffer> {
    const reply = await this.call('doc_render_preview', { max_side: maxSide }) as { image?: { data: string } }
    if (reply.image === undefined) throw new Error('photocraft: the preview carried no image')
    return Buffer.from(reply.image.data, 'base64')
  }
}

/** Parse JSON without assuming the shape. */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** One authorized directory the tenant may read and write. */
export interface Volume {
  readonly adapter: string
  readonly name: string
}

/**
 * What a recipe or a tool needs from the file bridge.
 *
 * The concrete provider is `FileBridge`; keeping the face separate lets a test
 * assert the bytes that cross it without standing up a socket.
 */
export interface BridgeClient {
  upload(name: string, data: Buffer, folder?: string): Promise<string>
  download(name: string): Promise<Buffer>
  mkdir(name: string): Promise<void>
}

/** The file bridge of the same capability. */
export class FileBridge {
  constructor(private readonly endpoint: Endpoint, private readonly timeoutMs = 300_000) {}

  /** Every directory this user granted the app. */
  async volumes(): Promise<Volume[]> {
    const reply = jsonReply(await send(this.endpoint, 'GET', '/volumes', { timeoutMs: this.timeoutMs }), 'volumes')
    const data = reply.data as { data?: Volume[] } | undefined
    return data?.data ?? []
  }

  /** The caller's own directory, which is where an agent should write. */
  async personal(): Promise<Volume> {
    const volumes = await this.volumes()
    const mine = volumes.find(volume => volume.name.startsWith('users/')) ?? volumes[0]
    if (mine === undefined) throw new Error('photocraft: 这个账号还没有被授予任何目录（VOS 应用管理 → 数据访问授权）')
    return mine
  }

  /** Write bytes into the caller's own directory, or one folder inside it. */
  async upload(name: string, data: Buffer, folder?: string): Promise<string> {
    const volume = await this.personal()
    const parent = `${volume.adapter}://${folder === undefined ? '' : `${folder}/`}`
    const query = new URLSearchParams({ adapter: volume.adapter, path: parent, name })
    const reply = await send(this.endpoint, 'POST', `/upload?${query.toString()}`, {
      headers: { 'content-type': 'application/octet-stream' },
      body: data,
      timeoutMs: this.timeoutMs,
    })
    jsonReply(reply, 'upload')
    return name
  }

  /** Read one file back out of the caller's directory. */
  async download(name: string): Promise<Buffer> {
    const volume = await this.personal()
    const query = new URLSearchParams({ adapter: volume.adapter, path: `${volume.adapter}://${name}` })
    const reply = await send(this.endpoint, 'GET', `/download?${query.toString()}`, { timeoutMs: this.timeoutMs })
    if (reply.status !== 200) throw new Error(`photocraft download failed: HTTP ${String(reply.status)}`)
    return reply.body
  }

  /** Create one directory beneath the caller's own directory. */
  async mkdir(name: string): Promise<void> {
    const volume = await this.personal()
    jsonReply(await send(this.endpoint, 'POST', '/new_folder', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adapter: volume.adapter, path: `${volume.adapter}://`, name }),
      timeoutMs: this.timeoutMs,
    }), 'new_folder')
  }

  /** Everything in the caller's own directory. */
  async list(): Promise<{ basename: string; path: string; file_size: number }[]> {
    const volume = await this.personal()
    const query = new URLSearchParams({ adapter: volume.adapter, path: `${volume.adapter}://` })
    const reply = jsonReply(await send(this.endpoint, 'GET', `/index?${query.toString()}`, { timeoutMs: this.timeoutMs }), 'index')
    const data = reply.data as { files?: { basename: string; path: string; file_size: number }[] } | undefined
    return data?.files ?? []
  }
}
