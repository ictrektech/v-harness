/**
 * The `@` knowledge source.
 *
 * One menu, two levels: typing after `@` lists the libraries this account can
 * read, and Tab on a library descends into its documents (the pipeline
 * rewrites the draft to `@library/`, so the level lives in the text the user
 * can see and undo). Typing after the slash filters documents server-side,
 * because a library can hold more documents than one page.
 *
 * A settling pick inserts an atomic reference: the model side sees
 * `<knowledge-base>…</knowledge-base>` or
 * `<knowledge-document>library/document</knowledge-document>`, so "search this
 * library" is a fact of the turn rather than a scope the run hopes to remember.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import type {
  InputTriggerCandidate, InputTriggerCrumb, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { documents, failureOf, libraries } from './api.ts'
import type { KnowledgeKey } from './locales.ts'
import { decodeScope, encodeScope, labelOf, markerOf, type Scope } from './markers.ts'

/** Menu value that returns a drilled menu to the library level. */
const ROOT = 'kb-root'

/** Dictionary-bound translate. */
export type Translate = (key: KnowledgeKey) => string

/**
 * @param query - text between `@` and the caret.
 * @returns the text after the trigger character, when the pipeline kept one.
 */
function pathOf(query: string): string {
  return query.startsWith('@') ? query.slice(1) : query
}

/**
 * @param type - the library type reported by the server.
 * @returns the row glyph: `wiki` and `faq` libraries read as files, documents
 *   libraries as folders.
 */
function iconOf(type: string): 'file' | 'folder' {
  return type === 'document' ? 'folder' : 'file'
}

/**
 * @param type - the library type reported by the server.
 * @param t - the knowledge dictionary.
 * @returns the row description naming what the library holds.
 */
function describeType(type: string, t: Translate): string {
  if (type === 'faq') return t('source.section')
  if (type === 'wiki') return t('source.section')
  return t('source.section')
}

/**
 * Rows for the library level: the visible libraries, then the panel row.
 * @param query - text typed after `@`.
 * @param signal - aborted when the user keeps typing or closes the menu.
 * @param t - the knowledge dictionary.
 * @returns the menu rows.
 */
async function baseRows(query: string, signal: AbortSignal, t: Translate): Promise<readonly InputTriggerCandidate[]> {
  const list = await libraries(signal)
  if (list === undefined) {
    return [{ name: t('source.failed'), description: failureOf() ?? '', icon: 'folder', value: 'kb-unavailable' }]
  }
  if (list.length === 0) {
    return [{ name: t('source.empty'), description: '', icon: 'folder', value: 'kb-unavailable' }]
  }
  const needle = query.trim().toLowerCase()
  const rows = list
    .filter(library => library.name.toLowerCase().includes(needle))
    .map(library => ({
      name: library.name,
      label: library.name,
      description: describeType(library.type, t),
      section: t('source.section'),
      icon: iconOf(library.type),
      value: `kb:${library.name}`,
      // Tab descends into the library; the settling pick takes the whole
      // library as the scope.
      drill: true,
    }))
  return rows
}

/**
 * Rows for the document level: documents inside one library.
 * @param baseName - the library the draft descended into.
 * @param keyword - text typed after the slash, sent to the server as a filter.
 * @param signal - aborted when the user keeps typing or closes the menu.
 * @param t - the knowledge dictionary.
 * @returns the menu rows.
 */
async function documentRows(
  baseName: string,
  keyword: string,
  signal: AbortSignal,
  t: Translate,
): Promise<readonly InputTriggerCandidate[]> {
  const list = await libraries(signal)
  const library = list?.find(item => item.name === baseName)
  if (library === undefined) return []
  const found = await documents(library.id, keyword.trim(), signal)
  if (found === undefined) {
    return [{ name: t('documents.failed'), description: failureOf() ?? '', icon: 'file', value: `kb:${baseName}` }]
  }
  if (found.length === 0) {
    return [{ name: t('documents.empty'), description: '', icon: 'file', value: `kb:${baseName}` }]
  }
  return found.map(document => ({
    name: document.name,
    label: document.name,
    description: document.folder,
    section: baseName,
    icon: 'file',
    value: `doc:${baseName}/${document.name}`,
  }))
}

/**
 * Build the source registered under `@` for this plugin.
 * @param t - the knowledge dictionary.
 * @param openPanel - opens the evidence panel in the right column.
 * @returns the trigger source to register.
 */
export function knowledgeSource(t: Translate): InputTriggerSource {
  return {
    trigger: '@',
    name: 'knowledge',
    // Right under the V-Office section: both are the account's own services,
    // while the file and session sources below are local to the workspace.
    order: -5,
    showGroupTitle: false,

    async candidates(_session, { query, signal }) {
      const path = pathOf(query)
      const slash = path.indexOf('/')
      return slash === -1
        ? baseRows(path, signal, t)
        : documentRows(path.slice(0, slash), path.slice(slash + 1), signal, t)
    },

    header(_session, { query }): readonly InputTriggerCrumb[] | undefined {
      const path = pathOf(query)
      const slash = path.indexOf('/')
      // Only a descent owes a way back; text the user typed carries its own
      // context in the draft.
      if (slash === -1) return undefined
      const base = path.slice(0, slash)
      return [
        { label: t('source.all'), value: ROOT },
        { label: base, value: `kb:${base}`, current: true },
      ]
    },

    onPick({ candidate, action }) {
      if (candidate.value === ROOT) return { text: '@', continue: true }
      const scope = typeof candidate.value === 'string' ? decodeScope(candidate.value) : undefined
      if (scope === undefined) return undefined
      if (action === 'drill') {
        // Only a library descends; a document is a terminal scope.
        return scope.kind === 'base' ? { text: `@${scope.name}/`, continue: true } : undefined
      }
      return {
        insert: {
          source: 'knowledge',
          ref: encodeScope(scope),
          label: labelOf(scope),
          appearance: scope.kind === 'base' ? 'folder' : 'file',
          clipboardText: labelOf(scope),
        },
      }
    },

    codec: {
      clipboardText: (ref) => {
        const scope = decodeScope(ref)
        return scope === undefined ? ref : labelOf(scope)
      },
      serialize: (ref) => {
        const scope: Scope | undefined = decodeScope(ref)
        // A ref this source did not encode must not reach the model as a
        // half-understood marker; the send fails instead of degrading quietly.
        return scope === undefined
          ? Promise.reject(new Error(`unknown knowledge reference "${ref}"`))
          : Promise.resolve(markerOf(scope))
      },
    },
  }
}
