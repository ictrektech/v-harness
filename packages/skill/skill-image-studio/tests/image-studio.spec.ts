import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillImageStudio from '@deepseek-ai/dsh-skill-image-studio'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:sea', () => ({ isSea: vi.fn(() => false) }))

const execFileAsync = promisify(execFile)
const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const names = ['image-studio', 'image-studio-generate', 'image-studio-models']
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

interface Recorded {
  method: string
  path: string
  authorization: string | undefined
  body: string
}

async function startApi(): Promise<{ server: Server; baseUrl: string; recorded: Recorded[] }> {
  const recorded: Recorded[] = []
  const jobs = new Map<string, Record<string, unknown>>()
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    recorded.push({ method: req.method ?? 'GET', path: url.pathname, authorization: req.headers.authorization, body })
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (url.pathname === '/api/v1/models') {
      json([
        { key: 'sdxl', name: 'SDXL', family: 'SD', capabilities: ['txt2img'], status: 'ready', size: 10,
          variants: [{ id: 'q8_0', name: 'Q8', status: 'ready', size: 5 }] },
        { key: 'qwen-image-edit', name: 'Qwen Edit', family: 'Qwen', capabilities: ['img2img', 'edit'], status: 'missing' },
      ])
      return
    }
    if (url.pathname === '/api/v1/models/sd35/pull' && req.method === 'POST') {
      json({ key: 'sd35', status: 'downloading', progress: 0 })
      return
    }
    if (url.pathname === '/api/v1/inputs' && req.method === 'POST') {
      json({ input_id: 'in_1', url: '/api/v1/inputs/in_1' })
      return
    }
    if (url.pathname === '/api/v1/generate' && req.method === 'POST') {
      const job = {
        job_id: 'job_1', status: 'succeeded', progress: 1, model_key: 'sdxl', prompt: 'tea house',
        width: 768, height: 768, seed: 42, outputs: ['output.png'], error: '',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:05Z',
      }
      jobs.set('job_1', job)
      json(job)
      return
    }
    if (url.pathname === '/api/v1/jobs/job_1') {
      json(jobs.get('job_1'))
      return
    }
    if (url.pathname === '/api/v1/jobs') {
      json([...jobs.values()])
      return
    }
    if (url.pathname === '/api/v1/outputs/job_1/output.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
      return
    }
    json({ detail: 'not found' }, 404)
    return
  }
  const server = createServer((req, res) => { void handle(req, res) })
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', () => { done() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, recorded }
}

describe('bundled Image Studio skills', () => {
  it('lists a compact catalog and appends runtime paths when loaded', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin(SkillImageStudio)
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual(names)
      for (const skill of catalog) {
        expect(skill).toMatchObject({
          source: 'bundled', provider: 'dsh-image-studio',
          invocation: { modelInvocable: true, userInvocable: true },
        })
        expect(skill.description.length).toBeLessThanOrEqual(500)
        const loaded = await ctx.skills.get(skill.name)
        expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(assets, skill.name).split(sep).join('/') })
        const raw = await readFile(join(assets, skill.name, 'SKILL.md'), 'utf8')
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
        expect(loaded?.content.startsWith(body)).toBe(true)
        const runtime = JSON.parse(loaded!.content.slice(loaded!.content.indexOf('{\n  "imageStudio"'))) as {
          imageStudio: { node: string; cli: string; baseUrl: string; authFile: string; requestTimeoutMs: number }
        }
        expect(runtime.imageStudio).toMatchObject({
          node: process.execPath, baseUrl: 'http://image-studio-backend:5000', requestTimeoutMs: 30_000,
        })
        expect(runtime.imageStudio.cli).toBe(join(assets, 'scripts', 'image-studio.mjs'))
        expect(runtime.imageStudio.authFile.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(runtime.imageStudio.authFile)).toBe(true)
      }
      await fiber.dispose()
      expect(await ctx.skills.list()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects relative paths and unusable runtimes before registration', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      expect(() => { SkillImageStudio.apply(ctx, { assetRoot: 'assets' }) }).toThrow('absolute directory')
      expect(() => { SkillImageStudio.apply(ctx, { assetRoot: assets, baseUrl: 'ftp://host' }) }).toThrow('http(s)')
      expect(() => { SkillImageStudio.apply(ctx, { assetRoot: assets, baseUrl: 'not a url' }) }).toThrow('http(s)')
      expect(() => { SkillImageStudio.apply(ctx, { assetRoot: assets, authFile: 'relative.json' }) }).toThrow('absolute path')
      expect(() => { SkillImageStudio.apply(ctx, { assetRoot: assets, cli: join(assets, 'missing.mjs') }) }).toThrow()
      expect(() => { SkillImageStudio.apply(ctx, { assetRoot: assets, node: assets }) }).toThrow()
      expect(await ctx.skills.list()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
})

describe('Image Studio CLI', () => {
  it('generates, waits, downloads, and forwards the bearer token', async () => {
    const { server, baseUrl, recorded } = await startApi()
    const root = await mkdtemp(join(tmpdir(), 'image-studio-cli- '))
    try {
      const authFile = join(root, 'auth.json')
      await writeFile(authFile, JSON.stringify({ baseUrl, token: 'secret-token' }))
      const { node, cli } = runtimePaths()
      const { stdout } = await execFileAsync(node, [cli, '--auth-file', authFile, 'generate',
        '--prompt', 'tea house', '--model-key', 'sdxl', '--width', '768', '--wait', '--out', root,
      ], { cwd: root, env: { PATH: '' }, timeout: 30_000 })
      const result = JSON.parse(stdout) as { job_id: string; files: { path: string; bytes: number }[] }
      expect(result.job_id).toBe('job_1')
      expect(result.files[0]?.bytes).toBe(PNG.length)
      expect(await readFile(result.files[0]!.path)).toEqual(PNG)
      const generate = recorded.find(entry => entry.path === '/api/v1/generate')!
      expect(generate.authorization).toBe('Bearer secret-token')
      expect(JSON.parse(generate.body)).toMatchObject({ prompt: 'tea house', model_key: 'sdxl', width: 768 })
      expect(JSON.parse(generate.body)).not.toHaveProperty('wait')
    } finally {
      server.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('filters the catalog and uploads reference images', async () => {
    const { server, baseUrl, recorded } = await startApi()
    const root = await mkdtemp(join(tmpdir(), 'image-studio-cli-models- '))
    try {
      const authFile = join(root, 'auth.json')
      await writeFile(authFile, JSON.stringify({ baseUrl }))
      await writeFile(join(root, 'ref.png'), PNG)
      const { node, cli } = runtimePaths()
      const ready = await execFileAsync(node, [cli, '--auth-file', authFile, 'models', '--ready'], { cwd: root, env: { PATH: '' } })
      const catalog = JSON.parse(ready.stdout) as { count: number; models: { key: string }[] }
      expect(catalog.count).toBe(1)
      expect(catalog.models[0]?.key).toBe('sdxl')

      const edit = await execFileAsync(node, [cli, '--auth-file', authFile, 'models', '--capability', 'img2img,edit'], { cwd: root, env: { PATH: '' } })
      expect((JSON.parse(edit.stdout) as { count: number }).count).toBe(1)

      const uploaded = await execFileAsync(node, [cli, '--auth-file', authFile, 'upload-input', join(root, 'ref.png')], { cwd: root, env: { PATH: '' } })
      expect(JSON.parse(uploaded.stdout)).toEqual({ input_id: 'in_1', url: '/api/v1/inputs/in_1' })
      expect(recorded.some(entry => entry.path === '/api/v1/inputs' && entry.method === 'POST')).toBe(true)
      expect(recorded.find(entry => entry.path === '/api/v1/inputs')?.authorization).toBeUndefined()
    } finally {
      server.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports HTTP failures with the server detail and a non-zero exit code', async () => {
    const { server, baseUrl } = await startApi()
    const { node, cli } = runtimePaths()
    try {
      let failure: { code?: number; stderr?: string } | undefined
      try {
        await execFileAsync(node, [cli, '--base-url', baseUrl, 'status', 'missing'], { env: { PATH: '' } })
      } catch (error) {
        failure = error as { code?: number; stderr?: string }
      }
      expect(failure?.code).toBe(1)
      expect(failure?.stderr).toContain('404: not found')
    } finally { server.close() }
  })
})

function runtimePaths(): { node: string; cli: string } {
  return { node: process.execPath, cli: join(assets, 'scripts', 'image-studio.mjs') }
}
