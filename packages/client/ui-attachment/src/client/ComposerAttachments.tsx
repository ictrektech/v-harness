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
import { formatRegionToken, formatStrokeToken, regionSummary, type Region, type RegionRole, type Stroke } from './region-format.ts'
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
  onInsertRegion, t,
}: ComposerAttachmentsProps) {
  const [preview, setPreview] = useState<ComposerImageAttachment | null>(null)
  const [measuring, setMeasuring] = useState<ComposerImageAttachment | null>(null)
  // Boxes and strokes per draft image; strokes only exist on the subject.
  const [marks, setMarks] = useState<ReadonlyMap<string, { regions: readonly Region[]; strokes: readonly Stroke[] }>>(new Map())
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
  // The picker opens only on request: uploading a picture drops a thumbnail and
  // nothing else. The ①② badge on that thumbnail opens and closes it, so an
  // upload never covers the conversation with a panel the user did not ask for.

  const remember = useCallback((id: string, regions: readonly Region[], strokes: readonly Stroke[]) => {
    setMarks((current) => {
      const next = new Map(current)
      if (regions.length === 0 && strokes.length === 0) next.delete(id)
      else next.set(id, { regions, strokes })
      return next
    })
  }, [])

  const railItems = useMemo<ComposerRailItem[]>(() => attachments.map(attachment => ({
    id: attachment.id,
    attachment,
  })), [attachments])

  const measuringMark = measuring === null ? undefined : marks.get(measuring.id)
  const measuringRegions = measuringMark?.regions ?? []
  const measuringStrokes = measuringMark?.strokes ?? []

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
              const mark = marks.get(attachment.id)
              const marked = ((mark?.regions.length ?? 0) + (mark?.strokes.length ?? 0)) > 0
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
                      {roleOf(attachment.id) === 'cut' ? '①' : '②'}
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
          values={measuringRegions}
          strokes={measuringStrokes}
          role={roleOf(measuring.id)}
          labels={regionPickerLabels(t)}
          onChange={(regions) => { remember(measuring.id, regions, measuringStrokes) }}
          onStrokesChange={(strokes) => { remember(measuring.id, measuringRegions, strokes) }}
          onConfirm={(regions, strokes) => {
            const role = roleOf(measuring.id)
            // The model receives the pictures in this order and can see no draft
            // id, so the position is the one handle both sides share.
            const picture = images.findIndex(image => image.id === measuring.id) + 1
            const tokens = [
              ...regions.map((region, index) => formatRegionToken(measuring.id, region, role, index + 1, picture)),
              ...strokes.map((stroke, index) => formatStrokeToken(measuring.id, stroke, index + 1, picture)),
            ]
            const inserted = onInsertRegion?.(tokens.join('\n')) ?? false
            setMeasuring(null)
            // Only a tag that actually reached the draft may be shown as queued:
            // a refused insertion leaves no chip claiming the box is in the message.
            remember(measuring.id, inserted ? regions : [], inserted ? strokes : [])
          }}
          onClose={() => {
            // A box the user drew is already an instruction: closing the panel
            // must not drop it. Confirming still wins (it clears the marks
            // first), so this only rescues boxes that would otherwise vanish.
            const drawn = marks.get(measuring.id)
            if (onInsertRegion !== undefined && drawn !== undefined) {
              const role = roleOf(measuring.id)
              const picture = images.findIndex(image => image.id === measuring.id) + 1
              const tokens = [
                ...drawn.regions.map((region, index) => formatRegionToken(measuring.id, region, role, index + 1, picture)),
                ...drawn.strokes.map((stroke, index) => formatStrokeToken(measuring.id, stroke, index + 1, picture)),
              ]
              if (tokens.length > 0) onInsertRegion(tokens.join('\n'))
            }
            setMeasuring(null)
          }}
        />
      )}
      {marks.size > 0 && measuring === null && (
        <div className={css.regionChips}>
          {[...marks.entries()].flatMap(([id, mark]) => [
            ...mark.regions.map((region, index) => (
              <span
                key={`${id}-r-${String(index)}`}
                className={roleOf(id) === 'cut' ? `${css.regionChip} ${css.regionChipCut}` : `${css.regionChip} ${css.regionChipPlace}`}
              >
                {String(index + 1)} · {regionSummary(region)}
                <button
                  type="button"
                  aria-label={t('image.region.clear')}
                  onClick={() => { remember(id, mark.regions.filter((_value, at) => at !== index), mark.strokes) }}
                >
                  <IconCloseFillRegular size={10} />
                </button>
              </span>
            )),
            ...mark.strokes.map((stroke, index) => (
              <span
                key={`${id}-s-${String(index)}`}
                className={`${css.regionChip} ${css.regionChipCut}`}
              >
                {t('image.brush.chip', { count: stroke.points.length })}
                <button
                  type="button"
                  aria-label={t('image.region.clear')}
                  onClick={() => { remember(id, mark.regions, mark.strokes.filter((_value, at) => at !== index)) }}
                >
                  <IconCloseFillRegular size={10} />
                </button>
              </span>
            )),
          ])}
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
