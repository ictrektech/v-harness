// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import type { MarkdownInlineMarks } from '../src/index.ts'

afterEach(cleanup)

/**
 * A vocabulary that replaces `[1]` with a literal mark element and leaves
 * every other run alone — the shape an owner's citation marks take.
 */
const marks: MarkdownInlineMarks = {
  resolve(text, key) {
    if (!text.includes('[1]')) return undefined
    const [before = '', after = ''] = text.split('[1]')
    return [
      ...before === '' ? [] : [before],
      <mark key={String(key)}>{'[1]'}</mark>,
      ...after === '' ? [] : [after],
    ]
  },
}

describe('MarkdownText inline marks', () => {
  it('hands a prose run to the owner vocabulary and keeps the surrounding text', () => {
    const { container } = render(<MarkdownText text={'年假 5 天[1]。'} marks={marks} />)
    expect(container.querySelector('mark')?.textContent).toBe('[1]')
    expect(container.textContent).toBe('年假 5 天[1]。')
  })

  it('renders the run unchanged when no vocabulary is supplied', () => {
    const { container } = render(<MarkdownText text={'年假 5 天[1]。'} />)
    expect(container.querySelector('mark')).toBeNull()
    expect(container.textContent).toBe('年假 5 天[1]。')
  })

  it('renders the run unchanged when the vocabulary declines it', () => {
    const declining: MarkdownInlineMarks = { resolve: () => undefined }
    const { container } = render(<MarkdownText text={'[1] 未检索到'} marks={declining} />)
    expect(container.querySelector('mark')).toBeNull()
    expect(container.textContent).toBe('[1] 未检索到')
  })

  it('leaves a run inside a link literal', () => {
    const { container } = render(<MarkdownText text={'[\\[1\\]](https://example.com)'} marks={marks} />)
    expect(container.querySelector('mark')).toBeNull()
    expect(screen.getByRole('link').textContent).toBe('[1]')
  })

  it('does not mark a run while the message streams', () => {
    const { container } = render(<MarkdownText text={'年假 5 天[1]'} marks={marks} streaming />)
    expect(container.querySelector('mark')).toBeNull()
  })
})
