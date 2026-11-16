import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CandidateRequest, ClientSessionContext, InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { containerRule, markerOf, nameOf, partsOf, refOf } from '../src/client/markers.ts'
import { vosContainerSource, type VosContainerAccess } from '../src/client/source.ts'

/** Translate to the key itself: assertions then name the key, not the copy. */
const t = (key: string): string => key

/** Container-level token as the descended draft carries it, under {@link t}. */
const LEVEL = 'source.root'

/** One mounted composer session. */
const session = { sessionId: 'session-1' } as unknown as ClientSessionContext

/** A conversation that carries the VOS operations preset. */
const allowed: VosContainerAccess = { preset: () => 'vos-full-access' }

/** A conversation that carries any other preset. */
const unrelated: VosContainerAccess = { preset: () => 'read-only' }

/** One listed container. */
const container = {
  id: 'a'.repeat(64), name: 'vos-app-demo-web-1', appId: 'com.ictrek.demo',
  version: '1.0', state: 'running', status: 'Up 3 hours',
}

/**
 * @param query - text after `@`.
 * @returns a leading-trigger candidate request.
 */
function request(query: string): CandidateRequest {
  return { query, position: 'leading', drilled: false, signal: new AbortController().signal }
}

/**
 * @param candidate - the picked row.
 * @param action - settling pick or the row's drill.
 * @returns the pick payload a source receives.
 */
function pick(candidate: { name: string; value?: string }, action: 'pick' | 'drill'): InputTriggerPick {
  return { candidate, session, position: 'leading', via: 'menu', action, span: {} as never } as unknown as InputTriggerPick
}

/**
 * @param body - gateway response body.
 * @param status - gateway status.
 * @returns the fetch double, for call assertions.
 */
function stubList(body: unknown, status = 200) {
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

afterEach(() => { vi.unstubAllGlobals() })

describe('who sees the source', () => {
  it('stays out of the menu, and off the network, without the operations preset', async () => {
    for (const access of [unrelated, { preset: () => undefined }]) {
      const fetchSpy = stubList({ containers: [container] })
      const source = vosContainerSource(t, access)
      expect(await source.candidates(session, request(''))).toEqual([])
      expect(await source.candidates(session, request(`${LEVEL}/`))).toEqual([])
      expect(fetchSpy).not.toHaveBeenCalled()
    }
  })

  it('disappears when the gateway refuses the reader', async () => {
    stubList({ error: 'forbidden' }, 403)
    const source = vosContainerSource(t, allowed)
    expect(await source.candidates(session, request(''))).toEqual([])
    expect(await source.candidates(session, request(`${LEVEL}/`))).toEqual([])
  })

  it('prefetches only where the preset already allows it', () => {
    const fetchSpy = stubList({ containers: [container] })
    vosContainerSource(t, allowed).warm?.(session)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockClear()
    vosContainerSource(t, unrelated).warm?.(session)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the container level', () => {
  it('offers one descendable row once the reader is admitted', async () => {
    const fetchSpy = stubList({ containers: [container] })
    const rows = await vosContainerSource(t, allowed).candidates(session, request(''))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: LEVEL, section: 'source.section', icon: 'folder', drill: true,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('descends into the level whether the row was settled or drilled', () => {
    stubList({ containers: [container] })
    const source = vosContainerSource(t, allowed)
    const row = { name: LEVEL, value: 'vos-container-root' }
    expect(source.onPick(pick(row, 'pick'))).toEqual({ text: `@${LEVEL}/`, continue: true })
    expect(source.onPick(pick(row, 'drill'))).toEqual({ text: `@${LEVEL}/`, continue: true })
  })

  it('leaves a descent that belongs to another source alone', async () => {
    stubList({ containers: [container] })
    const source = vosContainerSource(t, allowed)
    expect(await source.candidates(session, request('source.root2/web'))).toEqual([])
    expect(source.header?.(session, {
      query: 'source.root2/web', drilled: false, position: 'leading',
    } as never)).toBeUndefined()
  })
})

describe('the container listing', () => {
  it('names the conversation when it reads the gateway', async () => {
    const fetchSpy = stubList({ containers: [container] })
    await vosContainerSource(t, allowed).candidates(session, request(`${LEVEL}/`))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('sessionId=session-1')
  })

  it('renders one row per container, carrying the reference the pick inserts', async () => {
    stubList({ containers: [container] })
    const rows = await vosContainerSource(t, allowed).candidates(session, request(`${LEVEL}/`))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: container.name,
      label: container.name,
      description: 'com.ictrek.demo · running',
      section: 'source.section',
    })
    expect(rows[0].value).toBe(refOf(container.id, container.name))
  })

  it('filters on the container name and its application', async () => {
    stubList({ containers: [container, { ...container, id: 'b'.repeat(64), name: 'vos-app-other-db-1', appId: 'com.ictrek.other' }] })
    const source = vosContainerSource(t, allowed)
    expect((await source.candidates(session, request(`${LEVEL}/web`))).map(row => row.name))
      .toEqual([container.name])
    expect((await source.candidates(session, request(`${LEVEL}/other`))).map(row => row.name))
      .toEqual(['vos-app-other-db-1'])
    expect((await source.candidates(session, request(`${LEVEL}/missing`)))[0].name).toBe('source.empty')
  })

  it('says the listing is empty rather than offering nothing to pick', async () => {
    stubList({ containers: [] })
    const rows = await vosContainerSource(t, allowed).candidates(session, request(`${LEVEL}/`))
    expect(rows[0]).toMatchObject({ name: 'source.empty', value: '' })
  })

  it('walks back to the bare trigger from the header crumb', () => {
    stubList({ containers: [container] })
    const source = vosContainerSource(t, allowed)
    expect(source.onPick(pick({ name: 'source.back', value: 'vos-container-back' }, 'drill')))
      .toEqual({ text: '@', continue: true })
    expect(source.header?.(session, { query: `${LEVEL}/`, drilled: true, drilledBy: 'vosContainer' }))
      .toEqual([
        { label: 'source.back', value: 'vos-container-back' },
        { label: LEVEL, value: 'vos-container-root', current: true },
      ])
    expect(source.header?.(session, { query: '', drilled: false })).toBeUndefined()
  })

  it('inserts the container itself rather than a name the run must resolve', () => {
    stubList({ containers: [container] })
    const ref = refOf(container.id, container.name)
    expect(vosContainerSource(t, allowed).onPick(pick({ name: container.name, value: ref }, 'pick'))).toEqual({
      insert: {
        source: 'vosContainer', ref, label: container.name, appearance: 'file', clipboardText: container.name,
      },
    })
    expect(vosContainerSource(t, allowed).onPick(pick({ name: 'source.empty', value: '' }, 'pick'))).toBeUndefined()
  })
})

describe('the marker', () => {
  it('carries the id the operations tool needs and the name a reader knows', async () => {
    const ref = refOf(container.id, container.name)
    expect(nameOf(ref)).toBe(container.name)
    expect(partsOf(ref)).toEqual({ id: container.id, name: container.name })
    expect(markerOf(ref)).toBe(`<vos-container id="${container.id}">${container.name}</vos-container>`)
    await expect(vosContainerSource(t, allowed).codec?.serialize(ref, new AbortController().signal))
      .resolves.toBe(markerOf(ref))
  })

  it('renders a replayed message back into the same chip data', () => {
    const tag = markerOf(refOf(container.id, container.name))
    const marker = `prefix ${tag} suffix`
    const token = containerRule.match(marker, 0)
    expect(token).toEqual({
      id: 'vosContainer',
      start: marker.indexOf('<'),
      end: marker.indexOf('<') + tag.length,
      data: { id: container.id, name: container.name },
    })
  })

  it('keeps a bare identifier readable when no name travels with it', () => {
    expect(partsOf(container.id)).toEqual({ id: container.id, name: container.id })
  })
})
