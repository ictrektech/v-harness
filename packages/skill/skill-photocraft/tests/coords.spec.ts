import { describe, expect, it } from 'vitest'
import { adjustRegion, normalizeRegion, parseRegion, toFractions, toPixels } from '../src/coords.ts'

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

describe('toFractions', () => {
  it('round-trips a pixel box through the document size', () => {
    const box = { x: 296, y: 838, width: 1270, height: 94 }
    expect(toFractions(box, { width: 1740, height: 1180 })).toEqual({ x: 0.1701, y: 0.7102, w: 0.7299, h: 0.0797 })
  })
})

describe('parseRegion', () => {
  it('reads the tag the composer writes into a message', () => {
    const text = '把这块去掉\n<region image="att_7f3c" x="0.14" y="0.69" w="0.71" h="0.11"/>'
    expect(parseRegion(text)).toEqual({
      region: { x: 0.14, y: 0.69, w: 0.71, h: 0.11 },
      image: 'att_7f3c',
    })
  })

  it('answers undefined for a message without one', () => {
    expect(parseRegion('调成电影感')).toBeUndefined()
  })

  it('clamps a tag that overflows the document', () => {
    expect(parseRegion('<region x="0.9" y="0.1" w="0.9" h="0.1"/>')?.region)
      .toEqual({ x: 0.9, y: 0.1, w: 0.1, h: 0.1 })
  })
})

describe('adjustRegion', () => {
  it('applies a nudge the user described in words', () => {
    expect(adjustRegion({ x: 0.2, y: 0.5, w: 0.4, h: 0.2 }, { dy: -0.02, dw: 0.06 }))
      .toEqual({ x: 0.2, y: 0.48, w: 0.46, h: 0.2 })
  })
})
