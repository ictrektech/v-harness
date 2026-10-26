import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

const seen = [];
const upstream = createServer(async (req, res) => {
  const record = { path: req.url, authorization: req.headers.authorization, accept: req.headers.accept, session: req.headers['mcp-session-id'] };
  seen.push(record);
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    record.body = body;
  }
  if (req.headers.authorization === 'Bearer expired-token') {
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"code":10001,"msg":"VOS session expired"}');
    return;
  }
  if (req.url.startsWith('/storage/mcp')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-42' });
    res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
    res.end();
    return;
  }
  if (req.url.startsWith('/storage/upload')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: 'saved', size: (record.body ?? '').length }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 0, data: { path: req.url } }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
process.env.VH_PHOTOCRAFT_URL = `http://127.0.0.1:${upstream.address().port}/storage`;

const { rememberTokens } = await import('./office.mjs');
const { handlePhotocraft } = await import('./photocraft.mjs');
const gateway = createServer((req, res) => {
  handlePhotocraft('alice', req, res).catch((error) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: error.message }));
  });
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const base = `http://127.0.0.1:${gateway.address().port}`;
after(async () => {
  await Promise.all([
    new Promise((resolve) => gateway.close(resolve)),
    new Promise((resolve) => upstream.close(resolve)),
  ]);
});

rememberTokens('alice', { access: 'alice-token', expiresAt: Date.now() + 3_600_000 });
rememberTokens('expired', { access: 'expired-token', expiresAt: Date.now() + 3_600_000 });

test('the volume list reaches the service under the tenant token', async () => {
  seen.length = 0;
  const response = await fetch(`${base}/volumes`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { code: 0, data: { path: '/storage/volumes' } });
  assert.equal(seen.at(-1).authorization, 'Bearer alice-token');
  assert.equal(seen.at(-1).path, '/storage/volumes');
});

test('an MCP reply streams through with its session id intact', async () => {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('mcp-session-id'), 'session-42');
  assert.match(await response.text(), /"result":\{"ok":true\}/);
  assert.equal(seen.at(-1).path, '/storage/mcp');
});

test('the client session header and body reach the service unchanged', async () => {
  seen.length = 0;
  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'client-session-7' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call' }),
  });
  assert.equal(seen.at(-1).session, 'client-session-7');
  assert.equal(seen.at(-1).body, '{"jsonrpc":"2.0","id":2,"method":"tools/call"}');
  assert.match(seen.at(-1).accept, /text\/event-stream/);
});

test('an upload body is piped through to the service', async () => {
  const body = Buffer.from('fake-image-bytes');
  const response = await fetch(`${base}/upload?adapter=x_1&path=x_1%3A%2F%2F&name=a.png`, { method: 'POST', body });
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.equal(reply.data, 'saved');
  assert.equal(reply.size, body.length);
});

test('paths outside the capability are refused without reaching the service', async () => {
  seen.length = 0;
  for (const [method, path] of [['GET', '/album/session'], ['POST', '/mcp-evil'], ['DELETE', '/volumes']]) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal(seen.length, 0);
});

test('a rejected token is reported as a sign-in problem, not a retry', async () => {
  const server = createServer((req, res) => {
    handlePhotocraft('expired', req, res).catch(() => { res.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const reply = await fetch(`http://127.0.0.1:${server.address().port}/volumes`);
  assert.equal(reply.status, 401);
  assert.equal((await reply.json()).error, 'vos-token-rejected');
  await new Promise((resolve) => server.close(resolve));
});

test('a tenant with no token never reaches the service', async () => {
  const server = createServer((req, res) => {
    handlePhotocraft('nobody', req, res).catch(() => { res.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  seen.length = 0;
  const reply = await fetch(`http://127.0.0.1:${server.address().port}/volumes`);
  assert.equal(reply.status, 401);
  assert.equal((await reply.json()).error, 'vos-token-unavailable');
  assert.equal(seen.length, 0);
  await new Promise((resolve) => server.close(resolve));
});
