import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AlbumClient, FileBridge, McpClient } from '../src/client.ts'

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
      seen.push({ path: req.url ?? '', body, session: req.headers['mcp-session-id'] as string | undefined })
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
      if (req.url?.startsWith('/assets/') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(Buffer.from('ORIGINAL'))
        return
      }
      if (req.url === '/assets' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'asset-9', duplicate: false }))
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

  it('reads a finished file back out', async () => {
    const bridge = new FileBridge({ url: `unix:${socketPath}` })
    expect((await bridge.download('wish.png')).toString('utf8')).toBe('PNGDATA')
  })
})

describe('AlbumClient', () => {
  it('fetches an original by asset id', async () => {
    const album = new AlbumClient({ url: `unix:${socketPath}` })
    expect((await album.original('asset-1')).toString('utf8')).toBe('ORIGINAL')
  })

  it('uploads with the multipart fields the service requires', async () => {
    seen.length = 0
    const album = new AlbumClient({ url: `unix:${socketPath}` })
    const result = await album.upload('wish.png', Buffer.from('PNGDATA'))
    expect(result).toEqual({ id: 'asset-9', duplicate: false })
    const body = seen[0]?.body ?? ''
    for (const field of ['deviceAssetId', 'deviceId', 'fileCreatedAt', 'fileModifiedAt', 'fileSize', 'assetData']) {
      expect(body).toContain(`name="${field}"`)
    }
    expect(seen[0]?.path).toBe('/assets')
  })
})
