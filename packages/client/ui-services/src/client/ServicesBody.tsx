/**
 * The services tab's body: one shared list of the tenant's own services.
 *
 * Every read goes to the gateway; the tab holds no state of its own beyond the
 * last answer. A running service opens in a new browser tab through the
 * gateway's `/__vh/svc/<port>` proxy; stop and restart are the two state
 * changes the registry accepts for its owner.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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
 * How long after an action to read again.
 *
 * A restart answers once its jail has survived the first second and a half, but
 * the supervisor registers itself a moment after that: without this second read
 * the row kept saying "stopped" for up to a poll interval, which reads as the
 * click having done nothing.
 */
const SETTLE_MS = 2_000

/** One row's action in flight, or undefined while the panel is idle. */
interface Pending {
  readonly port: number
  readonly action: 'restart' | 'stop'
}

/**
 * The services list as the tab body draws it.
 * @param props - the tab runtime, the store, and the copy.
 * @returns the list, or the loading / failure / empty lines around it.
 */
export function ServicesBody({ useTabInfo, useStore, actions, t }: ServicesBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const state = useStore(store => store)
  /** The gesture in flight; one at a time keeps two rows from racing. */
  const [pending, setPending] = useState<Pending | undefined>(undefined)
  /** Failure lines keyed by port: the answer belongs beside the row that asked. */
  const [failures, setFailures] = useState<Readonly<Record<number, string>>>({})
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const read = useCallback(async (): Promise<void> => {
    try {
      const services = await fetchServices()
      if (!mounted.current || tab.signal.aborted) return
      actions.set(services)
    } catch (error) {
      if (!mounted.current || tab.signal.aborted) return
      actions.failed(t('error.unavailable', { message: error instanceof Error ? error.message : String(error) }))
    }
  }, [tab, actions, t])

  useEffect(() => {
    void read()
    const timer = setInterval(() => { void read() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [read])

  const run = (port: number, action: 'restart' | 'stop'): void => {
    // One in-flight gesture per panel: a double click must not queue two
    // restarts, and the gateway replays one jail per call.
    if (pending !== undefined) return
    setPending({ port, action })
    setFailures((previous) => {
      if (!previous.has(port)) return previous
      const next = new Map(previous)
      next.delete(port)
      return next
    })
    void (async () => {
      try {
        await serviceAction(port, action)
        await read()
        setTimeout(() => {
          if (mounted.current) void read()
        }, SETTLE_MS)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (mounted.current) setFailures(previous => new Map(previous).set(port, t('action.failed', { message })))
      } finally {
        if (mounted.current) setPending(undefined)
      }
    })()
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
          {state.services.map((service) => {
            const busy = pending?.port === service.port ? pending.action : undefined
            const failure = failures.get(service.port)
            return (
              <li className={css.row} key={service.port} data-services-port={service.port} data-services-busy={busy ?? 'false'}>
                <div className={css.main}>
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
                    <button
                      type="button"
                      className={css.tool}
                      disabled={pending !== undefined}
                      aria-busy={busy === 'restart'}
                      onClick={() => run(service.port, 'restart')}
                    >
                      {busy === 'restart' ? t('restarting') : t('restart')}
                    </button>
                  )}
                  {service.running && (
                    <button
                      type="button"
                      className={css.tool}
                      disabled={pending !== undefined}
                      aria-busy={busy === 'stop'}
                      onClick={() => run(service.port, 'stop')}
                    >
                      {busy === 'stop' ? t('stopping') : t('stop')}
                    </button>
                  )}
                </div>
                {failure !== undefined && <p className={css.rowError} data-services-error={service.port}>{failure}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
