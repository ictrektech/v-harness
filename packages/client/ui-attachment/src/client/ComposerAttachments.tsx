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
  const [regions, setRegions] = useState<ReadonlyMap<string, Region>>(new Map())
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


  // Derived from state rather than from a transition: the attachment list
  // updates more than once per upload (pending, then ready), and a
  // transition-based effect opens the picker on whichever update happens to be
  // first — or not at all. One image, no region, not dismissed ⇒ open.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (onInsertRegion === undefined || measuring !== null) return
    const images = attachments.filter((attachment): attachment is ComposerImageAttachment => attachment.kind === 'image')
    if (images.length !== 1) return
    const [only] = images
    if (only === undefined || dismissed.has(only.id) || regions.has(only.id)) return
    setMeasuring(only)
  }, [attachments, dismissed, measuring, onInsertRegion, regions])

  const railItems = useMemo<ComposerRailItem[]>(() => attachments.map(attachment => ({
    id: attachment.id,
    attachment,
  })), [attachments])

  // The first image is the subject, every later one is material: the order the
  // user attached them in is the role, so no extra switch is needed.
  const roleOf = useCallback((id: string): RegionRole => {
    const images = attachments.filter(item => item.kind === 'image')
    return images[0]?.id === id ? 'cut' : 'place'
  }, [attachments])

  const remember = useCallback((id: string, region: Region | undefined) => {
    setRegions((current) => {
      const next = new Map(current)
      if (region === undefined) next.delete(id)
      else next.set(id, region)
      return next
    })
  }, [])

  const measuringRegion = measuring === null ? undefined : regions.get(measuring.id)

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
              const region = regions.get(attachment.id)
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
                      className={region === undefined ? css.regionBadge : `${css.regionBadge} ${css.regionBadgeOn}`}
                      title={t('image.region.title')}
                      aria-label={t('image.region.open')}
                      onClick={() => { setMeasuring(current => current?.id === attachment.id ? null : attachment) }}
                    >
                      {t('image.region.open')}
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
      {onInsertRegion !== undefined && attachments.some(item => item.kind === 'image') && (
        <p className={css.tip}>{t('image.region.tip')}</p>
      )}
      {measuring !== null && (
        <RegionPicker
          src={measuring.previewUrl}
          alt={measuring.file.name || t('image.original')}
          value={measuringRegion}
          labels={regionPickerLabels(t)}
          onChange={(region) => { remember(measuring.id, region) }}
          onConfirm={(region) => {
            const inserted = onInsertRegion?.(formatRegionToken(measuring.id, region, roleOf(measuring.id))) ?? false
            setMeasuring(null)
            // Only a tag that actually reached the draft may be shown as sent;
            // a refused insertion must not leave a chip implying it worked.
            if (!inserted) return
            remember(measuring.id, region)
            // The draft write and the submit read the same editor; let the write
            // land first instead of racing it in the same tick.
            setTimeout(() => { onSubmitDraft?.() }, 0)
          }}
          onClose={() => {
            setDismissed(current => new Set(current).add(measuring.id))
            setMeasuring(null)
          }}
        />
      )}
      {regions.size > 0 && (
        <div className={css.regionChips}>
          {[...regions.entries()].map(([id, region]) => (
            <span key={id} className={roleOf(id) === 'cut' ? `${css.regionChip} ${css.regionChipCut}` : `${css.regionChip} ${css.regionChipPlace}`}>
              {t('image.region.chip')} {regionSummary(region)}
              <button
                type="button"
                aria-label={t('image.region.clear')}
                onClick={() => { remember(id, undefined) }}
              >
                <IconCloseFillRegular size={10} />
              </button>
            </span>
          ))}
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
