/** Copy for the V-Office `@` source. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace owning this plugin's copy. */
export const NS = 'ui-voffice'

/** Chinese dictionary; its key set is the source of truth. */
export const zh = {
  'source.section': '我的文档',
  'source.empty': '还没有文档，可以在 V-Office 里新建',
  'source.failed': '无法读取文档列表',
  'source.kindWord': 'Word 文档',
  'source.kindSheet': '表格',
  'source.kindSlides': '演示文稿',
  'source.kindPdf': 'PDF',
} as const

/** Keys this plugin translates. */
export type VofficeKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The V-Office `@` document source. */
    'ui-voffice': VofficeKey
  }
}

/** English dictionary, checked complete against {@link zh}. */
export const en = {
  'source.section': 'My documents',
  'source.empty': 'No documents yet — create one in V-Office',
  'source.failed': 'Could not read the document list',
  'source.kindWord': 'Word document',
  'source.kindSheet': 'Spreadsheet',
  'source.kindSlides': 'Presentation',
  'source.kindPdf': 'PDF',
} satisfies Record<VofficeKey, string>
