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
  ], calls: [] };
  const handle = createVosOps({
    sessionFor: () => ({ sid: state.sid, subject: 'test' }), tokenFor: () => 'test',
    agentSessionAllowed: async (_subject, id) => id === 'session-1' && state.sessionAllowed,
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
      return Buffer.from('sample log');
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

test('refuses non-platform logs and in-use or tagged images', async () => {
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
  assert.equal((await prepare()).status, 409);
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
