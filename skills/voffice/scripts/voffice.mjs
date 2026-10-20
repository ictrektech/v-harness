#!/usr/bin/env node
/**
 * V-Office document CLI for the v-harness agent.
 *
 * The agent never holds a VOS access token. In a v-harness deployment the
 * gateway listens on `$HOME/.dsh/voffice.sock` (0700 directory, 0600 socket,
 * owned by this tenant) and adds the Authorization header itself. The direct
 * HTTP mode exists for local debugging outside the container and is selected
 * only when `V_OFFICE_URL` and `V_OFFICE_BEARER_TOKEN` are both set.
 *
 * Every command prints one JSON object on stdout and exits 0, or prints an
 * error object on stderr and exits 1.
 *
 *   me                              confirm which VOS user this endpoint serves
 *   list                            list the current user's documents
 *   download <name> [--out <path>]  fetch a document into the workspace
 *   view <name> [--out <path>]      download, ready for the `present` tool
 *   open <name>                     print an absolute link to the online editor
 *   upload <file> [--name <name>]   create or atomically overwrite a document
 *   rename <name> <new-name>        rename a document
 *   delete <name>                   delete a document
 *   health                          upstream health check (no token needed)
 */

import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** Suffixes the storage service accepts; anything else is rejected upstream. */
const ALLOWED_EXT = new Set([
  '.docx', '.xlsx', '.pptx', '.pdf', '.odt', '.ods', '.odp', '.csv', '.txt', '.md',
])
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_NAME_LEN = 200
const SOCKET_ENV = 'VH_OFFICE_SOCK'
const REQUEST_TIMEOUT_MS = 300_000
const ERROR_BODY_LIMIT = 4_096

class UsageError extends Error {}

/**
 * Resolve the transport once: a per-tenant Unix socket, or an explicit HTTP
 * base with a bearer token (local debugging only).
 * @returns {{ describe: string, request: (path: string, options: object) => import('node:http').ClientRequest }}
 */
function resolveTransport() {
  const explicitSocket = process.env[SOCKET_ENV]
  const socketPath = explicitSocket ?? join(homedir(), '.dsh', 'voffice.sock')
  if (explicitSocket || existsSync(socketPath)) {
    if (!existsSync(socketPath)) {
      throw new UsageError(
        `V-Office 能力端点不存在（${socketPath}）。请在 v-harness 页面重新登录后再试。`,
      )
    }
    return {
      describe: `socket ${socketPath}`,
      request: (path, options) => httpRequest({ socketPath, path, ...options }),
    }
  }

  const base = process.env.V_OFFICE_URL?.replace(/\/+$/, '')
  const token = process.env.V_OFFICE_BEARER_TOKEN
  if (!base || !token) {
    throw new UsageError(
      '未接入 V-Office：既没有本地能力端点，也没有 V_OFFICE_URL + V_OFFICE_BEARER_TOKEN。'
        + '这通常意味着当前会话没有完成 VOS 登录；请在 v-harness 页面重新登录。',
    )
  }
  const url = new URL(base)
  const sendRequest = url.protocol === 'https:' ? httpsRequest : httpRequest
  return {
    describe: `http ${base}`,
    request: (path, options) => {
      const headers = { ...options.headers, authorization: `Bearer ${token}` }
      return sendRequest(
        new URL(`${url.pathname.replace(/\/+$/, '')}${path}`, url.origin),
        { ...options, headers },
      )
    },
  }
}

/**
 * Validate a document name: no path segments, an accepted suffix.
 * @param {string | undefined} value
 * @returns {string} the validated name.
 */
function assertName(value) {
  const name = String(value ?? '').trim()
  if (!name) throw new UsageError('文件名不能为空')
  if (name.length > MAX_NAME_LEN) {
    throw new UsageError(`文件名超过 ${String(MAX_NAME_LEN)} 个字符`)
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new UsageError('文件名不能包含路径或 ".."')
  }
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) throw new UsageError('文件名必须包含扩展名')
  const suffix = name.slice(dot).toLowerCase()
  if (!ALLOWED_EXT.has(suffix)) {
    throw new UsageError(`不支持的文件类型 ${suffix}；仅支持 ${[...ALLOWED_EXT].join(' ')}`)
  }
  return name
}

/**
 * Resolve a download target and refuse anything outside the workspace.
 * @param {string} target
 * @returns {string} absolute path inside the current working directory.
 */
function resolveInWorkspace(target) {
  const cwd = process.cwd()
  const absolute = resolve(cwd, target)
  if (absolute !== cwd && !absolute.startsWith(`${cwd}${sep}`)) {
    throw new UsageError('下载目标必须位于当前工作目录（沙盒只允许写 workspace）')
  }
  return absolute
}

/**
 * Read a response body as JSON when possible, as text otherwise.
 * @param {import('node:http').IncomingMessage} response
 * @returns {Promise<unknown>}
 */
async function readBody(response) {
  const chunks = []
  let size = 0
  for await (const chunk of response) {
    size += chunk.length
    if (size > ERROR_BODY_LIMIT) break
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Turn one upstream failure into an actionable message.
 * @param {number} status
 * @param {unknown} body
 * @returns {string}
 */
function explain(status, body) {
  let detail = ''
  if (typeof body === 'string') detail = body.slice(0, 300)
  else if (body && typeof body === 'object' && 'detail' in body) {
    detail = JSON.stringify(body.detail).slice(0, 300)
  }
  switch (status) {
    case 401:
      return 'VOS 登录令牌缺失或已过期：请在 v-harness 页面刷新（F5）后重试'
    case 404:
      return '当前用户的「我的文档」中没有这个文件'
    case 409:
      return '目标文件名已存在，或该文档已被其他窗口修改（版本冲突）'
    case 413:
      return '文件超过 100 MB 上限'
    default:
      return `V-Office 返回 HTTP ${String(status)}${detail ? `：${detail}` : ''}`
  }
}

/**
 * Create one request without writing its body.
 * @param {ReturnType<typeof resolveTransport>} transport
 * @param {string} method
 * @param {string} path
 * @param {Record<string, string | number>} [headers]
 * @returns {import('node:http').ClientRequest}
 */
function open(transport, method, path, headers = {}) {
  const request = transport.request(path, { method, headers })
  request.setTimeout(REQUEST_TIMEOUT_MS, () => {
    request.destroy(new Error('请求超时（300 秒）'))
  })
  return request
}

/**
 * Wait for the response head, failing on transport errors.
 * @param {import('node:http').ClientRequest} request
 * @returns {Promise<import('node:http').IncomingMessage>}
 */
function responded(request) {
  return new Promise((resolveResponse, reject) => {
    request.on('error', reject)
    request.on('response', resolveResponse)
  })
}

/**
 * Fail on a non-2xx response with the mapped message.
 * @param {import('node:http').IncomingMessage} response
 */
async function ensureOk(response) {
  const status = response.statusCode ?? 0
  if (status >= 200 && status < 300) return
  throw new UsageError(explain(status, await readBody(response)))
}

/**
 * GET one small JSON document.
 * @param {ReturnType<typeof resolveTransport>} transport
 * @param {string} path
 * @returns {Promise<Record<string, unknown>>}
 */
async function getJson(transport, path) {
  const request = open(transport, 'GET', path, { accept: 'application/json' })
  const response = responded(request)
  request.end()
  const resolved = await response
  await ensureOk(resolved)
  const body = await readBody(resolved)
  return body && typeof body === 'object' ? body : {}
}

/**
 * Download one document into the workspace.
 * @param {ReturnType<typeof resolveTransport>} transport
 * @param {string} name
 * @param {string | undefined} outOption
 * @returns {Promise<{ name: string, path: string, bytes: number }>}
 */
async function download(transport, name, outOption) {
  const target = resolveInWorkspace(outOption ?? name)
  const request = open(transport, 'GET', `/api/v1/files/${encodeURIComponent(name)}`, {
    accept: 'application/octet-stream',
  })
  const response = responded(request)
  request.end()
  const resolved = await response
  await ensureOk(resolved)
  await mkdir(dirname(target), { recursive: true })
  await pipeline(resolved, createWriteStream(target))
  const written = await stat(target)
  return { name, path: target, bytes: written.size }
}

/**
 * Upload one local file, creating or atomically overwriting the document.
 * @param {ReturnType<typeof resolveTransport>} transport
 * @param {string} file
 * @param {string | undefined} explicitName
 * @returns {Promise<{ name: string, size: number, response: unknown }>}
 */
async function upload(transport, file, explicitName) {
  const source = resolve(process.cwd(), file)
  const stats = await stat(source).catch(() => undefined)
  if (!stats?.isFile()) throw new UsageError(`文件不存在：${file}`)
  if (stats.size > MAX_UPLOAD_BYTES) throw new UsageError('文件超过 100 MB 上限')
  if (stats.size === 0) throw new UsageError('文件为空，V-Office 会拒绝')
  const name = assertName(explicitName ?? basename(source))

  const request = open(transport, 'PUT', `/api/v1/files/${encodeURIComponent(name)}`, {
    'content-type': 'application/octet-stream',
    'content-length': String(stats.size),
  })
  const response = responded(request)
  const body = createReadStream(source)
  body.on('error', (error) => { request.destroy(error) })
  body.pipe(request)
  const resolved = await response
  await ensureOk(resolved)
  const payload = await readBody(resolved)
  return { name, size: stats.size, response: payload }
}

/**
 * Parse `--key value` / `--key=value` options around positional arguments.
 * @param {string[]} argv
 * @returns {{ positionals: string[], options: Record<string, string> }}
 */
function parseOptions(argv) {
  const positionals = []
  /** @type {Record<string, string>} */
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const [key, inline] = token.slice(2).split('=', 2)
    if (!key) throw new UsageError('选项格式错误')
    const value = inline ?? argv[index + 1]
    if (value === undefined) throw new UsageError(`选项 --${key} 需要一个值`)
    options[key] = value
    if (inline === undefined) index += 1
  }
  return { positionals, options }
}

/**
 * Run one command and return its JSON payload.
 * @param {string[]} argv
 * @returns {Promise<Record<string, unknown>>}
 */
async function run(argv) {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    throw new UsageError(
      'usage: voffice <me|list|download|view|open|upload|rename|delete|health> ...',
    )
  }
  const transport = resolveTransport()

  if (command === 'health') {
    return { ok: true, health: await getJson(transport, '/api/v1/health') }
  }

  if (command === 'me') {
    return { ok: true, ...(await getJson(transport, '/api/v1/me')) }
  }

  if (command === 'list') {
    const body = await getJson(transport, '/api/v1/files')
    const files = Array.isArray(body.files) ? body.files : []
    return { ok: true, total: files.length, files }
  }

  if (command === 'download' || command === 'view') {
    const parsed = parseOptions(rest)
    const name = assertName(parsed.positionals[0])
    const result = await download(transport, name, parsed.options.out)
    if (command === 'view') {
      return {
        ok: true,
        ...result,
        hint: '调用 present 工具声明这个文件，用户点击卡片即可在右侧预览。',
      }
    }
    return { ok: true, ...result }
  }

  if (command === 'open') {
    const name = assertName(parseOptions(rest).positionals[0])
    // The gateway records the portal origin from the browser's own requests;
    // the chat renderer refuses relative hrefs, so the link must be absolute.
    const { origin } = await getJson(transport, '/__vh/origin')
    if (typeof origin !== 'string' || origin === '') {
      throw new UsageError(
        '拿不到门户地址：请让用户先在 v-harness 页面刷新一次，再重试；或让用户到 VOS → V-Office「我的文档」里打开。',
      )
    }
    return {
      ok: true,
      name,
      url: `${origin}/__vh/office/open?name=${encodeURIComponent(name)}`,
      hint: '把 url 原样放进 markdown 链接给用户（[在线编辑](url)）。点开即进入 Collabora 在线编辑，保存直接写回「我的文档」。',
    }
  }

  if (command === 'upload') {
    const parsed = parseOptions(rest)
    const file = parsed.positionals[0]
    if (!file) throw new UsageError('usage: voffice upload <file> [--name <name>]')
    return { ok: true, ...(await upload(transport, file, parsed.options.name)) }
  }

  if (command === 'rename') {
    const [rawName, rawNext] = parseOptions(rest).positionals
    const name = assertName(rawName)
    const next = assertName(rawNext)
    const payload = JSON.stringify({ name: next })
    const request = open(transport, 'PATCH', `/api/v1/files/${encodeURIComponent(name)}`, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    const response = responded(request)
    request.end(payload)
    const resolved = await response
    await ensureOk(resolved)
    return { ok: true, from: name, to: next, response: await readBody(resolved) }
  }

  if (command === 'delete') {
    const name = assertName(parseOptions(rest).positionals[0])
    const request = open(transport, 'DELETE', `/api/v1/files/${encodeURIComponent(name)}`)
    const response = responded(request)
    request.end()
    const resolved = await response
    await ensureOk(resolved)
    return { ok: true, deleted: name, response: await readBody(resolved) }
  }

  throw new UsageError(`未知命令：${command}`)
}

try {
  const result = await run(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  process.exitCode = 1
}
