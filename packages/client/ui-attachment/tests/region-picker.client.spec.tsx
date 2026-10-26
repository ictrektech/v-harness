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
  'image.region.done': '就用这块并发送',
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

  it('sends the measured box in one action and leaves no tag behind', async () => {
    const onInsertRegion = vi.fn((token: string) => { void token; return true })
    const onSubmitDraft = vi.fn(() => true)
    render(<ComposerAttachments {...props({ onInsertRegion, onSubmitDraft })} />)

    const stage = document.querySelector('[data-region-stage]')
    expect(stage).toBeTruthy()
    fireEvent.pointerDown(stage as Element, { clientX: 80, clientY: 120 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 200 })
    fireEvent.pointerUp(window)
    fireEvent.click(screen.getByText('就用这块并发送'))
    await new Promise(resolve => { setTimeout(resolve, 0) })

    expect(onInsertRegion).toHaveBeenCalledTimes(1)
    const token = onInsertRegion.mock.calls[0]?.[0]
    expect(token).toBe('<region role="cut" n="1" image="a1" x="0.1000" y="0.3000" w="0.4000" h="0.2000"/>')
    expect(onSubmitDraft).toHaveBeenCalledTimes(1)
  })

  it('does not send when the draft refuses the insertion', async () => {
    const onInsertRegion = vi.fn((token: string) => { void token; return false })
    const onSubmitDraft = vi.fn(() => true)
    render(<ComposerAttachments {...props({ onInsertRegion, onSubmitDraft })} />)
    const stage = document.querySelector('[data-region-stage]') as Element
    fireEvent.pointerDown(stage, { clientX: 80, clientY: 120 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 200 })
    fireEvent.pointerUp(window)
    fireEvent.click(screen.getByText('就用这块并发送'))
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(onInsertRegion).toHaveBeenCalledTimes(1)
    expect(onSubmitDraft).not.toHaveBeenCalled()
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
      .toBe('<region role="place" n="2" image="att_7f3c" x="0.1400" y="0.6900" w="0.7100" h="0.1100"/>')
  })

  it('summarises a box for the chip', () => {
    expect(regionSummary({ x: 0.14, y: 0.69, w: 0.71, h: 0.11 })).toBe('14%,69% · 71%×11%')
  })
})
