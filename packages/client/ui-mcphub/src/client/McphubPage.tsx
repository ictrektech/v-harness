/**
 * The MCPHub service page: what the current user may call through MCPHub, the
 * tools behind each service, which of them the Agent mounts, and the start,
 * stop and reload of a service the user may act on.
 *
 * Creating, sharing and editing services stay in MCPHub; whether a user may
 * act on one is MCPHub's verdict, relayed by the gateway.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { McphubFace, McphubServer, McphubServerAction, McphubSnapshot, McphubTool } from './face.ts'
import type { McphubKey } from './locales.ts'
import css from './McphubPage.module.css'

/** Where the VOS shell opens MCPHub; a top-level navigation, not an iframe. */
export const MCPHUB_APP_URL = '/#/app/com.ictrek.mcphub/mcphub'

/** Full component props assembled by the main slot renderer. */
export type McphubPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'mcphub'>
  & InjectFace<McphubFace>

/** Visibility labels; an unknown value from a newer MCPHub falls back. */
const VISIBILITY: Readonly<Record<string, McphubKey>> = {
  private: 'visibility.private',
  public: 'visibility.public',
  group: 'visibility.group',
}

/** Status labels and their dot; an unknown value falls back. */
const STATUS: Readonly<Record<string, McphubKey>> = {
  running: 'status.running',
  stopped: 'status.stopped',
  connecting: 'status.connecting',
  'oauth-required': 'status.oauthRequired',
}

/** Routing labels; `smart` needs a database-mode MCPHub, so it stays a label. */
const ROUTING: Readonly<Record<string, McphubKey>> = {
  all: 'routing.all',
  smart: 'routing.smart',
}

/** What the Agent mounts: every visible service, or exactly the chosen ones. */
type MountMode = 'all' | 'some'

/** This namespace's translate function. */
type Translate = McphubPageProps['t']

/** The outcome line under the selection controls. */
interface SaveNote {
  readonly tone: 'ok' | 'error'
  readonly text: string
}

/** Why the last action on one service failed; success shows as a new status. */
interface ActionFailure {
  readonly name: string
  readonly text: string
}

/** Everything the section renderers read, assembled once per render. */
interface View {
  readonly snapshot: McphubSnapshot | undefined
  readonly failure: string | undefined
  readonly pending: boolean
  readonly tools: ReadonlyMap<string, readonly McphubTool[]> | undefined
  readonly toolsPending: boolean
  readonly toolsFailure: string | undefined
  readonly open: readonly string[]
  readonly mode: MountMode
  readonly picked: readonly string[]
  readonly note: SaveNote | undefined
  readonly saving: boolean
  readonly changed: boolean
  readonly acting: string | undefined
  readonly actionFailure: ActionFailure | undefined
  readonly t: Translate
  readonly toggleTools: (name: string) => void
  readonly pick: (name: string) => void
  readonly choose: (mode: MountMode) => void
  readonly save: () => void
  readonly act: (name: string, action: McphubServerAction, enabled?: boolean) => void
}

/**
 * Render the service list with its loading, empty, signed-out and unreachable
 * states, together with the tool preview and the mounting choice.
 * @param props - the injected faces and the page's localized copy.
 * @returns the page element.
 */
export function McphubPage({ load, loadTools, loadSelection, saveSelection, act: actOnServer, t }: McphubPageProps) {
  const [snapshot, setSnapshot] = useState<McphubSnapshot | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(true)
  const live = useRef<AbortController | undefined>(undefined)

  const [tools, setTools] = useState<ReadonlyMap<string, readonly McphubTool[]> | undefined>(undefined)
  const [toolsPending, setToolsPending] = useState(false)
  const [toolsFailure, setToolsFailure] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState<readonly string[]>([])

  const [saved, setSaved] = useState<readonly string[] | null>(null)
  const [mode, setMode] = useState<MountMode>('all')
  const [picked, setPicked] = useState<readonly string[]>([])
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<SaveNote | undefined>(undefined)

  const [acting, setActing] = useState<string | undefined>(undefined)
  const [actionFailure, setActionFailure] = useState<ActionFailure | undefined>(undefined)

  const readList = useCallback((controller: AbortController): Promise<void> => {
    // Read through a call so a later `await` cannot be mistaken for a point
    // where the answer is still wanted.
    const stale = (): boolean => controller.signal.aborted
    return (async () => {
      try {
        const next = await load(controller.signal)
        if (stale()) return
        setSnapshot(next)
        setFailure(undefined)
      } catch (error) {
        if (stale()) return
        setFailure(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [load])

  const refresh = useCallback(() => {
    live.current?.abort()
    const controller = new AbortController()
    live.current = controller
    const stale = (): boolean => controller.signal.aborted
    setPending(true)
    void (async () => {
      await readList(controller)
      if (!stale()) setPending(false)
      // The choice is a second read, and a failed one leaves the Agent on
      // "every service" — which is what an absent record already means.
      const chosen = await loadSelection(controller.signal).catch(() => null)
      if (stale()) return
      setSaved(chosen)
      setMode(chosen === null ? 'all' : 'some')
      setPicked(chosen ?? [])
    })()
  }, [readList, loadSelection])

  useEffect(() => {
    refresh()
    return () => { live.current?.abort() }
  }, [refresh])

  const reload = useCallback((): void => {
    // A quiet re-read after an action: the list stays on screen (no reading
    // state), and the mounting choice the user may still be editing keeps
    // exactly the state it had.
    live.current?.abort()
    const controller = new AbortController()
    live.current = controller
    void readList(controller)
  }, [readList])

  const toggleTools = useCallback((name: string): void => {
    setOpen(current => (current.includes(name)
      ? current.filter(entry => entry !== name)
      : [...current, name]))
    if (tools !== undefined || toolsPending) return
    setToolsPending(true)
    setToolsFailure(undefined)
    void loadTools()
      .then((answer) => {
        setTools(new Map(answer.servers.map(server => [server.name, server.tools])))
        if (!answer.available) setToolsFailure(t('unavailable'))
        else if (!answer.authorized) setToolsFailure(t('unauthorized'))
        else if (answer.error !== undefined) setToolsFailure(t('tools.failed', { message: answer.error }))
      }, (error: unknown) => {
        setToolsFailure(t('tools.failed', { message: error instanceof Error ? error.message : String(error) }))
      })
      .finally(() => { setToolsPending(false) })
  }, [tools, toolsPending, loadTools, t])

  const pick = useCallback((name: string): void => {
    setPicked(current => (current.includes(name)
      ? current.filter(entry => entry !== name)
      : [...current, name]))
    setMode('some')
    setNote(undefined)
  }, [])

  const choose = useCallback((next: MountMode): void => {
    setMode(next)
    setNote(undefined)
  }, [])

  const save = useCallback((): void => {
    if (saving) return
    const names = mode === 'all' ? null : picked
    setSaving(true)
    setNote(undefined)
    void saveSelection(names)
      .then(() => {
        setSaved(names)
        setNote({ tone: 'ok', text: t('selection.saved') })
      }, (error: unknown) => {
        setNote({
          tone: 'error',
          text: t('selection.failed', { message: error instanceof Error ? error.message : String(error) }),
        })
      })
      .finally(() => { setSaving(false) })
  }, [saving, mode, picked, saveSelection, t])

  const changed = mode === 'all'
    ? saved !== null
    : saved === null
      || picked.length !== saved.length
      || picked.some(name => !saved.includes(name))

  const act = useCallback((name: string, action: McphubServerAction, enabled?: boolean): void => {
    if (acting !== undefined) return
    setActing(name)
    setActionFailure(undefined)
    void actOnServer(name, action, enabled)
      // Success needs no line of its own: the quiet re-read shows the new
      // status without flashing the page or resetting the mounting choice.
      .then(() => { reload() }, (error: unknown) => {
        setActionFailure({
          name,
          text: t('action.failed', { message: error instanceof Error ? error.message : String(error) }),
        })
      })
      .finally(() => { setActing(undefined) })
  }, [acting, actOnServer, reload, t])

  const view: View = {
    snapshot, failure, pending,
    tools, toolsPending, toolsFailure, open,
    mode, picked, note, saving, changed,
    acting, actionFailure,
    t, toggleTools, pick, choose, save, act,
  }

  return (
    <main className={css.page}>
      <div className={css.content}>
        <header className={css.heading}>
          <div className={css.titles}>
            <h1 className={css.title}>{t('title')}</h1>
            <p className={css.description}>{t('description')}</p>
          </div>
          <div className={css.actions}>
            {snapshot?.available === true && (
              <span className={css.badge} data-mcphub-routing={snapshot.routing}>
                {t(ROUTING[snapshot.routing] ?? 'routing.unknown')}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={refresh} disabled={pending}>{t('refresh')}</Button>
            <a className={css.manage} href={MCPHUB_APP_URL} target="_top" rel="noreferrer">{t('manage')}</a>
          </div>
        </header>
        {body(view)}
      </div>
    </main>
  )
}

/**
 * The section under the heading: one branch per state the read can report.
 * @param view - the page state and the actions it offers.
 * @returns the section element.
 */
function body(view: View) {
  const { snapshot, failure, pending, t } = view
  if (failure !== undefined) return <Notice text={t('failed', { message: failure })} tone="error" />
  if (snapshot === undefined) return <Notice text={t('loading')} tone="idle" />
  if (!snapshot.available) return <Notice text={t('unavailable')} tone="idle" />
  if (!snapshot.authorized) {
    return <Notice text={t('unauthorized')} hint={t('unauthorizedHint')} tone="error" />
  }
  if (snapshot.error !== undefined) return <Notice text={t('failed', { message: snapshot.error })} tone="error" />
  if (snapshot.servers.length === 0) {
    return <Notice text={t('empty')} hint={t('emptyHint')} tone="idle" />
  }
  return (
    <>
      <p className={css.count}>{t('count', { count: snapshot.servers.length })}</p>
      <ul className={css.list}>
        {snapshot.servers.map(server => <Row key={server.name} view={view} server={server} />)}
      </ul>
      <p className={css.actionHint}>{t('action.hint')}</p>
      {pending ? <p className={css.reading}>{t('loading')}</p> : null}
      <Selection view={view} />
    </>
  )
}

/**
 * One service, its two row actions, and its tools once unfolded.
 * @param props.view - the page state and the actions it offers.
 * @param props.server - the service as the gateway reported it.
 * @returns the list item.
 */
function Row({ view, server }: { view: View; server: McphubServer }) {
  const { t, mode, picked, tools, open, acting, actionFailure } = view
  // A service that is off reads as stopped whatever its connection says.
  const dot = !server.enabled || server.status === 'stopped'
    ? css.dotStopped
    : server.status === 'running' ? css.dotRunning : css.dotIdle
  const unfolded = open.includes(server.name)
  const listed = tools?.get(server.name)
  return (
    <li className={css.entry} data-mcphub-server={server.name}>
      <div className={css.row}>
        <span className={css.name}>{server.name}</span>
        <span className={css.rowDescription}>{server.description}</span>
        <span className={css.badge}>{t(VISIBILITY[server.visibility] ?? 'visibility.unknown')}</span>
        <span className={css.state}>
          <span className={`${css.dot} ${dot}`} aria-hidden="true" />
          {t(!server.enabled ? 'status.disabled' : STATUS[server.status] ?? 'status.unknown')}
        </span>
        <span className={css.rowActions}>
          <button
            type="button"
            className={css.tool}
            disabled={acting !== undefined}
            aria-busy={acting === server.name}
            title={t('action.hint')}
            onClick={() => { view.act(server.name, 'toggle', !server.enabled) }}
          >
            {acting === server.name ? t('action.working') : server.enabled ? t('action.stop') : t('action.start')}
          </button>
          <button
            type="button"
            className={css.tool}
            disabled={acting !== undefined}
            aria-busy={acting === server.name}
            title={t('action.hint')}
            onClick={() => { view.act(server.name, 'reload') }}
          >
            {t('action.reload')}
          </button>
          <button
            type="button"
            className={css.tool}
            aria-expanded={unfolded}
            onClick={() => { view.toggleTools(server.name) }}
          >
            {unfolded ? t('tools.hide') : t('tools.show')}
          </button>
          {mode === 'some' && (
            <label className={css.pick}>
              <input type="checkbox" checked={picked.includes(server.name)} onChange={() => { view.pick(server.name) }} />
              {t('selection.pick')}
            </label>
          )}
        </span>
      </div>
      {actionFailure?.name === server.name ? <p className={css.rowError}>{actionFailure.text}</p> : null}
      {unfolded ? <ToolList view={view} listed={listed} /> : null}
    </li>
  )
}

/**
 * What unfolding one row shows: its tools, or why they are not there.
 * @param props.view - the page state and the actions it offers.
 * @param props.listed - this service's tools once the preview arrived.
 * @returns the tool list or its placeholder.
 */
function ToolList({ view, listed }: { view: View; listed: readonly McphubTool[] | undefined }) {
  const { t, toolsPending, toolsFailure } = view
  if (toolsFailure !== undefined) return <p className={css.rowError}>{toolsFailure}</p>
  if (listed === undefined) {
    return <p className={css.toolsNote}>{toolsPending ? t('tools.loading') : t('tools.empty')}</p>
  }
  if (listed.length === 0) return <p className={css.toolsNote}>{t('tools.empty')}</p>
  return (
    <ul className={css.tools}>
      {listed.map(tool => (
        <li className={tool.enabled ? css.toolLine : `${css.toolLine} ${css.toolOff}`} key={tool.name}>
          <span className={css.toolName}>{tool.name}</span>
          {tool.description === '' ? null : <span className={css.toolDescription}>{tool.description}</span>}
          {tool.enabled ? null : <span className={css.toolFlag}>{t('tools.disabled')}</span>}
        </li>
      ))}
    </ul>
  )
}

/**
 * The mounting choice: every service, or the ones ticked, saved for the next
 * start. Nothing here claims the choice applies while the workspace runs.
 * @param props.view - the page state and the actions it offers.
 * @returns the controls element.
 */
function Selection({ view }: { view: View }) {
  const { t, mode, picked, note, saving, changed } = view
  return (
    <section className={css.selection} data-mcphub-selection={mode}>
      <span className={css.selectionTitle}>{t('selection.title')}</span>
      <div className={css.modes}>
        <button
          type="button"
          className={mode === 'all' ? `${css.mode} ${css.modeActive}` : css.mode}
          onClick={() => { view.choose('all') }}
        >
          {t('selection.all')}
        </button>
        <button
          type="button"
          className={mode === 'some' ? `${css.mode} ${css.modeActive}` : css.mode}
          onClick={() => { view.choose('some') }}
        >
          {t('selection.some')}
        </button>
      </div>
      <button
        type="button"
        className={css.tool}
        disabled={saving || !changed || (mode === 'some' && picked.length === 0)}
        aria-busy={saving}
        onClick={() => { view.save() }}
      >
        {t('selection.save')}
      </button>
      <p className={note?.tone === 'error' ? `${css.selectionHint} ${css.selectionError}` : css.selectionHint}>
        {note?.text ?? t('selection.hint')}
      </p>
    </section>
  )
}

/**
 * A centered message for one non-list state.
 * @param props.text - the message.
 * @param props.hint - an optional second line.
 * @param props.tone - whether the message reports a failure.
 * @returns the notice element.
 */
function Notice({ text, hint, tone }: { text: string; hint?: string; tone: 'idle' | 'error' }) {
  return (
    <div className={tone === 'error' ? `${css.notice} ${css.noticeError}` : css.notice}>
      <p className={css.noticeText}>{text}</p>
      {hint === undefined ? null : <p className={css.noticeHint}>{hint}</p>}
    </div>
  )
}
