/** One composer region or brush token as a compact chip; the coordinates live in its title. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './RegionTokenChip.module.css'

/** Chip props: the parsed node plus the namespace translator the registration declares. */
export type RegionTokenChipProps = UserTextNodeProps<'region'> & { readonly t: TranslateNS<'conversation'> }

/** Image glyph: the token always describes a place on a picture. */
function RegionGlyph() {
  return (
    <svg className={css.icon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.75" cy="6.25" r="1.15" fill="currentColor" />
      <path d="M2.4 12.1l3.1-3.1a1.4 1.4 0 0 1 2 0l1.6 1.6 1.3-1.3a1.4 1.4 0 0 1 2 0l1.2 1.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Render a collapsed token as its own chip instead of the raw fractions.
 * @param props - matched node, its original text, and the conversation translator.
 * @returns an inline chip whose tooltip is the untouched token.
 */
export function RegionTokenChip({ node, raw, t }: RegionTokenChipProps) {
  const name = node.data.kind === 'box' ? t('image.region.chip') : t('image.region.brushMode')
  return (
    <span className={css.chip} data-region-token={node.data.kind} title={raw}>
      <RegionGlyph />
      <span className={css.label}>{`${name} ${String(node.data.index)}`}</span>
    </span>
  )
}
