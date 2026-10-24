import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientSessionContext, CandidateRequest, InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { markerOf, documentRule } from '../src/client/markers.ts'
import { vofficeSource } from '../src/client/source.ts'

/** Translate to the key itself: assertions then name the key, not the copy. */
const t = (key: string): string => key

/** One mounted composer session. */
const session = { sessionId: 'session-1' } as unknown as ClientSessionContext

/**
 * @param query - text after `@`.
 * @returns a leading-trigger candidate request.
 */
function request(query: string): CandidateRequest {
  return { query, position: 'leading', drilled: false, signal: new AbortController().signal }
}

/**
 * @param body - gateway response body.
 * @param status - gateway status.
 */
function stubList(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

/**
 * @param candidate - the picked row.
 * @param action - settling pick or the row's drill.
 * @returns the pick payload a source receives.
 */
function pick(candidate: { name: string; value?: string }, action: 'pick' | 'drill'): InputTriggerPick {
  return { candidate, session, position: 'leading', via: 'menu', action, span: {} as never } as unknown as InputTriggerPick
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the V-Office @ source', () => {
  it('lists the user documents and filters them as the query grows', async () => {
    stubList({ ok: true, files: [{ name: '预算表.xlsx' }, { name: '年度总结.docx' }] })
    const source = vofficeSource(t)
    expect((await source.candidates(session, request(''))).map(row => row.name)).toEqual(['预算表.xlsx', '年度总结.docx'])
    expect((await source.candidates(session, request('@预算'))).map(row => row.name)).toEqual(['预算表.xlsx'])
  })

  it('describes each row by kind without asking the gateway for it', async () => {
    stubList({ ok: true, files: [{ name: '预算表.xlsx' }, { name: '笔记' }] })
    const rows = await vofficeSource(t).candidates(session, request(''))
    expect(rows.map(row => row.description)).toEqual(['source.kindSheet', ''])
  })

  it('names a listing failure instead of showing an empty menu', async () => {
    stubList({ error: 'vos-token-unavailable', message: '令牌已过期' }, 401)
    const rows = await vofficeSource(t).candidates(session, request(''))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('source.failed')
    expect(rows[0]?.description).toBe('令牌已过期')
  })

  it('says so when the folder holds nothing', async () => {
    stubList({ ok: true, files: [] })
    const rows = await vofficeSource(t).candidates(session, request(''))
    expect(rows[0]?.name).toBe('source.empty')
  })

  it('never claims a notice row', async () => {
    stubList({ ok: true, files: [] })
    const source = vofficeSource(t)
    const [row] = await source.candidates(session, request(''))
    expect(source.onPick(pick(row!, 'pick'))).toBeUndefined()
  })

  it('inserts an atomic reference on a settling pick', () => {
    const outcome = vofficeSource(t).onPick(pick({ name: '预算表.xlsx', value: '预算表.xlsx' }, 'pick'))
    expect(outcome).toEqual({
      insert: {
        source: 'voffice',
        ref: '预算表.xlsx',
        label: '预算表.xlsx',
        appearance: 'file',
        clipboardText: '预算表.xlsx',
      },
    })
  })

  it('opens the editor on the drill action and leaves the draft untouched', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    const outcome = vofficeSource(t).onPick(pick({ name: '预算表.xlsx', value: '预算表.xlsx' }, 'drill'))
    expect(outcome).toBe('handled')
    expect(open).toHaveBeenCalledWith('/__vh/office/open?name=%E9%A2%84%E7%AE%97%E8%A1%A8.xlsx', '_blank', 'noopener')
  })

  it('opens the same document from a click on its reference', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    expect(vofficeSource(t).openReference?.(session, { ref: 'A.docx' })).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(vofficeSource(t).openReference?.(session, { ref: '' })).toBe(false)
  })

  it('serializes the reference into the marker the model reads', async () => {
    const source = vofficeSource(t)
    await expect(source.codec?.serialize('预算表.xlsx', new AbortController().signal))
      .resolves.toBe('<voffice-document>预算表.xlsx</voffice-document>')
    expect(source.codec?.clipboardText('预算表.xlsx')).toBe('预算表.xlsx')
  })
})

describe('the document marker', () => {
  it('renders a sent marker back into a chip node', () => {
    const hit = documentRule.match(`看看 ${markerOf('预算表.xlsx')} 的合计`, 0)
    expect(hit?.data).toEqual({ name: '预算表.xlsx' })
  })

  it('ignores text that carries no marker', () => {
    expect(documentRule.match('普通的一句话', 0)).toBeUndefined()
  })
})
