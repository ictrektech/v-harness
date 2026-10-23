#!/usr/bin/env node
/**
 * WeKnora / HybRAG knowledge-base CLI for the v-harness agent.
 *
 * The agent never holds a VOS access token. In a v-harness deployment the
 * gateway listens on `$HOME/.dsh/weknora.sock`, keeps the tenant's token in
 * memory and adds `Authorization` itself. Direct HTTP mode exists for local
 * debugging only and is selected when both `WEKNORA_URL` and
 * `WEKNORA_BEARER_TOKEN` are set.
 *
 * Every command prints one JSON object on stdout and exits 0, or prints an
 * error object on stderr and exits 1.
 *
 *   kbs                          knowledge bases this caller can read
 *   docs <kb> [--keyword]        documents inside one knowledge base
 *   search <query> [--kb] [--doc] [--limit]
 *                                retrieval with citations
 *   read <knowledge_id>          one document, every chunk in order
 */

import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SOCKET_ENV = 'VH_WEKNORA_SOCK'
const REQUEST_TIMEOUT_MS = 120_000
/** Server cap for both `/chunks` and `/knowledge` page sizes. */
const PAGE_SIZE = 100
/** Guard against a runaway pagination loop on a bad `total`. */
const MAX_PAGES = 20
/** Results per search when the caller names no limit. */
const DEFAULT_LIMIT = 8
/** Server cap for `match_count`. */
const MAX_LIMIT = 200
/** Passage characters kept with one citation. */
const SNIPPET_CHARS = 600

class UsageError extends Error {}

/**
 * Resolve the transport once: a per-tenant Unix socket, or explicit HTTP with
 * a bearer token (local debugging only).
 * @returns {{ describe: string, request: (path: string, options: object) => import('node:http').ClientRequest }}
 */
function resolveTransport() {
  const explicitSocket = process.env[SOCKET_ENV]
  const socketPath = explicitSocket ?? join(homedir(), '.dsh', 'weknora.sock')
  if (explicitSocket || existsSync(socketPath)) {
    if (!existsSync(socketPath)) {
      throw new UsageError(
        `知识库能力端点不存在（${socketPath}）。这通常意味着当前会话没有完成 VOS 登录，请在 v-harness 页面重新登录。`,
      )
    }
    return {
      describe: `socket ${socketPath}`,
      request: (path, options) => httpRequest({ socketPath, path, ...options }),
    }
  }

  const base = process.env.WEKNORA_URL?.replace(/\/+$/, '')
  const token = process.env.WEKNORA_BEARER_TOKEN
  if (!base || !token) {
    throw new UsageError(
      `知识库能力端点不存在（${socketPath}），也没有 WEKNORA_URL + WEKNORA_BEARER_TOKEN。`
        + '请在 v-harness 页面重新登录，或为本地调试配置这两个变量。',
    )
  }
  const url = new URL(base)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return {
    describe: `http ${base}`,
    request: (path, options) => send(
      new URL(`${url.pathname.replace(/\/+$/, '')}${path}`, url.origin),
      { ...options, headers: { ...options.headers, authorization: `Bearer ${token}` } },
    ),
  }
}

/**
 * @param {import('node:http').IncomingMessage} response
 * @returns {Promise<string>}
 */
async function readText(response) {
  const chunks = []
  for await (const chunk of response) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

/**
 * @param {string} text
 * @returns {unknown} parsed JSON, or the raw text when the body is not JSON.
 */
function parse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Pull the human-readable part out of an upstream error body.
 *
 * WeKnora answers with `{error: {message}}` for typed failures and with
 * `{message}` for older handlers; both must reach the user as one line.
 * @param {unknown} body
 * @returns {string}
 */
function upstreamMessage(body) {
  if (typeof body === 'string') return body.slice(0, 300)
  const error = body?.error
  if (typeof error === 'string') return error.slice(0, 300)
  if (typeof error?.message === 'string') return error.message.slice(0, 300)
  if (typeof body?.message === 'string') return body.message.slice(0, 300)
  return JSON.stringify(body ?? {}).slice(0, 300)
}

/**
 * One request through the resolved transport.
 * @param {{ request: Function, describe: string }} transport
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [init]
 * @returns {Promise<unknown>} the parsed success body.
 */
async function call(transport, path, init = {}) {
  const payload = init.body === undefined
    ? undefined
    : Buffer.from(JSON.stringify(init.body), 'utf8')
  const headers = { accept: 'application/json' }
  if (payload) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(payload.byteLength)
  }

  const response = await new Promise((resolve, reject) => {
    const outgoing = transport.request(path, { method: init.method ?? 'GET', headers })
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => { outgoing.destroy(new Error('知识库请求超时')) })
    outgoing.on('error', reject)
    outgoing.on('response', resolve)
    outgoing.end(payload)
  })

  const body = parse(await readText(response))
  const status = response.statusCode ?? 0
  if (status >= 400) throw new Error(`知识库服务返回 HTTP ${String(status)}：${upstreamMessage(body)}`)
  return body
}

/**
 * @param {unknown} body
 * @returns {Record<string, any>[]} the rows of a list response.
 */
function rows(body) {
  const data = body?.data
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data?.knowledge_bases)) return data.knowledge_bases
  return []
}

/**
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | undefined} the value after `--name`.
 */
function option(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

/**
 * @param {string[]} argv
 * @returns {string | undefined} the first argument that is not an option.
 */
function positional(argv) {
  return argv.find((value) => !value.startsWith('--'))
}

/**
 * @param {string} text
 * @returns {string} at most SNIPPET_CHARS characters, with an explicit marker.
 */
function snippet(text) {
  const value = String(text ?? '')
  return value.length <= SNIPPET_CHARS
    ? value
    : `${value.slice(0, SNIPPET_CHARS)}…[截断，共 ${String(value.length)} 字符]`
}

/**
 * Every knowledge base this caller can read.
 * @param {{ request: Function, describe: string }} transport
 * @returns {Promise<Record<string, any>[]>}
 */
async function listKnowledgeBases(transport) {
  return rows(await call(transport, '/api/v1/knowledge-bases'))
}

/**
 * Turn a `--kb` spec into ids. Library names are accepted because the `@` menu
 * inserts the human-readable name while the API wants ids.
 * @param {{ request: Function, describe: string }} transport
 * @param {string} spec - comma-separated ids and/or names.
 * @returns {Promise<string[]>}
 */
async function resolveKnowledgeBases(transport, spec) {
  const wanted = spec.split(',').map((value) => value.trim()).filter(Boolean)
  const list = await listKnowledgeBases(transport)
  const matched = list.filter((kb) => wanted.includes(kb.id) || wanted.includes(kb.name))
  const missing = wanted.filter((value) => !list.some((kb) => kb.id === value || kb.name === value))
  if (missing.length > 0) {
    throw new Error(`没有匹配的知识库：${missing.join('、')}。先跑 kbs 看有哪些库。`)
  }
  return matched.map((kb) => kb.id)
}

/**
 * Default scope: every library the caller can read.
 * @param {{ request: Function, describe: string }} transport
 * @returns {Promise<string[]>}
 */
async function allKnowledgeBases(transport) {
  const ids = (await listKnowledgeBases(transport)).map((kb) => kb.id)
  if (ids.length === 0) throw new Error('当前账号还没有被分配知识库，请联系管理员。')
  return ids
}

/**
 * One knowledge base by name or id.
 * @param {{ request: Function, describe: string }} transport
 * @param {string} spec
 * @returns {Promise<Record<string, any>>}
 */
async function oneKnowledgeBase(transport, spec) {
  const list = await listKnowledgeBases(transport)
  const found = list.find((kb) => kb.id === spec || kb.name === spec)
  if (!found) throw new Error(`没有匹配的知识库：${spec}。先跑 kbs 看有哪些库。`)
  return found
}

/**
 * @param {{ request: Function, describe: string }} transport
 * @returns {Promise<Record<string, unknown>>}
 */
async function kbs(transport) {
  const list = (await listKnowledgeBases(transport)).map((kb) => ({
    id: kb.id,
    name: kb.name,
    type: kb.type ?? 'document',
    ...(typeof kb.document_count === 'number' ? { documents: kb.document_count } : {}),
    ...(kb.description ? { description: kb.description } : {}),
  }))
  return { count: list.length, knowledge_bases: list }
}

/**
 * Documents inside one knowledge base, every page collected.
 * @param {{ request: Function, describe: string }} transport
 * @param {string[]} argv
 * @returns {Promise<Record<string, unknown>>}
 */
async function docs(transport, argv) {
  const spec = positional(argv)
  if (!spec) throw new UsageError('用法：docs <库名或ID> [--keyword 词] [--limit 500]')

  const knowledgeBase = await oneKnowledgeBase(transport, spec)
  const keyword = option(argv, 'keyword')
  const limit = Math.min(Math.max(Number(option(argv, 'limit') ?? 500), 1), 500)
  const collected = []
  let total = 0
  let complete = false

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
    if (keyword !== undefined) query.set('keyword', keyword)
    const body = await call(
      transport,
      `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBase.id)}/knowledge?${query.toString()}`,
    )
    if (typeof body?.total === 'number') total = body.total
    const pageRows = rows(body)
    collected.push(...pageRows)
    const exhausted = pageRows.length < PAGE_SIZE || (total > 0 && collected.length >= total)
    if (exhausted) {
      complete = true
      break
    }
    if (collected.length >= limit) break
  }

  const documents = collected.slice(0, limit).map((row) => ({
    id: row.id,
    title: row.title || row.file_name || row.id,
    file_name: row.file_name ?? '',
    folder_path: row.folder_path ?? '',
    parse_status: row.parse_status ?? '',
    ...(row.file_type ? { file_type: row.file_type } : {}),
    ...(row.updated_at ? { updated_at: row.updated_at } : {}),
  }))

  return {
    knowledge_base: { id: knowledgeBase.id, name: knowledgeBase.name, type: knowledgeBase.type ?? 'document' },
    count: documents.length,
    total: total || collected.length,
    truncated: !complete || total > documents.length,
    documents,
  }
}

/**
 * Turn a `--doc` spec into document ids.
 *
 * A chip writes `库名/文档名` into the message, so the CLI accepts that form
 * beside a bare id: the model should not have to run `docs` first just to
 * learn an id the reference already names.
 * @param {{ request: Function, describe: string }} transport
 * @param {string} spec - comma-separated ids and/or `库名/文档名` pairs.
 * @returns {Promise<string[]>} the document ids to search.
 */
async function resolveDocuments(transport, spec) {
  const wanted = spec.split(',').map((value) => value.trim()).filter(Boolean)
  const ids = []
  for (const value of wanted) {
    const slash = value.indexOf('/')
    if (slash === -1) {
      ids.push(value)
      continue
    }
    const baseName = value.slice(0, slash)
    const documentName = value.slice(slash + 1)
    const knowledgeBase = await oneKnowledgeBase(transport, baseName)
    const query = new URLSearchParams({ page: '1', page_size: String(PAGE_SIZE), keyword: documentName })
    const body = await call(
      transport,
      `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBase.id)}/knowledge?${query.toString()}`,
    )
    const found = rows(body)
    const match = found.find((row) => (row.title || row.file_name) === documentName) ?? found[0]
    if (match === undefined) {
      throw new Error(`知识库「${knowledgeBase.name}」里没有文档「${documentName}」。先跑 docs ${baseName} 看有哪些文档。`)
    }
    ids.push(match.id)
  }
  return ids
}

/**
 * One retrieved passage, with the citation fields the client renders.
 * @param {Record<string, any>} row
 * @returns {Record<string, unknown>}
 */
function citation(row) {
  return {
    chunk_id: row.id,
    knowledge_id: row.knowledge_id,
    knowledge_base_id: row.knowledge_base_id ?? '',
    title: row.knowledge_title || row.title || '',
    chunk_index: row.chunk_index ?? 0,
    score: row.score ?? 0,
    snippet: snippet(row.content),
  }
}

/**
 * @param {{ request: Function, describe: string }} transport
 * @param {string[]} argv
 * @returns {Promise<Record<string, unknown>>}
 */
async function search(transport, argv) {
  const query = positional(argv)
  if (!query) throw new UsageError('用法：search <关键词> [--kb 库名,库名] [--doc 文档ID,...] [--limit 8]')

  const limit = Math.min(Math.max(Number(option(argv, 'limit') ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
  const kbSpec = option(argv, 'kb')
  const docSpec = option(argv, 'doc')
  const knowledgeDocumentIds = docSpec === undefined ? [] : await resolveDocuments(transport, docSpec)
  const knowledgeBaseIds = kbSpec === undefined
    ? (knowledgeDocumentIds.length === 0 ? await allKnowledgeBases(transport) : [])
    : await resolveKnowledgeBases(transport, kbSpec)

  const body = await call(transport, '/api/v1/knowledge-search', {
    method: 'POST',
    body: {
      query,
      knowledge_base_ids: knowledgeBaseIds,
      ...(knowledgeDocumentIds.length === 0 ? {} : { knowledge_ids: knowledgeDocumentIds }),
      match_count: limit,
    },
  })

  const citations = rows(body).map(citation)
  return {
    query,
    scope: { knowledge_bases: knowledgeBaseIds, knowledge_documents: knowledgeDocumentIds },
    count: citations.length,
    ...(citations.length === 0
      ? { hint: '换个检索词，或用 docs 确认文档确实在库里。' }
      : {}),
    citations,
  }
}

/**
 * One document, every chunk in reading order.
 * @param {{ request: Function, describe: string }} transport
 * @param {string[]} argv
 * @returns {Promise<Record<string, unknown>>}
 */
async function read(transport, argv) {
  const id = positional(argv)
  if (!id) throw new UsageError('用法：read <knowledge_id>')

  const document = await call(transport, `/api/v1/knowledge/${encodeURIComponent(id)}`)
  const record = document?.data?.knowledge ?? document?.data ?? {}
  const chunks = []
  let total = 0
  let complete = false

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await call(
      transport,
      `/api/v1/chunks/${encodeURIComponent(id)}?page=${String(page)}&page_size=${String(PAGE_SIZE)}`,
    )
    if (typeof body?.total === 'number') total = body.total
    const pageRows = rows(body)
    chunks.push(...pageRows.map((chunk) => ({
      chunk_id: chunk.id,
      chunk_index: chunk.chunk_index ?? 0,
      content: chunk.content,
    })))
    const exhausted = pageRows.length < PAGE_SIZE || (total > 0 && chunks.length >= total)
    if (exhausted) {
      complete = true
      break
    }
  }

  chunks.sort((left, right) => left.chunk_index - right.chunk_index)

  return {
    knowledge: {
      id: record.id ?? id,
      title: record.title || record.file_name || '',
      file_name: record.file_name ?? '',
      folder_path: record.folder_path ?? '',
      parse_status: record.parse_status ?? '',
    },
    count: chunks.length,
    total: total || chunks.length,
    truncated: !complete || total > chunks.length,
    chunks,
  }
}

/** Commands this CLI accepts. */
const COMMANDS = { kbs, docs, search, read }

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  const run = COMMANDS[command]
  if (!run) {
    throw new UsageError(`未知命令 ${String(command)}；可用：${Object.keys(COMMANDS).join(' / ')}`)
  }
  const transport = resolveTransport()
  const result = await run(transport, argv)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

await main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`)
  process.exit(1)
})
