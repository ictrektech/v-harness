/** `settings.locale` namespace dictionaries (the Language row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'language.title': '语言',
  'language.follow': '跟随 VOS',
} satisfies Record<string, string>

/** The settings.locale namespace key union. */
export type SettingsLocaleKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'language.title': 'Language',
  'language.follow': 'Follow VOS',
} satisfies Record<SettingsLocaleKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'language.title': '言語',
  'language.follow': 'VOS に従う',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'language.title': 'Idioma',
  'language.follow': 'Usar el idioma de VOS',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'language.title': 'Langue',
  'language.follow': 'Suivre la langue de VOS',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'language.title': 'Sprache',
  'language.follow': 'VOS-Sprache verwenden',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'language.title': 'Язык',
  'language.follow': 'Использовать язык VOS',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'language.title': 'Idioma',
  'language.follow': 'Usar o idioma do VOS',
} satisfies Record<keyof typeof en, string>
