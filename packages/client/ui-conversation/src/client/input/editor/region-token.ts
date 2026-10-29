/**
 * Collapse the composer's own region/brush tokens while they sit in the draft.
 *
 * The token text is what the turn sends and what the log keeps, so it stays the
 * node's content; only the glyphs are replaced by a chip label. Deleting the
 * chip deletes the token, and the projection that builds the message is
 * untouched because this is still a plain `TextNode`.
 *
 * @module @deepseek-ai/dsh-client-ui-conversation/input/editor/region-token
 */
import clsx from 'clsx'
import type { EditorConfig } from 'lexical'
import { TextNode } from 'lexical'
import { registerLexicalTextEntity } from '@lexical/text'
import { mergeRegister } from '@lexical/utils'
import type { SerializedTextNode } from 'lexical'
import css from './composer-editor.module.css'

/** A token's shape, as the chip shows it. */
export interface RegionTokenLabel {
  /** `box` for `<region …/>`, `brush` for `<strokes …>…</strokes>`. */
  readonly kind: 'box' | 'brush'
  /** The token's own `n`, or 1 when it carries none. */
  readonly index: number
}

/**
 * Read a token's kind and order out of its wire text.
 * @param text - one complete token, or anything else.
 * @returns the label fields, or undefined when the text is not a token.
 */
export function regionTokenLabel(text: string): RegionTokenLabel | undefined {
  const trimmed = text.trim()
  const kind = trimmed.startsWith('<region ') ? 'box' : trimmed.startsWith('<strokes ') ? 'brush' : undefined
  if (kind === undefined) return undefined
  const closed = kind === 'box' ? trimmed.endsWith('/>') : trimmed.endsWith('</strokes>')
  if (!closed) return undefined
  const index = / n="(\d+)"/u.exec(trimmed)
  return { kind, index: index === null ? 1 : Number(index[1]) }
}

/** One collapsible token as an editable text node with chip styling. */
export class RegionTokenNode extends TextNode {
  /** Lexical node registry type tag. */
  static override getType(): string {
    return 'composer-region-token'
  }

  /**
   * Clone with identity (Lexical writable-copy contract).
   * @param node - node to clone.
   * @returns a copy carrying the same NodeKey.
   */
  static override clone(node: RegionTokenNode): RegionTokenNode {
    return new RegionTokenNode(node.__text, node.__key)
  }

  /**
   * Rebuild one token node from its JSON form.
   * @param json - serialized node.
   * @returns a fresh node.
   */
  static override importJSON(json: SerializedTextNode): RegionTokenNode {
    const node = new RegionTokenNode(json.text)
    node.setFormat(json.format)
    node.setDetail(json.detail)
    node.setMode(json.mode)
    node.setStyle(json.style)
    return node
  }

  /** Serialize to the JSON node form. */
  override exportJSON(): SerializedTextNode {
    return { ...super.exportJSON(), type: 'composer-region-token' }
  }

  /** Replace the glyphs with the chip label; the token text stays the node's content. */
  override createDOM(config: EditorConfig): HTMLElement {
    const el = super.createDOM(config)
    const label = regionTokenLabel(this.getTextContent())
    el.className = clsx(el.className, css.regionToken)
    el.setAttribute('spellcheck', 'false')
    el.setAttribute('data-composer-region-token', label?.kind ?? 'box')
    // Glyphs, not words: the chip needs no dictionary entry and reads the same in every locale.
    const mark = label?.kind === 'brush' ? '✎' : '▦'
    el.setAttribute('data-chip-label', `${mark} ${String(label?.index ?? 1)}`)
    return el
  }

  /** Entity nodes never merge with plain siblings (the transform owns their bounds). */
  override isTextEntity(): true {
    return true
  }

  /** Editing continues inside; the transform re-evaluates match shape per edit. */
  override canInsertTextBefore(): boolean {
    return true
  }
}

/**
 * Register the token entity transform.
 * @param editor - the shell-owned editor.
 * @returns the unregister disposer.
 */
export function registerRegionTokenDecoration(editor: Parameters<typeof registerLexicalTextEntity>[0]): () => void {
  const getMatch = (text: string): { start: number; end: number } | null => {
    if (regionTokenLabel(text) === undefined) return null
    return { start: 0, end: text.length }
  }
  return mergeRegister(...registerLexicalTextEntity(editor, getMatch, RegionTokenNode, node => new RegionTokenNode(node.getTextContent())))
}
