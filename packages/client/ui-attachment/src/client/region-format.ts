/**
 * Region tokens for the composer.
 *
 * The picker measures a rectangle on the draft image, but the model needs a
 * position inside a document it has never seen at that size. Neither pixels nor
 * a screenshot helps across those surfaces, so the composer emits fractions of
 * the image (`0..1`) inside a self-describing tag that rides along with the
 * user's own words:
 *
 * ```text
 * 把这块去掉
 * <region image="att_7f3c" x="0.14" y="0.69" w="0.71" h="0.11"/>
 * ```
 *
 * Text is deliberate: it is model-visible, it is logged with the turn, and it
 * needs no new message part type or browser-only state.
 *
 * @module @deepseek-ai/dsh-client-ui-attachment/region-format
 */

/** A rectangle as fractions of the image, each in `0..1`. */
export interface Region {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The smallest region the picker will produce, in fractions. */
const MIN_SIDE = 0.004

/**
 * Keep a dragged rectangle inside the image and drop the accidental clicks.
 * @param region - raw fractions from the pointer.
 * @returns the clamped region, or `undefined` when it is too small to mean anything.
 */
export function clampRegion(region: Region): Region | undefined {
  const clamp = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  const x = clamp(region.x)
  const y = clamp(region.y)
  const w = Math.min(clamp(region.w), 1 - x)
  const h = Math.min(clamp(region.h), 1 - y)
  if (w < MIN_SIDE || h < MIN_SIDE) return undefined
  return { x, y, w, h }
}

/** What a box means: cut from the subject, or place onto the material. */
export type RegionRole = 'cut' | 'place'

/**
 * The tag appended to the message.
 *
 * `img` is the picture's position in the message (`1` for the first image) and is
 * the only field a model can line up with what it received: `image` is a draft id
 * that exists solely in this browser and means nothing once the message is sent.
 * @param attachmentId - the draft attachment the region was drawn on.
 * @param region - fractions of that image.
 * @param role - `cut` for the first image, `place` for any later one.
 * @param index - which box on that image, starting at 1.
 * @param image - which picture in the message, starting at 1.
 * @returns the one-line token.
 */
export function formatRegionToken(
  attachmentId: string,
  region: Region,
  role: RegionRole = 'cut',
  index = 1,
  image = 1,
): string {
  const fixed = (value: number): string => value.toFixed(4)
  const attributes = [
    `role="${role}"`,
    `n="${String(index)}"`,
    `img="${String(image)}"`,
    `image="${attachmentId}"`,
    `x="${fixed(region.x)}"`,
    `y="${fixed(region.y)}"`,
    `w="${fixed(region.w)}"`,
    `h="${fixed(region.h)}"`,
  ]
  return `<region ${attributes.join(' ')}/>`
}

/**
 * The chip copy that shows the user what was measured.
 * @param region - fractions of the image.
 * @returns a short percentage summary, e.g. `14%,69% · 71%×11%`.
 */
export function regionSummary(region: Region): string {
  const pct = (value: number): string => `${String(Math.round(value * 100))}%`
  return `${pct(region.x)},${pct(region.y)} · ${pct(region.w)}×${pct(region.h)}`
}
