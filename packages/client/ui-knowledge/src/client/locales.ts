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
  'hybrag.description': '打开知识库：看有哪些库，选一个再检索',
  'tab.label': '知识库',
  'tab.guide.title': '知识库',
  'tab.guide.description': '搜索公司知识库，查看回答背后的原文片段。',
  'search.placeholder': '关键词，例如 报销流程',
  'search.action': '搜索',
  'search.running': '检索中…',
  'search.empty': '没有匹配的片段。',
  'search.failed': '知识库检索失败，请稍后重试。',
  'search.scopeFailed': '读不到你的知识库列表，将检索全部知识库。',
  'sources.title': '检索结果',
  'sources.count': '共 {count} 条',
  'libraries.title': '知识库',
  'libraries.count': '共 {count} 个',
  'documents.show': '文档',
  'documents.hide': '收起',
  'documents.loading': '加载中…',
  'documents.failed': '文档加载失败，刷新后重试',
  'documents.empty': '这个库还没有文档',
  'mode.search': '检索',
  'mode.ask': '问答',
  'model.label': '模型',
  'model.default': '默认',
  'answer.title': '回答',
  'apply.label': '填入输入框',
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
  'hybrag.description': 'Open the knowledge bases: see what you can search, then pick one',
  'tab.label': 'Knowledge bases',
  'tab.guide.title': 'Knowledge bases',
  'tab.guide.description': 'Search the company knowledge bases and read the passages behind an answer.',
  'search.placeholder': 'Keywords, for example expense approval',
  'search.action': 'Search',
  'search.running': 'Searching…',
  'search.empty': 'No matching passage.',
  'search.failed': 'The knowledge search failed. Try again later.',
  'search.scopeFailed': 'Your knowledge-base list is unavailable; searching every knowledge base.',
  'sources.title': 'Results',
  'sources.count': '{count} passages',
  'libraries.title': 'Knowledge bases',
  'libraries.count': '{count} total',
  'documents.show': 'Documents',
  'documents.hide': 'Hide',
  'documents.loading': 'Loading…',
  'documents.failed': 'Could not load documents; refresh and retry',
  'documents.empty': 'This library has no documents yet',
  'mode.search': 'Search',
  'mode.ask': 'Answer',
  'model.label': 'Model',
  'model.default': 'Default',
  'answer.title': 'Answer',
  'apply.label': 'Use in composer',
} satisfies Record<KnowledgeKey, string>
