/**
 * One knowledge-base scope chip in the user's own text.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import type { ReactNode } from 'react'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * @param props - the resolved node and its raw marker text.
 * @returns the library name as a chip; the raw marker stays the tooltip.
 */
export function KnowledgeReference({ node, raw }: UserTextNodeProps<'knowledge'>): ReactNode {
  return <ReferenceChip appearance="folder" label={node.data.name} title={raw} />
}
