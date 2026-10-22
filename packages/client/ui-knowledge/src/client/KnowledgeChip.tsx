/**
 * One knowledge scope in the user's own text.
 *
 * A library chip and a document chip differ only in glyph and tooltip: the
 * library reads as a folder, the document as a file inside it, so a message
 * that narrows to one document is distinguishable at a glance from one that
 * narrows to the whole library.
 *
 * @module @deepseek-ai/dsh-client-ui-knowledge/client
 */
import type { ReactNode } from 'react'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * @param props - the resolved node and its raw marker text.
 * @returns the library name as a folder chip; the raw marker stays the tooltip.
 */
export function KnowledgeBaseChip({ node, raw }: UserTextNodeProps<'knowledgeBase'>): ReactNode {
  return <ReferenceChip appearance="folder" label={node.data.name} title={raw} />
}

/**
 * @param props - the resolved node and its raw marker text.
 * @returns `library / document` as a file chip.
 */
export function KnowledgeDocumentChip({ node, raw }: UserTextNodeProps<'knowledgeDocument'>): ReactNode {
  const label = node.data.base === '' ? node.data.name : `${node.data.base} / ${node.data.name}`
  return <ReferenceChip appearance="file" label={label} title={raw} />
}
