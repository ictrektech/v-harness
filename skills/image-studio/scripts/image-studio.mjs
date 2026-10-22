#!/usr/bin/env node
// Image Studio CLI: one-shot generation, job polling, output download, and model preparation.
// Zero dependencies; requests go through the global fetch implementation of the host Node runtime.

import { createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const DEFAULT_BASE_URL = 'http://image-studio-backend:5000'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_WAIT_TIMEOUT_SECONDS = 1800
const DEFAULT_INTERVAL_SECONDS = 3
const DOWNLOAD_TIMEOUT_MS = 600_000

const GENERATE_FIELDS = new Set([
  'prompt', 'negative_prompt', 'model_key', 'model_variant',
  'init_job_id', 'init_filename', 'init_input_id',
  'width', 'height', 'steps', 'cfg_scale', 'strength', 'sampler', 'seed', 'batch_count',
  'scheduler', 'clip_skip', 'guidance', 'img_cfg_scale', 'eta', 'flow_shift',
  'high_noise_steps', 'high_noise_cfg_scale', 'high_noise_sampler',
  'slg_scale', 'skip_layer_start', 'skip_layer_end',
  'rng', 'sampler_rng', 'prediction', 'weight_type', 'tensor_type_rules',
  'cache_mode', 'cache_option', 'qwen_image_layers',
  'hires', 'hires_scale', 'hires_width', 'hires_height', 'hires_steps', 'hires_denoising_strength',
  'video_frames', 'fps',
  'vae_tiling', 'vae_tile_size', 'vae_tile_overlap', 'temporal_tiling',
  'temporal_tile_frames', 'temporal_tile_overlap', 'max_vram',
  'stream_layers', 'auto_fit', 'clip_on_cpu', 'offload_to_cpu', 'vae_cpu_fallback',
  'backend', 'params_backend',
])

const NUMBER_FIELDS = new Set([
  'width', 'height', 'steps', 'cfg_scale', 'strength', 'seed', 'batch_count',
  'clip_skip', 'guidance', 'img_cfg_scale', 'eta', 'flow_shift',
  'high_noise_steps', 'high_noise_cfg_scale', 'slg_scale', 'skip_layer_start', 'skip_layer_end',
  'qwen_image_layers', 'hires_scale', 'hires_width', 'hires_height', 'hires_steps',
  'hires_denoising_strength', 'video_frames', 'fps', 'vae_tile_overlap',
  'temporal_tile_frames', 'temporal_tile_overlap', 'max_vram',
])

const BOOLEAN_FIELDS = new Set([
  'hires', 'vae_tiling', 'temporal_tiling', 'stream_layers', 'auto_fit',
  'clip_on_cpu', 'offload_to_cpu', 'vae_cpu_fallback',
])

const USAGE = `Image Studio CLI

Usage:
  image-studio.mjs [global options] <command> [options]

Global options:
  --base-url <url>          Backend or VOS gateway prefix (env IMAGE_STUDIO_BASE_URL)
  --auth-file <path>        JSON file with { "baseUrl"?: string, "token"?: string }
  --token-file <path>       File whose trimmed content is the bearer token
  --request-timeout-ms <n>  Per-request HTTP timeout (default ${DEFAULT_REQUEST_TIMEOUT_MS})

Commands:
  health | about | me
  models [--capability txt2img,img2img,edit,video] [--ready] [--all]
  model <key> [--variant <id>]
  pull <key> [--variant <id>] [--force]
  stop <key> [--variant <id>]
  sync <key>
  upload-input <file>
  generate --prompt <text> [options] [--wait] [--out <dir>]
  wait <job_id> [--interval <s>] [--timeout <s>] [--download] [--out <dir>]
  status <job_id>
  jobs [--limit <n>] [--all]
  download <job_id> [--out <dir>] [--filename <name>]
  cancel <job_id>

Every command prints JSON to stdout. Failures exit non-zero and explain the reason on stderr.`

class CliError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

function parseArgs(argv) {
  const positional = []
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals > 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && (!next.startsWith('--') || /^-\d/u.test(next))) {
      flags.set(body, next)
      index += 1
      continue
    }
    flags.set(body, true)
  }
  return { positional, flags }
}

function readAuthFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new CliError(`cannot read auth file ${path}: ${error.message}`)
  }
}

function resolveConnection(flags) {
  const authFile = stringFlag(flags, 'auth-file')
    ?? process.env.IMAGE_STUDIO_AUTH_FILE
    ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dsh', 'image-studio.json')
  const auth = readAuthFile(authFile)
  const baseUrl = (stringFlag(flags, 'base-url')
    ?? process.env.IMAGE_STUDIO_BASE_URL
    ?? (typeof auth.baseUrl === 'string' ? auth.baseUrl : undefined)
    ?? DEFAULT_BASE_URL).replace(/\/+$/u, '')
  const tokenFile = stringFlag(flags, 'token-file')
  const token = tokenFile !== undefined
    ? readFileSync(tokenFile, 'utf8').trim()
    : (typeof auth.token === 'string' && auth.token ? auth.token : (process.env.IMAGE_STUDIO_AUTH ?? ''))
  const requestTimeoutMs = numberFlag(flags, 'request-timeout-ms') ?? DEFAULT_REQUEST_TIMEOUT_MS
  return { baseUrl, token, authFile, requestTimeoutMs }
}

function stringFlag(flags, name) {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function numberFlag(flags, name) {
  const value = stringFlag(flags, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new CliError(`--${name} expects a number, got ${value}`)
  return parsed
}

function boolFlag(flags, name) {
  const value = flags.get(name)
  if (value === undefined) return undefined
  if (value === true) return true
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new CliError(`--${name} expects true or false, got ${value}`)
}

function flagList(flags, name) {
  const values = []
  for (const [key, value] of flags) {
    if (key !== name) continue
    if (typeof value !== 'string') continue
    values.push(...value.split(',').map(item => item.trim()).filter(Boolean))
  }
  return values
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, undefined, 2)}\n`)
}

function sleep(ms) {
  return new Promise(done => setTimeout(done, ms))
}

async function request(connection, path, options = {}) {
  const { method = 'GET', body, headers = {}, query } = options
  const url = new URL(`${connection.baseUrl}${path}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
  }
  const requestHeaders = { accept: 'application/json', ...headers }
  if (connection.token) requestHeaders.authorization = `Bearer ${connection.token}`
  const response = await fetch(url, {
    method, headers: requestHeaders, body,
    signal: AbortSignal.timeout(connection.requestTimeoutMs),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new CliError(`${method} ${url.pathname} -> ${response.status}${errorDetail(text)}`, response.status)
  }
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new CliError(`${method} ${url.pathname} returned non-JSON content`)
  }
}

function errorDetail(text) {
  if (!text) return ''
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed.detail === 'string') return `: ${parsed.detail}`
    if (parsed.detail !== undefined) return `: ${JSON.stringify(parsed.detail)}`
  } catch {
    // Non-JSON bodies fall through to the trimmed text.
  }
  return `: ${text.trim().slice(0, 500)}`
}

function summarizeModel(model) {
  const variants = Array.isArray(model.variants) ? model.variants : []
  return {
    key: model.key,
    name: model.name,
    family: model.family,
    capabilities: model.capabilities,
    status: model.status,
    params: model.params,
    size: model.size,
    progress: model.progress,
    downloaded_bytes: model.downloaded_bytes,
    total_bytes: model.total_bytes,
    error: model.error,
    // The service's own per-model defaults (size, steps, sampler). The form
    // pre-fills them so the dialog opens on real values instead of blanks the
    // user has to guess at.
    runtime: model.runtime,
    variants: variants.map(variant => ({
      id: variant.id, name: variant.name, status: variant.status,
      size: variant.size, progress: variant.progress,
    })),
  }
}

function summarizeJob(job, detailed) {
  const summary = {
    job_id: job.job_id,
    status: job.status,
    progress: job.progress,
    model_key: job.model_key,
    model_variant: job.model_variant,
    prompt: job.prompt,
    width: job.width,
    height: job.height,
    seed: job.seed,
    outputs: job.outputs,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
  }
  if (!detailed) return summary
  return {
    ...summary,
    negative_prompt: job.negative_prompt,
    steps: job.steps,
    cfg_scale: job.cfg_scale,
    sampler: job.sampler,
    batch_count: job.batch_count,
    strength: job.strength,
    video_frames: job.video_frames,
    fps: job.fps,
    scheduler: job.scheduler,
    clip_skip: job.clip_skip,
    guidance: job.guidance,
    metadata: job.metadata,
    immich_uploads: job.immich_uploads,
  }
}

function buildGeneratePayload(flags) {
  const payload = {}
  for (const [flag, value] of flags) {
    const negative = flag.startsWith('no-')
    const key = (negative ? flag.slice(3) : flag).replaceAll('-', '_')
    if (!GENERATE_FIELDS.has(key)) continue
    if (negative) {
      if (!BOOLEAN_FIELDS.has(key)) throw new CliError(`--${flag} is not a boolean option`)
      payload[key] = false
      continue
    }
    if (BOOLEAN_FIELDS.has(key)) {
      payload[key] = value === true ? true : boolFlag(flags, flag)
    } else if (NUMBER_FIELDS.has(key)) {
      if (typeof value !== 'string') throw new CliError(`--${flag} expects a number`)
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new CliError(`--${flag} expects a number, got ${value}`)
      payload[key] = parsed
    } else {
      if (value === true) throw new CliError(`--${flag} expects a value`)
      payload[key] = value
    }
  }
  if (typeof payload.prompt !== 'string' || payload.prompt.length === 0) {
    throw new CliError('generate requires --prompt')
  }
  return payload
}

function mimeType(path) {
  const suffix = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (suffix === '.jpg' || suffix === '.jpeg') return 'image/jpeg'
  if (suffix === '.webp') return 'image/webp'
  return 'image/png'
}

async function uploadInput(connection, path) {
  const absolute = resolve(path)
  const data = readFileSync(absolute)
  const form = new FormData()
  form.append('file', new Blob([data], { type: mimeType(absolute) }), basename(absolute))
  return request(connection, '/api/v1/inputs', { method: 'POST', body: form })
}

async function waitForJob(connection, jobId, options) {
  const intervalMs = (options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000
  const timeoutMs = (options.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000
  const deadline = Date.now() + timeoutMs
  let lastProgress
  for (;;) {
    const job = await request(connection, `/api/v1/jobs/${encodeURIComponent(jobId)}`)
    if (job.status === 'succeeded' || job.status === 'failed') return job
    lastProgress = job.progress
    if (Date.now() >= deadline) {
      throw new CliError(`timed out waiting for ${jobId} (status ${job.status}, progress ${lastProgress ?? 0})`)
    }
    await sleep(intervalMs)
  }
}

async function downloadOutputs(connection, job, outDir, only) {
  const names = (job.outputs ?? []).map(name => basename(name))
  const selected = only === undefined ? names : names.filter(name => name === basename(only))
  if (selected.length === 0) throw new CliError(`job ${job.job_id} has no matching output`)
  const directory = resolve(outDir ?? join('image-studio-output', job.job_id))
  mkdirSync(directory, { recursive: true })
  const files = []
  for (const name of selected) {
    const url = new URL(`${connection.baseUrl}/api/v1/outputs/${encodeURIComponent(job.job_id)}/${encodeURIComponent(name)}`)
    const headers = connection.token ? { authorization: `Bearer ${connection.token}` } : {}
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) {
      throw new CliError(`GET ${url.pathname} -> ${response.status}${errorDetail(await response.text())}`, response.status)
    }
    const target = join(directory, name)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
    files.push({ filename: name, path: target, bytes: statSync(target).size })
  }
  return { job_id: job.job_id, directory, files }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  if (flags.has('help') || positional.length === 0 || positional[0] === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const [command, ...rest] = positional
  const connection = resolveConnection(flags)

  switch (command) {
    case 'health':
      return print(await request(connection, '/health'))
    case 'about':
      return print(await request(connection, '/api/v1/about'))
    case 'me':
      return print(await request(connection, '/api/v1/me'))
    case 'models': {
      const models = await request(connection, '/api/v1/models')
      const capabilities = flagList(flags, 'capability')
      const readyOnly = flags.has('ready')
      const filtered = (Array.isArray(models) ? models : []).filter((model) => {
        if (readyOnly && model.status !== 'ready') return false
        return capabilities.every(capability => (model.capabilities ?? []).includes(capability))
      })
      return print({ count: filtered.length, models: filtered.map(summarizeModel) })
    }
    case 'model': {
      const key = requireArgument(rest[0], 'model key')
      const variant = stringFlag(flags, 'variant')
      const model = await request(connection, `/api/v1/models/${encodeURIComponent(key)}`, { query: { variant } })
      return print(summarizeModel(model))
    }
    case 'pull': {
      const key = requireArgument(rest[0], 'model key')
      const variant = stringFlag(flags, 'variant')
      const force = boolFlag(flags, 'force')
      const model = await request(connection, `/api/v1/models/${encodeURIComponent(key)}/pull`, {
        method: 'POST', query: { variant, force: force === undefined ? undefined : String(force) },
      })
      return print(summarizeModel(model))
    }
    case 'stop': {
      const key = requireArgument(rest[0], 'model key')
      const variant = stringFlag(flags, 'variant')
      const model = await request(connection, `/api/v1/models/${encodeURIComponent(key)}/stop`, {
        method: 'POST', query: { variant },
      })
      return print(summarizeModel(model))
    }
    case 'sync': {
      const key = requireArgument(rest[0], 'model key')
      return print(await request(connection, `/api/v1/models/${encodeURIComponent(key)}/sync`, { method: 'POST' }))
    }
    case 'upload-input': {
      const path = requireArgument(rest[0], 'reference image path')
      return print(await uploadInput(connection, path))
    }
    case 'generate': {
      const payload = buildGeneratePayload(flags)
      const input = stringFlag(flags, 'input')
      if (input !== undefined) {
        const uploaded = await uploadInput(connection, input)
        payload.init_input_id = uploaded.input_id
      }
      const job = await request(connection, '/api/v1/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      })
      if (!flags.has('wait')) return print(summarizeJob(job, false))
      const finished = await waitForJob(connection, job.job_id, {
        intervalSeconds: numberFlag(flags, 'interval'),
        timeoutSeconds: numberFlag(flags, 'timeout'),
      })
      if (finished.status !== 'succeeded') {
        print(summarizeJob(finished, true))
        throw new CliError(`generation ${finished.job_id} failed: ${finished.error || 'unknown error'}`)
      }
      const downloaded = await downloadOutputs(connection, finished, stringFlag(flags, 'out'))
      return print({ ...summarizeJob(finished, false), directory: downloaded.directory, files: downloaded.files })
    }
    case 'wait': {
      const jobId = requireArgument(rest[0], 'job id')
      const job = await waitForJob(connection, jobId, {
        intervalSeconds: numberFlag(flags, 'interval'),
        timeoutSeconds: numberFlag(flags, 'timeout'),
      })
      if (job.status !== 'succeeded') {
        print(summarizeJob(job, true))
        throw new CliError(`generation ${job.job_id} failed: ${job.error || 'unknown error'}`)
      }
      if (!flags.has('download') && stringFlag(flags, 'out') === undefined) return print(summarizeJob(job, false))
      const downloaded = await downloadOutputs(connection, job, stringFlag(flags, 'out'))
      return print({ ...summarizeJob(job, false), directory: downloaded.directory, files: downloaded.files })
    }
    case 'status': {
      const jobId = requireArgument(rest[0], 'job id')
      return print(summarizeJob(await request(connection, `/api/v1/jobs/${encodeURIComponent(jobId)}`), true))
    }
    case 'jobs': {
      const jobs = await request(connection, '/api/v1/jobs')
      const all = Array.isArray(jobs) ? jobs : []
      const limit = numberFlag(flags, 'limit') ?? (flags.has('all') ? all.length : 20)
      const sorted = [...all].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      return print({ count: all.length, jobs: sorted.slice(0, limit).map(job => summarizeJob(job, false)) })
    }
    case 'download': {
      const jobId = requireArgument(rest[0], 'job id')
      const job = await request(connection, `/api/v1/jobs/${encodeURIComponent(jobId)}`)
      return print(await downloadOutputs(connection, job, stringFlag(flags, 'out'), stringFlag(flags, 'filename')))
    }
    case 'cancel': {
      const jobId = requireArgument(rest[0], 'job id')
      return print(await request(connection, `/api/v1/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }))
    }
    default:
      throw new CliError(`unknown command: ${command}\n\n${USAGE}`)
  }
}

function requireArgument(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new CliError(`missing ${label}`)
  return value
}

main().catch((error) => {
  if (error instanceof CliError) {
    process.stderr.write(`image-studio: ${error.message}\n`)
  } else {
    process.stderr.write(`image-studio: ${error?.message ?? String(error)}\n`)
  }
  process.exitCode = 1
})
