#!/usr/bin/env node
/**
 * WeKnora (HybRAG) knowledge-base CLI for the v-harness agent.
 *
 * The agent never holds a VOS access token. In a v-harness deployment the
 * gateway listens on `$HOME/.dsh/weknora.sock` (0700 directory, 0600 socket,
 * owned by this tenant) and adds the Authorization header itself. WeKnora
 * verifies that token against the same VOS OIDC userinfo endpoint, so no token
 * exchange happens anywhere. The direct HTTP mode exists for local debugging
 * outside the container and is selected only when both `WEKNORA_URL` and
 * `WEKNORA_BEARER_TOKEN` are set.
 *
 * Every command prints one JSON object on stdout and exits 0, or prints an
 * error object on stderr and exits 1.
 *
 *   health                          reachability, identity, visible libraries
 *   search <query> [--kb a,b] [--limit n]
 *                                   retrieval; emits citations for the UI
 *   read <knowledge_id> [--limit n] one document with its chunks in order
 */

import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOCKET_ENV = 'VH_WEKNORA_SOCK';
const REQUEST_TIMEOUT_MS = 120_000;
const SNIPPET_CHARS = 600;

class UsageError extends Error {}

/**
 * Resolve the transport once: a per-tenant Unix socket, or an explicit HTTP
 * base with a bearer token (local debugging only).
 * @returns {{ describe: string, request: (path: string, options: object) => import('node:http').ClientRequest }}
 */
function resolveTransport() {
  const explicitSocket = process.env[SOCKET_ENV];
  const socketPath = explicitSocket ?? join(homedir(), '.dsh', 'weknora.sock');
  if (existsSync(socketPath)) {
    return {
      describe: `socket ${socketPath}`,
      request: (path, options) => httpRequest({ socketPath, path, ...options }),
    };
  }

  const base = process.env.WEKNORA_URL?.replace(/\/+$/, '');
  const token = process.env.WEKNORA_BEARER_TOKEN;
  if (!base || !token) {
    throw new UsageError(
      `知识库能力端点不存在（${socketPath}），也没有 WEKNORA_URL + WEKNORA_BEARER_TOKEN。`
        + '这通常意味着当前会话没有完成 VOS 登录；请在 v-harness 页面重新登录。',
    );
  }
  const url = new URL(base);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return {
    describe: `http ${base}`,
    request: (path, options) => send(
      new URL(`${url.pathname.replace(/\/+$/, '')}${path}`, url.origin),
      { ...options, headers: { ...options.headers, authorization: `Bearer ${token}` } },
    ),
  };
}

/**
 * @param {import('node:http').IncomingMessage} response
 * @returns {Promise<string>}
 */
async function readText(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * @param {string} text
 * @returns {unknown} parsed JSON, or the raw text when the body is not JSON.
 */
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * One request through the resolved transport.
 * @param {{ request: Function, describe: string }} transport
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [init]
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function call(transport, path, init = {}) {
  const payload = init.body === undefined
    ? undefined
    : Buffer.from(JSON.stringify(init.body), 'utf8');
  const headers = { accept: 'application/json' };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.byteLength);
  }

  const response = await new Promise((resolve, reject) => {
    const outgoing = transport.request(path, { method: init.method ?? 'GET', headers });
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => { outgoing.destroy(new Error('知识库请求超时')); });
    outgoing.on('error', reject);
    outgoing.on('response', resolve);
    outgoing.end(payload);
  });

  return { status: response.statusCode ?? 0, body: parse(await readText(response)) };
}

/**
 * @param {unknown} body
 * @returns {unknown[]} the `data` array of a WeKnora list response.
 */
function rows(body) {
  return Array.isArray(body?.data) ? body.data : [];
}

/**
 * @param {unknown} body
 * @returns {string} an upstream message safe to show a user.
 */
function upstreamError(body) {
  if (typeof body === 'string') return body.slice(0, 300);
  return body?.error ?? body?.message ?? JSON.stringify(body ?? {}).slice(0, 300);
}

/**
 * @param {unknown} text
 * @returns {string} at most SNIPPET_CHARS characters, with an explicit marker.
 */
function snippet(text) {
  const value = String(text ?? '');
  return value.length <= SNIPPET_CHARS
    ? value
    : `${value.slice(0, SNIPPET_CHARS)}…[截断，共 ${String(value.length)} 字符]`;
}

/**
 * The citation shape the client renders as a badge; keep it stable.
 * @param {Record<string, any>} chunk
 * @returns {Record<string, unknown>}
 */
function citation(chunk) {
  return {
    chunk_id: chunk.id,
    knowledge_id: chunk.knowledge_id,
    title: chunk.knowledge_title || chunk.knowledge_filename || '',
    chunk_index: chunk.chunk_index,
    score: chunk.score,
    snippet: snippet(chunk.content),
  };
}

/**
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | undefined} the value after `--name`.
 */
function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * Libraries the caller can see. Used as the default scope of a search.
 * @param {{ request: Function, describe: string }} transport
 * @returns {Promise<string[]>}
 */
async function visibleLibraries(transport) {
  const { status, body } = await call(transport, '/api/v1/knowledge-bases');
  if (status !== 200) throw new Error(`无法列出知识库（HTTP ${String(status)}）：${upstreamError(body)}`);
  const ids = rows(body).map((kb) => kb.id).filter(Boolean);
  if (ids.length === 0) throw new Error('当前账号看不到任何知识库，请让管理员分配知识库权限');
  return ids;
}

/**
 * Turn a `--kb` spec into library ids. Ids and names are both accepted because
 * the `@` menu inserts the human-readable name, while the API wants ids.
 * @param {{ request: Function, describe: string }} transport
 * @param {string | undefined} spec - comma-separated ids and/or names.
 * @returns {Promise<string[]>} the ids to search.
 */
async function resolveScope(transport, spec) {
  if (spec === undefined) return visibleLibraries(transport);

  const wanted = spec.split(',').filter(Boolean);
  const { status, body } = await call(transport, '/api/v1/knowledge-bases');
  if (status !== 200) throw new Error(`无法列出知识库（HTTP ${String(status)}）：${upstreamError(body)}`);

  const scope = rows(body)
    .filter((kb) => wanted.includes(kb.id) || wanted.includes(kb.name))
    .map((kb) => kb.id);
  if (scope.length === 0) throw new Error(`没有匹配的知识库：${spec}`);
  return scope;
}

/**
 * @param {{ request: Function, describe: string }} transport
 * @param {string[]} argv
 * @returns {Promise<Record<string, unknown>>}
 */
async function health(transport, argv) {
  const service = await call(transport, '/health');
  const libraries = await call(transport, '/api/v1/knowledge-bases');
  const identity = libraries.status === 200
    ? 'ok'
    : libraries.status === 401 ? 'unauthenticated' : 'failed';

  return {
    endpoint: transport.describe,
    service: { ok: service.status === 200, status: service.status },
    identity,
    knowledge_bases: rows(libraries.body).map((kb) => ({ id: kb.id, name: kb.name })),
    ...(libraries.status === 200 ? {} : { detail: upstreamError(libraries.body) }),
  };
}

/**
 * @param {{ request: Function, describe: string }} transport
 * @param {string[]} argv
 * @returns {Promise<Record<string, unknown>>}
 */
async function search(transport, argv) {
  const query = argv.find((value) => !value.startsWith('--'));
  if (!query) throw new UsageError('用法：search <关键词> [--kb 库ID,库ID] [--limit 5]');

  const limit = Number(option(argv, 'limit') ?? 5);
  const scope = await resolveScope(transport, option(argv, 'kb'));
  const { status, body } = await call(transport, '/api/v1/knowledge-search', {
    method: 'POST',
    body: { query, knowledge_base_ids: scope, match_count: limit },
  });
  if (status !== 200) throw new Error(`检索失败（HTTP ${String(status)}）：${upstreamError(body)}`);

  const citations = rows(body).map(citation);
  return { query, scope, count: citations.length, citations };
}

/**
 * @param {{ request: Function, describe: string }} transport
 * @param {string[]} argv
 * @returns {Promise<Record<string, unknown>>}
 */
async function read(transport, argv) {
  const id = argv.find((value) => !value.startsWith('--'));
  if (!id) throw new UsageError('用法：read <knowledge_id> [--limit 100]');

  // The upstream clamps page_size to 100; going higher would silently lie
  // about coverage, so the limit is capped here instead.
  const limit = Math.min(Number(option(argv, 'limit') ?? 100), 100);
  const document = await call(transport, `/api/v1/knowledge/${id}`);
  if (document.status !== 200) {
    throw new Error(`读取文档失败（HTTP ${String(document.status)}）：${upstreamError(document.body)}`);
  }

  const chunks = await call(transport, `/api/v1/chunks/${id}?page=1&page_size=${String(limit)}`);
  if (chunks.status !== 200) {
    throw new Error(`读取分段失败（HTTP ${String(chunks.status)}）：${upstreamError(chunks.body)}`);
  }

  const ordered = rows(chunks.body)
    .sort((left, right) => (left.chunk_index ?? 0) - (right.chunk_index ?? 0));
  const total = Number(chunks.body?.total ?? ordered.length);

  return {
    knowledge: {
      id: document.body?.data?.id ?? id,
      title: document.body?.data?.title ?? document.body?.data?.file_name ?? '',
    },
    count: ordered.length,
    total,
    truncated: total > ordered.length,
    chunks: ordered.map((chunk) => ({
      chunk_id: chunk.id,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
    })),
  };
}

/** Commands this CLI accepts. */
const COMMANDS = { health, search, read };

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) throw new UsageError(`未知命令 ${String(command)}；可用：${Object.keys(COMMANDS).join(' / ')}`);

  const transport = resolveTransport();
  const result = await run(transport, argv);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exit(1);
});
