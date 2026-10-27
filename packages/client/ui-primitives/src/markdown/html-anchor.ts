/**
 * Fold bare HTML anchors around workspace files back into link nodes.
 *
 * Raw HTML never enters the pipeline, so `<a href="wish-1.png">wish-1.png</a>`
 * would reach the reader as literal markup. Models still emit that shape when
 * pointing at a file they just wrote, so a destination that names a local file
 * becomes the same link node authored Markdown would have produced: the
 * existing anchor renderer then offers the file preview instead of the tag.
 */

import type { Link, PhrasingContent, Root, RootContent } from 'mdast'
import { parseFileLink } from './file-link.ts'

/** An opening anchor around a single destination; extra attributes are ignored. */
const OPENING = /^<a\s+href="([^"]*)"[^>]*>$/u
const CLOSING = /^<\/a\s*>$/u

/**
 * Replace `<a href="local">text</a>` runs with link nodes.
 *
 * Only destinations `parseFileLink` accepts are folded: an external URL keeps
 * its literal text, so this cannot introduce a navigation target the Markdown
 * grammar would have rejected.
 * @param root - Parsed Markdown tree, modified in place.
 * @returns The same root with the anchors folded.
 */
export function recoverHtmlAnchors(root: Root): Root {
  const visit = (node: Root | RootContent): void => {
    // A node without phrasing children cannot hold an inline anchor.
    if (!('children' in node)) return
    const children = node.children as PhrasingContent[]
    for (let index = 0; index < children.length; index += 1) {
      const opening = children[index]
      if (opening === undefined || opening.type !== 'html') continue
      const href = OPENING.exec(opening.value)?.[1]
      if (href === undefined || parseFileLink(href) === undefined) continue
      // The grammar emits each tag as its own node, so the run is the slice
      // between the opening tag and the next closing one.
      const closing = children.findIndex((child, at) => at > index && child.type === 'html' && CLOSING.test(child.value))
      if (closing < 0) continue
      const inner = children.slice(index + 1, closing)
      if (inner.length === 0) continue
      const link: Link = { type: 'link', url: href, children: inner }
      children.splice(index, closing - index + 1, link)
    }
    for (const child of children) visit(child)
  }
  visit(root)
  return root
}
