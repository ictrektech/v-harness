import type { IconProps } from './icons/props.ts'
import { FishLogo } from './FishLogo.tsx'

/** Display options for the v-harness wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading interwoven mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the v-harness name and optional mark in the surrounding theme color.
 * @param props - Height, layout class, and leading-mark visibility.
 * @returns decorative brand artwork.
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const width = includeMark ? 158 : 124
  return (
    <svg width={(size * width) / 24} height={size} className={className}
      viewBox={`0 0 ${width} 24`} fill="currentColor" aria-hidden="true">
      {includeMark && <g transform="translate(0 2)"><FishLogo size={29} /></g>}
      <text x={includeMark ? 36 : 0} y="18" fontFamily="system-ui, sans-serif"
        fontSize="22" fontWeight="600" letterSpacing="-0.6">v-harness</text>
    </svg>
  )
}
