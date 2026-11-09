/**
 * MCPHub services, browser half: the **MCP 服务** entry of the left Sidebar and
 * the page it opens. The page reads what the gateway discovered for this
 * tenant and acts on its services through the same gateway; it never talks to
 * MCPHub itself, and it holds no credential.
 *
 * The plugin is mounted only where the gateway proved MCPHub is installed
 * (`VH_MCPHUB` in the carrier's row), so an environment without that
 * application shows no entry at all.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: `ctx.locale`, `ctx.slots`, the `main` keyed slot, and the
// `sidebar.panellist` list this plugin registers into.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { McphubPage } from './McphubPage.tsx'
import { McphubPanelIcon } from './McphubPanelIcon.tsx'
import {
  actOnMcphubServer,
  fetchMcphubSelection,
  fetchMcphubServices,
  fetchMcphubTools,
  saveMcphubSelection,
  type McphubFace,
} from './face.ts'
import { en, zh } from './locales.ts'

export type {
  McphubFace,
  McphubServer,
  McphubSnapshot,
  McphubTool,
  McphubToolServer,
  McphubToolsSnapshot,
} from './face.ts'
export type { McphubKey } from './locales.ts'
export type { McphubPageProps } from './McphubPage.tsx'

/** Dictionary namespace owned by this plugin. */
export const NS = 'mcphub'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'mcphub' as MainPanelId

/** Services required by the registrations: the slots and copy. */
export const inject = ['slots', 'locale']

/**
 * Contribute the services entry to the left Sidebar and the page it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mcphub: dictionaries')
  const face: McphubFace = {
    load: signal => fetchMcphubServices(signal),
    loadTools: signal => fetchMcphubTools(signal),
    loadSelection: signal => fetchMcphubSelection(signal),
    saveSelection: names => saveMcphubSelection(names),
    act: (name, action, enabled) => actOnMcphubServer(name, action, enabled),
  }
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => face,
  }, McphubPage)), 'ui-mcphub: services page')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => t('panel'),
    locale: NS,
  }, McphubPanelIcon)), 'ui-mcphub: sidebar entry')
}
