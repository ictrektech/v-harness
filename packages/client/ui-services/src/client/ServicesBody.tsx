/**
 * The services tab's body: one shared list of the tenant's own services.
 *
 * Every read goes to the gateway; the tab holds no state of its own beyond the
 * last answer. A running service opens in a new browser tab through the
 * gateway's `/__vh/svc/<port>` proxy; stop and restart are the two state
 * changes the registry accepts for its owner.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchServices, serviceAction, serviceUrlFor } from './face.ts'
import type {} from './locales.ts'
import type { createServicesStore } from './store.ts'
import css from './ServicesBody.module.css'

/** The body's composed props: the tab it draws, its store, and its copy. */
export type ServicesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createServicesStore>>
  & PropsLocale<'uiServices'>

/** Poll period for the list; the gateway's staleness window tolerates misses. */
const REFRESH_MS = 5_000

/**
 * The services list as the tab body draws it.
 * @param props - the tab runtime, the store, and the copy.
 * @returns the list, or the loading / failure / empty lines around it.
 */
export function ServicesBody({ useTabInfo, useStore, actions, t }: ServicesBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const state = useStore(store => store)
  const busyUntil = useRef(0)

  useEffect(() => {
    let alive = true
    const read = async (): Promise<void> => {
      try {
        const services = await fetchServices()
        if (!alive || tab.signal.aborted) return
        actions.set(services)
      } catch (error) {
        if (!alive || tab.signal.aborted) return
        actions.failed(t('error.unavailable', { message: error instanceof Error ? error.message : String(error) }))
      }
    }
    void read()
    const timer = setInterval(read, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [tab, actions, t])

  const run = (port: number, action: 'restart' | 'stop'): void => {
    // One in-flight gesture per row: a double click must not queue two restarts.
    const key = `${String(port)}:${action}`
    if (Date.now() < busyUntil.current) return
    busyUntil.current = Date.now() + 1_000
    void serviceAction(port, action).catch((error: unknown) => {
      actions.failed(t('action.failed', { message: `${key}: ${error instanceof Error ? error.message : String(error)}` }))
    })
  }

  return (
    <div data-services-state={state.error === undefined ? 'ready' : 'error'}>
      {!state.loaded && state.error === undefined && (
        <p className={css.statusLine} data-services-note="loading">{t('loading')}</p>
      )}
      {state.error !== undefined && (
        <p className={css.statusLine} data-services-note="error">{state.error}</p>
      )}
      {state.error === undefined && state.services.length === 0 && (
        <p className={css.statusLine} data-services-note="empty">{t('empty')}</p>
      )}
      {state.services.length > 0 && (
        <ul className={css.list} data-services-list="true">
          {state.services.map((service) => (
            <li className={css.row} key={service.port} data-services-port={service.port}>
              <span className={service.running ? `${css.dot} ${css.dotOn}` : css.dot} aria-hidden="true" />
              <span className={css.name}>{service.name}</span>
              <span className={css.port}>:{String(service.port)}</span>
              <span className={css.state}>{service.running ? t('running') : t('stopped')}</span>
              {service.running && (
                <a className={css.tool} href={serviceUrlFor(service.port, service.basePath)} target="_blank" rel="noreferrer">
                  {t('open')}
                </a>
              )}
              {!service.running && service.restartable && (
                <button type="button" className={css.tool} onClick={() => run(service.port, 'restart')}>
                  {t('restart')}
                </button>
              )}
              {service.running && (
                <button type="button" className={css.tool} onClick={() => run(service.port, 'stop')}>
                  {t('stop')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
