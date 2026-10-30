import { describe, expect, it } from 'vitest'
import { regionChipLabel, regionTokens } from '../src/client/input/editor/region-chip.ts'

describe('region chips', () => {
  it('labels a box and a brush by their own order', () => {
    expect(regionChipLabel('<region role="cut" n="2" img="1" image="a" x="0.1" y="0.2" w="0.3" h="0.4"/>')).toBe('▦ 2')
    expect(regionChipLabel('<strokes img="1" n="3" image="a">[[0.1,0.2],[0.2,0.3]]</strokes>')).toBe('✎ 3')
    expect(regionChipLabel('not a token')).toBe('▦ 1')
  })

  it('splits the picker batch and drops blank lines', () => {
    expect(regionTokens('<region a/>\n\n<strokes b></strokes>\n')).toEqual(['<region a/>', '<strokes b></strokes>'])
    expect(regionTokens('')).toEqual([])
  })
})
