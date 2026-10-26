import { describe, expect, it } from 'vitest'
import { normalizeRegion, toPixels } from '../src/coords.ts'

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

describe('toPixels', () => {
  it('scales fractions onto the document and keeps at least one pixel', () => {
    expect(toPixels({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, { width: 1000, height: 800 }))
      .toEqual({ x: 500, y: 200, width: 250, height: 400 })
    expect(toPixels({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, { width: 100, height: 100 }))
      .toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})
