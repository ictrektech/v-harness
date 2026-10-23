import { describe, expect, it } from 'vitest'
import type { Citation } from '../src/client/api.ts'
import { markParts } from '../src/client/marks.tsx'

/**
 * @param number - the passage's 1-based position in the retrieved list.
 * @returns a citation shaped the way `turn.ts` reads one out of a tool result.
 */
function citation(number: number): Citation {
  return {
    chunkId: `chunk-${String(number)}`,
    knowledgeId: `doc-${String(number)}`,
    knowledgeBaseId: 'kb-1',
    title: `制度 ${String(number)}.md`,
    chunkIndex: number,
    score: 1 - number / 10,
    snippet: `第 ${String(number)} 段`,
  }
}

const retrieved: readonly Citation[] = [citation(1), citation(2), citation(3)]

describe('answer citation marks', () => {
  it('turns a retrieved number into the passage at that position', () => {
    expect(markParts('年假 5 天[2]。', retrieved)).toEqual([
      '年假 5 天',
      { number: 2, citation: retrieved[1] },
      '。',
    ])
  })

  it('keeps a number the turn never retrieved as literal text', () => {
    expect(markParts('年假 5 天[9]。', retrieved)).toBeUndefined()
  })

  it('keeps the unretrieved numbers of a mixed run while marking the rest', () => {
    expect(markParts('[1] 与 [9]', retrieved)).toEqual([
      { number: 1, citation: retrieved[0] },
      ' 与 [9]',
    ])
  })

  it('marks adjacent citations separately', () => {
    expect(markParts('两条[1][3]', retrieved)).toEqual([
      '两条',
      { number: 1, citation: retrieved[0] },
      { number: 3, citation: retrieved[2] },
    ])
  })

  it('leaves runs with no marker untouched', () => {
    expect(markParts('没有角标的正文', retrieved)).toBeUndefined()
    expect(markParts('[abc] 与 []', retrieved)).toBeUndefined()
  })

  it('marks nothing when the turn retrieved nothing', () => {
    expect(markParts('年假 5 天[1]。', [])).toBeUndefined()
  })
})
