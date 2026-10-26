import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComposerAttachment, ComposerAttachmentsProps, ComposerImageAttachment,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconCloseFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { AttachmentRail } from '../AttachmentRail.tsx'
import type { AttachmentRailItem } from '../AttachmentRail.tsx'
import { DropOverlay } from '../DropOverlay.tsx'
import { FileCard } from '../FileCard.tsx'
import { ImageLightbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { RegionPicker } from './RegionPicker.tsx'
import { formatRegionToken, regionSummary, type Region, type RegionRole } from './region-format.ts'
import {
  attachmentRailLabels, dropOverlayLabels, fileCardLabels, lightboxLabels, regionPickerLabels,
} from './labels.ts'
import { installDocumentDropEvents } from './drop-events.ts'
import css from './ComposerAttachments.module.css'

/** Rail item retaining its browser-owned attachment for callbacks. */
interface ComposerRailItem extends AttachmentRailItem {
  attachment: ComposerAttachment
}

/** Draft image previews, pending-file cards, drop target, and original-image preview. */
export function ComposerAttachments({
  attachments, canAcceptDrop, onAddFiles, onRemoveAttachment, uploads, onRetryFile, dropLimits,
  onInsertRegion, onSubmitDraft, t,
}: ComposerAttachmentsProps) {
  const [preview, setPreview] = useState<ComposerImageAttachment | null>(null)
  const [measuring, setMeasuring] = useState<ComposerImageAttachment | null>(null)
  const [marks, setMarks] = useState<ReadonlyMap<string, readonly Region[]>>(new Map())
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const closePreview = useCallback(() => { setPreview(null) }, [])

  useEffect(() => {
    if (preview !== null && !attachments.some(attachment => attachment.id === preview.id)) setPreview(null)
  }, [attachments, preview])

  useEffect(() => {
    if (measuring !== null && !attachments.some(attachment => attachment.id === measuring.id)) setMeasuring(null)
  }, [attachments, measuring])

  useEffect(() => {
    return installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive)
  }, [canAcceptDrop, onAddFiles])

  // The first image is the subject, every later one is material — that order is
  // the role, so the picker needs no colour switch.
  const images = useMemo(
    () => attachments.filter((attachment): attachment is ComposerImageAttachment => attachment.kind === 'image'),
    [attachments],
  )
  const roleOf = useCallback(
    (id: string): RegionRole => (images[0]?.id === id ? 'cut' : 'place'),
    [images],
  )

  // Derived from state rather than from a transition: the attachment list
  // updates more than once per upload, and a transition-based effect opens the
  // picker on whichever update happens to be first — or not at all.
  useEffect(() => {
    if (onInsertRegion === undefined || measuring !== null) return
    const [only] = images
    if (images.length === 0 || only === undefined) return
    if (dismissed.has(only.id) || (marks.get(only.id)?.length ?? 0) > 0) return
    setMeasuring(only)
  }, [dismissed, images, marks, measuring, onInsertRegion])

  const remember = useCallback((id: string, regions: readonly Region[]) => {
    setMarks((current) => {
      const next = new Map(current)
      if (regions.length === 0) next.delete(id)
      else next.set(id, regions)
      return next
    })
  }, [])

  const railItems = useMemo<ComposerRailItem[]>(() => attachments.map(attachment => ({
    id: attachment.id,
    attachment,
  })), [attachments])

  const measuringValues = measuring === null ? [] : marks.get(measuring.id) ?? []

  return (
    <>
      {dragActive && (
        <DropOverlay
          disabled={!canAcceptDrop}
          labels={dropOverlayLabels(t, canAcceptDrop, dropLimits)}
        />
      )}
      {railItems.length > 0 && (
        <div className={css.rail}>
          <AttachmentRail
            items={railItems}
            labels={attachmentRailLabels(t)}
            renderItem={(item) => {
              const attachment = item.attachment
              if (attachment.kind === 'file') {
                const upload = uploads[attachment.id]
                return (
                  <FileCard
                    name={attachment.file.name || t('file.label')}
                    bytes={attachment.file.size}
                    state={upload === undefined || upload.status === 'uploading'
                      ? 'uploading'
                      : upload.status === 'ready' ? 'ready' : 'error'}
                    {...upload?.status === 'uploading' && upload.total !== undefined && upload.total > 0
                      ? { progress: upload.loaded / upload.total }
                      : {}}
                    labels={fileCardLabels(t, attachment.file.name)}
                    onRemove={() => { onRemoveAttachment(attachment.id) }}
                    onRetry={() => { onRetryFile(attachment.id) }}
                  />
                )
              }
              const marked = (marks.get(attachment.id)?.length ?? 0) > 0
              return (
                <div className={css.imageItem}>
                  <button
                    type="button"
                    className={css.thumbnail}
                    title={t('image.openOriginal')}
                    onClick={() => { setPreview(attachment) }}
                  >
                    <img src={attachment.previewUrl} alt={attachment.file.name || t('image.pending')} />
                  </button>
                  {onInsertRegion !== undefined && (
                    <button
                      type="button"
                      className={marked ? `${css.regionBadge} ${css.regionBadgeOn}` : css.regionBadge}
                      title={t('image.region.title')}
                      aria-label={t('image.region.open')}
                      onClick={() => { setMeasuring(current => current?.id === attachment.id ? null : attachment) }}
                    >
                      {roleOf(attachment.id) === 'cut' ? '①' : '②'} {t('image.region.open')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={css.remove}
                    aria-label={t('image.remove', { name: attachment.file.name })}
                    onClick={() => { onRemoveAttachment(attachment.id) }}
                  >
                    <IconCloseFillRegular size={12} />
                  </button>
                </div>
              )
            }}
          />
        </div>
      )}
      {onInsertRegion !== undefined && images.length > 0 && (
        <p className={css.tip}>{t('image.region.tip')}</p>
      )}
      {measuring !== null && (
        <RegionPicker
          src={measuring.previewUrl}
          alt={measuring.file.name || t('image.original')}
          values={measuringValues}
          role={roleOf(measuring.id)}
          labels={regionPickerLabels(t)}
          onChange={(regions) => { remember(measuring.id, regions) }}
          onConfirm={(regions) => {
            const role = roleOf(measuring.id)
            const tokens = regions.map((region, index) => formatRegionToken(measuring.id, region, role, index + 1))
            const inserted = onInsertRegion?.(tokens.join('\n')) ?? false
            setMeasuring(null)
            // Only a tag that actually reached the draft may be shown as sent.
            if (!inserted) return
            remember(measuring.id, regions)
            setTimeout(() => { onSubmitDraft?.() }, 0)
          }}
          onClose={() => {
            setDismissed(current => new Set(current).add(measuring.id))
            setMeasuring(null)
          }}
        />
      )}
      {marks.size > 0 && measuring === null && (
        <div className={css.regionChips}>
          {[...marks.entries()].flatMap(([id, regions]) => regions.map((region, index) => (
            <span
              key={`${id}-${String(index)}`}
              className={roleOf(id) === 'cut' ? `${css.regionChip} ${css.regionChipCut}` : `${css.regionChip} ${css.regionChipPlace}`}
            >
              {roleOf(id) === 'cut' ? '①' : '②'} {String(index + 1)} · {regionSummary(region)}
              <button
                type="button"
                aria-label={t('image.region.clear')}
                onClick={() => { remember(id, regions.filter((_value, at) => at !== index)) }}
              >
                <IconCloseFillRegular size={10} />
              </button>
            </span>
          )))}
        </div>
      )}
      {preview !== null && (
        <ImageLightbox
          src={preview.previewUrl}
          alt={preview.file.name || t('image.original')}
          labels={lightboxLabels(t)}
          onClose={closePreview}
        />
      )}
    </>
  )
}
