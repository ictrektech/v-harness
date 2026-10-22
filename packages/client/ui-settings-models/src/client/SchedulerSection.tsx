/** Managed model settings over the same catalog used by the conversation picker. */
import { useEffect } from 'react'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

interface Operations {
  load(): Promise<ModelCatalog>
  select(provider: string, model: string): Promise<void>
}

/** Own the catalog, refresh/save failures, and confirmed default selection. */
export class SchedulerController {
  readonly store = createSnapshotStore<{
    catalog: ModelCatalog | null; busy: boolean; error: string | null
  }>({ catalog: null, busy: false, error: null })

  /** @param operations - authenticated catalog and default-selection callbacks. */
  constructor(private readonly operations: Operations) {}

  /**
   * Refresh models, or persist a selection and reload its confirmed value.
   * @param selection - optional default model to save before reloading.
   * @returns after the current operation settles and its state is published.
   */
  async load(selection?: { provider: string; model: string }): Promise<void> {
    if (this.store.getSnapshot().busy) return
    this.store.update(state => { state.busy = true; state.error = null })
    try {
      if (selection) await this.operations.select(selection.provider, selection.model)
      const catalog = await this.operations.load()
      this.store.update(state => { state.catalog = catalog })
    } catch (error) {
      this.store.update(state => { state.error = error instanceof Error ? error.message : String(error) })
    } finally {
      this.store.update(state => { state.busy = false })
    }
  }
}

interface Injected {
  controller: SchedulerController
  hooks: { snapshot: SchedulerController['store'] }
  t: (key: keyof typeof en) => string
}

/**
 * Render V-Scheduler guidance and the default-model dropdown without credential dialogs.
 * @param props - injected catalog state, actions and localized copy.
 * @returns the managed Models settings section.
 */
export function SchedulerSection(props: InjectFace<Injected>) {
  const { controller, useSnapshot, t } = props
  const state = useSnapshot(value => value)
  useEffect(() => { void controller.load() }, [controller])
  const rows = state.catalog?.groups.flatMap(group => group.models.map(model => ({
    key: JSON.stringify([group.id, model.id]), provider: group.id, model: model.id, name: model.name,
  }))) ?? []
  const selected = rows.find(row => row.provider === state.catalog?.default.provider && row.model === state.catalog.default.model)?.key ?? ''
  return <section className={styles['section']}>
    <h2 className={styles['title']}>{t('title')}</h2>
    <p className={styles['intro']}>{t('schedulerIntro')}</p>
    <a href="/#/app/app-drawer/com.ictrek.v-scheduler/v-scheduler" target="_top">{t('schedulerOpen')}</a>
    <label className={styles['schedulerLabel']}>
      {t('schedulerDefault')}
      <select value={selected} disabled={state.busy || rows.length === 0} onChange={event => {
        const row = rows.find(item => item.key === event.target.value)
        if (row) void controller.load(row)
      }}>
        <option value="" disabled>{state.busy ? t('schedulerLoading') : t('schedulerChoose')}</option>
        {rows.map(row => <option key={row.key} value={row.key}>{row.name}</option>)}
      </select>
    </label>
    <div><Button disabled={state.busy} onClick={() => { void controller.load() }}>{t('schedulerRefresh')}</Button></div>
    {!state.busy && rows.length === 0 && !state.error && !state.catalog?.failures.length
      ? <p role="status" className={styles['intro']}>{t('schedulerEmpty')}</p> : null}
    <p className={styles['intro']}>{t('schedulerSelectionHint')}</p>
    {state.error ? <p role="alert" className={styles['notice']}>{state.error}</p> : null}
    {state.catalog?.failures.map(failure => <p role="alert" className={styles['notice']} key={failure.id}>{failure.message}</p>)}
  </section>
}
