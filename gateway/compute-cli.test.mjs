import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const run = promisify(execFile);
test('compute CLIs send the native method, path and complete JSON body', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vh-compute-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, 'api.sock');
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'OK', data: { items: [] } }));
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  server.listen(socket);
  await once(server, 'listening');
  const studio = new URL('../skills/image-studio/scripts/image-studio.mjs', import.meta.url).pathname;
  const nodes = new URL('../skills/image-studio/scripts/v-scheduler.mjs', import.meta.url).pathname;
  const env = { ...process.env, VH_IMAGE_STUDIO_SOCK: socket, VH_SCHEDULER_SOCKET: socket };
  const deployment = 'a'.repeat(32);
  await run(process.execPath, [studio, 'deploy-backend', '--kind', 'ssh', '--node-id', 'node-a', '--request-key', 'fixture'], { env });
  await run(process.execPath, [studio, 'prepare-model', deployment, '--model-key', 'sdxl', '--model-variant', 'q4'], { env });
  await run(process.execPath, [studio, 'remove-remote-model', deployment, '--model-id', 'sdxl@q4'], { env });
  await run(process.execPath, [studio, 'backend-stop', deployment], { env });
  const config = join(root, 'node.json');
  const settings = { name: 'fixture', host: 'fixture.invalid', ssh_user: 'fixture', auth_method: 'password', ssh_password: 'private-fixture' };
  await writeFile(config, JSON.stringify(settings), { mode: 0o600 });
  const added = await run(process.execPath, [nodes, 'add', '--json-file', config], { env });
  assert.ok(!added.stdout.includes(settings.ssh_password));
  await run(process.execPath, [nodes, 'update', 'node-a', '--json-file', config], { env });
  await run(process.execPath, [nodes, 'runtime', 'node-a'], { env });
  await run(process.execPath, [nodes, 'remove', 'node-a'], { env });
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ['POST', '/api/v1/compute/deployments'],
    ['POST', '/api/v1/compute/deployments/' + deployment + '/models'],
    ['DELETE', '/api/v1/compute/deployments/' + deployment + '/models/sdxl%40q4'],
    ['POST', '/api/v1/compute/deployments/' + deployment + '/stop'],
    ['POST', '/scheduler/api/v1/managed-nodes'],
    ['PUT', '/scheduler/api/v1/managed-nodes/node-a'],
    ['POST', '/scheduler/api/v1/managed-nodes/node-a/runtime'],
    ['DELETE', '/scheduler/api/v1/managed-nodes/node-a'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].body), { kind: 'ssh', node_id: 'node-a', request_key: 'fixture' });
  assert.deepEqual(JSON.parse(calls[1].body), { model_key: 'sdxl', model_variant: 'q4' });
  assert.deepEqual(JSON.parse(calls[4].body), settings);
  assert.deepEqual(JSON.parse(calls[5].body), settings);
  await run(process.execPath, [nodes, 'drain', 'vos:node-a'], { env });
  await run(process.execPath, [nodes, 'resume', 'vos:node-a'], { env });
  assert.deepEqual(calls.slice(-2).map(call => [call.method, call.path, JSON.parse(call.body)]), [
    ['POST', '/scheduler/api/v1/nodes/vos%3Anode-a/drain', { draining: true }],
    ['POST', '/scheduler/api/v1/nodes/vos%3Anode-a/drain', { draining: false }],
  ]);
});
