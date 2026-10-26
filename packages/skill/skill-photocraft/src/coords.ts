/**
 * Region coordinates, in the one unit that survives every surface.
 *
 * A preview in the chat, the composer thumbnail and the engine's own canvas are
 * three different pixel grids; only the proportion between them is stable. Every
 * tool therefore takes and returns `0..1` fractions of the document, and the
 * conversion happens once, here.
 *
 * @module @deepseek-ai/dsh-skill-photocraft/coords
 */

/** One rectangle as fractions of the document, each in `0..1`. */
export interface Region {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** One rectangle in document pixels, as the engine's selection commands take it. */
export interface PixelBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Clamp one region into the document and reject the degenerate ones.
 * @param region - fractions as supplied by the caller.
 * @returns the clamped region.
 * @throws when the region has no area after clamping.
 */
export function normalizeRegion(region: Region): Region {
  const clamp = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  // Four decimals is finer than any engine pixel at the largest document the
  // service accepts, and it keeps clipping from leaking binary rounding noise
  // into the numbers a model reads back.
  const round = (value: number): number => Math.round(clamp(value) * 10_000) / 10_000
  const x = round(region.x)
  const y = round(region.y)
  const clipped = {
    x,
    y,
    w: round(Math.min(round(region.w), 1 - x)),
    h: round(Math.min(round(region.h), 1 - y)),
  }
  if (clipped.w <= 0 || clipped.h <= 0) throw new Error('photocraft: 选区为空，框选范围需要覆盖至少一个像素')
  return clipped
}

/**
 * Turn fractions into the pixel rectangle a selection command takes.
 * @param region - fractions of the document.
 * @param size - document size in pixels.
 * @returns integer pixel bounds covering at least one pixel each way.
 */
export function toPixels(region: Region, size: { width: number; height: number }): PixelBox {
  const clipped = normalizeRegion(region)
  return {
    x: Math.round(clipped.x * size.width),
    y: Math.round(clipped.y * size.height),
    width: Math.max(1, Math.round(clipped.w * size.width)),
    height: Math.max(1, Math.round(clipped.h * size.height)),
  }
}



