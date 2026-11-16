/**
 * The `@` container marker and the rule that renders it as a chip.
 *
 * A picked container serialises as
 * `<vos-container id="…64 hex…">name</vos-container>`, which stays plain text
 * in the user message: the model reads both the container the user meant and
 * the identifier the operations tool needs, and a replayed message renders the
 * same chip without asking the gateway anything.
 *
 * @module @deepseek-ai/dsh-client-ui-vos-container/client
 */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** One VOS application container this message points at. */
    vosContainer: { readonly id: string; readonly name: string }
  }
}

/** Marker tag; the dialog between this plugin and the operations tools. */
const TAG = 'vos-container'

/** One `<vos-container>` pair carrying the id attribute. */
const MARKER = new RegExp(`<${TAG} id="([^"<>]+)">([^<>]+)</${TAG}>`, 'gu')

/** Separates the id from the name inside one source-owned reference. */
const SEPARATOR = '/'

/**
 * @param id - the container's full identifier.
 * @param name - the container's Docker name.
 * @returns the opaque reference this source stores in a picked chip.
 */
export function refOf(id: string, name: string): string {
  return `${id}${SEPARATOR}${name}`
}

/**
 * @param ref - one source-owned reference.
 * @returns the container id and name it carries.
 */
export function partsOf(ref: string): { readonly id: string; readonly name: string } {
  const at = ref.indexOf(SEPARATOR)
  // A reference without the separator is a bare identifier: the name is then
  // the identifier itself, which still renders as a readable chip.
  return at === -1
    ? { id: ref, name: ref }
    : { id: ref.slice(0, at), name: ref.slice(at + 1) }
}

/**
 * @param ref - one source-owned reference.
 * @returns the container name inside it.
 */
export function nameOf(ref: string): string {
  return partsOf(ref).name
}

/**
 * @param ref - one source-owned reference.
 * @returns its model-facing marker text.
 */
export function markerOf(ref: string): string {
  const { id, name } = partsOf(ref)
  return `<${TAG} id="${id}">${name}</${TAG}>`
}

/** Render every container marker in a user message as a chip. */
export const containerRule: UserTextRule<'vosContainer'> = {
  id: 'vosContainer',
  order: 36,
  match(text, from) {
    MARKER.lastIndex = from
    const token = MARKER.exec(text)
    if (token === null) return undefined
    return {
      id: 'vosContainer',
      start: token.index,
      end: token.index + token[0].length,
      data: { id: token[1] as string, name: token[2] as string },
    }
  },
}
