/** VOS host language: normalization, storage fallback and bridge subscription. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTimeout as wait } from 'node:timers/promises'
import {
  isHostLocaleKey, listenForHostLocale, normalizeHostLocale, parseStoredLocale, readStoredHostLocale,
} from '../src/client/vos-locale.ts'

function storage(entries: Record<string, string>): Storage {
  const values = new Map(Object.entries(entries))
  return {
    get length() { return values.size },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
    clear: () => values.clear(),
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('normalizeHostLocale', () => {
  it('maps both Chinese scripts and English regions to the shipped dictionaries', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hant', 'zh_Hans_CN']) {
      expect(normalizeHostLocale(tag)).toBe('zh')
    }
    for (const tag of ['en', 'en-US', 'en-GB']) expect(normalizeHostLocale(tag)).toBe('en')
    expect(normalizeHostLocale('ja-JP')).toBeNull()
    expect(normalizeHostLocale({ locale: 'en-US' })).toBeNull()
  })
})

describe('host storage preference', () => {
  it('recognizes current and stamped keys only', () => {
    expect(isHostLocaleKey('preferences-locale')).toBe(true)
    expect(isHostLocaleKey('VIVIBIT-5.5.9-prod-preferences-locale')).toBe(true)
    expect(isHostLocaleKey('vben-web-antd-5.0-prod-preferences-locale')).toBe(true)
    expect(isHostLocaleKey('model-hub-language')).toBe(false)
  })

  it('parses the JSON envelope, a bare tag, and broken input', () => {
    expect(parseStoredLocale('{"value":"en-US"}')).toBe('en')
    expect(parseStoredLocale('"zh-TW"')).toBe('zh')
    expect(parseStoredLocale('zh-CN')).toBe('zh')
    expect(parseStoredLocale('{broken')).toBeNull()
    expect(parseStoredLocale('{"value":null}')).toBeNull()
  })

  it('prefers the newest stamped entry and skips unreadable ones', () => {
    const values = storage({
      'VIVIBIT-5.5.9-prod-preferences-locale': '{"value":"zh-CN"}',
      'VIVIBIT-5.5.10-prod-preferences-locale': '{"value":"en-US"}',
      'vben-web-antd-5.0-prod-preferences-locale': '{"value":"zh-TW"}',
    })
    expect(readStoredHostLocale(values)).toBe('en')
    values.setItem('VIVIBIT-5.5.10-prod-preferences-locale', '{broken')
    expect(readStoredHostLocale(values)).toBe('zh')
    const unavailable = new Proxy({} as Storage, { get: () => { throw new Error('denied') } })
    expect(readStoredHostLocale(unavailable)).toBeNull()
  })
})

describe('listenForHostLocale', () => {
  it('subscribes before reading the snapshot and drops a late snapshot', async () => {
    let handler: (state: { locale?: unknown }) => void = () => {}
    let resolveSnapshot: (state: { locale?: unknown }) => void = () => {}
    const snapshot = new Promise<{ locale?: unknown }>((resolve) => { resolveSnapshot = resolve })
    vi.stubGlobal('window', {
      parent: {},
      vos_platform: {
        broadcast: { on: (_event: string, listener: typeof handler) => { handler = listener; return () => {} } },
        getState: () => snapshot,
      },
    })
    const applied: string[] = []
    const stop = listenForHostLocale(locale => applied.push(locale))
    try {
      handler({ locale: 'zh-TW' })
      resolveSnapshot({ locale: 'en-US' })
      await wait(0)
      expect(applied).toEqual(['zh'])
    } finally {
      stop()
    }
  })

  it('detaches the bridge on dispose', async () => {
    let handler: (state: { locale?: unknown }) => void = () => {}
    let unsubscribed = false
    vi.stubGlobal('window', {
      parent: {},
      vos_platform: {
        broadcast: { on: (_event: string, listener: typeof handler) => {
          handler = listener
          return () => { unsubscribed = true }
        } },
        getState: async () => ({ locale: 'en-US' }),
      },
    })
    const applied: string[] = []
    const stop = listenForHostLocale(locale => applied.push(locale))
    await wait(0)
    expect(applied).toEqual(['en'])
    stop()
    expect(unsubscribed).toBe(true)
    handler({ locale: 'zh-CN' })
    expect(applied).toEqual(['en'])
  })
})
