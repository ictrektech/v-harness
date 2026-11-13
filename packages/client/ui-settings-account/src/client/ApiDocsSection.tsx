import { useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

export type ApiDocsKey = 'title' | 'language' | 'loading' | 'failed' | 'copy' | 'copied' | 'footnotes'

export const apiDocsEn = {
  title: 'API documentation', language: 'en', loading: 'Loading API documentation…',
  failed: 'Could not load API documentation. Reopen this section to retry.',
  copy: 'Copy', copied: 'Copied', footnotes: 'Footnotes',
} satisfies Record<ApiDocsKey, string>

export const apiDocsZh = {
  title: 'API 文档', language: 'zh', loading: '正在加载 API 文档…',
  failed: '无法加载 API 文档，请重新打开此页面重试。',
  copy: '复制', copied: '已复制', footnotes: '脚注',
} satisfies Record<ApiDocsKey, string>

export function ApiDocsSection({ t }: PropsLocale<'settings.vh-api'>) {
  const language = t('language')
  const [document, setDocument] = useState<{ language: string; text: string | null }>()
  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/__vh/api-docs/${language}`, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(String(response.status))
        return response.text()
      })
      .then(text => { if (!controller.signal.aborted) setDocument({ language, text }) })
      .catch(() => { if (!controller.signal.aborted) setDocument({ language, text: null }) })
    return () => controller.abort()
  }, [language])
  if (document?.language !== language) return <p role="status">{t('loading')}</p>
  if (document.text === null) return <p role="alert">{t('failed')}</p>
  return <MarkdownText text={document.text} labels={{
    code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes'),
  }} />
}
