/** Tenant-scoped inference proxy. VOS bearer tokens remain in the gateway. */
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { accessTokenFor } from './office.mjs';

const ORIGIN = process.env.V_SCHEDULER_URL ?? 'http://v-scheduler:8080';
const keys = new Map();

/** Create one inference-only capability for a tenant process. */
export function schedulerEnvironment(namespace) {
  let key = keys.get(namespace);
  if (!key) { key = randomBytes(32).toString('hex'); keys.set(namespace, key); }
  return {
    VH_SCHEDULER_URL: `http://127.0.0.1:${process.env.PORT ?? 8080}/__vh/scheduler`,
    VH_SCHEDULER_KEY: key,
  };
}

const normalized = value => String(value).trim().toLowerCase().replace(/^\/?(?:v1\/)?/, '').replaceAll('-', '_');

/** Select a supported wire API from declared endpoints, then capabilities. */
export function schedulerModels(payload) {
  if (!payload || !Array.isArray(payload.models)) throw new Error('Invalid V-Scheduler model catalog');
  return payload.models.flatMap(row => {
    const endpoints = (row.endpoints ?? []).map(normalized);
    const capabilities = (row.capabilities ?? []).map(normalized);
    let api;
    if (endpoints.some(e => ['chat', 'chat/completions', 'chat_completions'].includes(e))) api = 'openai-completions';
    else if (endpoints.some(e => ['responses', 'response'].includes(e))) api = 'openai-responses';
    else if (endpoints.some(e => ['messages', 'message', 'anthropic_messages', 'anthropic/messages'].includes(e))) api = 'anthropic-messages';
    else if (endpoints.some(e => ['completions', 'completion'].includes(e))) api = 'text-completions';
    else if (!endpoints.length && (capabilities.some(c => ['chat', 'completion', 'completions', 'generate', 'generation', 'tools', 'thinking'].includes(c))
      || !capabilities.length && ['chat', 'completion', 'completions'].includes(normalized(row.kind)))) api = 'openai-completions';
    // An upstream-routed model of undeclared kind is still a chat model: the
    // scheduler answers it through its upstream, so inference works even
    // though neither endpoints nor capabilities say anything usable.
    else if (!endpoints.length && !capabilities.length && normalized(row.kind) === 'unknown' && row.upstream_id) api = 'openai-completions';
    const id = row.qualified ?? row.id;
    if (!api || typeof id !== 'string' || !id) return [];
    return [{ id, name: row.name ?? id, api, input: capabilities.includes('vision') ? ['text', 'image'] : ['text'] }];
  });
}

/** Fetch only models visible to this VOS user; management credentials are never used. */
async function catalog(token) {
  const response = await fetch(`${ORIGIN}/api/v1/models`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`V-Scheduler model discovery: HTTP ${response.status}`);
  return schedulerModels(await response.json());
}

/** Authenticate a process capability and forward only model discovery and inference. */
export async function handleScheduler(req, res, path) {
  const target = new URL(path, 'http://localhost');
  path = target.pathname;
  const key = req.headers.authorization?.replace(/^Bearer /, '') ?? req.headers['x-api-key'];
  const namespace = [...keys].find(([, value]) => value === key)?.[0];
  const reply = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  if (!namespace) return reply(401, { error: { message: 'Invalid inference capability' } });
  const token = await accessTokenFor(namespace);
  if (!token) return reply(401, { error: { message: 'VOS session expired; refresh v-harness' } });
  if (req.method === 'GET' && path === '/v1/models') return reply(200, { data: await catalog(token) });
  if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/responses', '/v1/messages', '/text/v1/chat/completions'].includes(path)) {
    return reply(403, { error: { message: 'Inference route not allowed' } });
  }
  if (path === '/text/v1/chat/completions') return forwardTextCompletion(req, res, token);
  const abort = new AbortController();
  res.once('close', () => abort.abort());
  const response = await fetch(`${ORIGIN}${path}${target.search}`, {
    method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(req.headers['anthropic-version'] ? { 'anthropic-version': req.headers['anthropic-version'] } : {}),
      ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}),
    }, body: req, duplex: 'half', signal: abort.signal,
  });
  res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
  if (response.body) await pipeline(Readable.fromWeb(response.body), res);
  else res.end();
}

/** Adapt text-only completion models to the chat transport; tools remain unsupported. */
async function forwardTextCompletion(req, res, token) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const prompt = body.messages.map(message => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}\n`).join('') + 'assistant:';
  const abort = new AbortController();
  res.once('close', () => abort.abort());
  const response = await fetch(`${ORIGIN}/v1/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: body.model, prompt, stream: body.stream, max_tokens: body.max_tokens ?? body.max_completion_tokens, temperature: body.temperature, top_p: body.top_p, stop: body.stop }),
    signal: abort.signal,
  });
  if (!response.ok) {
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(await response.text()); return;
  }
  const convert = (value, stream) => ({ ...value, object: stream ? 'chat.completion.chunk' : 'chat.completion', choices: value.choices.map(choice => ({
    index: choice.index, finish_reason: choice.finish_reason,
    [stream ? 'delta' : 'message']: { role: 'assistant', content: choice.text ?? '' },
  })) });
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(convert(await response.json(), false))); return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    let split;
    while ((split = pending.indexOf('\n\n')) !== -1) {
      const event = pending.slice(0, split); pending = pending.slice(split + 2);
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (!data) continue;
      res.write(`data: ${data === '[DONE]' ? data : JSON.stringify(convert(JSON.parse(data), true))}\n\n`);
    }
  }
  res.end();
}
