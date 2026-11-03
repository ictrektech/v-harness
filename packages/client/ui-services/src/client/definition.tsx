/**
 * Stage one of this package's registration: what the `services` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The guide page offers
 * it as an entry box, and the body is one shared list of the tenant's own
 * services. The guide reuses the browser artwork — a service *is* a web app —
 * so landing this plugin introduces no new glyph.
 */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'

/** The tab kind this package owns. */
export const SERVICES_KIND = 'services'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const SERVICES_ID = '@deepseek-ai/dsh-client-ui-services'

/**
 * The services type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function servicesDefinition(t: TranslateNS<'uiServices'>): SidebarRightTabDefinition {
  return {
    id: SERVICES_ID,
    kind: SERVICES_KIND,
    priority: 'extension',
    title: () => t('type.label'),
    guide: [{
      id: 'services',
      commandId: 'workspace.services' as ShortcutCommandId,
      order: 20,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: GuideArtworkBrowser,
    }],
  }
}
