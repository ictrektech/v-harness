/**
 * Forwarding failure paths. The success path is covered through a real unix
 * socket in `servers.spec.ts`; these cases drive the stream events a gateway
 * outage produces.
 */

import { createServer } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import { egressPathFor, forwardCapability } from '../src/forward.ts'

const KEY = 'd'.repeat(64)

/**
 * A request whose only used members are `url`, `method`, `headers`, and `on`.
 * @param url - request URL, or undefined to exercise the fallback.
 * @param method - request method.
 * @returns the stand-in request.
 */
function fakeRequest(
  url: string | undefined = '/api/v1/about',
  method = 'GET',
): import('node:http').IncomingMessage {
  const handlers = new Map<string, () => void>()
  return {
    url,
    method,
    headers: {},
    on: (event: string, handler: () => void) => { handlers.set(event, handler) },
    pipe: () => { throw new Error('GET must not pipe a body') },
    fire: (event: string) => { handlers.get(event)?.() },
  } as unknown as import('node:http').IncomingMessage
}

/** The recording half of a stand-in response, kept apart from its cast. */
interface FakeResponse {
  readonly headersSent: boolean
  readonly writeHead: ReturnType<typeof vi.fn>
  readonly end: ReturnType<typeof vi.fn>
  readonly destroy: ReturnType<typeof vi.fn>
  readonly on: (event: string, handler: () => void) => void
}

/**
 * A response that records writes and exposes its terminal event.
 * @param headersSent - whether the response already started.
 * @returns the recorder, the value to hand to the forwarder, completion, and
 *   the close trigger.
 */
function fakeResponse(headersSent = false): {
  res: FakeResponse
  target: import('node:http').ServerResponse
  done: Promise<void>
  close: () => void
} {
  let finish: () => void = () => {}
  let closed: () => void = () => {}
  const done = new Promise<void>((resolve) => { finish = resolve })
  const handlers = new Map<string, () => void>()
  const res: FakeResponse = {
    headersSent,
    writeHead: vi.fn(),
    end: vi.fn(() => { finish() }),
    destroy: vi.fn(() => { finish() }),
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler)
      if (event === 'close') closed = handler
    },
  }
  return {
    res,
    target: res as unknown as import('node:http').ServerResponse,
    done,
    close: () => { closed() },
  }
}

describe('egressPathFor', () => {
  it('keeps the path and query below the capability prefix', () => {
    expect(egressPathFor('image-studio', '/api/v1/about?x=1')).toBe(
      '/__vh/egress/image-studio/api/v1/about?x=1',
    )
    expect(egressPathFor('image-studio', undefined)).toBe('/__vh/egress/image-studio/')
  })

  it('refuses every target that could leave the capability', () => {
    expect(egressPathFor('image-studio', '//evil.example/api')).toBeUndefined()
    expect(egressPathFor('image-studio', 'http://evil.example/api')).toBeUndefined()
    expect(egressPathFor('image-studio', '/../voffice/api')).toBeUndefined()
    expect(egressPathFor('image-studio', '/%2e%2e/voffice/api')).toBeUndefined()
    expect(egressPathFor('image-studio', '/a\\b')).toBeUndefined()
    expect(egressPathFor('image-studio', '/a/%00b')).toBeUndefined()
    expect(egressPathFor('image-studio', '/%zz')).toBeUndefined()
    expect(egressPathFor('image-studio', 'http://[')).toBeUndefined()
  })
})

describe('forwardCapability failures', () => {
  it('refuses a method no capability call uses', async () => {
    const req = fakeRequest('/api/v1/about', 'TRACE')
    const { res, target, done } = fakeResponse()
    forwardCapability({ gatewayUrl: 'http://127.0.0.1:1', capability: 'image-studio', key: KEY }, req, target)
    await done
    expect(res.writeHead).toHaveBeenCalledWith(405, { 'content-type': 'application/json; charset=utf-8' })
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'method-not-allowed' }))
  })

  it('refuses a path that leaves the capability prefix', async () => {
    const req = fakeRequest('/../voffice/api/v1/me')
    const { res, target, done } = fakeResponse()
    forwardCapability({ gatewayUrl: 'http://127.0.0.1:1', capability: 'image-studio', key: KEY }, req, target)
    await done
    expect(res.writeHead).toHaveBeenCalledWith(400, { 'content-type': 'application/json; charset=utf-8' })
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'path-invalid' }))
  })

  it('answers 502 when the gateway cannot be reached', async () => {
    const req = fakeRequest()
    const { res, target, done, close } = fakeResponse()
    forwardCapability({ gatewayUrl: 'http://127.0.0.1:1', capability: 'image-studio', key: KEY }, req, target)
    await done
    expect(res.writeHead).toHaveBeenCalledWith(502, { 'content-type': 'application/json; charset=utf-8' })
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'gateway-unreachable' }))
    close()
    ;(req as unknown as { fire: (event: string) => void }).fire('error')
  })

  it('tears the response down when the gateway fails after headers', async () => {
    const req = fakeRequest()
    ;(req as unknown as { url: string | undefined }).url = undefined
    const { res, target, done } = fakeResponse(true)
    forwardCapability({ gatewayUrl: 'http://127.0.0.1:1', capability: 'image-studio', key: KEY }, req, target)
    await done
    expect(res.destroy).toHaveBeenCalled()
  })

  it('gives up on an upstream that never answers', async () => {
    const silent = createServer(() => {})
    await new Promise<void>((resolve) => { silent.listen(0, '127.0.0.1', resolve) })
    const address = silent.address()
    if (address === null || typeof address === 'string') throw new Error('silent upstream did not bind')
    const req = fakeRequest()
    const { res, target, done } = fakeResponse()
    forwardCapability({
      gatewayUrl: `http://127.0.0.1:${String(address.port)}`,
      capability: 'image-studio',
      key: KEY,
      timeoutMs: 25,
    }, req, target)
    await done
    expect(res.writeHead).toHaveBeenCalledWith(502, { 'content-type': 'application/json; charset=utf-8' })
    silent.closeAllConnections()
    await new Promise((resolve) => { silent.close(resolve) })
  })
})
