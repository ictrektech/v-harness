/**
 * One VOS container in the user's own text.
 *
 * The chip reads as a file and keeps the raw marker as its tooltip, so the
 * message shows the container name the user picked while the model keeps the
 * tag, and with it the identifier the operations tool needs.
 *
 * @module @deepseek-ai/dsh-client-ui-vos-container/client
 */
import type { ReactNode } from 'react'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * @param props - the resolved node and its raw marker text.
 * @returns the container name as a file chip; the raw marker stays the tooltip.
 */
export function VosContainerChip({ node, raw }: UserTextNodeProps<'vosContainer'>): ReactNode {
  return <ReferenceChip appearance="file" label={node.data.name} title={raw} />
}
