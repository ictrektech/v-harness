/** Decorative v-harness mark for the running Chat status. */
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ChatView.module.css'

/**
 * Render the same theme-aware mark used by the sidebar, without motion.
 * @returns a decorative running-status mark.
 */
export function RunningWhaleTail() {
  return <span className={css.runningIcon} aria-hidden="true"><FishLogo size={14} /></span>
}
