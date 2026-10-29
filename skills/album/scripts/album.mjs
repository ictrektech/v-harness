#!/usr/bin/env node
/**
 * AI-album (Immich) CLI for the v-harness agent.
 *
 * Credential model mirrors the voffice CLI: the agent never holds a key. In a
 * v-harness deployment the gateway listens on `$HOME/.dsh/album.sock`, keeps
 * the tenant's VOS token in memory and exchanges it at Immich's
 * `/oauth/vos-exchange`; direct-HTTP mode exists for local debugging only and
 * is selected when `ALBUM_URL` and `ALBUM_API_KEY` are both set.
 *
 * Every command prints one JSON object on stdout and exits 0, or prints an
 * error object on stderr and exits 1.
 *
 *   health                    upstream connectivity
 *   me                        which album account this endpoint serves
 *   search <query> [--size n] [--thumbs n]      CLIP semantic photo search
 *   photos [--city --country --from --to --type image|video --favorite
 *           --album <id> --person <id> --rating 1-5 --size n --thumbs n]
 *                                               metadata / filter search
 *   person <name>             resolve a recognized person
 *   explore                   city / place aggregates
 *   albums                    list albums
 *   album-create <name> [--description d]       create an album
 *   album-add <albumId> <assetId...>            add photos into an album
 *   view <id> [--out <path>]  download the original into the workspace
 *   thumb <id> [--out <path>] [--size thumb|preview|full]
 *                             download a thumbnail into the workspace
 *   upload <file> [--album <id>] [--out]        upload one photo / video
 */

import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

const SOCKET_ENV = 'VH_ALBUM_SOCK'
const REQUEST_TIMEOUT_MS = 120_000
/** Error bodies are diagnostics: keep a sample, never the whole payload. */
const ERROR_BODY_LIMIT = 4_096
/** Result bodies carry the photo list and must be read whole (14 assets ≈ 13 KB). */
const RESULT_BODY_LIMIT = 8 * 1024 * 1024
const THUMB_DIR = process.env.ALBUM_THUMB_DIR ?? 'album-thumbs'
const THUMB_SIZES = new Set(['thumb', 'preview', 'full'])
/**
 * 相册前端的跳转链接路径：拼在 `/search/photos/<id>` 前。
 *
 * 部署的挂载段不一样的用 `ALBUM_FRONTEND_URL` 覆盖；链接本身由网关记着的
 * 门户域名拼成绝对地址（见 portalOrigin），域名不同也不用改配置。
 */
const FRONTEND_PATH = (process.env.ALBUM_FRONTEND_URL ?? '/app/com.ictrek.ai-album').replace(/\/+$/, '')

class UsageError extends Error {}

/**
 * Resolve the transport once: a per-tenant Unix socket, or explicit HTTP with
 * an Immich API key (local debugging only).
 * @returns {{ describe: string, request: (path: string, options: object) => import('node:http').ClientRequest }}
 */
function resolveTransport() {
  const explicitSocket = process.env[SOCKET_ENV]
  const socketPath = explicitSocket ?? join(homedir(), '.dsh', 'album.sock')
  if (explicitSocket || existsSync(socketPath)) {
    if (!existsSync(socketPath)) {
      throw new UsageError(
        `AI 相册能力端点不存在（${socketPath}）。请在 v-harness 页面重新登录后再试。`,
      )
    }
    return {
      describe: `socket ${socketPath}`,
      request: (path, options) => httpRequest({ socketPath, path, ...options }),
    }
  }

  const base = process.env.ALBUM_URL?.replace(/\/+$/, '')
  const key = process.env.ALBUM_API_KEY
  if (!base || !key) {
    throw new UsageError(
      '未接入 AI 相册：既没有本地能力端点，也没有 ALBUM_URL + ALBUM_API_KEY。',
    )
  }
  const url = new URL(base)
  const sendRequest = url.protocol === 'https:' ? httpsRequest : httpRequest
  return {
    describe: `http ${base}`,
    request: (path, options) => {
      const headers = { ...options.headers, 'x-api-key': key }
      return sendRequest(
        new URL(`${url.pathname.replace(/\/+$/, '')}${path}`, url.origin),
        { ...options, headers },
      )
    },
  }
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
 *
 * `limit` exists because the two callers want opposite things: an error body is
 * a diagnostic and may be truncated, while a successful result must be read
 * whole — truncating it turns a valid list into unparsable text.
 * @param {import('node:http').IncomingMessage} response
 * @param {number} [limit] maximum bytes to buffer.
 * @returns {Promise<unknown>}
 */
async function readBody(response, limit = ERROR_BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of response) {
    size += chunk.length
    if (size > limit) break
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
 * Parse one successful body, failing loudly when it is not a JSON document.
 *
 * Silently degrading an unreadable result to `{}` is what made a full album
 * look empty: callers must learn that the answer was lost, not receive a
 * plausible zero.
 * @param {unknown} body - result of {@link readBody}.
 * @returns {Record<string, unknown> | unknown[]} the document, or `{}` when
 *   the endpoint legitimately answered without a body.
 */
function resultObject(body) {
  if (body === undefined) return {}
  if (typeof body === 'string') {
    throw new UsageError(`相册返回了无法解析的响应：${body.slice(0, 200)}`)
  }
  if (Array.isArray(body)) return body
  return typeof body === 'object' && body !== null ? body : {}
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
  else if (body && typeof body === 'object' && 'message' in body) {
    detail = String(body.message).slice(0, 300)
  }
  const missing = typeof body === 'object' && body ? String(body.message ?? '').match(/Missing required permission: (.+)/) : null
  if (missing) {
    return `相册密钥缺少权限 ${missing[1]}：需要平台侧在 ai-album 的 IMMICH_VOS_PERMISSIONS 里放开后重试`
  }
  switch (status) {
    case 401:
      return 'AI 相册登录状态失效：请在 v-harness 页面刷新（F5）后重试'
    case 403:
      return '相册密钥权限不足：需要平台侧调整 IMMICH_VOS_PERMISSIONS'
    case 404:
      return '相册里没有这个文件/人物/相册，先用 search 或 albums 确认'
    case 413:
      return '文件超过相册上传上限'
    case 502:
      return 'AI 相册服务不可达'
    case 503:
      return 'AI 相册服务正在启动，稍等几秒再试'
    default:
      return `AI 相册返回 HTTP ${String(status)}${detail ? `：${detail}` : ''}`
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
    request.destroy(new Error('请求超时（120 秒）'))
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
  const error = new UsageError(explain(status, await readBody(response)))
  error.status = status
  throw error
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
  return resultObject(await readBody(resolved, RESULT_BODY_LIMIT))
}

/**
 * POST one small JSON document.
 * @param {ReturnType<typeof resolveTransport>} transport
 * @param {string} path
 * @param {unknown} payload
 * @returns {Promise<Record<string, unknown>>}
 */
async function postJson(transport, path, payload) {
  const data = JSON.stringify(payload)
  const request = open(transport, 'POST', path, {
    accept: 'application/json',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  })
  const response = responded(request)
  request.end(data)
  const resolved = await response
  await ensureOk(resolved)
  return resultObject(await readBody(resolved, RESULT_BODY_LIMIT))
}

/**
 * Parse `--key value` / `--key=value` options around positional arguments.
 * A flag without a value (`--favorite`, `--refresh`) parses as `''`.
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
    const next = argv[index + 1]
    const value = inline ?? (next !== undefined && !next.startsWith('--') ? next : '')
    options[key] = value
    if (inline === undefined && value !== '') index += 1
  }
  return { positionals, options }
}

/**
 * Shape one Immich asset for the model: stable, compact, present-ready.
 * @param {Record<string, unknown>} asset
 * @returns {Record<string, unknown>}
 */
function shapeAsset(asset) {
  const id = String(asset.id ?? '')
  const exif = (asset.exifInfo ?? {})
  return {
    id,
    filename: asset.originalFileName ?? asset.originalPath?.split('/').pop() ?? '',
    type: asset.type === 'VIDEO' ? 'video' : 'image',
    takenAt: exif.dateTimeOriginal ?? asset.fileCreatedAt ?? '',
    city: exif.city || '',
    favorite: asset.isFavorite === true,
    thumbPath: asset.__thumbPath ?? undefined,
  }
}

/**
 * This tenant's portal origin, as recorded by the gateway for this account
 * (the same endpoint the V-Office editor links use). An empty string when the
 * gateway has not seen a browser request from this account yet.
 * @returns {Promise<string>}
 */
function portalOrigin() {
  const socketPath = process.env.VH_OFFICE_SOCK ?? join(homedir(), '.dsh', 'voffice.sock')
  if (!existsSync(socketPath)) return Promise.resolve('')
  return new Promise((resolve) => {
    const request = httpRequest(
      { socketPath, path: '/__vh/origin', headers: { accept: 'application/json' } },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => {
          try { resolve(String(JSON.parse(body).origin ?? '')) } catch { resolve('') }
        })
        response.on('error', () => resolve(''))
      },
    )
    request.setTimeout(5_000, () => request.destroy(new Error('origin timeout')))
    request.on('error', () => resolve(''))
    request.end()
  })
}

/**
 * Give every asset a clickable album-frontend link.
 *
 * The link must be an absolute URL on the user's own portal: the chat client
 * renders a relative path as a workspace file (clicking it reports "file not
 * found"), while an absolute one opens the album app on the machine the user
 * is actually on. No browser request seen yet → the bare relative path, the
 * best available fallback.
 * @param {Record<string, unknown>[]} assets
 * @returns {Promise<void>}
 */
async function withViewUrls(assets) {
  if (FRONTEND_PATH === '') return
  const origin = await portalOrigin()
  const base = origin !== '' && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(origin)
    ? origin.replace(/\/+$/u, '')
    : ''
  for (const asset of assets) {
    const id = String(asset.id ?? '')
    if (id === '') continue
    asset.viewUrl = `${base}${FRONTEND_PATH}/search/photos/${encodeURIComponent(id)}`
  }
}

/**
 * Download one binary response into the workspace.
 * @param {import('node:http').IncomingMessage} response
 * @param {string} target
 * @returns {Promise<{ path: string, bytes: number }>}
 */
async function downloadTo(response, target) {
  const absolute = resolveInWorkspace(target)
  await mkdir(dirname(absolute), { recursive: true })
  await pipeline(response, createWriteStream(absolute))
  const written = await stat(absolute)
  return { path: absolute, bytes: written.size }
}

/**
 * Fetch one thumbnail for an asset into the workspace thumb directory.
 * @param {ReturnType<typeof resolveTransport>} transport
 * @param {Record<string, unknown>} asset
 * @param {string} size
 * @returns {Promise<Record<string, unknown>>} the asset with thumbPath set.
 */
async function withThumb(transport, asset, size) {
  const id = String(asset.id ?? '')
  if (!id) return asset
  const ext = asset.type === 'video' ? '.jpg' : '.jpg'
  const target = join(THUMB_DIR, `${id}-${size}${ext}`)
  const request = open(transport, 'GET', `/assets/${encodeURIComponent(id)}/thumbnail?size=${encodeURIComponent(size)}`, { accept: 'application/octet-stream' })
  const response = responded(request)
  request.end()
  const resolved = await response
  await ensureOk(resolved)
  const file = await downloadTo(resolved, target)
  return { ...asset, thumbPath: file.path }
}

/**
 * Attach workspace thumbnails to the first few assets so the model can
 * present them right away.
 * @param {ReturnType<typeof resolveTransport>} transport
 * @param {Record<string, unknown>[]} assets
 * @param {number} limit
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function withThumbs(transport, assets, limit) {
  const count = Math.max(0, Math.min(limit, assets.length, 6))
  let failures = 0
  for (const asset of assets.slice(0, count)) {
    try {
      const shaped = await withThumb(transport, asset, 'preview')
      Object.assign(asset, { thumbPath: shaped.thumbPath })
    } catch (error) {
      // 单张缩略图取不到只少一张预览：列表本身仍然有效，失败数如实上报。
      // 整个命令因一张预览失败而报废，比缺一张图糟得多（线上发生过）。
      if (!(error instanceof Error && error.name === 'AbortError')) failures += 1
    }
  }
  return { failures }
}

/**
 * Parse the common search filters shared by `search` and `photos`.
 * @param {Record<string, string>} options
 * @returns {Record<string, unknown>} Immich metadata-search payload fields.
 */
function filtersFrom(options) {
  /** @type {Record<string, unknown>} */
  const payload = {}
  if (options.type) payload.type = options.type === 'video' ? 'VIDEO' : 'IMAGE'
  if (options.city) payload.city = options.city
  if (options.country) payload.country = options.country
  if (options.from) payload.takenAfter = options.from
  if (options.to) payload.takenBefore = options.to
  if (options.rating) payload.rating = Number(options.rating)
  if (options.favorite !== undefined) payload.isFavorite = options.favorite !== 'false'
  if (options.album) payload.albumIds = [options.album]
  if (options.person) payload.personIds = [options.person]
  if (options.size) payload.size = Math.max(1, Math.min(100, Number(options.size) || 25))
  return payload
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
      'usage: album <health|me|search|photos|person|explore|albums|album-create|album-add|view|thumb|upload> ...',
    )
  }
  const transport = resolveTransport()

  if (command === 'health') {
    return { ok: true, health: await getJson(transport, '/server/ping') }
  }

  if (command === 'me') {
    return { ok: true, ...(await getJson(transport, '/users/me')) }
  }

  if (command === 'search' || command === 'photos') {
    const parsed = parseOptions(rest)
    const size = Math.max(1, Math.min(100, Number(parsed.options.size) || 25))
    const thumbs = parsed.options.thumbs === '' || parsed.options.thumbs === undefined
      ? 4
      : Math.max(0, Math.min(6, Number(parsed.options.thumbs) || 0))
    const filters = filtersFrom(parsed.options)
    /** @type {Record<string, unknown>} */
    let payload
    let hint
    if (command === 'search') {
      const query = parsed.positionals[0]
      if (!query) throw new UsageError('usage: album search <描述> [--size n]')
      payload = { query, size, ...(filters.city ? { city: filters.city } : {}), ...filters }
      hint = '用 present 工具展示 thumbPath 对应的缩略图（photo 网格），并交代总数与可继续收窄的条件；用户指着某张说「做成视频/改风格」时交给 image-studio skill。'
    } else {
      payload = { ...filters, size }
      hint = '同一套展示方式；提醒用户还可以加时间/地点/人物/相册条件继续收窄。'
    }
    const endpoint = command === 'search' ? '/search/smart' : '/search/metadata'
    const body = await postJson(transport, endpoint, payload)
    const assets = Array.isArray(body.assets?.items)
      ? body.assets.items
      : Array.isArray(body.assets) ? body.assets : []
    const list = assets.map(shapeAsset)
    await withViewUrls(list)
    const { failures } = await withThumbs(transport, list, thumbs)
    const result = { ok: true, total: list.length, assets: list, hint }
    if (failures > 0) result.thumbFailures = failures
    return result
  }

  if (command === 'person') {
    const name = parseOptions(rest).positionals[0]
    if (!name) throw new UsageError('usage: album person <名字>')
    const body = await getJson(transport, `/search/person?name=${encodeURIComponent(name)}`)
    const people = Array.isArray(body.people) ? body.people : []
    return {
      ok: true,
      total: people.length,
      people: people.map((p) => ({ id: p.id, name: p.name, assets: p.assetCount ?? 0 })),
      hint: '拿 person id 传给 photos --person <id> 列出这个人的照片。',
    }
  }

  if (command === 'explore') {
    const body = await getJson(transport, '/search/explore')
    return { ok: true, explore: body, hint: '按城市/地点聚合浏览；用 photos --city <城市> 深入。' }
  }

  if (command === 'albums') {
    const body = await getJson(transport, '/albums')
    const list = Array.isArray(body) ? body : []
    return {
      ok: true,
      total: list.length,
      albums: list.map((a) => ({ id: a.id, name: a.albumName, assets: a.assetCount ?? 0, description: a.description ?? '' })),
      hint: 'album-add <相册id> <照片id...> 可以把照片加进相册；相册只是分组，不影响原图。',
    }
  }

  if (command === 'album-create') {
    const parsed = parseOptions(rest)
    const name = parsed.positionals[0]
    if (!name) throw new UsageError('usage: album album-create <名称> [--description d]')
    const body = await postJson(transport, '/albums', { albumName: name, description: parsed.options.description ?? '' })
    return { ok: true, id: body.id, name: body.albumName, hint: '相册建好了；用 album-add 把照片加进去。' }
  }

  if (command === 'album-add') {
    const parsed = parseOptions(rest)
    const [albumId, ...assetIds] = parsed.positionals
    if (!albumId || assetIds.length === 0) throw new UsageError('usage: album album-add <相册id> <照片id...>')
    const body = await postJson(transport, `/albums/${encodeURIComponent(albumId)}/assets`, { ids: assetIds })
    const added = Array.isArray(body.album?.assets) ? body.album.assets.length : assetIds.length
    return { ok: true, added, hint: '已加入相册；照片文件位置不变。' }
  }

  if (command === 'view' || command === 'thumb') {
    const parsed = parseOptions(rest)
    const id = parsed.positionals[0]
    if (!id) throw new UsageError(`usage: album ${command} <id> [--out <路径>]`)
    if (command === 'view') {
      const request = open(transport, 'GET', `/assets/${encodeURIComponent(id)}/original`, { accept: 'application/octet-stream' })
      const response = responded(request)
      request.end()
      const resolved = await response
      await ensureOk(resolved)
      const out = parsed.options.out ?? id
      const file = await downloadTo(resolved, out)
      return {
        ok: true,
        id,
        ...file,
        hint: '原图已下载到 workspace。交给 image-studio skill 加工（风格化/视频），生成结果用 album upload 存回相册。',
      }
    }
    const size = THUMB_SIZES.has(parsed.options.size ?? '') ? parsed.options.size : 'preview'
    const request = open(transport, 'GET', `/assets/${encodeURIComponent(id)}/thumbnail?size=${encodeURIComponent(size)}`, { accept: 'application/octet-stream' })
    const response = responded(request)
    request.end()
    const resolved = await response
    await ensureOk(resolved)
    const out = parsed.options.out ?? join(THUMB_DIR, `${id}-${size}.jpg`)
    const file = await downloadTo(resolved, out)
    return { ok: true, id, ...file, hint: '用 present 展示这张缩略图。' }
  }

  if (command === 'upload') {
    const parsed = parseOptions(rest)
    const file = parsed.positionals[0]
    if (!file) throw new UsageError('usage: album upload <文件> [--album <相册id>]')
    const source = resolve(process.cwd(), file)
    const stats = await stat(source).catch(() => undefined)
    if (!stats?.isFile()) throw new UsageError(`文件不存在：${file}`)
    const data = Buffer.from(await import('node:fs/promises').then((m) => m.readFile(source)))
    const checksum = createHash('sha1').update(data).digest('base64')
    const boundary = '----vh-album-' + createHash('sha1').update(source + String(stats.size)).digest('hex')
    const name = basename(source)
    const parts = []
    const field = (partName, value) => {
      parts.push(
        Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${partName}"\r\n\r\n${value}\r\n`),
      )
    }
    field('deviceAssetId', `vh-${checksum.slice(0, 16)}`)
    field('deviceId', 'v-harness')
    field('fileCreatedAt', stats.mtime.toISOString())
    field('fileModifiedAt', stats.mtime.toISOString())
    field('fileSize', String(stats.size))
    parts.push(
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="assetData"; filename="${name}"\r\ncontent-type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    )
    const body = Buffer.concat(parts)
    const request = open(transport, 'POST', '/assets', {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': body.length,
      accept: 'application/json',
    })
    const response = responded(request)
    request.end(body)
    const resolved = await response
    await ensureOk(resolved)
    const payload = await readBody(resolved, RESULT_BODY_LIMIT)
    const id = Array.isArray(payload) ? payload[0]?.id : payload?.id
    const duplicated = Array.isArray(payload) ? payload[0]?.duplicate : payload?.duplicate
    const result = { ok: true, id, duplicate: duplicated === true, name, size: stats.size }
    if (parsed.options.album) {
      await postJson(transport, `/albums/${encodeURIComponent(parsed.options.album)}/assets`, { ids: [id] })
      result.album = parsed.options.album
    }
    result.hint = '已存入相册（SHA-1 去重，字节相同不会重复入库）；原图语义上不受影响。'
    return result
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
