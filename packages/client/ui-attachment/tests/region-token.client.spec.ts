import { describe, expect, it } from 'vitest'
import { formatRegionToken, formatStrokeToken } from '../src/client/region-format.ts'
import { regionTokenRule } from '../src/client/region-token-rule.ts'

/** Facts reader the evaluator would hand a rule; this rule reads none. */
const context = { read: () => undefined } as never

describe('region token rule', () => {
  it('collapses a region tag into one node covering the whole tag', () => {
    const token = formatRegionToken('att_7f3c', { x: 0.14, y: 0.69, w: 0.71, h: 0.11 }, 'cut', 1, 1)
    const text = `把这块去掉\n${token}`
    const node = regionTokenRule.match(text, 0, context)
    expect(node).toMatchObject({ id: 'region', start: 6, end: 6 + token.length, data: { kind: 'box', index: 1 } })
    expect(node === undefined ? '' : text.slice(node.start, node.end)).toBe(token)
  })

  it('collapses a brush token and keeps its draw order', () => {
    const token = formatStrokeToken('att_7f3c', { points: [[0.63, 0.13], [0.64, 0.15]] }, 2, 1)
    const node = regionTokenRule.match(token, 0, context)
    expect(node).toMatchObject({ id: 'region', start: 0, end: token.length, data: { kind: 'brush', index: 2 } })
  })

  it('reports only the nearest token at or after the cursor', () => {
    const first = formatRegionToken('a1', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, 'cut', 1, 1)
    const second = formatStrokeToken('a1', { points: [[0.1, 0.1], [0.2, 0.2]] }, 1, 1)
    const text = `${first}\n${second}`
    expect(regionTokenRule.match(text, 0, context)).toMatchObject({ start: 0, data: { kind: 'box' } })
    expect(regionTokenRule.match(text, first.length + 1, context)).toMatchObject({ start: first.length + 1, data: { kind: 'brush' } })
  })

  it('leaves an unterminated tag as ordinary text', () => {
    expect(regionTokenRule.match('<strokes img="1" n="1" image="a1">[[0.1,0.2],', 0, context)).toBeUndefined()
    expect(regionTokenRule.match('没有任何标记', 0, context)).toBeUndefined()
  })
})
