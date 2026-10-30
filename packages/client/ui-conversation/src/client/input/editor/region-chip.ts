/**
 * The composer's own region/brush tokens as reference chips.
 *
 * The token is what the model reads and what the turn log keeps, so it rides in
 * the chip's clipboard projection (`ReferenceChipNode.__clipboardText`) and the
 * chip only shows a glyph. No text transform is involved: the picker inserts the
 * chip once, and editing never rebuilds it.
 *
 * @module @deepseek-ai/dsh-client-ui-conversation/input/editor/region-chip
 */

/** Chip source tag: the picker's own marks, distinct from `@` reference sources. */
export const REGION_SOURCE = 'region'

/**
 * Read a token's kind and order for the chip label.
 * @param token - one complete token, or anything else.
 * @returns the glyph and order the chip shows; `1` when the token carries no `n`.
 */
export function regionChipLabel(token: string): string {
  const trimmed = token.trim()
  const mark = trimmed.startsWith('<strokes ') ? '✎' : '▦'
  const index = / n="(\d+)"/u.exec(trimmed)
  return `${mark} ${index === null ? '1' : index[1] as string}`
}

/**
 * Split the picker's newline-joined token batch.
 * @param tokens - whole tokens, one per line.
 * @returns the non-empty tokens, in order.
 */
export function regionTokens(tokens: string): string[] {
  return tokens.split('\n').map(token => token.trim()).filter(token => token !== '')
}
