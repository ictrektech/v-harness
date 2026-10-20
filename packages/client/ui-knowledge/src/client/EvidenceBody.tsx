/**
 * The evidence page's body: a keyword box over the caller's knowledge bases.
 *
 * Two requests, both through the gateway with the page's own cookie: list the
 * libraries once, then search inside them. Every failure becomes one status
 * line rather than a separate state, because the page has exactly one thing to
 * say when something goes wrong.
 *
 * The page also arrives with passages: a citation chip under an answer opens it
 * with that turn's citations and the one the user clicked, so "show me the
 * source" never re-runs the search the agent already ran.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import { evidenceParams } from './evidence-tab.ts'
import { libraries, search, type KnowledgeCitation } from './weknora.ts'
import css from './EvidenceBody.module.css'

/** The body's composed props. */
export type EvidenceBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'knowledge'>

/** The chip title's composed props. */
export type EvidenceTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'knowledge'>

/**
 * Render the page body.
 * @param props - tab runtime props plus the `knowledge` dictionary.
 * @returns the search box, the status line, and the passages.
 */
export function EvidenceBody({ useTabInfo, t }: EvidenceBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const revision = tab.navigation.revision
  const opened = useMemo(() => evidenceParams(tab.navigation.params), [tab.navigation.params])
  const [scope, setScope] = useState<readonly string[] | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [citations, setCitations] = useState<readonly KnowledgeCitation[]>(opened?.citations ?? [])
  const [focus, setFocus] = useState<string | undefined>(opened?.focus)
  const [status, setStatus] = useState<string>()

  // Navigating the page again replaces what it shows, including when it is
  // already on screen and the second answer cites a different passage.
  useEffect(() => {
    setCitations(opened?.citations ?? [])
    setFocus(opened?.focus)
    setStatus(undefined)
  }, [opened, revision])

  useEffect(() => {
    const controller = new AbortController()
    void libraries(controller.signal).then((rows) => {
      setScope(rows?.map(library => library.id))
      if (rows === undefined) setStatus(t('search.scopeFailed'))
    })
    return () => { controller.abort() }
  }, [t])

  /**
   * @param event - the form submit.
   */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setStatus(t('search.running'))
    const found = await search(query, scope ?? [])
    if (found === undefined) {
      setStatus(t('search.failed'))
      return
    }
    setCitations(found)
    setFocus(undefined)
    setStatus(found.length === 0 ? t('search.empty') : undefined)
  }

  return (
    <div className={css.root}>
      <form className={css.form} onSubmit={(event) => { void submit(event) }}>
        <input
          className={css.input}
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
          placeholder={t('search.placeholder')}
        />
        <button className={css.button} type="submit">{t('search.action')}</button>
      </form>
      {status === undefined ? null : <p className={css.status}>{status}</p>}
      <ul className={css.list}>
        {citations.map(citation => (
          <li
            className={citation.chunkId === focus ? `${css.item} ${css.focused}` : css.item}
            key={citation.chunkId}
          >
            <p className={css.title}>
              {citation.title}
              <span className={css.index}>{`#${String(citation.chunkIndex)}`}</span>
            </p>
            <p className={css.snippet}>{citation.snippet ?? ''}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Render the chip title.
 * @param props - tab runtime props plus the `knowledge` dictionary.
 * @returns the type label.
 */
export function EvidenceTitle({ t }: EvidenceTitleProps): ReactNode {
  return t('tab.label')
}
