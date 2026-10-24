/**
 * The `@` V-Office document source.
 *
 * One menu, two levels, the shape the knowledge source already uses: typing
 * after `@` offers one row naming the user's own folder, and opening that row
 * descends into the documents. The level lives in the text the user can see and
 * undo (`@我的文档/`), so backing out is ordinary editing rather than a hidden
 * mode, and the folder listing is fetched only once the menu descends.
 *
 * A settling pick inside the folder inserts an atomic reference, so the turn
 * carries the document as a fact rather than a name the run hopes to remember.
 * The drill action (Tab, or the row's chevron) opens that document in an online
 * editor instead and hands the pick back as handled, leaving the draft alone.
 *
 * @module @deepseek-ai/dsh-client-ui-voffice/client
 */
import type {
  InputTriggerCandidate, InputTriggerCrumb, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { failureOf, listDocuments, openDocument } from './api.ts'
import type { VofficeKey } from './locales.ts'
import { markerOf } from './markers.ts'

/** Rows one menu may render; the listing itself is never truncated upstream. */
const ROW_LIMIT = 100

/** Menu value that returns a descended menu to the folder level. */
const ROOT = 'voffice-root'

/** Dictionary-bound translate. */
export type Translate = (key: VofficeKey) => string

/** Extension to the copy naming what that kind of document is. */
const KIND_KEYS: Readonly<Record<string, VofficeKey>> = {
  doc: 'source.kindWord',
  docx: 'source.kindWord',
  xls: 'source.kindSheet',
  xlsx: 'source.kindSheet',
  csv: 'source.kindSheet',
  ppt: 'source.kindSlides',
  pptx: 'source.kindSlides',
  pdf: 'source.kindPdf',
}

/**
 * @param query - text between `@` and the caret.
 * @returns that text without a leading trigger character the pipeline kept.
 */
function pathOf(query: string): string {
  return query.startsWith('@') ? query.slice(1) : query
}

/**
 * @param name - the document's cloud name.
 * @param t - the V-Office dictionary.
 * @returns what kind of document it is, or an empty string when unknown.
 */
function describeOf(name: string, t: Translate): string {
  const dot = name.lastIndexOf('.')
  if (dot === -1 || dot === name.length - 1) return ''
  const key = KIND_KEYS[name.slice(dot + 1).toLowerCase()]
  return key === undefined ? '' : t(key)
}

/**
 * The row a menu shows instead of documents, never selectable.
 * @param name - already-translated row text.
 * @param description - cause line, empty when there is nothing to explain.
 * @returns one inert candidate.
 */
function noticeRow(name: string, description: string): InputTriggerCandidate {
  return { name, description, icon: 'file', value: '' }
}

/**
 * The only row the menu opens on: the folder itself.
 * @param t - the V-Office dictionary.
 * @returns the descendable folder row.
 */
function folderRow(t: Translate): InputTriggerCandidate {
  return {
    name: t('source.root'),
    label: t('source.root'),
    description: t('source.rootHint'),
    icon: 'folder',
    value: ROOT,
    drill: true,
  }
}

/**
 * Rows inside the folder, filtered by what the user typed after the slash.
 * @param keyword - text typed after the folder token.
 * @param signal - aborted when the user keeps typing or closes the menu.
 * @param t - the V-Office dictionary.
 * @returns the document rows, or one inert notice row.
 */
async function documentRows(
  keyword: string,
  signal: AbortSignal,
  t: Translate,
): Promise<readonly InputTriggerCandidate[]> {
  const list = await listDocuments(signal)
  if (list === undefined) {
    // An aborted request is a superseded one, not a failure to report.
    if (signal.aborted) return []
    return [noticeRow(t('source.failed'), failureOf() ?? '')]
  }
  if (list.length === 0) return [noticeRow(t('source.empty'), '')]
  const needle = keyword.trim().toLowerCase()
  const matched = needle === '' ? list : list.filter(file => file.name.toLowerCase().includes(needle))
  if (matched.length === 0) return [noticeRow(t('source.empty'), '')]
  return matched.slice(0, ROW_LIMIT).map(file => ({
    name: file.name,
    label: file.name,
    description: describeOf(file.name, t),
    icon: 'file' as const,
    value: file.name,
    // Tab and the row chevron open the document instead of inserting it.
    drill: true,
  }))
}

/**
 * Build the `@` source for this plugin.
 * @param t - the V-Office dictionary.
 * @returns the trigger source to register.
 */
export function vofficeSource(t: Translate): InputTriggerSource {
  return {
    trigger: '@',
    name: 'voffice',
    // Ahead of the file and session sources: on this platform the user's own
    // cloud documents are the likeliest thing they mean after `@`.
    order: -10,
    showGroupTitle: false,

    async candidates(_session, { query, signal }) {
      const path = pathOf(query)
      const slash = path.indexOf('/')
      // The folder level costs no request: it is one row the user descends.
      if (slash === -1) return [folderRow(t)]
      return documentRows(path.slice(slash + 1), signal, t)
    },

    header(_session, { query }): readonly InputTriggerCrumb[] | undefined {
      const path = pathOf(query)
      const slash = path.indexOf('/')
      // Only a descent owes a way back; text the user typed carries its own
      // context in the draft.
      if (slash === -1) return undefined
      return [{ label: t('source.root'), value: ROOT }]
    },

    onPick({ candidate, action }) {
      const name = candidate.value
      // Notice rows carry no value: claiming one would insert an empty ref.
      if (name === undefined || name === '') return undefined
      if (name === ROOT) {
        // The only thing the folder row can do is open the folder, whether the
        // user settled it or drilled into it.
        return { text: `@${t('source.root')}/`, continue: true }
      }
      if (action === 'drill') {
        openDocument(name)
        // The draft keeps whatever the user typed; only the editor tab opens.
        return 'handled'
      }
      return {
        insert: {
          source: 'voffice',
          ref: name,
          label: name,
          appearance: 'file',
          clipboardText: name,
        },
      }
    },

    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(markerOf(ref)),
    },

    openReference(_session, { ref }) {
      if (ref === '') return false
      openDocument(ref)
      return true
    },
  }
}
