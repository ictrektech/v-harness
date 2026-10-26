import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconCloseFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { clampRegion, regionSummary, type Region } from './region-format.ts'
import css from './RegionPicker.module.css'

/** Strings the picker renders, resolved from the conversation namespace. */
export interface RegionPickerLabels {
  readonly title: string
  readonly hint: string
  readonly clear: string
  readonly done: string
  readonly close: string
}

/** Props of the inline region picker. */
export interface RegionPickerProps {
  /** The draft image being measured. */
  src: string
  /** Alt text of that image. */
  alt: string
  /** Boxes already drawn on this image, in order. */
  values: readonly Region[]
  /** Colour the boxes: red cuts from the subject, green places onto material. */
  role: 'cut' | 'place'
  labels: RegionPickerLabels
  /** Receives the full list after every change. */
  onChange: (regions: readonly Region[]) => void
  /** Called by the done button. */
  onConfirm: (regions: readonly Region[]) => void
  /** Called by the dismiss affordance, which the auto-opened picker needs. */
  onClose: () => void
}

/**
 * Measure one or more rectangles on a draft image, inline above the composer.
 *
 * The stage element is sized by the image itself, so a pointer position becomes
 * a fraction by one division; each finished drag appends a box, and the boxes
 * are numbered because the wish refers to them in order ("这块…那块…").
 * @param props - image, boxes, role, labels, and callbacks.
 * @returns the picker, with the stage and its readout.
 */
export function RegionPicker({
  src, alt, values, role, labels, onChange, onConfirm, onClose,
}: RegionPickerProps) {
  const stage = useRef<HTMLDivElement>(null)
  const origin = useRef<Region | undefined>(undefined)
  const [dragging, setDragging] = useState(false)

  /** Pointer position as a fraction of the stage, which is the photo. */
  const at = useCallback((clientX: number, clientY: number): Region | undefined => {
    const box = stage.current?.getBoundingClientRect()
    if (box === undefined || box.width === 0 || box.height === 0) return undefined
    return { x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height, w: 0, h: 0 }
  }, [])

  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent): void => {
      const start = origin.current
      const point = at(event.clientX, event.clientY)
      if (start === undefined || point === undefined) return
      const draft = clampRegion({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x),
        h: Math.abs(point.y - start.y),
      })
      if (draft !== undefined) onChange([...values.slice(0, -1), draft])
    }
    const up = (): void => {
      const start = origin.current
      origin.current = undefined
      setDragging(false)
      if (start === undefined) return
      // A click that never became a drag leaves no box behind.
      onChange(values.filter(region => region.w > 0.004 && region.h > 0.004))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, at, onChange, values])

  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const point = at(event.clientX, event.clientY)
    if (point === undefined) return
    origin.current = point
    // A zero-sized placeholder marks the box being drawn as the last entry.
    onChange([...values, { x: point.x, y: point.y, w: 0, h: 0 }])
    setDragging(true)
  }

  return (
    <div className={css.picker}>
      <div className={css.head}>
        <span className={role === 'cut' ? `${css.badge} ${css.badgeCut}` : `${css.badge} ${css.badgePlace}`}>
          {role === 'cut' ? '①' : '①'}
        </span>
        <span className={css.title}>{labels.title}</span>
        <span className={css.hint}>{labels.hint}</span>
        <button type="button" className={css.dismiss} aria-label={labels.close} onClick={onClose}>
          <IconCloseFillRegular size={12} />
        </button>
      </div>
      <div
        ref={stage}
        className={css.stage}
        onPointerDown={start}
        role="presentation"
        data-region-stage
      >
        <img className={css.image} src={src} alt={alt} draggable={false} />
        {values.map((value, index) => (
          <div
            key={`${String(index)}-${String(value.x)}-${String(value.y)}`}
            className={role === 'cut' ? `${css.box} ${css.boxCut}` : `${css.box} ${css.boxPlace}`}
            style={{
              left: `${String(value.x * 100)}%`,
              top: `${String(value.y * 100)}%`,
              width: `${String(value.w * 100)}%`,
              height: `${String(value.h * 100)}%`,
            }}
          >
            <span className={css.number}>{String(index + 1)}</span>
          </div>
        ))}
      </div>
      <div className={css.meta}>
        <span className={css.readout}>
          {values.length === 0
            ? labels.hint
            : values.map((value, index) => `${String(index + 1)}·${regionSummary(value)}`).join('  ')}
        </span>
        <span className={css.actions}>
          <Button variant="ghost" size="sm" disabled={values.length === 0} onClick={() => { onChange([]) }}>
            {labels.clear}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={values.length === 0}
            onClick={() => { onConfirm(values) }}
          >
            {labels.done}
          </Button>
        </span>
      </div>
    </div>
  )
}
