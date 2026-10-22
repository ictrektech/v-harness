import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

const seen = [];
const upstream = createServer(async (req, res) => {
  seen.push({ path: req.url, authorization: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/v1/models') {
    const owner = req.headers.authorization === 'Bearer alice-token' ? 'alice' : 'bob';
    res.end(JSON.stringify({ models: [
      { id: 'native', qualified: `private/${owner}`, endpoints: ['chat_completions'] },
      { qualified: 'registered/embed', endpoints: ['embeddings'], capabilities: ['chat'] },
    ] })); return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  seen.at(-1).body = JSON.parse(body);
  if (req.url === '/v1/completions') {
    if (seen.at(-1).body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"id":"fixture","choices":[{"index":0,"text":"hel');
      res.end('lo","finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return;
    }
    res.end(JSON.stringify({ id: 'fixture', choices: [{ index: 0, text: 'hello', finish_reason: 'stop' }] })); return;
  }
  res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
process.env.V_SCHEDULER_URL = `http://127.0.0.1:${upstream.address().port}`;
const { rememberTokens } = await import('./office.mjs');
const { schedulerModels, schedulerEnvironment, handleScheduler } = await import('./scheduler.mjs');
const gateway = createServer((req, res) => {
  handleScheduler(req, res, req.url).catch(error => { res.writeHead(502); res.end(JSON.stringify({ error: error.message, cause: error.cause?.message })); });
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const base = `http://127.0.0.1:${gateway.address().port}`;
after(async () => { await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))]); });

for (const namespace of ['alice', 'bob']) rememberTokens(namespace, { access: `${namespace}-token`, expiresAt: Date.now() + 3600000 });
const alice = schedulerEnvironment('alice').VH_SCHEDULER_KEY;
const bob = schedulerEnvironment('bob').VH_SCHEDULER_KEY;
const request = (path, key, body) => fetch(`${base}${path}`, {
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
});

test('declared endpoints are authoritative; chat, responses, messages and completions are selectable', () => {
  const models = schedulerModels({ models: [
    { qualified: 'a', endpoints: ['/v1/chat/completions'] },
    { qualified: 'b', endpoints: ['responses'] },
    { qualified: 'c', endpoints: ['anthropic_messages'] },
    { qualified: 'd', endpoints: ['completions'] },
    { qualified: 'e', capabilities: ['completion'] },
    { qualified: 'excluded', endpoints: ['embeddings'], capabilities: ['chat'] },
    { qualified: 'audio', endpoints: ['audio/speech'] },
    { qualified: 'kind-chat', kind: 'chat' },
    { qualified: 'kind-embedding', kind: 'embedding' },
    { qualified: 'unknown' },
  ] });
  assert.deepEqual(models.map(row => row.id), ['a', 'b', 'c', 'd', 'e', 'kind-chat']);
  assert.equal(models[3].api, 'text-completions');
  assert.throws(() => schedulerModels({ data: [] }), /Invalid/);
});

test('each capability uses its own VOS identity and qualified model IDs', async () => {
  assert.notEqual(alice, bob);
  const a = await (await request('/v1/models', alice)).json();
  const b = await (await request('/v1/models', bob)).json();
  assert.ok(a.data, JSON.stringify(a));
  assert.deepEqual(a.data.map(row => row.id), ['private/alice']);
  assert.deepEqual(b.data.map(row => row.id), ['private/bob']);
  assert.equal((await request('/api/v1/upstreams', alice, {})).status, 403);
  assert.equal((await request('/v1/models', 'unknown')).status, 401);
  assert.equal((await request('/v1/models', schedulerEnvironment('expired').VH_SCHEDULER_KEY)).status, 401);
  await request('/v1/chat/completions', alice, { model: 'private/alice', messages: [] });
  assert.equal(seen.at(-1).authorization, 'Bearer alice-token');
  assert.equal(seen.at(-1).body.model, 'private/alice');
  await request('/v1/messages?beta=true', alice, { model: 'private/alice', messages: [] });
  assert.equal(seen.at(-1).path, '/v1/messages?beta=true');
});

test('text completion models support chat responses and split SSE frames', async () => {
  const body = { model: 'private/text', messages: [{ role: 'user', content: 'hi' }] };
  const response = await request('/text/v1/chat/completions', alice, body);
  const result = await response.json();
  assert.ok(result.choices, JSON.stringify(result));
  assert.equal(result.choices[0].message.content, 'hello');
  assert.equal(seen.at(-1).path, '/v1/completions');
  assert.match(seen.at(-1).body.prompt, /user: hi\nassistant:/);
  const stream = await (await request('/text/v1/chat/completions', alice, { ...body, stream: true })).text();
  assert.match(stream, /"content":"hello"/);
  assert.match(stream, /data: \[DONE\]/);
});
