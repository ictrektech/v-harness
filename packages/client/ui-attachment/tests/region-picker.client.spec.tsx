// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComposerImageAttachment, ComposerAttachmentsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ComposerAttachments } from '../src/client/ComposerAttachments.tsx'
import { clampRegion, formatRegionToken, regionSummary } from '../src/client/region-format.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
  // jsdom lays nothing out, so the picker needs a stage rectangle to measure in.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 400, width: 800, height: 400,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const messages: Record<string, string> = {
  'attachment.pending': '待发送附件',
  'attachment.scrollLeft': '向左滚动附件',
  'attachment.scrollRight': '向右滚动附件',
  'file.pending': '待发送文件',
  'file.uploading': '上传中…',
  'file.uploadFailed': '上传失败，点击重试',
  'file.label': '文件',
  'image.pending': '待发送图片',
  'image.original': '原图',
  'image.preview': '原图预览',
  'image.closePreview': '关闭原图预览',
  'image.openOriginal': '查看原图',
  'image.region.open': '框选',
  'image.region.title': '框选要处理的位置',
  'image.region.hint': '在图上拖一个框',
  'image.region.clear': '清除',
  'image.region.done': '就用这些框',
  'image.region.chip': '区域',
  'attachment.dropBlocked': '当前无法添加文件或图片',
  'attachment.dropTitle': '文件或图片拖动到此处即可添加',
}

const t = ((key: string, params?: Readonly<Record<string, unknown>>): string => {
  if (key === 'image.remove') return `移除图片 ${String(params?.name ?? '')}`
  return messages[key] ?? key
}) as unknown as ComposerAttachmentsProps['t']

const photo = (id: string): ComposerImageAttachment => ({
  kind: 'image',
  id,
  file: { name: `${id}.png`, size: 1024, type: 'image/png' },
  previewUrl: `blob:${id}`,
} as ComposerImageAttachment)

function props(overrides: Partial<ComposerAttachmentsProps> = {}): ComposerAttachmentsProps {
  return {
    attachments: [photo('a1')],
    canAcceptDrop: true,
    onAddFiles: () => {},
    onRemoveAttachment: () => {},
    uploads: {},
    onRetryFile: () => {},
    t,
    ...overrides,
  } as ComposerAttachmentsProps
}

describe('region measurement', () => {
  it('opens on a freshly attached image without a click', () => {
    render(<ComposerAttachments {...props({ onInsertRegion: () => true })} />)
    expect(screen.getByText('框选要处理的位置')).toBeTruthy()
  })

  it('writes the measured box into the draft and leaves sending to the user', async () => {
    const onInsertRegion = vi.fn((token: string) => { void token; return true })
    render(<ComposerAttachments {...props({ onInsertRegion })} />)

    const stage = document.querySelector('[data-region-stage]')
    expect(stage).toBeTruthy()
    fireEvent.pointerDown(stage as Element, { clientX: 80, clientY: 120 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 200 })
    fireEvent.pointerUp(window)
    fireEvent.click(screen.getByText('就用这些框'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(onInsertRegion).toHaveBeenCalledTimes(1)
    const token = onInsertRegion.mock.calls[0]?.[0]
    expect(token).toBe('<region role="cut" n="1" image="a1" x="0.1000" y="0.3000" w="0.4000" h="0.2000"/>')
  })

  it('keeps the second picture open for a green box after the first is confirmed', async () => {
    const onInsertRegion = vi.fn((token: string) => { void token; return true })
    render(<ComposerAttachments {...props({ attachments: [photo('a1'), photo('a2')], onInsertRegion })} />)

    const first = document.querySelector('[data-region-stage]') as Element
    fireEvent.pointerDown(first, { clientX: 80, clientY: 120 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 200 })
    fireEvent.pointerUp(window)
    fireEvent.click(screen.getByText('就用这些框'))

    // The material is measured by its own button, and its tag carries the role
    // that pairs it with the red box of the same number.
    // Each thumbnail's badge is labelled with the region action; the second one
    // belongs to the material, which is the only picture that can take a green box.
    const openers = screen.getAllByLabelText('框选')
    fireEvent.click(openers[1] as Element)
    const second = document.querySelector('[data-region-stage]') as Element
    fireEvent.pointerDown(second, { clientX: 400, clientY: 200 })
    fireEvent.pointerMove(window, { clientX: 560, clientY: 280 })
    fireEvent.pointerUp(window)
    fireEvent.click(screen.getByText('就用这些框'))

    expect(onInsertRegion).toHaveBeenCalledTimes(2)
    expect(onInsertRegion.mock.calls[1]?.[0])
      .toBe('<region role="place" n="1" image="a2" x="0.5000" y="0.5000" w="0.2000" h="0.2000"/>')
  })

  it('does not remember a box the draft refused', async () => {
    const onInsertRegion = vi.fn((token: string) => { void token; return false })
    render(<ComposerAttachments {...props({ onInsertRegion })} />)
    const stage = document.querySelector('[data-region-stage]') as Element
    fireEvent.pointerDown(stage, { clientX: 80, clientY: 120 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 200 })
    fireEvent.pointerUp(window)
    fireEvent.click(screen.getByText('就用这些框'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(onInsertRegion).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/10%,30%/)).toBeNull()
  })

  it('offers nothing when the composer cannot edit the draft', () => {
    render(<ComposerAttachments {...props()} />)
    expect(screen.queryByText('框选')).toBeNull()
    expect(screen.queryByText('框选要处理的位置')).toBeNull()
  })
})

describe('region-format', () => {
  it('drops a click that never became a drag', () => {
    expect(clampRegion({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 })).toBeUndefined()
  })

  it('clips a drag that ran off the image', () => {
    expect(clampRegion({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.8, y: 0.9, w: 0.19999999999999996, h: 0.09999999999999998 })
  })

  it('writes fractions the model can scale onto any document', () => {
    expect(formatRegionToken('att_7f3c', { x: 0.14, y: 0.69, w: 0.71, h: 0.11 }, 'place', 2))
      .toBe('<region role="place" n="2" img="1" image="att_7f3c" x="0.1400" y="0.6900" w="0.7100" h="0.1100"/>')
  })

  it('names the picture by its position in the message, not by a draft id', () => {
    expect(formatRegionToken('att_9ab1', { x: 0.5, y: 0.5, w: 0.25, h: 0.2 }, 'place', 1, 2))
      .toContain('img="2"')
  })

  it('summarises a box for the chip', () => {
    expect(regionSummary({ x: 0.14, y: 0.69, w: 0.71, h: 0.11 })).toBe('14%,69% · 71%×11%')
  })
})
