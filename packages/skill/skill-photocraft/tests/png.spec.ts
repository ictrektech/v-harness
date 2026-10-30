import { describe, expect, it } from 'vitest'
import { cropPng, fitPng, guidesPng, pngHasAlpha, pngSize } from '../src/png.ts'

/** One 8×8 RGBA PNG: every pixel distinct, so a wrong window is visible. */
const SAMPLE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAXElEQVR4nBXKMQEDQQgAsJPyUpCCFKQgBSk4acOQLe+9+n0ESdEMy3ufQJAUzbDfhRAIkqIZNi6kQJAUzbB5oQSCpGiGrQstECRFM2xfGIEgKZph58IKBEnRDMsf+pGXwQKipHUAAAAASUVORK5CYII=',
  'base64',
)

describe('closeup cropping', () => {
  it('reads the size from the header alone', () => {
    expect(pngSize(SAMPLE)).toEqual({ width: 8, height: 8 })
  })

  it('crops the window the caller marked', () => {
    const cropped = cropPng(SAMPLE, { x: 0, y: 0, w: 0.5, h: 0.5 })
    expect(pngSize(cropped)).toEqual({ width: 4, height: 4 })
  })

  it('clamps a window that runs past the edge', () => {
    expect(pngSize(cropPng(SAMPLE, { x: 0.5, y: 0.5, w: 4, h: 4 })))
      .toEqual({ width: 4, height: 4 })
    expect(pngSize(cropPng(SAMPLE, { x: -1, y: -1, w: 0.5, h: 0.5 })))
      .toEqual({ width: 4, height: 4 })
  })

  it('hands back the original when the window covers the picture', () => {
    expect(cropPng(SAMPLE, { x: 0, y: 0, w: 1, h: 1 })).toBe(SAMPLE)
  })

  it('enlarges to the size the closeup is judged at', () => {
    expect(pngSize(fitPng(SAMPLE, 32))).toEqual({ width: 32, height: 32 })
    expect(pngSize(fitPng(SAMPLE, 4))).toEqual({ width: 4, height: 4 })
  })

  it('draws the grid, the target box, and the ruler without changing the size', () => {
    const annotated = guidesPng(SAMPLE, {
      pitch: 4,
      scale: 2,
      rulerPixels: 2,
      target: { x: 2, y: 2, w: 4, h: 3 },
    })
    expect(pngSize(annotated)).toEqual({ width: 8, height: 8 })
    expect(annotated.equals(SAMPLE)).toBe(false)
  })

  it('marks a closeup with no target by its centre', () => {
    const annotated = guidesPng(SAMPLE, { pitch: 4 })
    expect(pngSize(annotated)).toEqual({ width: 8, height: 8 })
    expect(annotated.equals(SAMPLE)).toBe(false)
  })

  it('passes through bytes it cannot decode', () => {
    const junk = Buffer.from('not a png at all')
    expect(cropPng(junk, { x: 0, y: 0, w: 0.5, h: 0.5 })).toBe(junk)
    expect(fitPng(junk, 32)).toBe(junk)
    expect(guidesPng(junk)).toBe(junk)
    expect(pngSize(junk)).toBeUndefined()
  })
})

describe('alpha header check', () => {
  /** A PNG prefix whose IHDR reports `colorType`. */
  const headerOf = (colorType: number): Buffer => {
    const bytes = Buffer.alloc(26)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0)
    bytes.write('IHDR', 12, 'ascii')
    bytes[25] = colorType
    return bytes
  }

  it('accepts the colour types that carry alpha', () => {
    expect(pngHasAlpha(SAMPLE)).toBe(true)
    expect(pngHasAlpha(headerOf(6))).toBe(true)
    expect(pngHasAlpha(headerOf(4))).toBe(true)
  })

  it('rejects an opaque picture and anything that is not a PNG', () => {
    expect(pngHasAlpha(headerOf(2))).toBe(false)
    expect(pngHasAlpha(headerOf(0))).toBe(false)
    expect(pngHasAlpha(Buffer.from('PNG'))).toBe(false)
  })
})
