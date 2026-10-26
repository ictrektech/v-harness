import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the v-harness mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the v-harness interwoven mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <FishLogo size={size} />
}

/**
 * Render the v-harness name artwork without its independently slotted mark.
 * @returns the v-harness name wordmark.
 */
export function OfficialBrandName() {
  return <BrandWordmark includeMark={false} />
}
