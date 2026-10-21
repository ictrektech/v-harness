import { Context } from '@deepseek-ai/cordis'
import * as SkillVoffice from '@deepseek-ai/dsh-skill-voffice'
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('node:sea', () => ({ isSea: vi.fn(() => false) }))

const skills = fileURLToPath(new URL('../../../../skills/', import.meta.url))

describe('bundled V-Office skill tools', () => {
  it('mounts the interactive tools over the CLI that ships in skills/voffice', () => {
    const ctx = new Context()
    try {
      expect(() => { SkillVoffice.apply(ctx, { assetRoot: skills }) }).not.toThrow()
    } finally { void ctx.fiber.dispose() }
  })

  it('rejects relative paths and unusable runtimes', () => {
    const ctx = new Context()
    try {
      expect(() => { SkillVoffice.apply(ctx, { assetRoot: 'skills' }) }).toThrow('absolute directory')
      expect(() => { SkillVoffice.apply(ctx, { assetRoot: skills, cli: join(skills, 'missing.mjs') }) }).toThrow()
      expect(() => { SkillVoffice.apply(ctx, { assetRoot: skills, node: skills }) }).toThrow()
    } finally { void ctx.fiber.dispose() }
  })
})
