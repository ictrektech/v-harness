/**
 * The knowledge-base scope marker, `<knowledge-base>库名</knowledge-base>`.
 *
 * Two producers write the same text — the `@` pick and the panel's scope
 * button — so one rule renders both as a chip, and a replayed message shows
 * the same thing the user typed.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** One library the message narrowed this turn to. */
    knowledge: { readonly name: string }
  }
}

/** One `<knowledge-base>` pair; the name is whatever the picker inserted. */
const MARKER = /<knowledge-base>([^<]+)<\/knowledge-base>/gu

/** Render every scope marker in a user message as a chip. */
export const knowledgeReferenceRule: UserTextRule<'knowledge'> = {
  id: 'knowledge',
  order: 30,
  match(text, from) {
    MARKER.lastIndex = from
    const token = MARKER.exec(text)
    if (token === null) return undefined
    return {
      id: 'knowledge',
      start: token.index,
      end: token.index + token[0].length,
      data: { name: token[1] as string },
    }
  },
}

/**
 * @param name - library name to narrow to.
 * @returns the marker text both producers insert.
 */
export function knowledgeMarker(name: string): string {
  return `<knowledge-base>${name}</knowledge-base>`
}
