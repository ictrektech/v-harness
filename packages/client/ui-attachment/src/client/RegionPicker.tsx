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
  /** The region already drawn for this image, if any. */
  value?: Region | undefined
  labels: RegionPickerLabels
  /** Receives every change; `undefined` while the image has no region. */
  onChange: (region: Region | undefined) => void
  /** Called by the done button. */
  onConfirm: (region: Region) => void
  /** Called by the dismiss affordance, which the auto-opened picker needs. */
  onClose: () => void
}

/**
 * Measure one rectangle on a draft image, inline above the composer.
 *
 * The stage element is sized by the image itself (a block image with
 * `width:100%`, no height cap, no padding), so the stage's box *is* the photo's
 * box and a pointer position becomes a fraction by one division. Moves and
 * releases are listened for on the window because the image never receives
 * pointer events — a browser starts a native image drag otherwise.
 * @param props - image, current value, labels, and callbacks.
 * @returns the picker, with the stage and its readout.
 */
export function RegionPicker({
  src, alt, value, labels, onChange, onConfirm, onClose,
}: RegionPickerProps) {
  const stage = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  /** Frozen at pointer-down so a mid-drag reflow cannot move the reference. */
  const frozen = useRef<DOMRect | undefined>(undefined)

  /** Pointer position as a fraction of the stage, which is the photo. */
  const at = useCallback((clientX: number, clientY: number): Region | undefined => {
    const box = frozen.current ?? stage.current?.getBoundingClientRect()
    if (box === undefined || box.width === 0 || box.height === 0) return undefined
    return {
      x: (clientX - box.left) / box.width,
      y: (clientY - box.top) / box.height,
      w: 0,
      h: 0,
    }
  }, [])

  // Where the current drag started, in fractions.
  const origin = useRef<Region | undefined>(undefined)

  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent): void => {
      const point = at(event.clientX, event.clientY)
      const start = origin.current
      if (point === undefined || start === undefined) return
      onChange(clampRegion({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x),
        h: Math.abs(point.y - start.y),
      }))
    }
    const up = (): void => { frozen.current = undefined; setDragging(false) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, at, onChange])

  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    frozen.current = stage.current?.getBoundingClientRect()
    const point = at(event.clientX, event.clientY)
    if (point === undefined) return
    origin.current = point
    setDragging(true)
    onChange(undefined)
  }

  return (
    <div className={css.picker}>
      <div className={css.head}>
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
        {value !== undefined && (
          <div
            className={css.box}
            style={{
              left: `${String(value.x * 100)}%`,
              top: `${String(value.y * 100)}%`,
              width: `${String(value.w * 100)}%`,
              height: `${String(value.h * 100)}%`,
            }}
          />
        )}
      </div>
      <div className={css.meta}>
        <span className={css.readout}>{value === undefined ? labels.hint : regionSummary(value)}</span>
        <span className={css.actions}>
          <Button variant="ghost" size="sm" disabled={value === undefined} onClick={() => { onChange(undefined) }}>
            {labels.clear}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={value === undefined}
            onClick={() => { if (value !== undefined) onConfirm(value) }}
          >
            {labels.done}
          </Button>
        </span>
      </div>
    </div>
  )
}
