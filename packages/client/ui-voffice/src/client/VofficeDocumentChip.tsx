/**
 * One V-Office document in the user's own text.
 *
 * The chip reads as a file and keeps the raw marker as its tooltip, so the
 * message shows the name the user picked while the model keeps the tag.
 *
 * @module @deepseek-ai/dsh-client-ui-voffice/client
 */
import type { ReactNode } from 'react'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * @param props - the resolved node and its raw marker text.
 * @returns the document name as a file chip; the raw marker stays the tooltip.
 */
export function VofficeDocumentChip({ node, raw }: UserTextNodeProps<'vofficeDocument'>): ReactNode {
  return <ReferenceChip appearance="file" label={node.data.name} title={raw} />
}
