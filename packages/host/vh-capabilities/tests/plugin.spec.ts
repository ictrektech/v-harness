/**
 * Plugin wiring: the contract decides whether this process listens at all, and
 * the listeners die with the effect that created them.
 */

import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CONTRACT_FILE_NAME, CONTRACT_VERSION, apply, defaultGatewayUrl } from '../src/index.ts'

const KEY = 'c'.repeat(64)

/**
 * A cordis context that records the disposer of the one effect it receives.
 * @returns the fake context and a disposer slot.
 */
function fakeContext(): { ctx: Context; dispose: () => Promise<void> } {
  let dispose: () => Promise<void> = async () => {}
  const ctx = {
    effect: vi.fn(async (fn: () => Promise<() => Promise<void>>) => {
      dispose = await fn()
      return dispose
    }),
  } as unknown as Context
  return { ctx, dispose: () => dispose() }
}

/**
 * Write a contract into one DSH_HOME.
 * @param home - DSH_HOME.
 * @param capabilities - delegated capability names.
 * @returns the home written.
 */
async function delegate(home: string, capabilities: readonly string[] = ['image-studio']): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(join(home, CONTRACT_FILE_NAME), JSON.stringify({
    version: CONTRACT_VERSION,
    key: KEY,
    capabilities,
  }), { mode: 0o600 })
  return home
}

const roots: string[] = []

/**
 * @returns a fresh temporary directory.
 */
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vh-plugin-apply-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  delete process.env.DSH_HOME
  delete process.env.VH_GATEWAY_PORT
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('apply', () => {
  it('stays out of the way when the gateway still owns the sockets', async () => {
    const home = await temporary()
    const { ctx } = fakeContext()
    await apply(ctx, { dshHome: home })
    expect(ctx.effect).not.toHaveBeenCalled()
  })

  it('listens for the delegated capabilities and closes them on dispose', async () => {
    const home = await delegate(await temporary())
    const { ctx, dispose } = fakeContext()
    await apply(ctx, { dshHome: home, gatewayUrl: 'http://127.0.0.1:1' })
    expect(ctx.effect).toHaveBeenCalledTimes(1)
    await expect(access(join(home, 'image-studio.sock'))).resolves.toBeUndefined()
    await expect(access(join(home, 'album.sock'))).rejects.toThrow()
    await dispose()
    await expect(access(join(home, 'image-studio.sock'))).rejects.toThrow()
  })

  it('reads DSH_HOME from the environment when not configured', async () => {
    const home = await delegate(await temporary())
    process.env.DSH_HOME = home
    const { ctx, dispose } = fakeContext()
    await apply(ctx)
    await expect(access(join(home, 'image-studio.sock'))).resolves.toBeUndefined()
    await dispose()
  })

  it('falls back to a relative .dsh home when neither config nor environment names one', async () => {
    const saved = process.env.HOME
    delete process.env.HOME
    try {
      const { ctx } = fakeContext()
      await apply(ctx)
      expect(ctx.effect).not.toHaveBeenCalled()
    } finally {
      process.env.HOME = saved
    }
  })

  it('forwards to the gateway configured for this deployment', async () => {
    const seen: string[] = []
    const gateway = (await import('node:http')).createServer((req, res) => {
      seen.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => { gateway.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = gateway.address()
    if (address === null || typeof address === 'string') throw new Error('gateway did not bind')
    const home = await delegate(await temporary())
    const { ctx, dispose } = fakeContext()
    await apply(ctx, { dshHome: home, gatewayUrl: `http://127.0.0.1:${String(address.port)}` })
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ socketPath: join(home, 'image-studio.sock'), path: '/api/v1/about' }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
      })
      req.on('error', reject)
      req.end()
    })
    expect(body).toBe('{"ok":true}')
    expect(seen).toEqual(['/__vh/egress/image-studio/api/v1/about'])
    await dispose()
    await new Promise<void>((resolve) => { gateway.close(() => { resolve() }) })
  })
})

describe('defaultGatewayUrl', () => {
  it('uses the injected gateway port and falls back to 8080', () => {
    expect(defaultGatewayUrl({ VH_GATEWAY_PORT: '9090' })).toBe('http://127.0.0.1:9090')
    expect(defaultGatewayUrl({})).toBe('http://127.0.0.1:8080')
  })
})
