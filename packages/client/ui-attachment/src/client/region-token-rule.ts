/**
 * Collapse composer region/brush tokens into one inline chip in sent messages.
 *
 * The tokens stay in the source text: they are what the model reads and what the
 * turn log keeps. This rule only decides how the same range is displayed, so a
 * bubble shows `区域 1` instead of a wall of fractions, and the coordinates stay
 * reachable through the chip's title.
 *
 * @module @deepseek-ai/dsh-client-ui-attachment/region-token-rule
 */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    region: {
      /** `box` from a dragged rectangle, `brush` from a painted stroke. */
      readonly kind: 'box' | 'brush'
      /** Which mark on that image, as the token's own `n`, starting at 1. */
      readonly index: number
    }
  }
}

/** Opener of each token spelling, in the order {@link formatRegionToken} writes it. */
const OPENERS = [
  ['<region ', 'box', '/>'],
  ['<strokes ', 'brush', '</strokes>'],
] as const

/**
 * Find the nearest token at or after `from` and cover its whole range.
 * A tag missing its closer is not a token: the text stays as it was typed.
 * @param text - complete original text.
 * @param from - inclusive start offset.
 * @param context - synchronous Facts reader supplied by the evaluator.
 * @returns the collapsed node, or undefined when no later token exists.
 */
export const regionTokenRule: UserTextRule<'region'> = {
  id: 'region',
  order: 20,
  match(text, from) {
    let start = -1
    let kind: 'box' | 'brush' = 'box'
    let closer = '/>'
    for (const [opener, tokenKind, tokenCloser] of OPENERS) {
      const at = text.indexOf(opener, from)
      if (at < 0 || (start >= 0 && at >= start)) continue
      start = at
      kind = tokenKind
      closer = tokenCloser
    }
    if (start < 0) return undefined
    const closeAt = text.indexOf(closer, start)
    if (closeAt < 0) return undefined
    const end = closeAt + closer.length
    const index = / n="(\d+)"/u.exec(text.slice(start, end))
    return {
      id: 'region',
      start,
      end,
      data: { kind, index: index === null ? 1 : Number(index[1]) },
    }
  },
}
