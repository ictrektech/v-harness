import { Context } from '@deepseek-ai/cordis'
import * as SkillAlbum from '@deepseek-ai/dsh-skill-album'
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { photoList } from '../src/tools.ts'

vi.mock('node:sea', () => ({ isSea: vi.fn(() => false) }))

const skills = fileURLToPath(new URL('../../../../skills/', import.meta.url))
const workspace = '/workspace/tenant'

interface RegisteredTool {
  name: string
  output?: {
    presentationMeta?: (args: Record<string, unknown>, value: SearchValue) => unknown
  }
  execute?: (args: Record<string, unknown>, exec: { agent?: object; signal: AbortSignal }) => Promise<unknown>
}

interface SearchValue {
  total: number
  photos: readonly Record<string, unknown>[]
}

/**
 * Mount the plugin over stand-in seams and record what it registers.
 * @returns the registered tools and the workdir each shell request asked for.
 */
async function mount(): Promise<{ tools: RegisteredTool[]; workdirs: (string | undefined)[] }> {
  const tools: RegisteredTool[] = []
  const workdirs: (string | undefined)[] = []
  const ctx = new Context()
  ctx.provide('tools', {
    register(tool: RegisteredTool) {
      tools.push(tool)
      return () => {}
    },
  })
  ctx.provide('shell', {
    resolve(request: { workdir?: string }) {
      workdirs.push(request.workdir)
      return request
    },
    execute() {
      return Promise.resolve({
        result: () => Promise.resolve({
          timedOut: false,
          aborted: false,
          exitCode: 0,
          stdout: { text: '{"total":0,"assets":[]}' },
          stderr: { text: '' },
        }),
      })
    },
  })
  ctx.provide('workingDirectory', { ensure: () => Promise.resolve(workspace) })
  SkillAlbum.apply(ctx, { assetRoot: skills, node: process.execPath })
  // Injected callbacks run once their fibre settles, after the services exist.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return { tools, workdirs }
}

describe('bundled AI-album skill tools', () => {
  it('mounts every tool over the CLI that ships in skills/album', async () => {
    const { tools } = await mount()
    expect(tools.map(tool => tool.name)).toEqual([
      'album_search', 'album_photos', 'album_person', 'album_albums', 'album_upload',
    ])
  })

  it('tags photo results with the card kind', async () => {
    const { tools } = await mount()
    const search = tools.find(tool => tool.name === 'album_search')
    const value: SearchValue = { total: 3, photos: [] }
    expect(search?.output?.presentationMeta?.({ query: 'sea' }, value))
      .toEqual({ kind: 'album.search', total: 3, photos: [] })
  })

  it('drops rows without a thumbnail instead of blanking the whole grid', () => {
    const shaped = photoList({
      total: 3,
      assets: [
        { id: 'a', thumbPath: '/workspace/tenant/album-thumbs/a.jpg', city: '三亚' },
        { id: 'b' },
        { id: 'c', thumbPath: '/workspace/tenant/album-thumbs/c.jpg' },
      ],
    })
    expect(shaped.photos.map(photo => photo.id)).toEqual(['a', 'c'])
    expect(shaped.total).toBe(3)
  })

  it('runs the CLI in the caller workspace so thumbnails land where the card reads them', async () => {
    const { tools, workdirs } = await mount()
    const search = tools.find(tool => tool.name === 'album_search')
    await search?.execute?.({ query: 'sea' }, { agent: {}, signal: new AbortController().signal })
    expect(workdirs).toEqual([workspace])
  })

  it('leaves the shell default when no agent owns the call', async () => {
    const { tools, workdirs } = await mount()
    const search = tools.find(tool => tool.name === 'album_search')
    await search?.execute?.({ query: 'sea' }, { signal: new AbortController().signal })
    expect(workdirs).toEqual([undefined])
  })

  it('rejects relative paths and unusable runtimes', () => {
    const ctx = new Context()
    try {
      expect(() => { SkillAlbum.apply(ctx, { assetRoot: 'skills' }) }).toThrow('absolute directory')
      expect(() => { SkillAlbum.apply(ctx, { assetRoot: skills, cli: join(skills, 'missing.mjs') }) }).toThrow()
      expect(() => { SkillAlbum.apply(ctx, { assetRoot: skills, node: skills }) }).toThrow()
    } finally { void ctx.fiber.dispose() }
  })
})
