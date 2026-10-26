/**
 * Wire client for the per-tenant PhotoCraft capability socket.
 *
 * The capability speaks three things and this module wraps all of them:
 *
 * * **MCP over Streamable HTTP** on `/mcp` — one session per client instance,
 *   so the documents it opens stay alive across tool calls. Replies may arrive
 *   as `application/json` or as a `text/event-stream`; both are read here.
 * * **The file bridge** on `/volumes`, `/index`, `/download`, `/upload` — the
 *   only way bytes enter or leave the engine.
 * * **The AI-album capability** on its own socket, used to pull a source photo
 *   and to store a finished image back.
 *
 * A capability socket is a unix socket owned by the tenant user; an `http(s)`
 * endpoint is accepted for local development against the dev server.
 *
 * @module @deepseek-ai/dsh-skill-photocraft/client
 */

import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { basename } from 'node:path'

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

/** Split `unix:/x.sock` and `http://host/prefix` into what `http.request` wants. */
function parseEndpoint(endpoint: Endpoint): { socketPath?: string; base?: URL } {
  const { url } = endpoint
  if (url.startsWith('unix:')) return { socketPath: url.slice('unix:'.length) }
  const base = new URL(url)
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`photocraft: endpoint must be unix: or http(s):, got ${url}`)
  }
  return { base }
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
  const { socketPath, base } = parseEndpoint(endpoint)
  const body = options.body === undefined
    ? undefined
    : typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : options.body
  const headers: Record<string, string | number> = { ...options.headers }
  if (body !== undefined) headers['content-length'] = body.byteLength

  return await new Promise<Reply>((resolve, reject) => {
    const request = httpRequest({
      ...socketPath === undefined
        ? { protocol: base?.protocol, hostname: base?.hostname, port: base?.port || undefined }
        : { socketPath },
      method,
      path: socketPath === undefined ? `${base?.pathname.replace(/\/+$/u, '') ?? ''}${path}` : path,
      headers,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        resolve({
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

  /** Write bytes into the caller's own directory. */
  async upload(name: string, data: Buffer): Promise<string> {
    const volume = await this.personal()
    const query = new URLSearchParams({ adapter: volume.adapter, path: `${volume.adapter}://`, name })
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

/** The AI-album capability, used as a source and a sink for finished images. */
export class AlbumClient {
  constructor(private readonly endpoint: Endpoint, private readonly timeoutMs = 300_000) {}

  /**
   * Fetch one asset's original bytes.
   * @param id - the album asset id.
   * @returns the stored image bytes.
   */
  async original(id: string): Promise<Buffer> {
    const reply = await send(this.endpoint, 'GET', `/assets/${encodeURIComponent(id)}/original`, {
      headers: { accept: 'application/octet-stream' },
      timeoutMs: this.timeoutMs,
    })
    if (reply.status !== 200) {
      throw new Error(`album asset ${id} unavailable: HTTP ${String(reply.status)} ${reply.body.toString('utf8').slice(0, 200)}`)
    }
    return reply.body
  }

  /**
   * Store finished bytes back into the album.
   *
   * Same contract as `skills/album upload`: SHA-1 bytes are deduplicated by the
   * service, so re-exporting an identical image never creates a second asset.
   * @param name - file name shown in the album.
   * @param data - encoded image bytes.
   * @returns the new (or deduplicated) asset id.
   */
  async upload(name: string, data: Buffer): Promise<{ id: string; duplicate: boolean }> {
    const checksum = createHash('sha1').update(data).digest('base64')
    const boundary = `----dsh-photocraft-${createHash('sha1').update(`${name}:${String(data.length)}`).digest('hex')}`
    const now = new Date().toISOString()
    const fields: [string, string][] = [
      ['deviceAssetId', `dsh-${checksum.slice(0, 16)}`],
      ['deviceId', 'v-harness'],
      ['fileCreatedAt', now],
      ['fileModifiedAt', now],
      ['fileSize', String(data.length)],
    ]
    const parts: Buffer[] = []
    for (const [field, value] of fields) {
      parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${field}"\r\n\r\n${value}\r\n`))
    }
    parts.push(
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="assetData"; filename="${basename(name)}"\r\ncontent-type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    )
    const body = Buffer.concat(parts)
    const reply = await send(this.endpoint, 'POST', '/assets', {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, accept: 'application/json' },
      body,
      timeoutMs: this.timeoutMs,
    })
    const payload = jsonReply(reply, 'album upload')
    const record = Array.isArray(payload) ? payload[0] as Record<string, unknown> : payload
    const id = typeof record.id === 'string' ? record.id : ''
    if (id === '') throw new Error('photocraft: the album accepted the upload but returned no asset id')
    return { id, duplicate: record.duplicate === true }
  }
}
