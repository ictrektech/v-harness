import { describe, expect, it } from 'vitest'
import {
  baseScopeRule, decodeScope, documentScopeRule, encodeScope, labelOf, markerOf, type Scope,
} from '../src/client/markers.ts'

const base: Scope = { kind: 'base', name: '产品文档' }
const document: Scope = { kind: 'document', base: '产品文档', name: '部署指南' }

/** Facts reader the rules receive; both markers depend on text alone. */
const context = { read: () => undefined }

describe('knowledge scope markers', () => {
  it('serialises a library and a document as the marker the skill reads', () => {
    expect(markerOf(base)).toBe('<knowledge-base>产品文档</knowledge-base>')
    expect(markerOf(document)).toBe('<knowledge-document>产品文档/部署指南</knowledge-document>')
  })

  it('labels a document with its library, so two same-named documents stay distinguishable', () => {
    expect(labelOf(base)).toBe('产品文档')
    expect(labelOf(document)).toBe('产品文档 / 部署指南')
  })

  it('round-trips both scopes through the opaque ref', () => {
    expect(decodeScope(encodeScope(base))).toEqual(base)
    expect(decodeScope(encodeScope(document))).toEqual(document)
  })

  it('refuses a ref this source did not encode', () => {
    expect(decodeScope('file:src/index.ts')).toBeUndefined()
    expect(decodeScope('doc:no-slash')).toBeUndefined()
    expect(decodeScope('kb:')).toBeUndefined()
  })

  it('renders a library marker in user text as a folder chip node', () => {
    const text = '范围 <knowledge-base>产品文档</knowledge-base> 里的制度'
    const node = baseScopeRule.match(text, 0, context)
    expect(node).toEqual({
      id: 'knowledgeBase',
      start: 3,
      end: text.indexOf(' 里的制度'),
      data: { name: '产品文档' },
    })
  })

  it('splits a document marker into its library and document names', () => {
    const text = '<knowledge-document>产品文档/部署指南</knowledge-document>'
    expect(documentScopeRule.match(text, 0, context)).toEqual({
      id: 'knowledgeDocument',
      start: 0,
      end: text.length,
      data: { base: '产品文档', name: '部署指南' },
    })
  })

  it('leaves ordinary prose alone', () => {
    expect(baseScopeRule.match('普通消息', 0, context)).toBeUndefined()
    expect(documentScopeRule.match('普通消息', 0, context)).toBeUndefined()
  })
})
