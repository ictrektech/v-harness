import { describe, expect, it } from 'vitest'
import { centreCrop, normalizeRegion, toPixels } from '../src/coords.ts'

describe('normalizeRegion', () => {
  it('clips a region that runs past the document edge', () => {
    expect(normalizeRegion({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.8, y: 0.9, w: 0.2, h: 0.1 })
  })

  it('refuses a region with no area', () => {
    expect(() => normalizeRegion({ x: 1, y: 0, w: 0.2, h: 0.2 })).toThrow(/选区为空/u)
  })

  it('treats a non-finite member as zero instead of propagating NaN', () => {
    expect(normalizeRegion({ x: Number.NaN, y: 0.5, w: 0.25, h: 0.25 })).toEqual({ x: 0, y: 0.5, w: 0.25, h: 0.25 })
  })
})

describe('centreCrop', () => {
  it('takes the middle columns of a piece that is wider than its box', () => {
    expect(centreCrop({ width: 40, height: 20 }, { width: 30, height: 20 }))
      .toEqual({ x: 5, y: 0, width: 30, height: 20 })
  })

  it('takes the middle rows of a piece that is taller than its box', () => {
    expect(centreCrop({ width: 20, height: 40 }, { width: 20, height: 20 }))
      .toEqual({ x: 0, y: 10, width: 20, height: 20 })
  })

  it('keeps the whole piece when the proportions already match', () => {
    expect(centreCrop({ width: 40, height: 20 }, { width: 20, height: 10 }))
      .toEqual({ x: 0, y: 0, width: 40, height: 20 })
  })

  it('keeps the whole piece when the box has no measurable size', () => {
    expect(centreCrop({ width: 40, height: 20 }, { width: 0, height: 0 }))
      .toEqual({ x: 0, y: 0, width: 40, height: 20 })
  })

  it('never crops away the last pixel', () => {
    expect(centreCrop({ width: 1, height: 900 }, { width: 900, height: 1 }))
      .toEqual({ x: 0, y: 450, width: 1, height: 1 })
  })
})

describe('toPixels', () => {
  it('scales fractions onto the document and keeps at least one pixel', () => {
    expect(toPixels({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, { width: 1000, height: 800 }))
      .toEqual({ x: 500, y: 200, width: 250, height: 400 })
    expect(toPixels({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, { width: 100, height: 100 }))
      .toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})
