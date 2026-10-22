/**
 * `knowledge` dictionaries: the `@` source, the source cards under an answer,
 * and the evidence panel.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const NS = 'knowledge'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'source.section': '知识库',
  'source.all': '全部知识库',
  'source.panel': '浏览知识库…',
  'source.panel.description': '打开面板，查看有哪些库和文档',
  'source.loading': '正在读取知识库…',
  'source.failed': '读不到知识库列表',
  'source.empty': '当前账号还没有被分配知识库',
  'source.browse': '查看知识库',
  'documents.empty': '这个库还没有文档',
  'documents.failed': '文档列表读取失败',
  'documents.loading': '正在读取文档…',
  'chip.base': '知识库',
  'chip.document': '知识库文档',
  'sources.title': '参考片段',
  'sources.count': '共 {count} 段',
  'sources.more': '还有 {count} 段',
  'libraries.title': '知识库',
  'libraries.count': '共 {count} 个',
  'tab.label': '知识库',
  'tab.guide.title': '知识库',
  'tab.guide.description': '浏览知识库、检索片段，并把范围带回输入框。',
  'panel.search.placeholder': '关键词，例如 报销流程',
  'panel.search.action': '检索',
  'panel.search.running': '检索中…',
  'panel.search.empty': '没有匹配的片段。',
  'panel.search.failed': '检索失败，请稍后重试。',
  'panel.search.retry': '重试',
  'panel.scope.action': '用这 {count} 个库提问',
  'panel.document.expand': '展开全文',
  'panel.document.collapse': '收起',
  'panel.ask.about': '据此追问',
  'panel.ask.prefix': '《{title}》第 {index} 段：',
  'panel.selection': '检索范围',
  'panel.documents': '文档',
  'panel.documents.hide': '收起',
  'mode.search': '检索',
  'mode.ask': '问答',
  'model.label': '模型',
  'model.default': '默认',
  'answer.title': '回答',
  'sources.empty.hint': '换个关键词，或放宽到整个库再试。',
} satisfies Record<string, string>

/** The knowledge namespace key union. */
export type KnowledgeKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The knowledge-base source, its source cards, and the evidence panel. */
    knowledge: KnowledgeKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'source.section': 'Knowledge bases',
  'source.all': 'All knowledge bases',
  'source.panel': 'Browse knowledge bases…',
  'source.panel.description': 'Open the panel to see the libraries and documents',
  'source.loading': 'Reading knowledge bases…',
  'source.failed': 'The knowledge-base list is unavailable',
  'source.empty': 'No knowledge base is assigned to this account yet',
  'source.browse': 'Browse knowledge bases',
  'documents.empty': 'This library has no documents yet',
  'documents.failed': 'Could not load the document list',
  'documents.loading': 'Reading documents…',
  'chip.base': 'Knowledge base',
  'chip.document': 'Knowledge-base document',
  'sources.title': 'Passages',
  'sources.count': '{count} passages',
  'sources.more': '{count} more',
  'libraries.title': 'Knowledge bases',
  'libraries.count': '{count} total',
  'tab.label': 'Knowledge bases',
  'tab.guide.title': 'Knowledge bases',
  'tab.guide.description': 'Browse the libraries, search passages, and carry the scope back to the composer.',
  'panel.search.placeholder': 'Keywords, for example expense approval',
  'panel.search.action': 'Search',
  'panel.search.running': 'Searching…',
  'panel.search.empty': 'No matching passage.',
  'panel.search.failed': 'The search failed. Try again later.',
  'panel.search.retry': 'Retry',
  'panel.scope.action': 'Ask in {count} libraries',
  'panel.document.expand': 'Show full text',
  'panel.document.collapse': 'Collapse',
  'panel.ask.about': 'Ask about this',
  'panel.ask.prefix': 'In "{title}", passage {index}: ',
  'panel.selection': 'Search scope',
  'panel.documents': 'Documents',
  'panel.documents.hide': 'Hide',
  'mode.search': 'Search',
  'mode.ask': 'Answer',
  'model.label': 'Model',
  'model.default': 'Default',
  'answer.title': 'Answer',
  'sources.empty.hint': 'Try another keyword, or widen the scope to the whole library.',
} satisfies Record<KnowledgeKey, string>
