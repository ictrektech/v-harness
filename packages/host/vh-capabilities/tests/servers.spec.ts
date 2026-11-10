/**
 * Listener and forwarding behaviour, exercised over real unix sockets.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startCapabilityServers } from '../src/servers.ts'

const KEY = 'b'.repeat(64)

let root: string
let gateway: Server
let gatewayPort: number
let seen: { url: string; method: string; key: string | undefined; body: string } | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vh-plugin-servers-'))
  seen = undefined
  gateway = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen = {
        url: req.url ?? '',
        method: req.method ?? '',
        key: req.headers['x-vh-capability-key'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      const body = JSON.stringify({ url: req.url, method: req.method })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-internal': 'must-not-leak',
        'x-voffice-token': 'office-token',
      })
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => { gateway.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = gateway.address()
  if (address === null || typeof address === 'string') throw new Error('gateway did not bind a port')
  gatewayPort = address.port
})

afterEach(async () => {
  await new Promise<void>((resolve) => { gateway.close(() => { resolve() }) })
  await rm(root, { recursive: true, force: true })
})

/**
 * Request one tenant socket.
 * @param socketPath - socket to dial.
 * @param path - request path.
 * @param init - optional method and body.
 * @returns status, headers, and body.
 */
function ask(
  socketPath: string,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: init.method ?? 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

describe('startCapabilityServers', () => {
  it('forwards method, path, query, body, and key through egress', async () => {
    const servers = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    const answer = await ask(join(root, 'image-studio.sock'), '/api/v1/about?x=1', {
      method: 'POST',
      body: '{"prompt":"hi"}',
    })
    expect(answer.status).toBe(200)
    expect(answer.headers['x-internal']).toBeUndefined()
    expect(answer.headers['x-voffice-token']).toBe('office-token')
    expect(JSON.parse(answer.body)).toEqual({ url: '/__vh/egress/image-studio/api/v1/about?x=1', method: 'POST' })
    expect(seen).toEqual({
      url: '/__vh/egress/image-studio/api/v1/about?x=1',
      method: 'POST',
      key: KEY,
      body: '{"prompt":"hi"}',
    })
    await servers.close()
  })

  it('serves several capabilities from one directory', async () => {
    const servers = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio', 'album'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    const answer = await ask(join(root, 'album.sock'), '/albums')
    expect(seen?.url).toBe('/__vh/egress/album/albums')
    expect(answer.status).toBe(200)
    await servers.close()
  })

  it('replaces a socket this process left behind', { skip: process.platform === 'win32' }, async () => {
    const socketPath = join(root, 'image-studio.sock')
    const child = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write('ready'))`],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    if (child.stdout === null) throw new Error('child stdout was not piped')
    await once(child.stdout, 'data')
    child.kill('SIGKILL')
    await once(child, 'exit')
    expect((await stat(socketPath)).isSocket()).toBe(true)

    const servers = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    expect((await ask(socketPath, '/api/v1/about')).status).toBe(200)
    await servers.close()
    await expect(stat(socketPath)).rejects.toThrow()
  })

  it('answers 502 when the gateway is unreachable', async () => {
    const servers = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    await new Promise<void>((resolve) => { gateway.close(() => { resolve() }) })
    const answer = await ask(join(root, 'image-studio.sock'), '/api/v1/about')
    expect(answer.status).toBe(502)
    expect(JSON.parse(answer.body)).toEqual({ error: 'gateway-unreachable' })
    await servers.close()
    gateway = createServer()
    await new Promise<void>((resolve) => { gateway.listen(0, '127.0.0.1', () => { resolve() }) })
  })

  it('leaves a path it does not own and keeps the other capabilities', async () => {
    await mkdir(join(root, 'album.sock'))
    const servers = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio', 'album'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    expect((await ask(join(root, 'image-studio.sock'), '/api/v1/about')).status).toBe(200)
    await expect(ask(join(root, 'album.sock'), '/albums')).rejects.toThrow()
    expect((await stat(join(root, 'album.sock'))).isDirectory()).toBe(true)
    await servers.close()
  })

  it('rejects when the socket directory does not exist', async () => {
    await expect(startCapabilityServers({
      directory: join(root, 'missing'),
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })).rejects.toThrow()
  })

  it('rejects when the socket path cannot be inspected', async () => {
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'x')
    await expect(startCapabilityServers({
      directory: file,
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })).rejects.toThrow()
  })

  it('does not remove a path it no longer owns on close', async () => {
    const servers = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    const socketPath = join(root, 'image-studio.sock')
    await rm(socketPath, { force: true })
    await servers.close()
    await expect(stat(socketPath)).rejects.toThrow()

    const next = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    await rm(socketPath, { force: true })
    const replacement = createServer()
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject)
      replacement.listen(socketPath, () => { resolve() })
    })
    await next.close()
    expect((await stat(socketPath)).isSocket()).toBe(true)
    await new Promise((resolve) => { replacement.close(resolve) })
  })

  it('restores what the tenant put at the socket path', async () => {
    const servers = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    const socketPath = join(root, 'image-studio.sock')
    await rm(socketPath, { force: true })
    await writeFile(socketPath, 'tenant data')
    await servers.close()
    expect(await readFile(socketPath, 'utf8')).toBe('tenant data')
  })

  it('leaves a directory at the socket path alone', async () => {
    const servers = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    const socketPath = join(root, 'image-studio.sock')
    await rm(socketPath, { force: true })
    await mkdir(socketPath)
    await servers.close()
    expect((await stat(socketPath)).isDirectory()).toBe(true)
    await rm(socketPath, { recursive: true })
  })

  it('closes without waiting for a long-lived connection', async () => {
    const servers = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    const socketPath = join(root, 'image-studio.sock')
    const socket = new Socket()
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.connect(socketPath, () => {
        socket.write('POST /api/v1/about HTTP/1.1\r\nhost: localhost\r\ncontent-length: 100\r\n\r\npartial')
        resolve()
      })
    })
    const started = Date.now()
    await servers.close()
    expect(Date.now() - started).toBeLessThan(2_000)
    socket.destroy()
    await expect(stat(socketPath)).rejects.toThrow()
  })

  it('drops malformed requests instead of crashing', async () => {
    const servers = await startCapabilityServers({
      directory: root,
      capabilities: ['image-studio'],
      gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}`,
      key: KEY,
    })
    const socket = new Socket()
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.connect(join(root, 'image-studio.sock'), () => {
        socket.write('not http\r\n\r\n')
        resolve()
      })
    })
    await new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
    await servers.close()
  })
})
