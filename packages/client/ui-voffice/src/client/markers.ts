/**
 * The `@` document marker and the rule that renders it as a chip.
 *
 * A picked document serialises as `<voffice-document>名字</voffice-document>`,
 * which stays plain text in the user message: the model reads the cloud
 * document as a fact of the turn, and a replayed message renders the same chip
 * without asking the gateway anything.
 *
 * @module @deepseek-ai/dsh-client-ui-voffice/client
 */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** One V-Office document this message points at. */
    vofficeDocument: { readonly name: string }
  }
}

/** Marker tag; the dialog between this plugin and the `voffice` skill. */
const TAG = 'voffice-document'

/** One `<voffice-document>` pair. */
const MARKER = new RegExp(`<${TAG}>([^<]+)</${TAG}>`, 'gu')

/**
 * @param name - the document's cloud name.
 * @returns its model-facing marker text.
 */
export function markerOf(name: string): string {
  return `<${TAG}>${name}</${TAG}>`
}

/** Render every document marker in a user message as a chip. */
export const documentRule: UserTextRule<'vofficeDocument'> = {
  id: 'vofficeDocument',
  order: 35,
  match(text, from) {
    MARKER.lastIndex = from
    const token = MARKER.exec(text)
    if (token === null) return undefined
    return {
      id: 'vofficeDocument',
      start: token.index,
      end: token.index + token[0].length,
      data: { name: token[1] as string },
    }
  },
}
