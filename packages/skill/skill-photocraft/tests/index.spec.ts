/**
 * Plugin wiring: which endpoint wins, and what the tools are mounted with.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/index.ts'

const register = vi.fn()

vi.mock('../src/tools.ts', () => ({
  PREVIEW_SIDE_MIN: 64,
  PREVIEW_SIDE_MAX: 2048,
  registerPhotocraftTools: register,
}))

const plugin = await import('../src/index.ts')

/** Mount the plugin and report what it handed the tool layer. */
function mount(config: Config = {}): { services: readonly string[]; runtime: Record<string, unknown> } {
  let services: readonly string[] = []
  let runtime: Record<string, unknown> = {}
  register.mockImplementationOnce((_ctx: Context, mounted: Record<string, unknown>) => { runtime = mounted })
  const host = {
    inject: (names: readonly string[], run: (ctx: Context) => void) => {
      services = names
      run(new Context())
    },
  }
  plugin.apply(host as never, config)
  return { services, runtime }
}

describe('endpointOf', () => {
  it('prefers explicit configuration over the environment', () => {
    expect(plugin.endpointOf('unix:/a.sock', 'unix:/b.sock', '/fallback.sock')).toBe('unix:/a.sock')
  })

  it('takes the environment variable when no configuration names one', () => {
    expect(plugin.endpointOf(undefined, 'unix:/b.sock', '/fallback.sock')).toBe('unix:/b.sock')
  })

  it('falls back to the tenant socket path', () => {
    expect(plugin.endpointOf(undefined, undefined, '/fallback.sock')).toBe('unix:/fallback.sock')
    expect(plugin.endpointOf('', '', '/fallback.sock')).toBe('unix:/fallback.sock')
  })
})

describe('apply', () => {
  it('mounts the tools once the three services exist', () => {
    const { services, runtime } = mount()
    expect(services).toEqual(['tools', 'attachments', 'workingDirectory'])
    expect(register).toHaveBeenCalledTimes(1)
    expect(runtime.previewSide).toBe(768)
    expect(runtime.mcp).toBeDefined()
    expect(runtime.bridge).toBeDefined()
  })

  it('takes the preview size from the configuration', () => {
    expect(mount({ previewSide: 448 }).runtime.previewSide).toBe(448)
  })

  it('reads the tenant home from the environment, and from the OS when it is unset', () => {
    const home = process.env.HOME ?? ''
    try {
      process.env.HOME = '/home/tenant'
      expect(mount().runtime.previewSide).toBe(768)
      delete process.env.HOME
      expect(mount().runtime.previewSide).toBe(768)
    } finally {
      process.env.HOME = home
    }
  })

  it('exposes one config schema for the row', () => {
    expect(plugin.name).toBe('skill-photocraft')
    expect(plugin.Config({ endpoint: 'unix:/x.sock', previewSide: 448, requestTimeoutMs: 1000 }))
      .toMatchObject({ endpoint: 'unix:/x.sock', previewSide: 448 })
    expect(() => plugin.Config({ previewSide: 16 })).toThrow()
    expect(() => plugin.Config({ requestTimeoutMs: 10 })).toThrow()
  })
})
