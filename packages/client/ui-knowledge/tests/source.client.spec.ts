import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientSessionContext, HeaderRequest } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { forgetLibraries } from '../src/client/api.ts'
import { knowledgeSource } from '../src/client/source.ts'

/** Translate to the key itself: assertions then name the key, not the copy. */
const t = (key: string): string => key

/** One mounted composer session. */
const session = { sessionId: 'session-1' } as unknown as ClientSessionContext

/**
 * @param query - text after `@`.
 * @returns a descended header request.
 */
function headerRequest(query: string): HeaderRequest {
  return { query, drilled: true, drilledBy: 'knowledge' }
}

/**
 * @param body - gateway response body.
 * @param status - gateway status.
 */
function stubBases(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

beforeEach(() => {
  // The library cache is module state: every case starts cold.
  forgetLibraries()
  vi.unstubAllGlobals()
})

describe('the knowledge @ source', () => {
  it('publishes no header before the library list has settled', async () => {
    stubBases({ data: [{ id: 'kb-1', name: '合同智能档案', type: 'document' }] })
    const source = knowledgeSource(t)
    expect(source.header?.(session, headerRequest('合同智能档案/条款'))).toBeUndefined()
  })

  it('trails the library level down to a real library', async () => {
    stubBases({ data: [{ id: 'kb-1', name: '合同智能档案', type: 'document' }] })
    const source = knowledgeSource(t)
    await source.candidates(session, { query: '', position: 'leading', drilled: false, signal: new AbortController().signal })
    expect(source.header?.(session, headerRequest('合同智能档案/条款'))).toEqual([
      { label: 'source.all', value: 'kb-root' },
      { label: '合同智能档案', value: 'kb:合同智能档案', current: true },
    ])
  })

  it('answers a descent into another @ source with nothing and asks the gateway for no documents', async () => {
    stubBases({ data: [{ id: 'kb-1', name: '合同智能档案', type: 'document' }] })
    const source = knowledgeSource(t)
    await source.candidates(session, { query: '', position: 'leading', drilled: false, signal: new AbortController().signal })
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    // `我的文档` is V-Office's folder, not a library: no trail, no rows, no
    // document fetch beyond the library list this call reuses from cache.
    expect(source.header?.(session, headerRequest('我的文档/预算'))).toBeUndefined()
    await expect(source.candidates(session, {
      query: '我的文档/预算',
      position: 'leading',
      drilled: true,
      drilledBy: 'voffice',
      signal: new AbortController().signal,
    })).resolves.toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
