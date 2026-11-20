import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '../src/index.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return await realpath(dir)
}

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`)
}

interface MountedProvider {
  ctx: Context
  dispose(): Promise<void>
  root: string
}

/** Mount the registry plus the filesystem provider over one custom root. */
async function mountProvider(excludeFile: string, watch = false): Promise<MountedProvider> {
  const home = await tempDir('skill-exclude')
  const root = join(home, 'custom')
  await writeSkill(root, 'kept-skill', 'Stays visible')
  await writeSkill(root, 'off-skill', 'Excluded by the deployment')
  const ctx = new Context()
  const fiber = await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    includeDefaultRoots: false,
    customSkillDirs: [root],
    watch,
    excludeFile,
  })
  return { ctx, dispose: () => fiber.dispose(), root }
}

async function names(ctx: Context): Promise<string[]> {
  return (await ctx.skills.list()).map(skill => skill.name)
}

describe('skill exclusion file', () => {
  it('omits the listed names and keeps every other skill', async () => {
    const excludeFile = join(await tempDir('skill-exclude-list'), 'exclude.json')
    await writeFile(excludeFile, `${JSON.stringify({ exclude: ['off-skill'] })}\n`)
    const mounted = await mountProvider(excludeFile)
    const listed = await names(mounted.ctx)
    expect(listed).toEqual(['kept-skill'])
    await mounted.dispose()
  })

  it('keeps every skill when the file does not exist', async () => {
    const excludeFile = join(await tempDir('skill-exclude-missing'), 'absent.json')
    const mounted = await mountProvider(excludeFile)
    expect(await names(mounted.ctx)).toEqual(['kept-skill', 'off-skill'])
    await mounted.dispose()
  })

  it('keeps every skill when the file is not valid JSON', async () => {
    const excludeFile = join(await tempDir('skill-exclude-broken'), 'exclude.json')
    await writeFile(excludeFile, '{ not json')
    const mounted = await mountProvider(excludeFile)
    const warnings = vi.spyOn(mounted.ctx.logger, 'warn')
    expect(await names(mounted.ctx)).toEqual(['kept-skill', 'off-skill'])
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'))
    await mounted.dispose()
  })

  it('ignores entries that are not skill names', async () => {
    const excludeFile = join(await tempDir('skill-exclude-shape'), 'exclude.json')
    await writeFile(excludeFile, `${JSON.stringify({
      exclude: ['off-skill', 42, 'Not-Kebab', '../escape', null],
    })}\n`)
    const mounted = await mountProvider(excludeFile)
    expect(await names(mounted.ctx)).toEqual(['kept-skill'])
    await mounted.dispose()
  })

  it('ignores a document whose exclude field is not an array', async () => {
    const excludeFile = join(await tempDir('skill-exclude-scalar'), 'exclude.json')
    await writeFile(excludeFile, `${JSON.stringify({ exclude: 'off-skill' })}\n`)
    const mounted = await mountProvider(excludeFile)
    expect(await names(mounted.ctx)).toEqual(['kept-skill', 'off-skill'])
    await mounted.dispose()
  })

  it('ignores a document that is not an object', async () => {
    const excludeFile = join(await tempDir('skill-exclude-array'), 'exclude.json')
    await writeFile(excludeFile, '["off-skill"]\n')
    const mounted = await mountProvider(excludeFile)
    expect(await names(mounted.ctx)).toEqual(['kept-skill', 'off-skill'])
    await mounted.dispose()
  })

  it('follows the file while watching, without a restart', async () => {
    const excludeFile = join(await tempDir('skill-exclude-watch'), 'exclude.json')
    await writeFile(excludeFile, `${JSON.stringify({ exclude: [] })}\n`)
    const mounted = await mountProvider(excludeFile, true)
    expect(await names(mounted.ctx)).toEqual(['kept-skill', 'off-skill'])

    await writeFile(excludeFile, `${JSON.stringify({ exclude: ['off-skill'] })}\n`)
    await waitFor(async () => names(mounted.ctx), listed => listed.length === 1)

    // A rewrite inside the adapter's coalescing window is dropped, and the
    // gateway never writes twice that fast; the test respects the same spacing.
    await new Promise(resolve => setTimeout(resolve, 300))
    await writeFile(excludeFile, `${JSON.stringify({ exclude: [] })}\n`)
    await waitFor(async () => names(mounted.ctx), listed => listed.length === 2)

    await mounted.dispose()
  })

  it('does not follow the file when watching is off', async () => {
    const excludeFile = join(await tempDir('skill-exclude-static'), 'exclude.json')
    await writeFile(excludeFile, `${JSON.stringify({ exclude: [] })}\n`)
    const mounted = await mountProvider(excludeFile, false)
    expect(await names(mounted.ctx)).toEqual(['kept-skill', 'off-skill'])

    await writeFile(excludeFile, `${JSON.stringify({ exclude: ['off-skill'] })}\n`)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await names(mounted.ctx)).toEqual(['kept-skill', 'off-skill'])

    await mounted.dispose()
  })
})

/** Poll a reader until it reports the expected state or the deadline passes. */
async function waitFor(read: () => Promise<string[]>, accept: (listed: string[]) => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (true) {
    const value = await read()
    if (accept(value)) return
    if (Date.now() >= deadline) throw new Error('timed out waiting for the exclusion file change')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
