/**
 * The knowledge panel's body: library and document checkboxes, a mode switch
 * between raw retrieval and WeKnora's own RAG answer, a model picker, and the
 * passages either mode returns.
 *
 * Opened by picking `@hybrag` — the pick opens this panel instead of inserting
 * a reference — and also by a citation under an answer, which arrives with the
 * passages the answer used so "show me the source" never re-runs the search.
 *
 * Everything goes through the gateway with the page's own cookie: the library
 * list, the document list, the models, and both retrieval paths read as the
 * signed-in user.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import { evidenceParams } from './evidence-tab.ts'
import { knowledgeMarker } from './reference.ts'
import {
  ask, documents, libraries, models, readDocument, search,
  type DocumentChunk, type KnowledgeCitation, type KnowledgeDocument, type Library, type ModelOption,
} from './weknora.ts'
import css from './EvidenceBody.module.css'

/** The body's composed props. */
export type EvidenceBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'knowledge'>

/** The chip title's composed props. */
export type EvidenceTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'knowledge'>

/** Which retrieval path the panel runs. */
type Mode = 'search' | 'ask'

/**
 * Render the panel body.
 * @param props - tab runtime props plus the `knowledge` dictionary.
 * @returns the scope checkboxes, the mode switch, the question box, and the results.
 */
export function EvidenceBody({ useTabInfo, t, inputActions }: EvidenceBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const revision = tab.navigation.revision
  const opened = useMemo(() => evidenceParams(tab.navigation.params), [tab.navigation.params])
  const [mode, setMode] = useState<Mode>('search')
  const [all, setAll] = useState<readonly Library[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [docLists, setDocLists] = useState<Readonly<Record<string, readonly KnowledgeDocument[] | null>>>({})
  const [selectedDocs, setSelectedDocs] = useState<ReadonlySet<string>>(new Set())
  const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([])
  const [modelId, setModelId] = useState('')
  const [query, setQuery] = useState('')
  const [citations, setCitations] = useState<readonly KnowledgeCitation[]>(opened?.citations ?? [])
  const [focus, setFocus] = useState<string | undefined>(opened?.focus)
  const [expandedChunk, setExpandedChunk] = useState<string>()
  const [bodies, setBodies] = useState<Readonly<Record<string, readonly DocumentChunk[]>>>({})
  const [answer, setAnswer] = useState('')
  const [status, setStatus] = useState<string>()
  const [running, setRunning] = useState(false)

  // Navigating the page again replaces what it shows, including when it is
  // already on screen and the second answer cites a different passage.
  useEffect(() => {
    setCitations(opened?.citations ?? [])
    setFocus(opened?.focus)
    setStatus(undefined)
  }, [opened, revision])

  // A citation chip lands on the passage it named; without this the user has
  // to hunt for it in a list of sixty.
  const focused = useRef<HTMLLIElement>(null)
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'center' })
  }, [focus])

  useEffect(() => {
    const controller = new AbortController()
    void libraries(controller.signal).then((rows) => {
      if (rows === undefined) {
        setStatus(t('search.scopeFailed'))
        return
      }
      setAll(rows)
      setSelected(new Set(rows.map(library => library.id)))
    })
    void models(controller.signal).then((rows) => {
      if (rows !== undefined) setModelOptions(rows)
    })
    return () => { controller.abort() }
  }, [t])

  /**
   * @param id - the library to include or drop from the next request.
   */
  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /**
   * Put text where the caret is, leaving whatever the user already typed.
   * @param text - text to append at the insertion point.
   */
  function insertAtCaret(text: string): void {
    const at = inputActions.captureInsertion()
    inputActions.insertText(text, { start: at.end, end: at.end, draftRev: at.draftRev })
  }

  /**
   * Carry the checked libraries back to the composer as scope markers, so the
   * next question is narrowed rather than the panel's search being repeated.
   */
  function scopeNextQuestion(): void {
    const names = all.filter(library => selected.has(library.id)).map(library => knowledgeMarker(library.name))
    insertAtCaret(`${names.join('')} `)
  }

  /**
   * Expand one citation to its full chunk, fetching the document once.
   * @param citation - the passage the user clicked.
   */
  async function toggleBody(citation: KnowledgeCitation): Promise<void> {
    if (expandedChunk === citation.chunkId) {
      setExpandedChunk(undefined)
      return
    }
    setExpandedChunk(citation.chunkId)
    const id = citation.knowledgeId
    if (id === undefined || bodies[id] !== undefined) return
    const chunks = await readDocument(id, new AbortController().signal)
    setBodies(current => ({ ...current, [id]: chunks ?? [] }))
  }

  /**
   * @param citation - the passage to show.
   * @returns its full text when expanded, otherwise the search snippet.
   */
  function bodyOf(citation: KnowledgeCitation): string {
    const id = citation.knowledgeId
    if (expandedChunk !== citation.chunkId || id === undefined) return citation.snippet ?? ''
    const chunk = bodies[id]?.find(item => item.chunkIndex === citation.chunkIndex)
    return chunk?.content ?? citation.snippet ?? ''
  }

  /**
   * @param id - the document to include or drop from the next request.
   */
  function toggleDoc(id: string): void {
    setSelectedDocs((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /**
   * Open or close one library's document list, fetching it on first open.
   * @param id - the library to expand.
   */
  async function expand(id: string): Promise<void> {
    if (expanded.has(id)) {
      setExpanded((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      return
    }
    setExpanded(current => new Set(current).add(id))
    if (docLists[id] !== undefined) return
    const rows = await documents(id, new AbortController().signal)
    setDocLists(current => ({ ...current, [id]: rows ?? null }))
  }

  /**
   * The documents under one expanded library, with explicit loading, empty and
   * failed states so a refused request never looks like an empty library.
   * @param id - the library whose documents to render.
   * @returns the rows or a one-line state message.
   */
  function renderDocuments(id: string): ReactNode {
    const docs = docLists[id]
    if (docs === null) return <p className={css.documentStatus}>{t('documents.failed')}</p>
    if (docs === undefined) return <p className={css.documentStatus}>{t('documents.loading')}</p>
    if (docs.length === 0) return <p className={css.documentStatus}>{t('documents.empty')}</p>
    return (
      <ul className={css.docs}>
        {docs.map(document => (
          <li className={css.document} key={document.id}>
            <label className={css.check}>
              <input
                checked={selectedDocs.has(document.id)}
                onChange={() => { toggleDoc(document.id) }}
                type="checkbox"
              />
              <span className={css.checkLabel}>{document.name}</span>
            </label>
          </li>
        ))}
      </ul>
    )
  }

  /**
   * @param event - the form submit.
   */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (running || query.trim() === '') return
    setRunning(true)
    setStatus(t('search.running'))
    setAnswer('')
    const controller = new AbortController()
    try {
      if (mode === 'ask') {
        const result = await ask(
          query,
          { kbIds: [...selected], docIds: [...selectedDocs] },
          modelId,
          controller.signal,
        )
        if (result === undefined) {
          setStatus(t('search.failed'))
          return
        }
        setAnswer(result.answer)
        setCitations(result.citations)
        setStatus(undefined)
        return
      }
      const found = await search(query, [...selected], [...selectedDocs])
      if (found === undefined) {
        setStatus(t('search.failed'))
        return
      }
      setCitations(found)
      setFocus(undefined)
      setStatus(found.length === 0 ? t('search.empty') : undefined)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className={css.root}>
      <div className={css.modes}>
        <button
          className={mode === 'search' ? `${css.mode} ${css.modeActive}` : css.mode}
          onClick={() => { setMode('search') }}
          type="button"
        >
          {t('mode.search')}
        </button>
        <button
          className={mode === 'ask' ? `${css.mode} ${css.modeActive}` : css.mode}
          onClick={() => { setMode('ask') }}
          type="button"
        >
          {t('mode.ask')}
        </button>
      </div>

      <section className={css.section}>
        <p className={css.sectionTitle}>
          {t('libraries.title')}
          <span className={css.sectionCount}>{t('libraries.count', { count: String(all.length) })}</span>
        </p>
        <ul className={css.libraries}>
          {all.map(library => (
            <li className={css.library} key={library.id}>
              <div className={css.libraryRow}>
                <label className={css.check}>
                  <input
                    checked={selected.has(library.id)}
                    onChange={() => { toggle(library.id) }}
                    type="checkbox"
                  />
                  <span className={css.checkLabel}>{library.name}</span>
                </label>
                <button className={css.expand} onClick={() => { void expand(library.id) }} type="button">
                  {expanded.has(library.id) ? t('documents.hide') : t('documents.show')}
                </button>
              </div>
              {expanded.has(library.id) ? renderDocuments(library.id) : null}
            </li>
          ))}
        </ul>
        {selected.size === 0 ? null : (
          <button className={css.scopeAction} onClick={scopeNextQuestion} type="button">
            {t('scope.action', { count: String(selected.size) })}
          </button>
        )}
      </section>

      {mode === 'ask' && modelOptions.length > 0 ? (
        <label className={css.modelRow}>
          {t('model.label')}
          <select
            className={css.select}
            value={modelId}
            onChange={(event) => { setModelId(event.target.value) }}
          >
            <option value="">{t('model.default')}</option>
            {modelOptions.map(option => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      <form className={css.form} onSubmit={(event) => { void submit(event) }}>
        <input
          className={css.input}
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
          placeholder={t('search.placeholder')}
        />
        <button className={css.button} disabled={running} type="submit">{t('search.action')}</button>
      </form>
      {status === undefined ? null : <p className={css.status}>{status}</p>}
      {answer === '' ? null : (
        <section className={css.section}>
          <p className={css.sectionTitle}>
            {t('answer.title')}
            <button className={css.apply} onClick={() => { inputActions.setDraft(answer) }} type="button">
              {t('apply.label')}
            </button>
          </p>
          <p className={css.answer}>{answer}</p>
        </section>
      )}
      <section className={css.section}>
        <p className={css.sectionTitle}>
          {t('sources.title')}
          <span className={css.sectionCount}>{t('sources.count', { count: String(citations.length) })}</span>
        </p>
        <ul className={css.list}>
          {citations.map(citation => (
            <li
              className={citation.chunkId === focus ? `${css.item} ${css.focused}` : css.item}
              key={citation.chunkId}
              ref={citation.chunkId === focus ? focused : undefined}
            >
              <p className={css.title}>
                {citation.title}
                <span className={css.index}>{`#${String(citation.chunkIndex)}`}</span>
              </p>
              <p
                className={expandedChunk === citation.chunkId ? css.expanded : css.snippet}
                onClick={() => { void toggleBody(citation) }}
              >
                {bodyOf(citation)}
              </p>
              <button
                className={css.apply}
                onClick={() => { insertAtCaret(`《${citation.title}》第 ${String(citation.chunkIndex)} 段：`) }}
                type="button"
              >
                {t('ask.about')}
              </button>
            </li>
          ))}
        </ul>
      </section>
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
