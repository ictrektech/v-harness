import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVosOps, OPS_PATH, OpsError } from './vos-ops.mjs';

const appId = 'com.ictrek.demo';
const containerId = 'a'.repeat(64);
const imageId = 'sha256:' + 'b'.repeat(64);
const project = 'vos-app-com-ictrek-demo-01m79733shjks958r2h96tead4';
const container = {
  Id: containerId, Names: ['/' + project + '-demo-1'], Image: 'demo:1.0', ImageID: 'sha256:' + 'c'.repeat(64),
  State: 'exited', Ports: [], Labels: {
    'io.vos.platform.managed': 'true', 'io.vos.platform.kind': 'app', 'com.docker.compose.project': project,
    'com.docker.compose.service': 'demo', 'com.docker.compose.container-number': '1',
    'com.docker.compose.project.config_files': '/data/vos/apps/com.ictrek.demo/1.0/rendered/docker-compose.yml',
  },
};

function fixture() {
  const state = { admin: true, sessionAllowed: true, sid: 'a', installedVersion: '2.0', now: 1, containers: [{ ...container }], images: [
    { Id: imageId, RepoTags: [], RepoDigests: [], Created: 1, Size: 100 },
  ], calls: [], logData: Buffer.from('sample log'),
    inspect: { State: { Status: 'exited' }, RestartCount: 0 },
    nodeViews: [], managed: { can_manage: true, items: [] }, backends: [],
    deployments: [], schedulerDown: false, schedulerForbidden: false, schedulerCalls: [],
    inferenceDown: false, inferenceForbidden: false, inferenceCalls: [],
    inferenceBodies: [], probes: [], probeResult: null };
  const handle = createVosOps({
    sessionFor: () => ({ sid: state.sid, subject: 'test' }), tokenFor: () => 'test',
    agentSessionAllowed: async (_subject, id) => id === 'session-1' && state.sessionAllowed,
    sessionExists: async (_subject, id) => ['session-1', 'session-2'].includes(id),
    browserSessionActive: sid => sid === state.sid,
    userinfoUrl: () => 'http://example.test', readBody: async req => req.body, now: () => state.now, audit: () => {},
    respond: (res, status, body) => Object.assign(res, { status, body }),
    async platform(_token, path, body) {
      if (path === '/v1000/rbac/permission/my') return { is_super_admin: state.admin };
      if (path === '/v1000/app/list') return { total: 1, data: [{
        app_id: appId, installed_app_id: 'installation', version: state.installedVersion, state: 'installed',
      }] };
      state.calls.push([path, body]);
      return { task_id: 'task' };
    },
    async scheduler(token, path, body) {
      state.schedulerCalls.push([path, body]);
      if (state.schedulerForbidden) throw new OpsError(403, 'scheduler-forbidden');
      if (state.schedulerDown) throw new OpsError(502, 'scheduler-unavailable');
      if (path === '/scheduler/api/v1/nodes') return state.nodeViews;
      if (path === '/scheduler/api/v1/managed-nodes') return state.managed;
      if (path === '/scheduler/api/v1/backend-deployments') return { items: state.backends };
      const change = /^\/scheduler\/api\/v1\/backend-deployments\/([^/]+)\/(start|stop)$/.exec(path);
      if (change) {
        const row = state.backends.find(item => item.id === change[1]);
        if (!row) throw new Error('missing backend');
        row.state = change[2] === 'start' ? 'pending' : 'stopping';
        row.last_error = null;
        return row;
      }
      const node = /^\/scheduler\/api\/v1\/nodes\/([^/]+)\/(drain|revoke)$/.exec(path);
      if (node) {
        const row = state.nodeViews.find(item => item.id === decodeURIComponent(node[1]));
        if (!row) throw new OpsError(404, 'not-found');
        if (node[2] === 'drain') {
          row.draining = body?.draining === true;
          return { draining: row.draining };
        }
        row.managed = false;
        return { node_id: row.id, state: 'revoked' };
      }
      const rescan = /^\/scheduler\/api\/v1\/managed-nodes\/([^/]+)\/rescan$/.exec(path);
      if (rescan) {
        const row = state.managed.items.find(item => item.id === decodeURIComponent(rescan[1]));
        if (!row) throw new OpsError(404, 'not-found');
        return { ...row, status: 'online' };
      }
      throw new Error(`unexpected scheduler path ${path}`);
    },
    async inference(_token, path, body) {
      state.inferenceCalls.push(path);
      state.inferenceBodies.push([path, body]);
      if (state.inferenceForbidden) throw new OpsError(403, 'scheduler-forbidden');
      if (state.inferenceDown) throw new OpsError(502, 'scheduler-unavailable');
      if (path.startsWith('/deployments?')) {
        return { data: state.deployments, total: state.deployments.length,
          page_num: 1, page_size: 100, pages: 1 };
      }
      const change = /^\/deployments\/([^/]+)\/(start|stop)$/.exec(path);
      if (change) {
        const row = state.deployments.find(item => item.id === change[1]);
        if (!row) throw new Error('missing deployment');
        row.state = change[2] === 'start' ? 'running' : 'stopped';
        row.last_error = '';
        return row;
      }
      throw new Error(`unexpected inference path ${path}`);
    },
    async probe(port) {
      state.probes.push(port);
      return state.probeResult ?? { ok: true, status: 200, ms: 2, error: null };
    },
    daemon: async path => path.startsWith('/containers/') ? state.containers : state.images,
    async daemonCall(method, path) {
      state.calls.push([method, path]);
      if (path.endsWith('/json')) return Buffer.from(JSON.stringify(state.inspect));
      const logs = /\/containers\/([0-9a-f]{64})\/logs\?/.exec(path);
      if (logs) return state.logsById?.[logs[1]] ?? state.logData;
      return Buffer.alloc(0);
    },
  });
  return { state, async send(path, body, grant, headers = {}, agent) {
    const res = {};
    await handle({ method: body ? 'POST' : 'GET', body, headers: {
      'x-vh-ops': '1', 'x-vh-ops-grant': grant, ...headers,
    } }, res, new URL(OPS_PATH + path, 'http://example.test'), agent);
    return res;
  } };
}

test('requires administrator, same-origin requests and a grant bound to the session', async () => {
  const { send, state } = fixture();
  state.admin = false;
  assert.equal((await send('/authorize', {})).status, 403);
  state.admin = true;
  assert.equal((await send('/authorize', {}, undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await send('/inventory')).status, 403);
  const { body: { grant } } = await send('/authorize', {});
  assert.equal((await send('/inventory', null, grant)).body.containers[0].cleanup, true);
  state.sid = 'b';
  assert.equal((await send('/inventory', null, grant)).status, 403);
  state.sid = 'a';
  state.admin = false;
  assert.equal((await send('/inventory', null, grant)).status, 403);
});

test('binds execution to an exact target, rechecks state and consumes confirmation', async () => {
  const { send, state } = fixture();
  const { body: { grant } } = await send('/authorize', {});
  const prepare = () => send('/preview', { action: 'remove-container', id: containerId }, grant);
  const execute = (confirmation, targetId = containerId) => send('/execute', { confirmation, targetId }, grant);
  const { body: { confirmation } } = await prepare();
  assert.equal((await execute(confirmation, imageId)).status, 400);
  state.containers[0].State = 'running';
  assert.equal((await execute(confirmation)).status, 409);
  assert.deepEqual(state.calls, []);
  state.containers[0].State = 'exited';
  const retry = await prepare();
  assert.equal((await execute(retry.body.confirmation)).status, 200);
  assert.equal((await execute(retry.body.confirmation)).status, 409);
  assert.deepEqual(state.calls, [['DELETE', `/containers/${containerId}?force=0&v=0`]]);
});

test('refuses non-platform logs and protects referenced or changed images', async () => {
  const { send, state } = fixture();
  const { body: { grant } } = await send('/authorize', {});
  const logs = () => send('/logs?id=' + containerId, null, grant);
  assert.equal((await logs()).body.text, 'sample log');
  state.containers[0].Names = ['/vh-account-unrelated'];
  assert.equal((await logs()).status, 404);
  const prepare = () => send('/preview', { action: 'remove-image', id: imageId }, grant);
  state.containers[0].ImageID = imageId;
  assert.equal((await prepare()).status, 409);
  state.containers[0].ImageID = container.ImageID;
  state.images[0].RepoTags = ['demo:latest'];
  const tagged = await prepare();
  assert.equal(tagged.status, 200);
  assert.deepEqual(tagged.body.target.tags, ['demo:latest']);
  const execute = confirmation => send('/execute', { confirmation, targetId: imageId }, grant);
  state.images[0].RepoTags = ['demo:latest', 'demo:backup'];
  assert.equal((await execute(tagged.body.confirmation)).status, 409);
  assert.ok(state.calls.every(([method]) => method !== 'DELETE'));
  state.images[0].RepoTags = ['demo:latest'];
  const confirmed = await prepare();
  assert.equal((await execute(confirmed.body.confirmation)).status, 200);
  assert.deepEqual(state.calls.at(-1), ['DELETE', `/images/${imageId}?force=0&noprune=1`]);
  state.images[0].RepoTags = [];
  const { body: { confirmation } } = await prepare();
  state.now += 60001;
  assert.equal((await send('/execute', { confirmation, targetId: imageId }, grant)).status, 409);
});

test('uses the VOS restart workflow and can explicitly close the grant', async () => {
  const { send, state } = fixture();
  const { body: { grant } } = await send('/authorize', {});
  const { body: { confirmation } } = await send('/preview', { action: 'restart', id: appId }, grant);
  assert.equal((await send('/execute', { confirmation, targetId: appId }, grant)).body.taskId, 'task');
  assert.deepEqual(state.calls, [['/v1000/app/restart_async', { app_id: appId }]]);
  assert.equal((await send('/close', {}, grant)).status, 200);
  assert.equal((await send('/inventory', null, grant)).status, 403);
});

test('Full access diagnoses directly and only a browser may confirm its specific proposal', async () => {
  const { send, state } = fixture();
  const agent = { session: { subject: 'test' }, sessionId: 'session-1' };
  const read = (as = agent) => send('/inventory', null, undefined, {}, as);
  assert.equal((await read()).status, 200);
  assert.equal((await read({ ...agent, sessionId: 'session-2' })).status, 403);
  state.admin = false;
  assert.equal((await read()).status, 403);
  state.admin = true;
  const propose = () => send('/proposal', { action: 'restart', id: appId }, undefined, {}, agent);
  assert.deepEqual(await propose(), { status: 200,
    body: { action: 'restart', id: appId, pending: true, executed: false, expiresIn: 120 } });
  assert.deepEqual(await propose(), { status: 409,
    body: { error: 'confirmation-pending', action: 'restart', id: appId, expiresIn: 120 } });
  assert.deepEqual(await send('/status?id=' + containerId, null, undefined, {}, agent),
    { status: 400, body: { error: 'app-id-required' } });
  assert.deepEqual(state.calls, []);
  const suffix = '?sessionId=session-1';
  const preview = (await send('/proposal' + suffix)).body.proposal;
  const body = { confirmation: preview.confirmation, targetId: appId, approved: true };
  assert.equal((await send('/confirm-proposal' + suffix, body, undefined, {}, agent)).status, 403);
  assert.equal((await send('/confirm-proposal' + suffix, { ...body, targetId: 'wrong' })).status, 400);
  assert.equal((await send('/confirm-proposal' + suffix, body)).body.taskId, 'task');
  assert.deepEqual(await send('/confirm-proposal' + suffix, body),
    { status: 409, body: { error: 'confirmation-unavailable' } });
  assert.deepEqual(state.calls, [['/v1000/app/restart_async', { app_id: appId }]]);
  state.sessionAllowed = false;
  assert.equal((await read()).status, 403);
});


test('stops an exact retired running container only after browser confirmation', async () => {
  const { send, state } = fixture();
  const agent = { session: { subject: 'test' }, sessionId: 'session-1' };
  const query = '?sessionId=session-1';
  const propose = () => send('/proposal', { action: 'stop-container', id: containerId }, undefined, {}, agent);
  const confirm = async () => {
    const { body: { proposal } } = await send('/proposal' + query);
    return send('/confirm-proposal' + query, {
      confirmation: proposal.confirmation, targetId: containerId, approved: true,
    });
  };
  assert.equal((await propose()).status, 409);
  state.containers[0].State = 'running';
  assert.equal((await propose()).status, 200);
  assert.deepEqual(state.calls, []);
  state.installedVersion = '1.0';
  assert.equal((await confirm()).status, 409);
  assert.deepEqual(state.calls, []);
  state.installedVersion = '2.0';
  assert.equal((await propose()).status, 200);
  state.containers[0].State = 'restarting';
  assert.equal((await confirm()).status, 200);
  assert.deepEqual(state.calls, [['POST', `/containers/${containerId}/stop?t=30`]]);
});


test('host mode requires an administrator and browser opt-in for one conversation', async () => {
  const { send, state } = fixture();
  const agent = { session: { subject: 'test' }, sessionId: 'session-1' };
  const query = '?sessionId=session-1';
  const enable = () => send('/host-mode' + query, { enabled: true });
  const list = (as = agent) => send('/host-containers', null, undefined, {}, as);
  state.sessionAllowed = false;
  assert.equal((await list()).status, 403);
  state.admin = false;
  assert.equal((await enable()).status, 403);
  state.admin = true;
  assert.equal((await send('/host-mode', { enabled: true }, undefined, {}, agent)).status, 403);
  assert.equal((await enable()).body.enabled, true);
  assert.equal((await list()).body.containers[0].name, project + '-demo-1');
  assert.equal((await list({ ...agent, sessionId: 'session-2' })).status, 403);
  const propose = () => send('/proposal', { action: 'host-start', id: containerId }, undefined, {}, agent);
  assert.equal((await propose()).body.executed, false);
  assert.deepEqual(state.calls, []);
  const { body: { proposal } } = await send('/proposal' + query);
  state.sid = 'different-login';
  const confirm = () => send('/confirm-proposal' + query, {
    approved: true, targetId: containerId, confirmation: proposal.confirmation,
  });
  assert.equal((await confirm()).status, 403);
  state.sid = 'a';
  assert.equal((await confirm()).status, 200);
  assert.deepEqual(state.calls, [['POST', `/containers/${containerId}/start`]]);
  state.admin = false;
  assert.equal((await list()).status, 403);
  state.admin = true;
  assert.equal((await send('/host-mode' + query, { enabled: false })).body.enabled, false);
  assert.equal((await list()).status, 403);
  assert.equal((await enable()).body.enabled, true);
  state.now += 30 * 60 * 1000;
  assert.equal((await list()).status, 403);
});


test('host management reaches only VOS application containers', async () => {
  const { send, state } = fixture();
  const agent = { session: { subject: 'test' }, sessionId: 'session-1' };
  const harnessProject = 'vos-app-com-ictrek-v-harness-01m79733shjks958r2h96tead4';
  const database = { ...container, Id: 'e'.repeat(64), State: 'running', Image: 'postgres:16',
    Names: ['/vos-db-01m79733shjks958r2h96tead4-postgres-1'], Labels: {
      'io.vos.platform.managed': 'true', 'io.vos.platform.kind': 'db',
      'com.docker.compose.project': 'vos-db-01m79733shjks958r2h96tead4',
    } };
  const model = { ...container, Id: '9'.repeat(64), State: 'running', Image: 'vllm:latest',
    Names: ['/model-server'], Labels: { 'io.vos.platform.managed': 'true', 'io.vos.platform.kind': 'model' } };
  const harness = { ...container, Id: 'f'.repeat(64), State: 'running', Image: 'vh:1',
    Names: ['/' + harnessProject + '-gateway-1'], Labels: {
      'io.vos.platform.managed': 'true', 'io.vos.platform.kind': 'app',
      'com.docker.compose.project': harnessProject, 'com.docker.compose.service': 'gateway',
      'com.docker.compose.container-number': '1',
      'com.docker.compose.project.config_files': '/data/vos/apps/com.ictrek.v-harness/1.0/rendered/docker-compose.yml',
    } };
  state.containers.push(database, model, harness);
  assert.equal((await send('/host-mode?sessionId=session-1', { enabled: true })).body.enabled, true);
  const hidden = [database.Id, model.Id, harness.Id];
  const listed = await send('/host-containers', null, undefined, {}, agent);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.containers.map(c => c.id), [containerId]);
  for (const id of hidden) {
    assert.equal((await send('/host-logs?id=' + id, null, undefined, {}, agent)).status, 404);
    assert.equal((await send('/proposal', { action: 'host-stop', id }, undefined, {}, agent)).status, 409);
    assert.equal((await send('/proposal', { action: 'host-remove', ids: [id] }, undefined, {}, agent)).status, 409);
  }
  assert.deepEqual(state.calls, []);
});

test('the composer lists only authorized VOS application containers', async () => {
  const { send, state } = fixture();
  const query = '?sessionId=session-1';
  state.sessionAllowed = false;
  assert.equal((await send('/containers' + query)).status, 403);
  state.sessionAllowed = true;
  state.containers.push({ Id: 'e'.repeat(64), Names: ['/mariadb'], State: 'running', Image: 'mariadb:11', Labels: {} });
  const listed = await send('/containers' + query);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.containers.map(c => c.id), [containerId]);
  const [only] = listed.body.containers;
  assert.equal(only.name, project + '-demo-1');
  assert.equal(only.appId, appId);
  assert.equal(only.version, '1.0');
  assert.equal(only.state, 'exited');
  assert.equal((await send('/containers?sessionId=bad id')).status, 403);
  const agent = { session: { subject: 'test' }, sessionId: 'session-1' };
  assert.equal((await send('/containers', null, undefined, {}, agent)).status, 403);
});

test('one cleanup confirmation covers exited and created containers and rejects a changed batch', async () => {
  const { send, state } = fixture();
  const secondId = 'd'.repeat(64);
  state.containers.push({ ...container, Id: secondId, State: 'created' });
  const ids = [containerId, secondId];
  const agent = { session: { subject: 'test' }, sessionId: 'session-1' };
  const query = '?sessionId=session-1';
  const propose = () => send('/proposal', { action: 'remove-container', ids }, undefined, {}, agent);
  const confirmation = async () => (await send('/proposal' + query)).body.proposal;
  const confirm = (p, targetIds = ids) => send('/confirm-proposal' + query, {
    approved: true, confirmation: p.confirmation, targetIds,
  });

  assert.equal((await propose()).status, 200);
  assert.equal((await propose()).status, 409);
  const first = await confirmation();
  assert.deepEqual(first.targetIds, ids);
  assert.equal(first.targets.length, 2);
  assert.equal((await confirm(first, [containerId])).status, 400);
  assert.deepEqual(state.calls, []);
  state.containers[1].State = 'running';
  assert.equal((await confirm(first)).status, 409);
  assert.deepEqual(state.calls, []);

  state.containers[1].State = 'created';
  assert.equal((await propose()).status, 200);
  const skipped = await confirmation();
  assert.equal((await send('/confirm-proposal' + query, {
    approved: false, confirmation: skipped.confirmation,
  })).body.cancelled, true);
  assert.deepEqual(state.calls, []);

  assert.equal((await propose()).status, 200);
  const last = await confirmation();
  assert.deepEqual((await confirm(last)).body.results, ids.map(id => ({ id, removed: true })));
  assert.deepEqual(state.calls, ids.map(id => ['DELETE', `/containers/${id}?force=0&v=0`]));
  assert.equal((await confirm(last)).status, 409);
});

// Docker multiplexed frames: [stream, 0, 0, 0, length BE32] + payload.
const frame = (stream, text) => {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
};
const t1 = '2026-01-01T00:00:01.000000000Z';
const t2 = '2026-01-01T00:00:02.000000000Z';
const t3 = '2026-01-01T00:00:03.000000000Z';
const t4 = '2026-01-01T00:00:04.000000000Z';
const t5 = '2026-01-01T00:00:05.000000000Z';

test('logs support gateway-side time, pattern and context filtering', async () => {
  const { send, state } = fixture();
  const { body: { grant } } = await send('/authorize', {});
  const logs = query => send('/logs?id=' + containerId + query, null, grant);
  state.logData = Buffer.concat([
    frame(1, `${t1} service started\n`),
    frame(1, `${t2} ERROR: db timeout\n`),
    frame(2, `${t3} panic: stack line A\nline B\n`),
  ]);
  const windowed = await logs('&since=' + encodeURIComponent(t2));
  assert.equal(windowed.status, 200);
  assert.equal(windowed.body.scanned, 3);
  assert.equal(windowed.body.returned, 2);
  assert.equal(windowed.body.first, t2);
  assert.equal(windowed.body.last, t3);
  assert.equal(windowed.body.text.includes('service started'), false);
  assert.match(state.calls.at(-1)[1], /tail=1000/);
  assert.match(state.calls.at(-1)[1], /since=/);
  const relative = await logs('&since=30m');
  assert.equal(relative.body.returned, 3);
  // Mocked now=1 minus 30m, floored to epoch seconds with one second of slack.
  assert.match(state.calls.at(-1)[1], /since=-1801\b/);
  const matched = await logs('&pattern=timeout');
  assert.equal(matched.body.returned, 1);
  assert.match(matched.body.text, /ERROR: db timeout/);
  assert.equal(matched.body.text.includes('service started'), false);
  const nearby = await logs('&pattern=line B&context=1');
  assert.equal(nearby.body.returned, 2);
  assert.match(nearby.body.text, /ERROR: db timeout/);
  assert.match(nearby.body.text, /panic: stack line A\nline B/);
  assert.deepEqual(await logs('&pattern='), { status: 400, body: { error: 'invalid-pattern' } });
  assert.deepEqual(await logs('&pattern=%28%5Bp'), { status: 400, body: { error: 'invalid-pattern' } });
  assert.deepEqual(await logs('&context=99'), { status: 400, body: { error: 'invalid-context' } });
  assert.deepEqual(await logs('&since=nonsense'), { status: 400, body: { error: 'invalid-since' } });
  assert.deepEqual(await logs('&until=nonsense'), { status: 400, body: { error: 'invalid-until' } });
  assert.equal((await logs('&since=' + encodeURIComponent(t3) + '&until=' + encodeURIComponent(t1))).status, 400);
  state.logData = Buffer.concat(Array.from({ length: 350 }, (_, i) =>
    frame(1, `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000000000Z line ${i}\n`)));
  const capped = await logs('');
  assert.equal(capped.body.returned, 300);
  assert.equal(capped.body.truncated, true);
  assert.ok(capped.body.text.includes('line 0'));
  assert.equal(capped.body.text.includes('line 349'), false);
});

test('polling with the after cursor returns only new records and a next cursor', async () => {
  const { send, state } = fixture();
  const { body: { grant } } = await send('/authorize', {});
  const logs = query => send('/logs?id=' + containerId + query, null, grant);
  state.logData = Buffer.concat([
    frame(1, `${t1} service started\n`),
    frame(1, `${t2} all good\n`),
    frame(2, `${t3} ready\n`),
  ]);
  const first = await logs('');
  assert.equal(first.body.next, t3);
  assert.equal(first.body.returned, 3);
  // Docker's since is inclusive at the boundary, so the poll replays the
  // cursor stamp and the gateway must drop it by padded stamp comparison.
  state.logData = Buffer.concat([
    frame(1, `${t3} ready\n`),
    frame(1, `${t4} panic: boom\n`),
    frame(1, `${t5} recovered\n`),
  ]);
  const incremental = await logs('&after=' + encodeURIComponent(t3));
  assert.equal(incremental.status, 200);
  assert.equal(incremental.body.returned, 2);
  assert.equal(incremental.body.first, t4);
  assert.equal(incremental.body.next, t5);
  assert.equal(incremental.body.text.includes('ready'), false);
  assert.ok(state.calls.at(-1)[1].includes('since=' + (Math.floor(Date.parse(t3) / 1000) - 1)));
  assert.match(state.calls.at(-1)[1], /tail=1000/);
  state.logData = Buffer.concat([frame(1, `${t5} recovered\n`)]);
  const quiet = await logs('&after=' + encodeURIComponent(t5));
  assert.equal(quiet.body.returned, 0);
  assert.equal(quiet.body.next, t5);
  assert.equal(quiet.body.first, null);
  assert.deepEqual(await logs('&after=nonsense'), { status: 400, body: { error: 'invalid-after' } });
  assert.deepEqual(await logs('&after=2026-01-01T00%3A00%3A01%2B08%3A00'), { status: 400, body: { error: 'invalid-after' } });
  assert.equal((await logs('&after=' + encodeURIComponent(t1) + '&since=' + encodeURIComponent(t1))).status, 400);
  assert.equal((await logs('&after=' + encodeURIComponent(t2) + '&until=' + encodeURIComponent(t1))).status, 400);
  // Trailing-zero trims compare correctly across RFC3339Nano forms.
  state.logData = Buffer.concat([
    frame(1, '2026-01-01T00:00:01.5Z first half\n'),
    frame(1, '2026-01-01T00:00:01.500000001Z just after\n'),
  ]);
  const subNano = await logs('&after=2026-01-01T00%3A00%3A01.5Z');
  assert.equal(subNano.body.returned, 1);
  assert.match(subNano.body.text, /just after/);
});

test('app-logs merges one application stack into an interleaved labeled timeline', async () => {
  const { send, state } = fixture();
  const { body: { grant } } = await send('/authorize', {});
  const apiId = 'e'.repeat(64);
  const apiContainer = { ...container, Id: apiId, State: 'running',
    Names: ['/' + project + '-api-1'], Labels: { ...container.Labels, 'com.docker.compose.service': 'api' } };
  state.containers.push(apiContainer);
  state.logsById = {
    [containerId]: Buffer.concat([
      frame(1, `${t1} db started\n`),
      frame(2, `${t3} db ready\n`),
    ]),
    [apiId]: Buffer.concat([
      frame(1, `${t2} ERROR: connect refused\n`),
      frame(1, `${t4} connected\n`),
    ]),
  };
  const merged = await send('/app-logs?appId=' + encodeURIComponent(appId), null, grant);
  assert.equal(merged.status, 200);
  assert.equal(merged.body.appId, appId);
  assert.deepEqual(merged.body.containers, [project + '-demo-1', project + '-api-1']);
  assert.equal(merged.body.returned, 4);
  assert.equal(merged.body.scanned, 4);
  assert.equal(merged.body.first, t1);
  assert.equal(merged.body.last, t4);
  assert.equal(merged.body.next, t4);
  assert.equal(merged.body.text, [
    `${t1} [${project}-demo-1] db started`,
    `${t2} [${project}-api-1] ERROR: connect refused`,
    `${t3} [${project}-demo-1] db ready`,
    `${t4} [${project}-api-1] connected`,
  ].join('\n'));
  state.logsById[apiId] = Buffer.concat([
    frame(1, `${t3} connected\n`),
    frame(1, `${t4} serving\n`),
  ]);
  const incremental = await send('/app-logs?appId=' + encodeURIComponent(appId) + '&after=' + encodeURIComponent(t2), null, grant);
  assert.equal(incremental.body.returned, 3);
  assert.equal(incremental.body.first, t3);
  assert.equal(incremental.body.text, [
    `${t3} [${project}-demo-1] db ready`,
    `${t3} [${project}-api-1] connected`,
    `${t4} [${project}-api-1] serving`,
  ].join('\n'));
  assert.equal((await send('/app-logs?appId=com.ictrek.other', null, grant)).status, 404);
  assert.deepEqual(await send('/app-logs?appId=bad%20id', null, grant), { status: 400, body: { error: 'invalid-target' } });
  assert.deepEqual(await send('/app-logs?appId=' + encodeURIComponent(appId) + '&after=nonsense', null, grant),
    { status: 400, body: { error: 'invalid-after' } });
  const agent = { session: { subject: 'test' }, sessionId: 'session-1' };
  const agentRead = await send('/app-logs?appId=' + encodeURIComponent(appId), null, undefined, {}, agent);
  assert.equal(agentRead.status, 200);
  assert.equal(agentRead.body.returned, 4);
});

test('diagnose answers inspect facts and collapsed error summary for a visible container', async () => {
  const { send, state } = fixture();
  const { body: { grant } } = await send('/authorize', {});
  state.inspect = {
    State: { Status: 'exited', Running: false, Restarting: false, OOMKilled: true, ExitCode: 137, Error: '',
      StartedAt: '2026-01-01T00:00:00Z', FinishedAt: '2026-01-01T00:05:00Z',
      Health: { Status: 'unhealthy', FailingStreak: 4, Log: [{ Start: t1, End: t1, ExitCode: 1, Output: 'connection refused\n' }] } },
    RestartCount: 3,
  };
  state.logData = Buffer.concat([
    frame(1, `${t1} ERROR: db timeout\n`),
    frame(1, `${t1} ERROR: db timeout\n`),
    frame(1, `${t2} all good\n`),
  ]);
  const report = await send('/diagnose?id=' + containerId, null, grant);
  assert.equal(report.status, 200);
  assert.equal(report.body.state.oomKilled, true);
  assert.equal(report.body.state.exitCode, 137);
  assert.equal(report.body.state.restartCount, 3);
  assert.equal(report.body.state.health.status, 'unhealthy');
  assert.deepEqual(report.body.state.health.recent, [{ start: t1, end: t1, exitCode: 1, output: 'connection refused' }]);
  assert.equal(report.body.logs.scanned, 3);
  assert.equal(report.body.logs.first, t1);
  assert.deepEqual(report.body.logs.errors, [{ count: 2, first: t1, last: t1, sample: 'ERROR: db timeout' }]);
  assert.equal(report.body.stack.appId, appId);
  state.containers[0].Names = ['/vh-account-unrelated'];
  assert.equal((await send('/diagnose?id=' + containerId, null, grant)).status, 404);
  state.containers[0].Names = container.Names;
  const agent = { session: { subject: 'test' }, sessionId: 'session-1' };
  assert.equal((await send('/diagnose?id=' + containerId, null, undefined, {}, agent)).status, 200);
  assert.equal((await send('/diagnose?id=bad', null, undefined, {}, agent)).status, 400);
});

test('host diagnose follows host-mode authorization and stays agent-only', async () => {
  const { send, state } = fixture();
  const agent = { session: { subject: 'test' }, sessionId: 'session-1' };
  assert.equal((await send('/host-diagnose?id=' + containerId, null, undefined, {}, agent)).status, 403);
  assert.equal((await send('/host-diagnose?id=' + containerId)).status, 403);
  await send('/host-mode?sessionId=session-1', { enabled: true });
  const report = await send('/host-diagnose?id=' + containerId, null, undefined, {}, agent);
  assert.equal(report.status, 200);
  assert.equal(report.body.id, containerId);
  assert.equal((await send('/host-diagnose?id=' + 'e'.repeat(64), null, undefined, {}, agent)).status, 404);
  state.admin = false;
  assert.equal((await send('/host-diagnose?id=' + containerId, null, undefined, {}, agent)).status, 403);
});

const at = ms => new Date(ms).toISOString();

function nodeViews(state) {
  return [
    { id: 'local', display_name: 'here', heartbeat: at(state.now - 1000), health_state: 'ready',
      managed: true, management_enabled: true, draining: false,
      capacities: { cpu_millicores: 1000, memory_mib: 2048, gpu_slots: 1, gpu_memory_mib: 4096 },
      vos_applications: { data: [{ app_id: appId, installed_app_id: 'i1', version: '9.9', state: 'installed' }],
        observed_at: at(state.now - 1000), fresh: true },
      vos_metrics: { data: { hostname: 'here', cpu_logical_count: 8, cpu_used_percent: 12,
        memory_total_mib: 100, memory_used_mib: 40, disk: { size_bytes: 10, used_bytes: 4 } },
      observed_at: at(state.now - 1000), fresh: true } },
    { id: 'vos:member-2', display_name: 'gpu-2', heartbeat: at(state.now - 60000), health_state: 'unavailable',
      managed: false, management_enabled: false, draining: true,
      report: { observed_at: at(state.now - 5000), arch: 'aarch64', gpus: [{ name: 'Orin' }, { name: '' }] },
      vos_applications: { data: [{ app_id: appId, installed_app_id: 'i2', version: '1.0', state: 'stopped' }],
        observed_at: at(state.now - 60000), fresh: false, error_code: 'SOURCE_UNAVAILABLE' } },
  ];
}

test('answers this machine instead of failing when the scheduler cannot be read', async () => {
  const { send, state } = fixture();
  const { body: { grant } } = await send('/authorize', {});
  state.schedulerDown = true;
  const fallback = await send('/nodes', null, grant);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.source, 'local-fallback');
  assert.equal(fallback.body.error, 'scheduler-unavailable');
  assert.deepEqual(fallback.body.nodes.map(node => node.id), ['local']);
  assert.ok(fallback.body.nodes[0].capabilities.includes('logs'));
  state.admin = false;
  assert.equal((await send('/nodes', null, grant)).status, 403);
});

test('merges scheduler nodes with SSH-managed machines and drops connection settings', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-23T10:00:00Z');
  state.nodeViews = nodeViews(state);
  state.managed = { can_manage: true, items: [{ id: 'edge-1', name: 'edge', status: 'online', arch: 'arm64',
    gpu_model: 'Orin', profile: 'jetson-orin', detected_profile: 'jetson-orin',
    compatible_profiles: ['jetson-orin'], last_checked_at: at(state.now - 5000),
    host: '10.0.0.9', ssh_user: 'root', ssh_port: 22, has_password: true }] };
  const { body: { grant } } = await send('/authorize', {});
  const catalog = await send('/nodes', null, grant);
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.source, 'scheduler');
  assert.deepEqual(catalog.body.nodes.map(node => node.id), ['local', 'vos:member-2', 'edge-1']);
  const [local, remote, managed] = catalog.body.nodes;
  assert.equal(local.health, 'ready');
  assert.equal(local.status, 'online');
  // This machine's own VOS outranks the scheduler's cached 9.9 observation.
  assert.deepEqual(local.apps.rows.map(app => [app.appId, app.version]), [[appId, '2.0']]);
  assert.equal(remote.status, 'offline');
  assert.equal(remote.fresh, false);
  assert.equal(remote.arch, 'aarch64');
  assert.equal(remote.gpuModel, 'Orin');
  assert.deepEqual(remote.capabilities, ['apps', 'metrics']);
  for (const key of ['host', 'ssh_user', 'ssh_port', 'has_password']) assert.equal(key in managed, false);
});

test('reads one machine application list and refuses unknown nodes', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-23T10:00:00Z');
  state.nodeViews = nodeViews(state);
  const { body: { grant } } = await send('/authorize', {});
  const local = await send('/nodes/apps', null, grant);
  assert.equal(local.status, 200);
  assert.equal(local.body.source, 'vos');
  assert.equal(local.body.apps[0].appId, appId);
  const remote = await send('/nodes/apps?node=vos:member-2', null, grant);
  assert.equal(remote.body.local, false);
  assert.equal(remote.body.error, 'SOURCE_UNAVAILABLE');
  assert.deepEqual(remote.body.apps.map(app => [app.appId, app.version]), [[appId, '1.0']]);
  assert.equal((await send('/nodes/apps?node=missing', null, grant)).status, 404);
  assert.equal((await send('/nodes/apps?node=bad%20id', null, grant)).status, 400);
});

test('lists compute backends and repairs one through a confirmed proposal', async () => {
  const { send, state } = fixture();
  state.backends = [{ id: 'bk-1', app_id: 'image-studio', image: 'demo:1.0', target_kind: 'ssh',
    target_id: 'edge-1', host: '10.0.0.9', host_port: 42811, container_port: 8000,
    state: 'failed', last_error: 'BACKEND_START_FAILED', updated_at: '2026-11-23T10:00:00Z' }];
  const { body: { grant } } = await send('/authorize', {});
  const listed = await send('/backends', null, grant);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.available, true);
  assert.deepEqual(listed.body.backends.map(row => [row.id, row.state, row.error, row.endpoint]),
    [['bk-1', 'failed', 'BACKEND_START_FAILED', null]]);
  // Only a stopped or failed backend may start; a stale target is refused.
  const preview = await send('/preview', { action: 'backend-start', id: 'bk-1' }, grant);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.target.state, 'failed');
  const done = await send('/execute', { confirmation: preview.body.confirmation, targetId: 'bk-1' }, grant);
  assert.equal(done.status, 200);
  assert.equal(done.body.state, 'pending');
  const backendCalls = state.schedulerCalls.filter(([path]) => path.includes('/backend-deployments'));
  assert.ok(backendCalls.some(([path, body]) =>
    path === '/scheduler/api/v1/backend-deployments/bk-1/start' && JSON.stringify(body) === '{}'));
  // The re-read after the change reports the state the scheduler reached.
  assert.equal(backendCalls.at(-1)[0], '/scheduler/api/v1/backend-deployments');
  assert.equal((await send('/preview', { action: 'backend-start', id: 'bk-1' }, grant)).status, 409);
  assert.equal((await send('/preview', { action: 'backend-stop', id: 'missing' }, grant)).status, 409);
});

test('keeps the last machine list only while the scheduler is unreachable', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-23T10:00:00Z');
  state.nodeViews = nodeViews(state);
  const { body: { grant } } = await send('/authorize', {});
  const first = await send('/nodes', null, grant);
  assert.equal(first.body.source, 'scheduler');
  assert.equal(first.body.stale, false);
  assert.equal(first.body.error, null);
  state.now += 60_000;
  state.schedulerDown = true;
  const cached = await send('/nodes', null, grant);
  assert.equal(cached.status, 200);
  assert.equal(cached.body.source, 'cache');
  assert.equal(cached.body.stale, true);
  assert.equal(cached.body.error, 'scheduler-unavailable');
  // The machines it answered before survive; this machine's own applications
  // are re-read live rather than replayed from the cache.
  assert.deepEqual(cached.body.nodes.map(node => node.id), ['local', 'vos:member-2']);
  assert.equal(cached.body.nodes[0].apps.rows[0].appId, appId);
  assert.equal(cached.body.observedAt, at(state.now - 60_000));
  // A withdrawn scheduler role is not an outage: the stale list must not stand in.
  state.schedulerDown = false;
  state.schedulerForbidden = true;
  const refused = await send('/nodes', null, grant);
  assert.equal(refused.status, 200);
  assert.equal(refused.body.source, 'local-fallback');
  assert.equal(refused.body.error, 'scheduler-forbidden');
  assert.deepEqual(refused.body.nodes.map(node => node.id), ['local']);
});

test('reports a truncated backend register and retries an unconfirmed cleanup', async () => {
  const { send, state } = fixture();
  state.backends = Array.from({ length: 200 }, (_, index) => ({
    id: `bk-${index}`, app_id: 'image-studio', image: 'demo:1.0', target_kind: 'ssh',
    target_id: 'edge-1', host: '10.0.0.9', host_port: 42000 + index, state: 'running',
    last_error: null, updated_at: '2026-11-23T10:00:00Z',
  }));
  const { body: { grant } } = await send('/authorize', {});
  const listed = await send('/backends', null, grant);
  assert.equal(listed.body.total, 200);
  assert.equal(listed.body.truncated, true);
  const other = await send('/backends?node=other', null, grant);
  assert.deepEqual(other.body.backends, []);
  // The ledger page is still a page: a node filter cannot claim completeness.
  assert.equal(other.body.truncated, true);
  assert.equal((await send('/backends?node=bad%20id', null, grant)).status, 400);
  assert.equal((await send('/backends?node=edge-1', null, grant)).body.backends.length, 200);
  state.backends = [{ id: 'bk-1', app_id: 'image-studio', image: 'demo:1.0', target_kind: 'ssh',
    target_id: 'edge-1', host: '10.0.0.9', host_port: 42811, state: 'cleanup_failed',
    last_error: 'BACKEND_CLEANUP_FAILED', updated_at: '2026-11-23T10:00:00Z' }];
  const preview = await send('/preview', { action: 'backend-stop', id: 'bk-1' }, grant);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.target.state, 'cleanup_failed');
  const done = await send('/execute', { confirmation: preview.body.confirmation, targetId: 'bk-1' }, grant);
  assert.equal(done.status, 200);
  assert.equal(done.body.state, 'stopping');
  assert.ok(state.schedulerCalls.some(([path]) =>
    path === '/scheduler/api/v1/backend-deployments/bk-1/stop'));
});

test('summarizes one machine from register facts without log bodies', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-23T10:00:00Z');
  state.nodeViews = nodeViews(state);
  state.backends = [
    { id: 'bk-1', app_id: 'image-studio', image: 'demo:1.0', target_kind: 'ssh',
      target_id: 'vos:member-2', host: '10.0.0.9', host_port: 42811, state: 'failed',
      last_error: 'BACKEND_START_FAILED', updated_at: at(state.now) },
    { id: 'bk-2', app_id: 'v-voice', image: 'voice:1', target_kind: 'ssh',
      target_id: 'edge-1', host: '10.0.0.7', host_port: 42812, state: 'cleanup_failed',
      last_error: 'BACKEND_CLEANUP_FAILED', updated_at: at(state.now) },
  ];
  const { body: { grant } } = await send('/authorize', {});
  const remote = await send('/nodes/diagnose?node=vos:member-2', null, grant);
  assert.equal(remote.status, 200);
  assert.equal(remote.body.node.id, 'vos:member-2');
  assert.equal(remote.body.backends.total, 2);
  assert.equal(remote.body.backends.scoped, 1);
  assert.deepEqual(remote.body.backends.byState, { failed: 1 });
  assert.equal(remote.body.catalog.source, 'scheduler');
  const codes = remote.body.findings.map(finding => finding.code);
  for (const code of ['node-offline', 'node-observation-only', 'node-draining',
    'node-observation-stale', 'backend-failed']) {
    assert.ok(codes.includes(code), code);
  }
  // A summary carries state, never log text.
  assert.equal(JSON.stringify(remote.body).includes('ERROR'), false);
  const local = await send('/nodes/diagnose', null, grant);
  assert.equal(local.status, 200);
  assert.equal(local.body.node.local, true);
  assert.equal(local.body.apps.total, 1);
  assert.deepEqual(local.body.apps.byState, { installed: 1 });
  assert.equal((await send('/nodes/diagnose?node=missing', null, grant)).status, 404);
  assert.equal((await send('/nodes/diagnose?node=bad%20id', null, grant)).status, 400);
  // The authorized Agent reads the same summary; nothing else is added for it.
  const agent = { session: { subject: 'test' }, sessionId: 'session-1' };
  assert.equal((await send('/nodes/diagnose?node=vos:member-2', null, undefined, {}, agent)).status, 200);
});

test('drains, resumes, revokes and rescans machines through confirmed proposals', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-23T10:00:00Z');
  state.nodeViews = [...nodeViews(state), {
    id: 'vos:member-3', display_name: 'gpu-3', heartbeat: at(state.now - 1000),
    health_state: 'ready', managed: true, management_enabled: true, draining: false,
    capacities: { cpu_millicores: 1000, memory_mib: 1024, gpu_slots: 1, gpu_memory_mib: 1024 },
  }];
  state.managed = { can_manage: true, items: [{ id: 'edge-1', name: 'edge', status: 'online',
    arch: 'arm64', gpu_model: 'Orin', profile: 'jetson-orin', detected_profile: 'jetson-orin',
    compatible_profiles: ['jetson-orin'], last_checked_at: '2026-11-23T10:00:00Z',
    host: '10.0.0.9', ssh_user: 'root', ssh_port: 22, has_password: true }] };
  const { body: { grant } } = await send('/authorize', {});
  const preview = (action, id) => send('/preview', { action, id }, grant);
  const execute = (proposal, id) =>
    send('/execute', { confirmation: proposal.confirmation, targetId: id }, grant);

  // An observation-only machine carries no budget to drain, and this machine is
  // not a managed node at all.
  assert.equal((await preview('node-drain', 'vos:member-2')).status, 409);
  assert.equal((await preview('node-rescan', 'local')).status, 400);

  const drain = await preview('node-drain', 'vos:member-3');
  assert.equal(drain.status, 200);
  assert.equal(drain.body.target.managed, true);
  assert.equal((await execute(drain.body, 'vos:member-3')).body.state, 'draining');
  assert.ok(state.schedulerCalls.some(([path, body]) =>
    path === '/scheduler/api/v1/nodes/vos%3Amember-3/drain' && body.draining === true));

  const undrain = await preview('node-undrain', 'vos:member-3');
  assert.equal(undrain.status, 200);
  assert.equal((await execute(undrain.body, 'vos:member-3')).body.state, 'ready');
  assert.ok(state.schedulerCalls.some(([path, body]) =>
    path === '/scheduler/api/v1/nodes/vos%3Amember-3/drain' && body.draining === false));

  // A drain applied between confirmation and execution invalidates the proposal.
  const stale = await preview('node-drain', 'vos:member-3');
  state.nodeViews.find(row => row.id === 'vos:member-3').draining = true;
  assert.equal((await execute(stale.body, 'vos:member-3')).status, 409);

  const rescan = await preview('node-rescan', 'edge-1');
  assert.equal(rescan.status, 200);
  assert.equal((await execute(rescan.body, 'edge-1')).body.state, 'online');
  assert.ok(state.schedulerCalls.some(([path]) =>
    path === '/scheduler/api/v1/managed-nodes/edge-1/rescan'));

  const revoke = await preview('node-revoke', 'vos:member-3');
  assert.equal(revoke.status, 200);
  assert.equal((await execute(revoke.body, 'vos:member-3')).body.state, 'revoked');
  assert.ok(state.schedulerCalls.some(([path]) =>
    path === '/scheduler/api/v1/nodes/vos%3Amember-3/revoke'));
  // A revoked machine is no longer schedulable, so a second proposal is stale.
  assert.equal((await preview('node-undrain', 'vos:member-3')).status, 409);
});

test('reads inference deployments with their machine and reconcile state', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-24T04:30:00Z');
  state.managed = { can_manage: true, items: [{ id: 'node-1', name: 'Thor', status: 'online',
    arch: 'aarch64', gpu_model: 'NVIDIA Thor', profile: 'jetson-thor',
    last_checked_at: at(state.now - 5000), host: '192.168.1.35', ssh_user: 'root', has_password: true }] };
  state.deployments = [
    { id: '01M7W0W2X4564JJSE5MZ4XSYQZ', name: 'qwen3.6 35b', card_name: 'Qwen3.6-35B-A3B NVFP4 Thor',
      serve_model_name: 'Qwen3.6-35B-A3B-NVFP4', serve_port: 8000, state: 'running',
      desired_state: 'running', health_status: 'healthy', vrouter_state: 'registered',
      last_error: '', vrouter_last_error: '', inference_engine: 'vllm', updated_at: at(state.now),
      configs: { SECRET: 'private' }, nodes: [{ id: 'node-1', name: 'Thor', host: '192.168.1.35',
        status: 'online', role: 'head' }] },
    { id: '01M7W05Y8DTF775K22ZM4HJ3YP', name: 'qwen3.8 27b', state: 'stopped',
      desired_state: 'running', health_status: 'unknown', last_error: 'VLLM_EXIT',
      nodes: [{ id: 'node-1', name: 'Thor', role: 'head' }] },
  ];
  const { body: { grant } } = await send('/authorize', {});
  const listed = await send('/deployments', null, grant);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.available, true);
  assert.equal(listed.body.total, 2);
  assert.ok(state.inferenceCalls.some(path => path.startsWith('/deployments?')));
  const [running, stopped] = listed.body.deployments;
  assert.equal(running.head.name, 'Thor');
  assert.deepEqual([running.state, running.health, running.model],
    ['running', 'healthy', 'Qwen3.6-35B-A3B-NVFP4']);
  assert.equal(stopped.error, 'VLLM_EXIT');
  // Deployment settings never leave the gateway, and no SSH field does either.
  assert.equal(JSON.stringify(listed.body).includes('SECRET'), false);
  assert.equal(JSON.stringify(listed.body).includes('root'), false);
});

test('starts and stops an inference deployment through the confirm flow', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-24T04:30:00Z');
  state.deployments = [
    { id: 'dep-1', name: 'qwen3.8 27b', state: 'stopped', desired_state: 'running',
      health_status: 'unknown', last_error: 'VLLM_EXIT',
      configs: { SECRET: 'private' },
      nodes: [{ id: 'node-1', name: 'Thor', role: 'head' }] },
    { id: 'dep-2', name: 'qwen3.6 35b', state: 'running', health_status: 'healthy',
      nodes: [{ id: 'node-1', name: 'Thor', role: 'head' }] },
  ];
  const { body: { grant } } = await send('/authorize', {});
  const preview = await send('/preview', { action: 'deployment-start', id: 'dep-1' }, grant);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.target.state, 'stopped');
  // The serve settings never reach the confirmation dialog.
  assert.equal(JSON.stringify(preview.body).includes('SECRET'), false);
  const done = await send('/execute', { confirmation: preview.body.confirmation, targetId: 'dep-1' }, grant);
  assert.equal(done.status, 200);
  assert.equal(done.body.state, 'running');
  assert.ok(state.inferenceCalls.some(path => path === '/deployments/dep-1/start'));
  // The write is a POST (the register refuses GET) and carries a JSON body.
  assert.ok(state.inferenceBodies.some(([path, body]) =>
    path === '/deployments/dep-1/start' && JSON.stringify(body) === '{}'));
  // The re-read after the change reports the state the register reached, and a
  // started deployment cannot be started again.
  assert.equal((await send('/preview', { action: 'deployment-start', id: 'dep-1' }, grant)).status, 409);
  // A running deployment may be stopped; a stopped one cannot be stopped again.
  const stop = await send('/preview', { action: 'deployment-stop', id: 'dep-2' }, grant);
  assert.equal(stop.status, 200);
  const doneStop = await send('/execute', { confirmation: stop.body.confirmation, targetId: 'dep-2' }, grant);
  assert.equal(doneStop.status, 200);
  assert.equal(doneStop.body.state, 'stopped');
  assert.ok(state.inferenceCalls.some(path => path === '/deployments/dep-2/stop'));
  assert.equal((await send('/preview', { action: 'deployment-stop', id: 'dep-2' }, grant)).status, 409);
});

test('resolves a merged machine by either id and names its deployments', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-24T04:30:00Z');
  state.nodeViews = [
    { id: 'vos:member-2', display_name: 'Thor', heartbeat: at(state.now - 1000),
      health_state: 'ready', managed: true },
  ];
  state.managed = { can_manage: true, items: [
    { id: '01M7SCCM5X7EVMFK7PTXPXXABC', name: 'Thor', status: 'online', arch: 'aarch64',
      gpu_model: 'NVIDIA Thor', profile: 'jetson-thor', last_checked_at: at(state.now - 5000) },
  ] };
  state.deployments = [
    { id: 'dep-9', name: 'qwen3.8 27b', state: 'stopped', desired_state: 'running',
      health_status: 'unknown', last_error: 'VLLM_EXIT',
      nodes: [{ id: '01M7SCCM5X7EVMFK7PTXPXXABC', name: 'Thor', role: 'head' }] },
  ];
  const { body: { grant } } = await send('/authorize', {});
  const catalog = await send('/nodes', null, grant);
  const merged = catalog.body.nodes.find(node => node.name === 'Thor');
  // The merged row keeps the SSH register's own id beside the view id.
  assert.equal(merged.id, 'vos:member-2');
  assert.equal(merged.managedId, '01M7SCCM5X7EVMFK7PTXPXXABC');
  // Refreshing the hardware profile works with the view id: the register is
  // found through the merged row's managedId, so no 409 target-changed.
  const rescan = await send('/preview', { action: 'node-rescan', id: 'vos:member-2' }, grant);
  assert.equal(rescan.status, 200);
  assert.equal(rescan.body.target.id, '01M7SCCM5X7EVMFK7PTXPXXABC');
  // A deployment names its head machine by the SSH register's id; the problem
  // list still attaches the machine name through the merged row.
  const listed = await send('/issues', null, grant);
  const finding = listed.body.issues.find(row => row.code === 'deployment-stopped');
  assert.equal(finding.node?.name, 'Thor');
});

test('merges the scheduler view and the SSH-managed record into one machine', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-24T04:30:00Z');
  state.nodeViews = [
    { id: 'local', display_name: 'here', heartbeat: at(state.now - 1000),
      health_state: 'ready', managed: true },
    { id: 'vos:member-2', display_name: 'Thor', heartbeat: at(state.now - 1000),
      health_state: 'ready', managed: true },
  ];
  state.managed = { can_manage: true, items: [
    { id: 'node-1', name: 'Thor', status: 'online', arch: 'aarch64', gpu_model: 'NVIDIA Thor',
      profile: 'jetson-thor', last_checked_at: at(state.now - 5000), host: '192.168.1.35' },
    { id: 'node-2', name: 'Orin NX', status: 'unknown', arch: 'aarch64', gpu_model: 'Orin',
      last_checked_at: at(state.now - 5000) },
  ] };
  const { body: { grant } } = await send('/authorize', {});
  const catalog = await send('/nodes', null, grant);
  assert.equal(catalog.status, 200);
  // One row per machine: the scheduler's Thor and the managed Thor are the
  // same box, so the managed duplicate disappears from the list.
  assert.deepEqual(catalog.body.nodes.map(node => node.name), ['here', 'Thor', 'Orin NX']);
  const merged = catalog.body.nodes.find(node => node.name === 'Thor');
  // The scheduler view carries status and health; the managed record fills the
  // hardware profile and contributes the rescan capability.
  assert.equal(merged.status, 'online');
  assert.equal(merged.health, 'ready');
  assert.equal(merged.profile, 'jetson-thor');
  assert.equal(merged.gpuModel, 'NVIDIA Thor');
  assert.ok(merged.capabilities.includes('rescan'));
  // A machine only the managed register knows stays its own row.
  const sshOnly = catalog.body.nodes.find(node => node.name === 'Orin NX');
  assert.equal(sshOnly.kind, 'managed');
  assert.equal(sshOnly.status, 'unknown');
  assert.ok(sshOnly.capabilities.includes('rescan'));
});

test('merges machines, applications, backends and deployments into one problem list', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-24T04:30:00Z');
  state.nodeViews = [
    { id: 'local', display_name: 'here', heartbeat: at(state.now - 1000),
      health_state: 'ready', managed: true },
    { id: 'vos:member-2', display_name: 'gpu-2', heartbeat: at(state.now - 60000),
      health_state: 'unavailable', managed: false,
      vos_applications: { data: [{ app_id: appId, installed_app_id: 'i2', version: '1.0',
        state: 'failed', last_error: 'CONTAINER_EXIT' }], observed_at: at(state.now - 60000), fresh: false } },
  ];
  state.backends = [{ id: 'bk-1', app_id: 'image-studio', image: 'demo:1.0', target_kind: 'ssh',
    target_id: 'vos:member-2', host: '10.0.0.9', host_port: 42811, state: 'failed',
    last_error: 'BACKEND_START_FAILED', updated_at: at(state.now) }];
  state.deployments = [
    { id: 'dep-1', name: 'qwen3.8 27b', state: 'stopped', desired_state: 'running',
      health_status: 'unknown', last_error: 'VLLM_EXIT',
      nodes: [{ id: 'vos:member-2', name: 'gpu-2', role: 'head' }] },
  ];
  const { body: { grant } } = await send('/authorize', {});
  const listed = await send('/issues', null, grant);
  assert.equal(listed.status, 200);
  const codes = listed.body.issues.map(row => row.code);
  for (const code of ['node-offline', 'node-observation-stale', 'app-failed',
    'backend-failed', 'deployment-stopped']) {
    assert.ok(codes.includes(code), code);
  }
  // A stopped deployment the application still wants running is a problem, and
  // the row names the machine it is placed on.
  const stopped = listed.body.issues.find(row => row.code === 'deployment-stopped');
  assert.equal(stopped.node.name, 'gpu-2');
  assert.equal(stopped.subject, 'qwen3.8 27b');
  // Errors first, warnings after, and the counts agree with the rows.
  const levels = listed.body.issues.map(row => row.level);
  const firstWarning = levels.indexOf('warning');
  assert.ok(levels.slice(firstWarning).every(level => level === 'warning'));
  assert.equal(listed.body.counts.error, levels.filter(level => level === 'error').length);
  assert.equal(listed.body.counts.warning, levels.filter(level => level === 'warning').length);
  // The rows are part of the same answer, so the panel does not read the
  // deployment register a second time to render its list.
  assert.deepEqual(listed.body.deploymentRows.map(row => row.name), ['qwen3.8 27b']);
});

test('does not call an intentional stop or a stale application error a problem', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-24T04:30:00Z');
  state.nodeViews = [
    { id: 'local', display_name: 'here', heartbeat: at(state.now - 1000),
      health_state: 'ready', managed: true },
    { id: 'vos:member-2', display_name: 'gpu-2', heartbeat: at(state.now - 1000),
      health_state: 'ready', managed: true,
      vos_applications: { data: [{ app_id: appId, installed_app_id: 'i2', version: '1.0',
        state: 'installed', last_error: 'OLD_FAILURE' }], observed_at: at(state.now - 1000), fresh: true } },
  ];
  state.deployments = [
    { id: 'dep-1', name: 'qwen3.8 27b', state: 'stopped', desired_state: 'stopped',
      health_status: 'unknown', last_error: 'VLLM_EXIT',
      nodes: [{ id: 'vos:member-2', name: 'gpu-2', role: 'head' }] },
  ];
  const { body: { grant } } = await send('/authorize', {});
  const listed = await send('/issues', null, grant);
  const codes = listed.body.issues.map(row => row.code);
  // An administrator asked this one to stop, so it is not a problem.
  assert.equal(codes.includes('deployment-stopped'), false);
  // A lingering last_error on an installed application is worth a warning.
  const appError = listed.body.issues.find(row => row.code === 'app-error');
  assert.equal(appError.level, 'warning');
  assert.equal(listed.body.counts.error, 0);
});

test('reports an unreadable deployment register instead of claiming nothing is wrong', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-24T04:30:00Z');
  state.nodeViews = [nodeViews(state)[0]];
  state.inferenceForbidden = true;
  const { body: { grant } } = await send('/authorize', {});
  const listed = await send('/issues', null, grant);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.sources.deployments.available, false);
  assert.equal(listed.body.sources.deployments.error, 'scheduler-forbidden');
  assert.equal(listed.body.sources.catalog.available, true);
  assert.ok(listed.body.issues.some(row => row.code === 'deployments-unavailable'));
  // The deployment list itself degrades rather than failing the whole panel.
  const deployments = await send('/deployments', null, grant);
  assert.equal(deployments.status, 200);
  assert.equal(deployments.body.available, false);
  assert.deepEqual(deployments.body.deployments, []);
});

test('reads a local backend container and probes only local ports', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-24T04:30:00Z');
  const localId = 'd'.repeat(64);
  state.containers.push({ Id: localId, Names: ['/vs-backend-bk-local'], Image: 'demo:1.0',
    ImageID: 'sha256:' + 'e'.repeat(64), State: 'running', Status: 'Up 3 minutes',
    Ports: [], Labels: {} });
  state.backends = [
    { id: 'bk-local', app_id: 'image-studio', image: 'demo:1.0', target_kind: 'ssh',
      target_id: 'local', host: '127.0.0.1', host_port: 42811, state: 'running',
      last_error: null, updated_at: at(state.now) },
    { id: 'bk-remote', app_id: 'v-voice', image: 'voice:1', target_kind: 'ssh',
      target_id: 'edge-1', host: '10.0.0.9', host_port: 42812, state: 'running',
      last_error: null, updated_at: at(state.now) },
  ];
  const { body: { grant } } = await send('/authorize', {});
  const listed = await send('/backends', null, grant);
  const [local, remote] = listed.body.backends;
  assert.equal(local.container.id, localId);
  assert.deepEqual(local.probe, { ok: true, status: 200, ms: 2, error: null });
  assert.equal(remote.container, null);
  assert.equal(remote.probe, undefined);
  // Only the port of a container that runs on this machine is dialled.
  assert.deepEqual(state.probes, [42811]);

  const logs = await send('/backend-logs?id=bk-local', null, grant);
  assert.equal(logs.status, 200);
  assert.equal(logs.body.text, 'sample log');
  const facts = await send('/backend-diagnose?id=bk-local', null, grant);
  assert.equal(facts.status, 200);
  assert.equal(facts.body.local, true);
  assert.equal(facts.body.state.status, 'exited');
  // A backend on another machine, or an unknown one, is refused distinctly.
  assert.equal((await send('/backend-logs?id=bk-remote', null, grant)).status, 404);
  assert.equal((await send('/backend-diagnose?id=missing', null, grant)).status, 404);
});

test('reports a backend whose container stopped or whose port refuses', async () => {
  const { send, state } = fixture();
  state.now = Date.parse('2026-11-24T04:30:00Z');
  state.nodeViews = [{ id: 'local', display_name: 'here', heartbeat: at(state.now - 1000),
    health_state: 'ready', managed: true }];
  const container = { Id: 'f'.repeat(64), Names: ['/vs-backend-bk-stopped'], Image: 'demo:1.0',
    ImageID: 'sha256:' + 'a'.repeat(64), State: 'exited', Status: 'Exited (137) 2 minutes ago',
    Ports: [], Labels: {} };
  state.containers.push(container);
  state.backends = [{ id: 'bk-stopped', app_id: 'image-studio', image: 'demo:1.0',
    target_kind: 'ssh', target_id: 'local', host: '127.0.0.1', host_port: 42811,
    state: 'running', last_error: null, updated_at: at(state.now) }];
  const { body: { grant } } = await send('/authorize', {});

  const stopped = await send('/issues', null, grant);
  const stoppedCodes = stopped.body.issues.map(row => row.code);
  assert.ok(stoppedCodes.includes('backend-container-stopped'), stoppedCodes.join(','));

  // A running container whose port answers 401 is reachable, not broken.
  container.State = 'running';
  container.Status = 'Up 1 minute';
  state.probeResult = { ok: false, status: 401, ms: 5, error: 'unauthorized' };
  const unauthorized = await send('/issues', null, grant);
  const unauthorizedRow = unauthorized.body.issues.find(row => row.code === 'backend-unauthorized');
  assert.equal(unauthorizedRow.level, 'warning');
  assert.equal(unauthorized.body.issues.some(row => row.code === 'backend-unreachable'), false);

  state.probeResult = { ok: false, status: null, ms: 4, error: 'ECONNREFUSED' };
  const refused = await send('/issues', null, grant);
  assert.ok(refused.body.issues.some(row => row.code === 'backend-unreachable'
    && row.detail === 'ECONNREFUSED'));
});
