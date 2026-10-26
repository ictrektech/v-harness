// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FISH_LOGO_PATH } from '@deepseek-ai/dsh-client-ui-primitives'
import { RunningWhaleTail } from '../src/client/chat/RunningWhaleTail.tsx'

afterEach(cleanup)

describe('running-status brand mark', () => {
  it('uses the shared decorative interwoven mark without the upstream animation', () => {
    const view = render(<RunningWhaleTail />)
    expect(view.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelector('path')?.getAttribute('d')).toBe(FISH_LOGO_PATH)
    expect(view.container.querySelector('path')?.getAttribute('fill')).toBe('currentColor')
    expect(view.container.querySelector('svg')?.getAttribute('width')).toBe('14')
    expect(view.container.querySelector('animate')).toBeNull()
    expect(view.container.querySelector('img')).toBeNull()
  })
})
