import { describe, expect, it } from 'vitest'
import { regionTokenLabel } from '../src/client/input/editor/region-token.ts'

describe('composer region token', () => {
  it('reads a box token and its order', () => {
    expect(regionTokenLabel('<region role="cut" n="2" img="1" image="a1" x="0.1" y="0.2" w="0.3" h="0.4"/>'))
      .toEqual({ kind: 'box', index: 2 })
  })

  it('reads a brush token and its order', () => {
    expect(regionTokenLabel('<strokes img="1" n="3" image="a1">[[0.1,0.2],[0.2,0.3]]</strokes>'))
      .toEqual({ kind: 'brush', index: 3 })
  })

  it('leaves ordinary draft text alone', () => {
    expect(regionTokenLabel('把这块去掉')).toBeUndefined()
    expect(regionTokenLabel('<strokes img="1" n="1" image="a1">[[0.1,0.2],')).toBeUndefined()
    expect(regionTokenLabel('<region role="cut" x="0.1"')).toBeUndefined()
  })
})
