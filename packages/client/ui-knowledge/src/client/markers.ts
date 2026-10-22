/**
 * The `@` scope marker, and the two shapes a knowledge reference takes.
 *
 * A picked library serialises as `<knowledge-base>库名</knowledge-base>` and a
 * picked document as `<knowledge-document>库名/文档名</knowledge-document>`.
 * Both are plain text in the user message, so the model reads the scope as a
 * fact of the turn, and a replayed message renders the same chips without
 * asking the gateway anything.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** One library the message narrowed this turn to. */
    knowledgeBase: { readonly name: string }
    /** One document the message narrowed this turn to. */
    knowledgeDocument: { readonly base: string; readonly name: string }
  }
}

/** Marker tags; the dialog between this plugin and the `weknora` skill. */
const BASE_TAG = 'knowledge-base'
const DOCUMENT_TAG = 'knowledge-document'

/** A scope a chip can carry: a whole library or one of its documents. */
export type Scope =
  | { readonly kind: 'base'; readonly name: string }
  | { readonly kind: 'document'; readonly base: string; readonly name: string }

/**
 * @param scope - the picked scope.
 * @returns its model-facing marker text.
 */
export function markerOf(scope: Scope): string {
  return scope.kind === 'base'
    ? `<${BASE_TAG}>${scope.name}</${BASE_TAG}>`
    : `<${DOCUMENT_TAG}>${scope.base}/${scope.name}</${DOCUMENT_TAG}>`
}

/**
 * @param scope - the picked scope.
 * @returns the chip label: the library name, or the document inside it.
 */
export function labelOf(scope: Scope): string {
  return scope.kind === 'base' ? scope.name : `${scope.base} / ${scope.name}`
}

/**
 * Encode a scope into the opaque `ref` a trigger source hands the pipeline.
 * @param scope - the picked scope.
 * @returns `kb:<name>` or `doc:<base>/<name>`.
 */
export function encodeScope(scope: Scope): string {
  return scope.kind === 'base' ? `kb:${scope.name}` : `doc:${scope.base}/${scope.name}`
}

/**
 * @param ref - an encoded scope, or any other source's ref.
 * @returns the scope, or undefined when this source did not produce it.
 */
export function decodeScope(ref: string): Scope | undefined {
  if (ref.startsWith('kb:')) return ref.length > 3 ? { kind: 'base', name: ref.slice(3) } : undefined
  if (!ref.startsWith('doc:')) return undefined
  const rest = ref.slice(4)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined
  return { kind: 'document', base: rest.slice(0, slash), name: rest.slice(slash + 1) }
}

/** One `<knowledge-base>` pair. */
const BASE_MARKER = new RegExp(`<${BASE_TAG}>([^<]+)</${BASE_TAG}>`, 'gu')
/** One `<knowledge-document>` pair; the name is `<library>/<document>`. */
const DOCUMENT_MARKER = new RegExp(`<${DOCUMENT_TAG}>([^<]+)</${DOCUMENT_TAG}>`, 'gu')

/** Render every library marker in a user message as a chip. */
export const baseScopeRule: UserTextRule<'knowledgeBase'> = {
  id: 'knowledgeBase',
  order: 30,
  match(text, from) {
    BASE_MARKER.lastIndex = from
    const token = BASE_MARKER.exec(text)
    if (token === null) return undefined
    return {
      id: 'knowledgeBase',
      start: token.index,
      end: token.index + token[0].length,
      data: { name: token[1] as string },
    }
  },
}

/** Render every document marker in a user message as a chip. */
export const documentScopeRule: UserTextRule<'knowledgeDocument'> = {
  id: 'knowledgeDocument',
  order: 30,
  match(text, from) {
    DOCUMENT_MARKER.lastIndex = from
    const token = DOCUMENT_MARKER.exec(text)
    if (token === null) return undefined
    const name = token[1] as string
    const slash = name.indexOf('/')
    return {
      id: 'knowledgeDocument',
      start: token.index,
      end: token.index + token[0].length,
      data: { base: slash === -1 ? '' : name.slice(0, slash), name: slash === -1 ? name : name.slice(slash + 1) },
    }
  },
}
