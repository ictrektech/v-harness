import { Context } from '@deepseek-ai/cordis'
import * as SkillAlbum from '@deepseek-ai/dsh-skill-album'
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('node:sea', () => ({ isSea: vi.fn(() => false) }))

const skills = fileURLToPath(new URL('../../../../skills/', import.meta.url))

describe('bundled AI-album skill tools', () => {
  it('mounts the interactive tools over the CLI that ships in skills/album', () => {
    const ctx = new Context()
    try {
      expect(() => { SkillAlbum.apply(ctx, { assetRoot: skills }) }).not.toThrow()
    } finally { void ctx.fiber.dispose() }
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
