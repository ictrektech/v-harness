import { useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SkillTogglesSection.module.css'

/** One shipped skill and whether it fronts a VOS application. */
interface ShippedSkill {
  name: string
  service: boolean
}

/** The gateway's answer: the disabled list plus the catalog to render. */
interface TogglesDocument {
  disabled: string[]
  skills: ShippedSkill[]
}

async function loadToggles(signal: AbortSignal): Promise<TogglesDocument> {
  const response = await fetch('/__vh/skills/toggles', { cache: 'no-store', credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`skills/toggles: ${String(response.status)}`)
  return await response.json() as TogglesDocument
}

async function saveToggles(disabled: string[]): Promise<void> {
  const response = await fetch('/__vh/skills/toggles', {
    method: 'PUT',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disabled }),
  })
  if (!response.ok) throw new Error(`skills/toggles: ${String(response.status)}`)
}

/**
 * Render the shipped-skill switches, grouped into VOS services and tools.
 * @param props - localized copy for this section.
 * @returns the settings section.
 */
export function SkillTogglesSection({ t }: PropsLocale<'settings.vh-skills'>) {
  const [document, setDocument] = useState<TogglesDocument>()
  const [failed, setFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [busy, setBusy] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    void loadToggles(controller.signal)
      .then((next) => { if (!controller.signal.aborted) setDocument(next) })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => { controller.abort() }
  }, [])

  if (failed) return <p role="alert">{t('failed')}</p>
  if (document === undefined) return <p role="status">{t('loading')}</p>

  const toggle = (name: string, enabled: boolean): void => {
    const disabled = enabled
      ? document.disabled.filter(entry => entry !== name)
      : [...document.disabled, name]
    setSaveFailed(false)
    setBusy(name)
    setDocument({ ...document, disabled })
    void saveToggles(disabled)
      .catch(() => {
        setSaveFailed(true)
        setDocument(document)
      })
      .finally(() => { setBusy(undefined) })
  }

  const groups = [
    { id: 'services', label: t('services'), service: true },
    { id: 'tools', label: t('tools'), service: false },
  ]

  return <div className={css.section}>
    <p className={css.description}>{t('description')}</p>
    {saveFailed && <p role="alert">{t('saveFailed')}</p>}
    {groups.map((group) => {
      const skills = document.skills.filter(skill => skill.service === group.service)
      return <section key={group.id} className={css.group}>
        <h3 className={css.groupTitle}>{group.label}</h3>
        {skills.length === 0
          ? <p className={css.description}>{t('empty')}</p>
          : <ul className={css.list}>
            {skills.map(skill => <li key={skill.name} className={css.row}>
              <span className={css.name}>{skill.name}</span>
              <Switch
                checked={!document.disabled.includes(skill.name)}
                disabled={busy !== undefined}
                label={skill.name}
                onChange={(next) => { toggle(skill.name, next) }}
              />
            </li>)}
          </ul>}
      </section>
    })}
  </div>
}
