import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileBridge, McpClient, send } from '../src/client.ts'

let server: Server
let socketPath: string
let directory: string
const seen: { path: string; body: string; session?: string }[] = []

/** Read one request body into a string. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'photocraft-'))
  socketPath = join(directory, 'cap.sock')
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req)
      const session = req.headers['mcp-session-id']
      seen.push({ path: req.url ?? '', body, ...(typeof session === 'string' ? { session } : {}) })
      if (req.url === '/volumes') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { data: [
          { adapter: 'x_pub', name: 'public' },
          { adapter: 'x_me', name: 'users/alice/data' },
        ] } }))
        return
      }
      if (req.url?.startsWith('/upload')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: 'saved' }))
        return
      }
      if (req.url?.startsWith('/download')) {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.from('PNGDATA'))
        return
      }
      if (req.url?.startsWith('/index')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { files: [
          { basename: 'a.png', path: 'x_me://a.png', file_size: 6 },
        ] } }))
        return
      }
      if (req.url === '/new_folder') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: 'ok' }))
        return
      }
      if (req.url === '/mcp') {
        const frame = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } }
        if (frame.method === 'notifications/initialized') {
          res.writeHead(202)
          res.end()
          return
        }
        if (frame.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: '2025-06-18' } }))
          return
        }
        if (frame.params?.name === 'doc_open') {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(`data: {"jsonrpc":"2.0","id":${String(frame.id)},"result":{"content":[{"type":"text","text":"{\\"index\\":0,\\"name\\":\\"a.png\\",\\"width\\":1740,\\"height\\":1180,\\"layers\\":1}"}]}}\n\n`)
          return
        }
        if (frame.params?.name === 'doc_render_preview') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { content: [
            { type: 'text', text: '{}' },
            { type: 'image', mimeType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') },
          ] } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {
          isError: true,
          content: [{ type: 'text', text: 'no selection' }],
        } }))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })()
  })
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve) })
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  await rm(directory, { recursive: true, force: true })
})

describe('McpClient session recovery', () => {
  it('rebuilds the session and reopens its document after the engine forgets it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'photocraft-session-'))
    const socket = join(directory, 'cap.sock')
    let initialised = 0
    let validSession = ''
    const calls: string[] = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const frame = JSON.parse(await readBody(req)) as { id?: number; method: string; params?: { name?: string } }
        if (frame.method === 'initialize') {
          initialised += 1
          validSession = `sess-${String(initialised)}`
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': validSession })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
          return
        }
        if (frame.method === 'notifications/initialized') {
          res.writeHead(202)
          res.end()
          return
        }
        if (req.headers['mcp-session-id'] !== validSession) {
          res.writeHead(404)
          res.end('Not Found: Session not found')
          return
        }
        calls.push(frame.params?.name ?? '')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }))
      })()
    })
    await new Promise<void>((resolve) => { server.listen(socket, resolve) })
    try {
      const client = new McpClient({ url: `unix:${socket}` })
      await expect(client.open('a.png')).resolves.toEqual({ ok: true })
      // The engine forgets every session it handed out, as after a restart.
      validSession = 'forgotten'
      await expect(client.call('doc_inspect')).resolves.toEqual({ ok: true })
      expect(initialised).toBe(2)
      // The document lived in the dropped session, so it is reopened first.
      expect(calls).toEqual(['doc_open', 'doc_open', 'doc_inspect'])
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('McpClient', () => {
  it('opens one session and reuses its id for every later call', async () => {
    seen.length = 0
    const client = new McpClient({ url: `unix:${socketPath}` })
    const document = await client.open('a.png')
    expect(document).toEqual({ index: 0, name: 'a.png', width: 1740, height: 1180, layers: 1 })
    expect(seen[0]?.path).toBe('/mcp')
    expect(seen.at(-1)?.session).toBe('sess-1')
  })

  it('reads a preview out of an image content block', async () => {
    const client = new McpClient({ url: `unix:${socketPath}` })
    expect((await client.preview(512)).toString('utf8')).toBe('PNGDATA')
  })

  it('surfaces an engine error with its own words', async () => {
    const client = new McpClient({ url: `unix:${socketPath}` })
    await expect(client.run('select.deselect')).rejects.toThrow(/no selection/u)
  })
})

describe('FileBridge', () => {
  it('writes into the caller\'s own directory rather than the first grant', async () => {
    const bridge = new FileBridge({ url: `unix:${socketPath}` })
    expect((await bridge.personal()).adapter).toBe('x_me')
    seen.length = 0
    await bridge.upload('wish.png', Buffer.from('bytes'))
    const upload = seen.find(entry => entry.path.startsWith('/upload'))
    expect(upload?.path).toContain('adapter=x_me')
    expect(upload?.path).toContain('path=x_me%3A%2F%2F')
    expect(upload?.body).toBe('bytes')
  })

  it('writes into the directory root when no folder is named', async () => {
    const bridge = new FileBridge({ url: `unix:${socketPath}` })
    seen.length = 0
    await bridge.upload('plain.png', Buffer.from('bytes'))
    expect(seen.find(entry => entry.path.startsWith('/upload'))?.path).toContain('path=x_me%3A%2F%2F&')
  })

  it('writes into a named folder when one is given', async () => {
    const bridge = new FileBridge({ url: `unix:${socketPath}` })
    seen.length = 0
    await bridge.upload('wish.png', Buffer.from('bytes'), 'photocraft-tmp')
    expect(seen.find(entry => entry.path.startsWith('/upload'))?.path)
      .toContain(`path=${encodeURIComponent('x_me://photocraft-tmp/')}`)
  })

  it('reads a finished file back out', async () => {
    const bridge = new FileBridge({ url: `unix:${socketPath}` })
    expect((await bridge.download('wish.png')).toString('utf8')).toBe('PNGDATA')
  })

  it('lists the caller\'s own directory', async () => {
    const bridge = new FileBridge({ url: `unix:${socketPath}` })
    expect(await bridge.list()).toEqual([{ basename: 'a.png', path: 'x_me://a.png', file_size: 6 }])
  })

  it('creates a directory beneath the caller\'s own directory', async () => {
    const bridge = new FileBridge({ url: `unix:${socketPath}` })
    await bridge.mkdir('out')
    const folder = seen.find(entry => entry.path === '/new_folder')
    expect(folder?.body).toContain('"name":"out"')
    expect(folder?.body).toContain('"path":"x_me://"')
  })
})

/** One throwaway capability server, on its own socket. */
interface Temporary {
  readonly url: string
  readonly close: () => Promise<void>
}

/**
 * Start a capability endpoint that answers however this test wants.
 * @param handler - one request handler.
 * @returns the endpoint and its teardown.
 */
async function temporary(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<Temporary> {
  const folder = await mkdtemp(join(tmpdir(), 'photocraft-edge-'))
  const path = join(folder, 'cap.sock')
  const local = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => { handler(req, res, await readBody(req)) })()
  })
  await new Promise<void>((resolve) => { local.listen(path, resolve) })
  return {
    url: `unix:${path}`,
    close: async () => {
      await new Promise<void>((resolve) => { local.close(() => { resolve() }) })
      await rm(folder, { recursive: true, force: true })
    },
  }
}

/** Answer one JSON body with the given status. */
function jsonAnswer(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

describe('send', () => {
  it('carries a string body and reports the service status', async () => {
    const endpoint = await temporary((req, res, body) => {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ body, length: req.headers['content-length'] }))
    })
    try {
      const reply = await send({ url: endpoint.url }, 'POST', '/upload', { body: 'hello' })
      expect(reply.status).toBe(201)
      expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ body: 'hello', length: '5' })
    } finally {
      await endpoint.close()
    }
  })

  it('gives up on a service that never answers', async () => {
    const endpoint = await temporary(() => {})
    try {
      await expect(send({ url: endpoint.url }, 'GET', '/volumes', { timeoutMs: 30 }))
        .rejects.toThrow(/timed out/u)
    } finally {
      await endpoint.close()
    }
  })

  it('targets an http origin and keeps its path prefix', async () => {
    const paths: string[] = []
    const local = createServer((req, res) => {
      paths.push(req.url ?? '')
      jsonAnswer(res, 200, { code: 0 })
    })
    await new Promise<void>((resolve) => { local.listen(0, '127.0.0.1', resolve) })
    const address = local.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    try {
      const reply = await send({ url: `http://127.0.0.1:${String(address.port)}/base/` }, 'GET', '/volumes')
      expect(reply.status).toBe(200)
      expect(paths).toEqual(['/base/volumes'])
    } finally {
      await new Promise<void>((resolve) => { local.close(() => { resolve() }) })
    }
  })

  it('refuses a protocol it cannot speak', async () => {
    await expect(send({ url: 'ftp://example.test' }, 'GET', '/volumes'))
      .rejects.toThrow(/must be unix: or http\(s\)/u)
  })
})

describe('FileBridge refusals', () => {
  it('reports the service status in its own words', async () => {
    const endpoint = await temporary((_req, res) => { jsonAnswer(res, 500, { message: 'boom' }) })
    try {
      await expect(new FileBridge({ url: endpoint.url }).volumes()).rejects.toThrow(/volumes failed: HTTP 500/u)
    } finally {
      await endpoint.close()
    }
  })

  it('reports a body that is not JSON', async () => {
    const endpoint = await temporary((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>proxy error</html>')
    })
    try {
      await expect(new FileBridge({ url: endpoint.url }).volumes()).rejects.toThrow(/answered with non-JSON/u)
    } finally {
      await endpoint.close()
    }
  })

  it('reports a download the service will not give', async () => {
    const endpoint = await temporary((req, res) => {
      if (req.url === '/volumes') {
        jsonAnswer(res, 200, { data: { data: [{ adapter: 'x_me', name: 'users/a' }] } })
        return
      }
      res.writeHead(404)
      res.end('gone')
    })
    try {
      await expect(new FileBridge({ url: endpoint.url }).download('wish.png'))
        .rejects.toThrow(/download failed: HTTP 404/u)
    } finally {
      await endpoint.close()
    }
  })

  it('reads an empty grant list as nothing to work with', async () => {
    const endpoint = await temporary((_req, res) => { jsonAnswer(res, 200, { data: { data: [] } }) })
    try {
      const bridge = new FileBridge({ url: endpoint.url })
      expect(await bridge.volumes()).toEqual([])
      await expect(bridge.personal()).rejects.toThrow(/还没有被授予任何目录/u)
    } finally {
      await endpoint.close()
    }
  })

  it('reads a reply without a data envelope as empty', async () => {
    const endpoint = await temporary((_req, res) => { jsonAnswer(res, 200, { code: 0 }) })
    try {
      expect(await new FileBridge({ url: endpoint.url }).volumes()).toEqual([])
    } finally {
      await endpoint.close()
    }
  })

  it('reads a directory listing with no files as empty', async () => {
    const endpoint = await temporary((req, res) => {
      if (req.url === '/volumes') {
        jsonAnswer(res, 200, { data: { data: [{ adapter: 'x_me', name: 'users/a' }] } })
        return
      }
      jsonAnswer(res, 200, { data: {} })
    })
    try {
      expect(await new FileBridge({ url: endpoint.url }).list()).toEqual([])
    } finally {
      await endpoint.close()
    }
  })

  it('falls back to the first grant when none is personal', async () => {
    const endpoint = await temporary((_req, res) => {
      jsonAnswer(res, 200, { data: { data: [{ adapter: 'x_pub', name: 'public' }] } })
    })
    try {
      expect((await new FileBridge({ url: endpoint.url }).personal()).adapter).toBe('x_pub')
    } finally {
      await endpoint.close()
    }
  })
})

describe('McpClient refusals', () => {
  /** Answer one MCP request with the given frames. */
  function mcpAnswer(res: ServerResponse, body: string): void {
    const frame = JSON.parse(body) as { id?: number; method: string }
    if (frame.method === 'initialize') {
      jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id, result: {} })
      return
    }
    jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: '{}' }] } })
  }

  it('surfaces a JSON-RPC error frame', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id, error: { message: 'engine exploded' } })
    })
    try {
      await expect(new McpClient({ url: endpoint.url }).run('select.subject'))
        .rejects.toThrow(/photocraft MCP: engine exploded/u)
    } finally {
      await endpoint.close()
    }
  })

  it('refuses a reply with no content', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id, result: {} })
    })
    try {
      await expect(new McpClient({ url: endpoint.url }).run('select.subject'))
        .rejects.toThrow(/no content in reply/u)
    } finally {
      await endpoint.close()
    }
  })

  it('returns plain text a command answered with', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: 'done' }] } })
    })
    try {
      expect(await new McpClient({ url: endpoint.url }).call('doc_save')).toBe('done')
    } finally {
      await endpoint.close()
    }
  })

  it('refuses a preview without an image', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: '{}' }] } })
    })
    try {
      await expect(new McpClient({ url: endpoint.url }).preview())
        .rejects.toThrow(/preview carried no image/u)
    } finally {
      await endpoint.close()
    }
  })

  it('reads a stream that opens with a heartbeat and names another call', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        ': keep-alive',
        '',
        `data: {"jsonrpc":"2.0","id":${String((frame.id ?? 0) - 1)},"result":{}}`,
        '',
        `data: {"jsonrpc":"2.0","id":${String(frame.id)},"result":{"content":[{"type":"text","text":"{}"}]}}`,
        '',
      ].join('\n'))
    })
    try {
      expect(await new McpClient({ url: endpoint.url }).run('select.subject')).toEqual({})
    } finally {
      await endpoint.close()
    }
  })

  it('surfaces a streamed error frame', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: {"jsonrpc":"2.0","id":${String(frame.id)},"error":{"message":"liquify refused"}}\n\n`)
    })
    try {
      await expect(new McpClient({ url: endpoint.url }).run('filter.liquify'))
        .rejects.toThrow(/liquify refused/u)
    } finally {
      await endpoint.close()
    }
  })

  it('refuses a stream that never names the call', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"jsonrpc":"2.0","id":999,"result":{}}\n\n')
    })
    try {
      await expect(new McpClient({ url: endpoint.url }).run('select.subject'))
        .rejects.toThrow(/carried no matching frame/u)
    } finally {
      await endpoint.close()
    }
  })

  it('opens exactly one session for a whole conversation', async () => {
    const methods: string[] = []
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      methods.push(frame.method)
      if (frame.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-7' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
        return
      }
      jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: '{}' }] } })
    })
    try {
      const client = new McpClient({ url: endpoint.url })
      await client.run('select.subject')
      await client.run('select.rect')
      expect(methods.filter(method => method === 'initialize')).toHaveLength(1)
    } finally {
      await endpoint.close()
    }
  })

  it('reads a reply that carries no result as an empty one', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id })
    })
    try {
      await expect(new McpClient({ url: endpoint.url }).call('doc_save')).rejects.toThrow(/no content in reply/u)
    } finally {
      await endpoint.close()
    }
  })

  it('names an error frame that carries no message', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id, error: {} })
    })
    try {
      await expect(new McpClient({ url: endpoint.url }).run('select.subject'))
        .rejects.toThrow(/photocraft MCP: error/u)
    } finally {
      await endpoint.close()
    }
  })

  it('names a streamed error frame that carries no message', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: {"jsonrpc":"2.0","id":${String(frame.id)},"error":{}}\n\n`)
    })
    try {
      await expect(new McpClient({ url: endpoint.url }).run('select.rect'))
        .rejects.toThrow(/photocraft MCP: error/u)
    } finally {
      await endpoint.close()
    }
  })

  it('reads an image-only preview reply', async () => {
    const endpoint = await temporary((_req, res, body) => {
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        mcpAnswer(res, body)
        return
      }
      jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id, result: { content: [
        { type: 'image', mimeType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') },
      ] } })
    })
    try {
      expect((await new McpClient({ url: endpoint.url }).preview()).toString('utf8')).toBe('PNGDATA')
    } finally {
      await endpoint.close()
    }
  })

  it('keeps working with a service that hands out no session id', async () => {
    const sessions: (string | undefined)[] = []
    const endpoint = await temporary((req, res, body) => {
      sessions.push(req.headers['mcp-session-id'] as string | undefined)
      const frame = JSON.parse(body) as { id?: number; method: string }
      if (frame.method === 'initialize') {
        // No content-type header at all: the reply is still plain JSON.
        res.writeHead(200)
        res.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
        return
      }
      if (frame.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      jsonAnswer(res, 200, { jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: '{}' }] } })
    })
    try {
      const client = new McpClient({ url: endpoint.url })
      expect(await client.run('select.subject')).toEqual({})
      expect(sessions).toEqual([undefined, undefined, undefined])
    } finally {
      await endpoint.close()
    }
  })
})
