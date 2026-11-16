/**
 * The `@` VOS container source.
 *
 * One menu, two levels, the shape the V-Office and knowledge sources already
 * use: typing after `@` offers one `VOS containers` section holding one row
 * that names the container level, and opening that row descends into the
 * containers of the current conversation. The level lives in the text the user
 * can see and undo (`@容器/`), so backing out is ordinary editing rather than a
 * hidden mode, and the listing is fetched only once the menu descends.
 *
 * The source is invisible unless the conversation carries the operations preset
 * AND the gateway admits the reader: an ordinary conversation sees no row at
 * all, and so does anyone who is not a VOS system administrator. Both halves
 * matter — the preset is known locally and costs no request, while only the
 * gateway can answer for the role.
 *
 * The rows are exactly the containers the operations tool may act on: VOS
 * application stacks only. Picking one inserts an atomic reference carrying the
 * container id, so the next turn can name the target without a lookup.
 *
 * @module @deepseek-ai/dsh-client-ui-vos-container/client
 */
import type {
  ClientSessionContext, InputTriggerCandidate, InputTriggerCrumb, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { listContainers, type VosContainer } from './api.ts'
import type { VosContainerKey } from './locales.ts'
import { markerOf, nameOf, refOf } from './markers.ts'

/** Rows one menu may render; the listing itself is never truncated upstream. */
const ROW_LIMIT = 100

/** The permission preset that opens VOS operations for one conversation. */
const PRESET = 'vos-full-access'

/** How long an admitted answer stands before the menu asks again. */
const ADMITTED_TTL_MS = 30_000

/** How long a refusal stands; short, because the gate can change mid-session. */
const REFUSED_TTL_MS = 5_000

/** Menu value that descends from the header row into the container level. */
const ROOT = 'vos-container-root'

/** Menu value that walks a descended menu back to the `@` level. */
const BACK = 'vos-container-back'

/** Dictionary-bound translate. */
export type Translate = (key: VosContainerKey) => string

/** What this source may ask of the surrounding client. */
export interface VosContainerAccess {
  /**
   * @param sessionId - the conversation in the composer.
   * @returns its current permission preset, or undefined before it is known.
   */
  preset(sessionId: ClientSessionContext['sessionId']): string | undefined
}

/**
 * @param query - text between `@` and the caret.
 * @returns that text without a leading trigger character the pipeline kept.
 */
function pathOf(query: string): string {
  return query.startsWith('@') ? query.slice(1) : query
}

/**
 * The row a menu shows in place of containers, never selectable.
 * @param name - already-translated row text.
 * @returns one inert candidate.
 */
function noticeRow(name: string): InputTriggerCandidate {
  return { name, icon: 'file', value: '' }
}

/**
 * The only row the menu opens on: the container level itself.
 * @param t - the VOS container dictionary.
 * @returns the descendable container row.
 */
function containerLevelRow(t: Translate): InputTriggerCandidate {
  return {
    name: t('source.root'),
    label: t('source.section'),
    description: t('source.rootHint'),
    // The section heading sits above this row, the way the knowledge source
    // heads its own rows; the group-title row stays off.
    section: t('source.section'),
    icon: 'folder',
    value: ROOT,
    drill: true,
  }
}

/**
 * @param container - one listed container.
 * @param t - the VOS container dictionary.
 * @returns its menu row.
 */
function containerRow(container: VosContainer, t: Translate): InputTriggerCandidate {
  return {
    name: container.name,
    label: container.name,
    description: `${container.appId} · ${container.state}`,
    section: t('source.section'),
    icon: 'file',
    value: refOf(container.id, container.name),
  }
}

/**
 * Rows inside the container level, filtered by what the user typed after the
 * slash.
 * @param containers - the admitted listing.
 * @param keyword - text typed after the container token.
 * @param t - the VOS container dictionary.
 * @returns the container rows, or one inert notice row.
 */
function containerRows(
  containers: readonly VosContainer[],
  keyword: string,
  t: Translate,
): readonly InputTriggerCandidate[] {
  if (containers.length === 0) return [noticeRow(t('source.empty'))]
  const needle = keyword.trim().toLowerCase()
  const matched = needle === ''
    ? containers
    : containers.filter(container => container.name.toLowerCase().includes(needle)
      || container.appId.toLowerCase().includes(needle))
  if (matched.length === 0) return [noticeRow(t('source.empty'))]
  return [...matched]
    // An application's containers read as one group, the way they deploy.
    .sort((left, right) => left.appId.localeCompare(right.appId) || left.name.localeCompare(right.name))
    .slice(0, ROW_LIMIT)
    .map(container => containerRow(container, t))
}

/**
 * Build the `@` source for this plugin.
 * @param t - the VOS container dictionary.
 * @param access - the permission preset this conversation currently carries.
 * @returns the trigger source to register.
 */
export function vosContainerSource(t: Translate, access: VosContainerAccess): InputTriggerSource {
  /** Admitted or refused listings, so typing after `@` does not re-ask. */
  const settled = new Map<string, { at: number; admitted: boolean; containers: readonly VosContainer[] }>()
  /** One in-flight listing per conversation, shared by every keystroke. */
  const pending = new Map<string, Promise<{ admitted: boolean; containers: readonly VosContainer[] }>>()

  const enabled = (session: ClientSessionContext): boolean => access.preset(session.sessionId) === PRESET

  /**
   * @param sessionId - the conversation to list for.
   * @returns whether this reader may see containers, and which ones.
   */
  const probe = (sessionId: string): Promise<{ admitted: boolean; containers: readonly VosContainer[] }> => {
    const hit = settled.get(sessionId)
    if (hit !== undefined) {
      const ttl = hit.admitted ? ADMITTED_TTL_MS : REFUSED_TTL_MS
      if (Date.now() - hit.at < ttl) return Promise.resolve(hit)
    }
    const running = pending.get(sessionId)
    if (running !== undefined) return running
    const started = listContainers(sessionId, new AbortController().signal)
      .then((result) => {
        const snapshot = result.ok
          ? { at: Date.now(), admitted: true, containers: result.containers }
          : { at: Date.now(), admitted: false, containers: [] }
        settled.set(sessionId, snapshot)
        return snapshot
      })
      .finally(() => { pending.delete(sessionId) })
    pending.set(sessionId, started)
    return started
  }

  return {
    trigger: '@',
    name: 'vosContainer',
    // Between the V-Office documents (-10) and the knowledge bases (-5): a
    // container is the thing to name right after a document or a library.
    order: -8,
    showGroupTitle: false,

    warm(session) {
      // Prefetch only where the preset already allows it: a conversation that
      // never enables operations costs the gateway nothing.
      if (enabled(session)) void probe(String(session.sessionId))
    },

    async candidates(session, { query }) {
      // Both levels disappear together, so a `@` in an ordinary conversation
      // shows nothing of this source and keeps every other source intact.
      if (!enabled(session)) return []
      const snapshot = await probe(String(session.sessionId))
      // A refused reader (not a system administrator, or a role revoked
      // mid-session) gets no row at all rather than an entry that cannot work.
      if (!snapshot.admitted) return []
      const path = pathOf(query)
      const slash = path.indexOf('/')
      // The container level costs no request of its own: it is one row the user
      // descends into the listing the probe already holds.
      if (slash === -1) return [containerLevelRow(t)]
      // Only the token this source writes descends into its containers; a slash
      // under any other first segment belongs to another `@` source (a document
      // folder, a knowledge base) and lists nothing here.
      if (path.slice(0, slash) !== t('source.root')) return []
      return containerRows(snapshot.containers, path.slice(slash + 1), t)
    },

    header(_session, { query }): readonly InputTriggerCrumb[] | undefined {
      const path = pathOf(query)
      const slash = path.indexOf('/')
      // Only a descent owes a way back; text the user typed carries its own
      // context in the draft.
      if (slash === -1) return undefined
      // A foreign descent names no trail of this source's.
      if (path.slice(0, slash) !== t('source.root')) return undefined
      return [
        { label: t('source.back'), value: BACK },
        { label: t('source.root'), value: ROOT, current: true },
      ]
    },

    onPick({ candidate }) {
      const value = candidate.value
      // Notice rows carry no value: claiming one would insert an empty ref.
      if (value === undefined || value === '') return undefined
      // The crumb walks back to the container row, leaving the bare trigger in
      // the draft: the menu reopens on the level it came from.
      if (value === BACK) return { text: '@', continue: true }
      if (value === ROOT) {
        // The only thing the container row can do is open the level, whether
        // the user settled it or drilled into it.
        return { text: `@${t('source.root')}/`, continue: true }
      }
      return {
        insert: {
          source: 'vosContainer',
          ref: value,
          label: nameOf(value),
          appearance: 'file',
          clipboardText: nameOf(value),
        },
      }
    },

    codec: {
      clipboardText: ref => nameOf(ref),
      serialize: ref => Promise.resolve(markerOf(ref)),
    },
  }
}
