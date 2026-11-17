import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVosOps, OPS_PATH } from './vos-ops.mjs';

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
    inspect: { State: { Status: 'exited' }, RestartCount: 0 } };
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
