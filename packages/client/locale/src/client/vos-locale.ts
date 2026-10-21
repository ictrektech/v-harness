/**
 * Host (VOS) language detection for the browser client.
 *
 * The shell publishes its preference two ways: a `vos_platform` bridge that
 * announces `locale-change` (current releases) and the `preferences-locale`
 * storage entry every Vben-generation build has written. Both carry full
 * BCP 47 tags, which this module narrows to the dictionaries the client ships.
 */

/** Menu id meaning "let the host decide"; never a registered locale. */
export const FOLLOW_LOCALE_ID = 'auto'

/** Storage entry carrying the host's locale preference. */
const PREFERENCE_KEY = 'preferences-locale'

/** Prefixes older releases stamped the preference entry with. */
const PREFIXES = ['VIVIBIT-', 'vben-web-antd-']

/** Dictionary ids a host language can resolve to. */
export type HostLocale = 'zh' | 'en'

/** Bridge surface the VOS shell publishes on `window.vos_platform`. */
interface VosPlatform {
  getState?: () => Promise<{ locale?: unknown }>
  broadcast?: {
    on: (event: 'locale-change', handler: (state: { locale?: unknown }) => void) => () => void
  }
}

declare global {
  interface Window {
    vos_platform?: VosPlatform
  }
}

/**
 * Narrow a host locale tag to a shipped dictionary.
 *
 * Traditional Chinese resolves to the Simplified dictionary: the client ships
 * no `zh-TW` texts yet, and a reader of either script reads the other far
 * better than they read English.
 * @param value - untrusted tag from the bridge or from storage.
 * @returns the dictionary id, or null for a language the client does not ship.
 */
export function normalizeHostLocale(value: unknown): HostLocale | null {
  if (typeof value !== 'string') return null
  const tag = value.trim().replace(/_/g, '-').toLowerCase()
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh'
  if (tag === 'en' || tag.startsWith('en-')) return 'en'
  return null
}

/**
 * Whether a storage key carries the host's locale preference, in either the
 * current or the stamped legacy form.
 * @param key - storage key.
 * @returns true for a host preference entry.
 */
export function isHostLocaleKey(key: string): boolean {
  return key === PREFERENCE_KEY || PREFIXES.some(prefix => key.startsWith(prefix) && key.endsWith(`-${PREFERENCE_KEY}`))
}

/**
 * Parse one stored preference, accepting the JSON envelope VOS writes as well
 * as a bare tag.
 * @param stored - raw storage value.
 * @returns the dictionary id, or null when absent or unrecognized.
 */
export function parseStoredLocale(stored: string | null): HostLocale | null {
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored) as { value?: unknown } | string | null
    return normalizeHostLocale(typeof parsed === 'object' && parsed !== null ? parsed.value : parsed)
  } catch {
    return normalizeHostLocale(stored)
  }
}

/**
 * Read the host preference from storage, favoring the newest VOS version when
 * several stamped entries survive an upgrade.
 * @param storage - the page's local storage.
 * @returns the dictionary id, or null when nothing readable is stored.
 */
export function readStoredHostLocale(storage: Storage): HostLocale | null {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && isHostLocaleKey(key))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const key of keys) {
      const locale = parseStoredLocale(storage.getItem(key))
      if (locale !== null) return locale
    }
  } catch {
    // Storage access can be denied in an embedded browser.
  }
  return null
}

/**
 * Follow the host locale through the VOS bridge.
 *
 * VOS injects the bridge after the iframe's load event, so an absent platform
 * in an embedded page is polled briefly instead of being treated as final. The
 * subscription is installed before the snapshot is read, and a snapshot that
 * loses the race against a broadcast is dropped, so a late read can never
 * overwrite a newer announcement.
 * @param apply - receives every host locale the bridge publishes.
 * @returns disposer stopping the subscription and the poll.
 */
export function listenForHostLocale(apply: (locale: HostLocale) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  let active = true
  let stop: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let revision = 0
  const started = Date.now()

  function connect(): boolean {
    const bridge = window.vos_platform
    if (bridge === undefined) return false
    const update = (state: { locale?: unknown }): void => {
      const locale = normalizeHostLocale(state.locale)
      if (active && locale !== null) apply(locale)
    }
    try {
      stop = bridge.broadcast?.on('locale-change', (state) => {
        revision += 1
        update(state)
      })
      const snapshotRevision = revision
      void bridge.getState?.().then((state) => {
        if (revision === snapshotRevision) update(state)
      }).catch(() => undefined)
    } catch {
      // Older bridges expose neither call; the storage fallback still applies.
    }
    return true
  }

  if (!connect() && window.parent !== window) {
    timer = setInterval(() => {
      if (connect() || Date.now() - started >= 10_000) clearInterval(timer)
    }, 50)
  }
  return () => {
    active = false
    clearInterval(timer)
    stop?.()
  }
}
