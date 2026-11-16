/** Copy for the VOS container `@` source. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace owning this plugin's copy. */
export const NS = 'ui-vos-container'

/** Chinese dictionary; its key set is the source of truth. */
export const zh = {
  'source.section': 'VOS 容器',
  // No space in the folder token: the reference trigger ends at whitespace, so
  // a spaced name would break the descended `@…/` draft it writes.
  'source.root': '容器',
  'source.rootHint': '查看 VOS 应用容器',
  'source.back': '返回',
  'source.empty': '没有可用的 VOS 应用容器',
} as const

/** Keys this plugin translates. */
export type VosContainerKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The VOS container `@` source. */
    'ui-vos-container': VosContainerKey
  }
}

/** English dictionary, checked complete against {@link zh}. */
export const en = {
  'source.section': 'VOS containers',
  'source.root': 'containers',
  'source.rootHint': 'Show VOS application containers',
  'source.back': 'Back',
  'source.empty': 'No VOS application containers',
} satisfies Record<VosContainerKey, string>
