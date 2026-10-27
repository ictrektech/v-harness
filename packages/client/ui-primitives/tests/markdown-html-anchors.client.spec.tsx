// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider } from '../src/index.ts'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

describe('Markdown bare HTML anchors', () => {
  it('opens a workspace file an anchor names instead of showing the tag', () => {
    const openFile = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText text={'产物有两个：\n\n- <a href="wish-1.png">wish-1.png</a> — 成品图\n'} />
      </MarkdownDelegateProvider>,
    )
    const link = view.getByRole('button', { name: 'wish-1.png' })
    fireEvent.click(link)
    expect(openFile).toHaveBeenCalledExactlyOnceWith('wish-1.png', undefined)
    // The markup itself never reaches the reader.
    expect(view.container.textContent).not.toContain('<a')
  })

  it('keeps extra attributes on the opening tag from defeating the match', () => {
    const openFile = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText text={'<a href="wish-2.psd" target="_blank">wish-2.psd</a>'} />
      </MarkdownDelegateProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: 'wish-2.psd' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('wish-2.psd', undefined)
  })

  it.each([
    ['https://example.com/a.png', '外部地址不折叠'],
    ['javascript:alert(1)', '危险协议不折叠'],
    ['', '空地址不折叠'],
  ])('leaves %s literal', (href) => {
    const openFile = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText text={`<a href="${href}">label</a>`} />
      </MarkdownDelegateProvider>,
    )
    expect(view.queryByRole('button')).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
    expect(view.container.textContent).toContain('label')
  })
})
