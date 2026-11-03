/**
 * Browser half: register `services` as a right-Sidebar tab type.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`,
 * the body into the keyed `sidebar.right.pane.tab` seat and the chip title into
 * the keyed `sidebar.right.pane.tab.title` seat, both under the type's `id`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SERVICES_ID, servicesDefinition } from './definition.tsx'
import { en, zh } from './locales.ts'
import { createServicesStore } from './store.ts'
import { ServicesBody } from './ServicesBody.tsx'
import { ServicesTitle } from './ServicesTitle.tsx'

export type { UiServicesKey } from './locales.ts'
export type { ServiceEntry } from './face.ts'
export type { ServicesBodyProps } from './ServicesBody.tsx'

/** This package's copy namespace. */
const NS = 'uiServices'

/**
 * Required browser services: the tab registry, the keyed seat, the shortcut
 * registry behind the guide entry, and copy.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'shortcuts']

/**
 * Client plugin body: register the type, its dictionaries, its shortcut, its body, and its chip title.
 * @param ctx - client root context carrying the registry, the slots, and copy.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.inject(['shortcuts'], (shortcutCtx) => {
    shortcutCtx.effect(() => shortcutCtx.shortcuts.register({
      id: 'workspace.services' as ShortcutCommandId,
      label: () => t('guide.title'),
      aliases: ['services', '我的服务'],
      defaults: {
        'desktop:macos': { code: 'KeyS', modifiers: ['primary', 'alt'] },
        'desktop:windows': { code: 'KeyS', modifiers: ['primary', 'alt'] },
        'desktop:linux': { code: 'KeyS', modifiers: ['primary', 'alt'] },
        'web:macos': { code: 'KeyS', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyS', modifiers: ['primary', 'alt'] },
      },
      regions: ['page', 'editable', 'terminal'],
      modals: [],
      // Each tab plugin owns its command's availability, localized refusal, and tab kind.
      resolve: ({ target: element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
        return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('services', target) } }
      },
    }), 'ui-services: shortcut')
  })
  ctx.effect(() => ctx.sidebarRightTabs.register(servicesDefinition(t)), 'ui-services: services type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-services: dictionaries')

  const store = createServicesStore()
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: SERVICES_ID, locale: NS, store },
    ServicesBody,
  )), 'ui-services: services tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: SERVICES_ID },
    ServicesTitle,
  )), 'ui-services: services tab title')
}
