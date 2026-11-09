import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_PATH = '/app/com.ictrek.mcphub';
const seen = [];
const hub = createServer((req, res) => {
  seen.push({
    path: req.url,
    method: req.method,
    authorization: req.headers.authorization,
    accept: req.headers.accept,
    session: req.headers['mcp-session-id'],
    protocol: req.headers['mcp-protocol-version'],
  });
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"healthy"}');
    return;
  }
  if (req.url === `${BASE_PATH}/api/integration/discovery`) {
    if (req.headers.authorization === 'Bearer expired-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"success":false}');
      return;
    }
    if (req.headers.authorization !== 'Bearer alice-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"success":false}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: {
        protocol: 'mcp',
        transport: 'streamable-http',
        mcp_path: `${BASE_PATH}/mcp`,
        // The extra fields are what the panel must never see.
        servers: [
          {
            name: 'amap', description: '高德地图', visibility: 'private', status: 'running',
            mcp_path: `${BASE_PATH}/mcp/amap`, url: 'http://amap.internal', command: 'npx', env: { KEY: 'secret' },
          },
          { name: '', description: 'nameless', visibility: 'public', status: 'running' },
          { name: 'shared', description: '', visibility: 'group', status: 'stopped' },
        ],
      },
    }));
    return;
  }
  if (req.url === `${BASE_PATH}/mcp`) {
    req.resume();
    if (req.headers.authorization !== 'Bearer alice-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_token"}');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'mcp-session-id': 'session-42',
      'mcp-protocol-version': '2025-06-18',
    });
    res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n');
    res.end();
    return;
  }
  if (req.url === `${BASE_PATH}/api/servers`) {
    if (req.headers.authorization !== 'Bearer alice-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"success":false}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: [
        {
          name: 'amap',
          status: 'running',
          // The dashboard answer carries the whole configuration; the preview
          // must keep only what a row shows.
          url: 'http://amap.internal',
          env: { KEY: 'secret' },
          tools: [
            { name: 'amap-maps_geo', description: '地理编码', enabled: true },
            { name: 'amap-maps_route', description: '路径规划', enabled: false },
            { name: 'amap-maps_weather', description: '天气', enabled: true, inputSchema: { secret: true } },
          ],
        },
        { name: '', tools: [] },
      ],
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"success":false}');
});
hub.listen(0, '127.0.0.1');
await once(hub, 'listening');
const hubBase = `http://127.0.0.1:${String(hub.address().port)}${BASE_PATH}`;

// A port with nothing behind it stands in for "MCPHub is not installed".
const closed = createServer();
closed.listen(0, '127.0.0.1');
await once(closed, 'listening');
const closedBase = `http://127.0.0.1:${String(closed.address().port)}${BASE_PATH}`;
await new Promise((resolve) => { closed.close(resolve); });

process.env.MCPHUB_URL = hubBase;
// The routing mode and the selection record are deployment state; a host that
// carries either must not decide what this suite asserts.
delete process.env.MCPHUB_ROUTING;
const selectionRoot = await mkdtemp(join(tmpdir(), 'vh-mcphub-'));
process.env.MCPHUB_SELECTION_FILE = join(selectionRoot, 'selection.json');

const { rememberTokens } = await import('./office.mjs');
const {
  handleAgent,
  mcphubEnvironment,
  mcphubLaunchPatch,
  mcphubRouting,
  mcphubSelection,
  mcphubServices,
  mcphubTools,
  saveMcphubSelection,
} = await import('./mcphub.mjs');

// The dsh instance's own view: one capability URL, one key, no VOS token.
const agent = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  void handleAgent(req, res, path.slice('/__vh/mcphub/agent'.length)).catch((error) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(JSON.stringify({ error: error.message }));
  });
});
agent.listen(0, '127.0.0.1');
await once(agent, 'listening');
const agentBase = `http://127.0.0.1:${String(agent.address().port)}/__vh/mcphub/agent`;

after(async () => {
  await Promise.all([
    new Promise((resolve) => { hub.close(resolve); }),
    new Promise((resolve) => { agent.close(resolve); }),
  ]);
  await rm(selectionRoot, { recursive: true, force: true });
});

rememberTokens('alice', { access: 'alice-token', expiresAt: Date.now() + 3_600_000 });
rememberTokens('expired', { access: 'expired-token', expiresAt: Date.now() + 3_600_000 });

const alice = await mcphubEnvironment('alice');

test('a reachable MCPHub mounts the panel and mints one capability', () => {
  assert.equal(alice.VH_MCPHUB, '1');
  assert.equal(alice.VH_MCPHUB_ENDPOINT, `http://127.0.0.1:${String(process.env.PORT ?? 8080)}/__vh/mcphub/agent`);
  assert.match(alice.VH_MCPHUB_KEY ?? '', /^[0-9a-f]{64}$/u);
});

test('discovery keeps its BASE_PATH and carries the tenant token', async () => {
  seen.length = 0;
  const answer = await mcphubServices('alice');
  assert.equal(answer.available, true);
  assert.equal(answer.authorized, true);
  assert.deepEqual(answer.servers, [
    { name: 'amap', description: '高德地图', visibility: 'private', status: 'running' },
    { name: 'shared', description: '', visibility: 'group', status: 'stopped' },
  ]);
  assert.equal(seen.at(-1).path, `${BASE_PATH}/api/integration/discovery`);
  assert.equal(seen.at(-1).authorization, 'Bearer alice-token');
});

test('upstream connection details never reach the answer', async () => {
  const body = JSON.stringify(await mcphubServices('alice'));
  for (const leak of ['http://amap.internal', 'npx', 'secret', 'mcp_path']) {
    assert.equal(body.includes(leak), false, `leaked ${leak}`);
  }
});

test('a tenant without a VOS token is told to sign in, not shown an empty list', async () => {
  const answer = await mcphubServices('nobody');
  assert.deepEqual(answer, { available: true, authorized: false, servers: [] });
});

test('an upstream rejection is a sign-in answer, not a failure', async () => {
  const answer = await mcphubServices('expired');
  assert.deepEqual(answer, { available: true, authorized: false, servers: [] });
});

test('a capability reaches MCP under the tenant token and streams the reply back', async () => {
  seen.length = 0;
  const response = await fetch(`${agentBase}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${alice.VH_MCPHUB_KEY}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), 'session-42');
  assert.equal(response.headers.get('mcp-protocol-version'), '2025-06-18');
  assert.match(await response.text(), /"result":\{"tools":\[\]\}/u);

  const upstream = seen.at(-1);
  assert.equal(upstream.path, `${BASE_PATH}/mcp`);
  assert.equal(upstream.authorization, 'Bearer alice-token');
  // The transport needs both encodings, whichever the client asked for.
  assert.match(upstream.accept ?? '', /text\/event-stream/u);
});

test('the MCP session id travels upstream', async () => {
  seen.length = 0;
  const response = await fetch(`${agentBase}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${alice.VH_MCPHUB_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': 'session-42',
      'mcp-protocol-version': '2025-06-18',
    },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(seen.at(-1).session, 'session-42');
  assert.equal(seen.at(-1).protocol, '2025-06-18');
});

test('an unknown capability key is refused', async () => {
  const response = await fetch(`${agentBase}/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer not-a-key' }, body: '{}',
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'capability-key-required');
});

test('a capability cannot reach the dashboard API', async () => {
  const response = await fetch(`${agentBase}/api/integration/discovery`, {
    headers: { authorization: `Bearer ${alice.VH_MCPHUB_KEY}` },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'route-not-allowed');
});

test('only MCP methods pass', async () => {
  const response = await fetch(`${agentBase}/mcp`, {
    method: 'PUT', headers: { authorization: `Bearer ${alice.VH_MCPHUB_KEY}` },
  });
  assert.equal(response.status, 405);
});

test('a signed-out tenant gets a sign-in answer, not an upstream fault', async () => {
  const nobody = await mcphubEnvironment('nobody');
  const response = await fetch(`${agentBase}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${nobody.VH_MCPHUB_KEY}` }, body: '{}',
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'vos-token-unavailable');
});

test('an upstream rejection is passed through unchanged', async () => {
  const expired = await mcphubEnvironment('expired');
  const response = await fetch(`${agentBase}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${expired.VH_MCPHUB_KEY}` }, body: '{}',
  });
  assert.equal(response.status, 401);
});

test('an absent MCPHub is unavailable, and a miss is reused until it answers', async () => {
  process.env.MCPHUB_URL = closedBase;
  assert.deepEqual(await mcphubServices('alice'), { available: false, authorized: false, servers: [] });
  // The launch path reads the miss the panel just paid for instead of probing again.
  assert.deepEqual(await mcphubEnvironment('alice'), {});

  process.env.MCPHUB_URL = hubBase;
  const recovered = await mcphubServices('alice');
  assert.equal(recovered.available, true);
  assert.equal((await mcphubEnvironment('alice')).VH_MCPHUB, '1');
});

test('the routing mode is a deployment decision that defaults to the aggregate endpoint', async () => {
  assert.equal(mcphubRouting(), 'all');
  assert.equal(alice.VH_MCPHUB_ROUTING, 'all');
  process.env.MCPHUB_ROUTING = 'smart';
  try {
    assert.equal(mcphubRouting(), 'smart');
    assert.equal((await mcphubEnvironment('routing')).VH_MCPHUB_ROUTING, 'smart');
  } finally {
    delete process.env.MCPHUB_ROUTING;
  }
});

test('an unrecognized routing mode falls back to the aggregate endpoint', () => {
  process.env.MCPHUB_ROUTING = 'vector';
  try {
    assert.equal(mcphubRouting(), 'all');
  } finally {
    delete process.env.MCPHUB_ROUTING;
  }
});

test('the tool preview keeps names and descriptions, never configuration', async () => {
  seen.length = 0;
  const answer = await mcphubTools('alice');
  assert.equal(answer.available, true);
  assert.equal(answer.authorized, true);
  assert.deepEqual(answer.servers, [{
    name: 'amap',
    tools: [
      { name: 'amap-maps_geo', description: '地理编码', enabled: true },
      { name: 'amap-maps_route', description: '路径规划', enabled: false },
      { name: 'amap-maps_weather', description: '天气', enabled: true },
    ],
  }]);
  assert.equal(seen.at(-1).path, `${BASE_PATH}/api/servers`);
  assert.equal(seen.at(-1).authorization, 'Bearer alice-token');
  const body = JSON.stringify(answer);
  for (const leak of ['amap.internal', 'secret', 'inputSchema']) {
    assert.equal(body.includes(leak), false, `leaked ${leak}`);
  }
});

test('the preview reports an expired sign-in instead of an empty catalog', async () => {
  assert.deepEqual(await mcphubTools('expired'), { available: true, authorized: false, servers: [] });
  assert.deepEqual(await mcphubTools('nobody'), { available: true, authorized: false, servers: [] });
});

/** The tenant's own view of one launch, shared by the two selection tests. */
const selectionHome = join(selectionRoot, 'home');
const launchOptions = {
  namespace: 'alice',
  home: selectionHome,
  linuxName: String(process.getgid()),
  jailHome: '/home/alice',
  uid: process.getuid(),
};

test('a service choice is recorded per tenant and becomes a launch overlay', async () => {
  assert.equal(await mcphubSelection('alice'), undefined);
  assert.deepEqual(await mcphubLaunchPatch(launchOptions), {});

  // A name that is not a path segment is dropped, and repeats collapse: the
  // overlay quotes these values into YAML.
  assert.deepEqual(await saveMcphubSelection('alice', ['amap', 'shared', '../escape', 'amap']), ['amap', 'shared']);
  assert.deepEqual(await mcphubSelection('alice'), ['amap', 'shared']);
  assert.equal(await mcphubSelection('bob'), undefined);

  const overlay = await mcphubLaunchPatch(launchOptions);
  assert.equal(overlay.patch, '/home/alice/.dsh/profiles/web/mcphub.patch.yml');
  assert.deepEqual(overlay.env, { VH_MCPHUB_SELECT: '1' });

  const text = await readFile(join(selectionHome, '.dsh', 'profiles', 'web', 'mcphub.patch.yml'), 'utf8');
  assert.match(text, /serverName: 'amap'/u);
  assert.match(text, /serverName: 'shared'/u);
  // The capability travels in the environment, never through the file.
  assert.match(text, /process\.env\.VH_MCPHUB_ENDPOINT \+ '\/mcp\/amap'/u);
  assert.equal(text.includes(alice.VH_MCPHUB_KEY ?? ''), false);
});

test('following the aggregate endpoint removes the overlay again', async () => {
  assert.equal(await saveMcphubSelection('alice', undefined), undefined);
  assert.deepEqual(await mcphubLaunchPatch(launchOptions), {});
  await assert.rejects(
    readFile(join(selectionHome, '.dsh', 'profiles', 'web', 'mcphub.patch.yml')),
    /ENOENT/u,
  );
});
