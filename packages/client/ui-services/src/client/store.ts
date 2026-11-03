/**
 * The services tab's view state: one shared list. The gateway owns the truth
 * (its registry plus heartbeats), so the tab keeps only the last answer and
 * what went wrong reading it — a stale row is the gateway's business, not
 * state worth modeling here.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ServiceEntry } from './face.ts'

/** What one tab shows. */
export interface ServicesState {
  services: ServiceEntry[]
  /** The last read's failure line, or undefined while the list is usable. */
  error: string | undefined
  /** Whether the first read has landed (drives the loading line). */
  loaded: boolean
}

/** The store's write set; the body is the only writer. */
export type ServicesActions = {
  set: (draft: ServicesState, services: readonly ServiceEntry[]) => void
  failed: (draft: ServicesState, message: string) => void
}

/**
 * Declare the services store.
 *
 * A factory rather than a shared handle: the registration declares it as an
 * exclusive store, so the framework mints one instance per session.
 * @returns the store handle to declare on the registration.
 */
export function createServicesStore(): EngineStoreHandle<ServicesState, ServicesActions> {
  return defineStore({
    init: (): ServicesState => ({ services: [], error: undefined, loaded: false }),
    actions: {
      set: (d, services) => {
        d.services = [...services]
        d.error = undefined
        d.loaded = true
      },
      failed: (d, message) => {
        d.error = message
      },
    },
  })
}
