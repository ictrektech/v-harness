/** Tenant-scoped inference proxy. VOS bearer tokens remain in the gateway. */
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GATEWAY_IP } from './addressing.mjs';
import { accessTokenFor } from './vos-token-store.mjs';

const ORIGIN = process.env.V_SCHEDULER_URL ?? 'http://v-scheduler:8080';
const VOICE_ORIGIN = process.env.V_VOICE_URL ?? 'http://v-voice-backend:7070';
const keys = new Map();

/**
 * Create one inference-only capability for a tenant process.
 *
 * The URL names the gateway as the tenant sees it. Tenants share the container
 * network, so that is the same loopback the gateway binds (see
 * `addressing.mjs`).
 */
export function schedulerEnvironment(namespace) {
  let key = keys.get(namespace);
  if (!key) { key = randomBytes(32).toString('hex'); keys.set(namespace, key); }
  return {
    VH_SCHEDULER_URL: `http://${GATEWAY_IP}:${process.env.PORT ?? 8080}/__vh/scheduler`,
    VH_SCHEDULER_KEY: key,
  };
}

/**
 * Reinstall the key a surviving dsh process already carries in its env.
 *
 * A running process cannot be given a new variable, so a fresh gateway must
 * recover the old one instead of minting a replacement.
 * @param {string} namespace
 * @param {string} key
 * @returns {void}
 */
export function restoreSchedulerKey(namespace, key) {
  if (typeof key !== 'string' || key === '') return;
  keys.set(namespace, key);
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
    // ModelInfer's DeepSeek V4 chat route accepts the OpenAI effort field.
    // A generic thinking flag alone does not identify a provider's wire format.
    const hasEffort = api === 'openai-completions' && capabilities.includes('thinking')
      && typeof row.upstream_id === 'string' && row.upstream_id.startsWith('registered-modelinfer-')
      && /^deepseek-v4(?:\.\d+)?-(?:flash|pro)(?:-|$)/i.test(String(row.id).split('/').at(-1));
    return [{
      id, name: row.name ?? id, api, input: capabilities.includes('vision') ? ['text', 'image'] : ['text'],
      ...(hasEffort ? { reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' } } : {}),
    }];
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
  if (req.method === 'GET' && path === '/v1/audio/models') {
    const response = await fetch(`${ORIGIN}/api/v1/models`, {headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
    if (!response.ok) return reply(response.status, {error:{message:'V-Scheduler voice discovery failed'}});
    const payload = await response.json();
    const data = (payload.models ?? []).filter(row => typeof row.id === 'string' && row.upstream_id === 'app-v-voice'
      && Array.isArray(row.endpoints) && row.endpoints.some(endpoint => normalized(endpoint) === 'audio/transcriptions'))
      .map(row => ({id:row.qualified ?? row.id,name:row.name ?? row.id}));
    return reply(200,{data});
  }
  if (req.method === 'GET' && path === '/v1/audio/placements') {
    const response = await fetch(`${VOICE_ORIGIN}/api/v1/compute/placements`, {headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
    // Older V-Voice installations still support automatic Scheduler recognition.
    if (response.status === 404) return reply(200,{items:[]});
    if (!response.ok) return reply(response.status,{error:{message:'V-Voice compute discovery failed'}});
    const payload = await response.json();
    const items = (payload.items ?? []).filter(row => row.task_type === 'voice.transcribe'
      && ['deployment_id','executor_id','node_id','model_id'].every(key => typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 256))
      .map(({deployment_id,executor_id,node_id,model_id})=>({deployment_id,executor_id,node_id,model_id}));
    return reply(200,{items});
  }
  if (req.method === 'POST' && ['/v1/audio/transcriptions','/v1/audio/compute/transcriptions'].includes(path)) {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data;')) return reply(415,{error:{message:'Use multipart/form-data for speech'}});
    const abort = new AbortController();
    res.once('close',()=>abort.abort());
    const url = path === '/v1/audio/transcriptions' ? `${ORIGIN}${path}` : `${VOICE_ORIGIN}/api/v1/compute/transcriptions`;
    const response = await fetch(url, {method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':contentType},body:req,duplex:'half',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(120000)])});
    res.writeHead(response.status,{'content-type':response.headers.get('content-type') ?? 'application/json','cache-control':'no-store'});
    if(response.body)await pipeline(Readable.fromWeb(response.body),res);else res.end();
    return;
  }

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
