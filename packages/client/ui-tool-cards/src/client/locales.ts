/** `toolCards` namespace dictionaries for the product tool cards. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'toolCards'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'card.running': '正在处理',
  'card.unavailable': '此结果的交互卡片不可用',
  'image.studioTitle': '生成结果',
  'image.studioSeed': '种子 {seed}',
  'image.studioHint': '图片已存到工作区，点开可看大图；这个种子能原样复现同一张',
} satisfies Record<string, string>

/** The toolCards namespace key union. */
export type ToolCardsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'card.running': 'Working',
  'card.unavailable': 'The interactive card for this result is unavailable',
  'image.studioTitle': 'Generated',
  'image.studioSeed': 'seed {seed}',
  'image.studioHint': 'Saved to the workspace — open it for the full size; the seed reproduces this exact image',
} satisfies Record<string, string>
