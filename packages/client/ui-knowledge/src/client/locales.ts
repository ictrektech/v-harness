/**
 * `knowledge` dictionaries: the `@` source, the evidence page, and the source
 * strip under an answer.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const NS = 'knowledge'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section': '知识库',
  'all.label': '全部知识库',
  'all.description': '在可访问的所有知识库中检索',
  'tab.label': '检索证据',
  'tab.guide.title': '知识库证据',
  'tab.guide.description': '搜索公司知识库，查看回答背后的原文片段。',
  'search.placeholder': '关键词，例如 报销流程',
  'search.action': '搜索',
  'search.running': '检索中…',
  'search.empty': '没有匹配的片段。',
  'search.failed': '知识库检索失败，请稍后重试。',
  'search.scopeFailed': '读不到你的知识库列表，将检索全部知识库。',
  'sources.label': '出处',
  'sources.more': '另有 {count} 处',
} satisfies Record<string, string>

/** The knowledge namespace key union. */
export type KnowledgeKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The knowledge-base source, evidence page, and source strip. */
    knowledge: KnowledgeKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'section': 'Knowledge bases',
  'all.label': 'All knowledge bases',
  'all.description': 'Search every knowledge base you can access',
  'tab.label': 'Retrieval evidence',
  'tab.guide.title': 'Knowledge evidence',
  'tab.guide.description': 'Search the company knowledge bases and read the passages behind an answer.',
  'search.placeholder': 'Keywords, for example expense approval',
  'search.action': 'Search',
  'search.running': 'Searching…',
  'search.empty': 'No matching passage.',
  'search.failed': 'The knowledge search failed. Try again later.',
  'search.scopeFailed': 'Your knowledge-base list is unavailable; searching every knowledge base.',
  'sources.label': 'Sources',
  'sources.more': '{count} more',
} satisfies Record<KnowledgeKey, string>
