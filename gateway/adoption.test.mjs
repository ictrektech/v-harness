import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instanceAddress } from './addressing.mjs';
import {
  COOKIE_MAX_AGE_MS, adoptable, backfillInstanceState, probeInstance,
  readRegistry, writeRegistry,
} from './instance-state.mjs';
import {
  ensureInstance, instanceBoot, migrateInstanceStateKeys, primeInstanceBoots,
  stopAll, stopInstance,
} from './instances.mjs';
import { mcphubEnvironment, restoreMcphubKey } from './mcphub.mjs';
import { restoreSchedulerKey, schedulerEnvironment } from './scheduler.mjs';

/**
 * Reserve a loopback port and hand it back unused.
 * @returns {Promise<number>}
 */
async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(resolve); });
  return /** @type {number} */ (port);
}

/**
 * A dsh stand-in on a tenant loopback address. It only answers requests that
 * carry the expected cookie, exactly as a real instance does once its signing
 * key has been replaced.
 * @param {number} port
 * @param {string} cookie
 * @param {(req: import('node:http').IncomingMessage) => void} [observe]
 * @returns {Promise<import('node:http').Server>}
 */
async function tenantServer(port, cookie, observe) {
  const server = createServer((req, res) => {
    observe?.(req);
    if (req.headers.cookie !== cookie || req.headers.host !== `127.0.0.1:${String(port)}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>dsh</title>');
  });
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  return server;
}

/**
 * @param {string} subject
 * @param {number} uid
 * @param {number} port
 * @returns {import('./users.mjs').UserRecord}
 */
function user(subject, uid, port) {
  return {
    subject,
    namespace: `${subject}-namespace`,
    username: subject,
    account: `vh-${subject}`,
    linuxName: `vh-${subject}`,
    uid,
    port,
    createdAt: Date.now() - 60_000,
  };
}

/**
 * @param {string} root
 * @param {string} subject
 * @param {ReturnType<typeof user>} record
 * @param {number} port
 * @param {string} cookie
 * @param {number} [bootedAt]
 * @returns {{ statePath: string, usersPath: string, options: Parameters<typeof ensureInstance>[0] }}
 */
async function registryWithInstance(root, subject, record, port, cookie, bootedAt = Date.now() - 5_000) {
  const statePath = join(root, 'state-instances.json');
  const usersPath = join(root, 'users.json');
  const registry = {
    [subject]: {
      cookie,
      cookieExpiresAt: bootedAt + COOKIE_MAX_AGE_MS,
      port,
      uid: record.uid,
      bootedAt,
      schedulerKey: 'scheduler-key',
      mcphubKey: 'mcphub-key',
    },
  };
  await writeRegistry(statePath, registry);
  await writeFile(usersPath, JSON.stringify({ [subject]: record }), 'utf8');
  return {
    statePath,
    usersPath,
    options: {
      record,
      stateRoot: root,
      dshBin: join(root, 'no-dsh'),
      nodeBin: process.execPath,
      statePath,
      userHelper: join(root, 'no-userctl'),
    },
  };
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => { server.close(resolve); });
}

test('registry round-trips, stays private, and survives a damaged file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-registry-'));
  try {
    const path = join(root, 'state-instances.json');
    const registry = { subject: { cookie: 'dsh-auth-a=v1', bootedAt: 42 } };
    await writeRegistry(path, registry);
    assert.deepEqual(await readRegistry(path), registry);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, '{not json', 'utf8');
    assert.deepEqual(await readRegistry(path), {});
    assert.deepEqual(await readRegistry(join(root, 'missing.json')), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registry refuses a file readable beyond its owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-registry-mode-'));
  try {
    const path = join(root, 'state-instances.json');
    await writeRegistry(path, { subject: { cookie: 'dsh-auth-a=v1' } });
    await chmod(path, 0o644);
    assert.deepEqual(await readRegistry(path), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeRegistry pins a leftover temp file to 0600', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-registry-tmp-'));
  try {
    const path = join(root, 'state-instances.json');
    const temporary = `${path}.tmp-${String(process.pid)}`;
    await writeFile(temporary, 'stale', { mode: 0o644 });
    await writeRegistry(path, { subject: { cookie: 'dsh-auth-a=v1' } });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readRegistry(path), { subject: { cookie: 'dsh-auth-a=v1' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adoptable rejects expired cookies, mismatched tenants and missing boots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-adoptable-'));
  try {
    // Ensure the module-level maps do not retain anything from another case.
    await stopAll();
    const record = user('subject-a', 20_000, await freePort());
    const now = Date.now();
    const valid = {
      cookie: 'dsh-auth-a=v1',
      cookieExpiresAt: now + 1_000,
      port: record.port,
      uid: record.uid,
      bootedAt: now - 1_000,
    };
    assert.equal(adoptable(record, valid, now), true);
    assert.equal(adoptable(record, undefined, now), false);
    assert.equal(adoptable(record, { ...valid, cookie: '' }, now), false);
    assert.equal(adoptable(record, { ...valid, cookieExpiresAt: now - 1 }, now), false);
    assert.equal(adoptable(record, { ...valid, port: record.port + 1 }, now), false);
    assert.equal(adoptable(record, { ...valid, uid: record.uid + 1 }, now), false);
    assert.equal(adoptable(record, { ...valid, bootedAt: 0 }, now), false);
    assert.equal(adoptable(record, { ...valid, bootedAt: now + 1_000 }, now), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backfill upgrades cookie-only entries once and keeps boot stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-backfill-'));
  try {
    const record = user('subject-b', 20_001, await freePort());
    const expiresAt = Date.now() + COOKIE_MAX_AGE_MS;
    const registry = { [record.subject]: { cookie: 'dsh-auth-b=v1', cookieExpiresAt: expiresAt } };
    assert.equal(backfillInstanceState(registry, [record]), true);
    const entry = registry[record.subject];
    assert.equal(entry.port, record.port);
    assert.equal(entry.uid, record.uid);
    assert.equal(entry.bootedAt, expiresAt - COOKIE_MAX_AGE_MS);
    const boot = entry.bootedAt;
    assert.equal(backfillInstanceState(registry, [record]), false);
    assert.equal(entry.bootedAt, boot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('probe proves liveness, cookie and cookie authority together', async () => {
  const port = await freePort();
  const cookie = 'dsh-auth-probe=v1';
  let hits = 0;
  const server = await tenantServer(port, cookie, () => { hits += 1; });
  try {
    assert.equal(await probeInstance({ uid: 20_002, port, cookie, host: '127.0.0.1' }), true);
    assert.equal(await probeInstance({ uid: 20_002, port, cookie: 'dsh-auth-probe=old', host: '127.0.0.1' }), false);
    assert.equal(hits, 2);
  } finally {
    await closeServer(server);
  }
  assert.equal(await probeInstance({ uid: 20_002, port, cookie, host: '127.0.0.1', timeoutMs: 200 }), false);
});

test('probe uses the tenant loopback address and times out on a stalled reply', async () => {
  const port = await freePort();
  const server = createServer((_req, _res) => { /* never answers */ });
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  try {
    assert.equal(await probeInstance({
      uid: 20_003, port, cookie: 'dsh-auth-stall=v1', timeoutMs: 120,
    }), false);
    assert.equal(instanceAddress(20_003), '127.78.35.1');
  } finally {
    await closeServer(server);
  }
});

test('boot identity survives a gateway restart before any adoption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-boot-'));
  try {
    await stopAll();
    const subject = 'subject-c';
    const bootedAt = Date.now() - 9_000;
    primeInstanceBoots({ [subject]: { bootedAt } });
    assert.equal(instanceBoot(subject), bootedAt);
    await stopAll();
    assert.equal(instanceBoot(subject), bootedAt);
    assert.equal(instanceBoot('never-booted'), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureInstance adopts a live tenant instead of spawning a replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-adopt-'));
  let server;
  try {
    await stopAll();
    const subject = 'subject-d';
    const record = user(subject, 20_004, await freePort());
    const cookie = 'dsh-auth-d=v1';
    const bootedAt = Date.now() - 7_000;
    const { options } = await registryWithInstance(root, subject, record, record.port, cookie, bootedAt);
    let hits = 0;
    server = await tenantServer(record.port, cookie, () => { hits += 1; });
    primeInstanceBoots({ [subject]: { bootedAt } });

    const adopted = await ensureInstance(options);
    assert.equal(adopted.adopted, true, 'the process must be adopted, not spawned');
    assert.equal(adopted.child, undefined, 'an adopted process has no child handle');
    assert.equal(adopted.cookie, cookie);
    assert.equal(adopted.bootedAt, bootedAt);
    assert.equal(instanceBoot(subject), bootedAt);
    assert.equal(hits, 1, 'one probe, no launch');
    // A healthy listener is still there: no reclaim killed it.
    assert.equal(await probeInstance({ uid: record.uid, port: record.port, cookie, host: '127.0.0.1' }), true);

    const again = await ensureInstance(options);
    assert.equal(again, adopted, 'within the recheck window the same handle is returned');
    assert.equal(hits, 2, 'one probe for adoption, one proof of continued liveness');
  } finally {
    if (server) await closeServer(server);
    await stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('stopAll drops gateway handles without stopping tenant processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-stopall-'));
  let server;
  try {
    await stopAll();
    const subject = 'subject-e';
    const record = user(subject, 20_005, await freePort());
    const cookie = 'dsh-auth-e=v1';
    const { options } = await registryWithInstance(root, subject, record, record.port, cookie);
    server = await tenantServer(record.port, cookie);
    const adopted = await ensureInstance(options);
    assert.equal(adopted.adopted, true);

    await stopAll();
    assert.equal(instanceBoot(subject), adopted.bootedAt);
    assert.equal(await probeInstance({ uid: record.uid, port: record.port, cookie, host: '127.0.0.1' }), true);
  } finally {
    if (server) await closeServer(server);
    await stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('stopInstance refuses a stale pid that belongs to an unrelated process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-stopone-'));
  let server;
  let child;
  try {
    await stopAll();
    const subject = 'subject-f';
    const record = user(subject, 20_006, await freePort());
    const cookie = 'dsh-auth-f=v1';
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const { statePath } = await registryWithInstance(root, subject, record, record.port, cookie);
    const registry = await readRegistry(statePath);
    registry[subject].pid = child.pid;
    await writeRegistry(statePath, registry);
    server = await tenantServer(record.port, cookie);
    const adopted = await ensureInstance({
      record,
      stateRoot: root,
      dshBin: join(root, 'no-dsh'),
      nodeBin: process.execPath,
      statePath,
      userHelper: join(root, 'no-userctl'),
    });
    assert.equal(adopted.adopted, true);

    assert.equal(await stopInstance(subject), true);
    assert.equal(child.exitCode, null, 'a reused pid is not signalled without proof of ownership');
    assert.equal(await stopInstance(subject), false);
    assert.equal(instanceBoot(subject), 0);
  } finally {
    if (child?.exitCode === null) child.kill('SIGKILL');
    if (server) await closeServer(server);
    await stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('stopInstance stops whoever holds the tenant port, not the jail wrapper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-stoplistener-'));
  let child;
  try {
    await stopAll();
    const subject = 'subject-g';
    const portFile = join(root, 'port');
    // A real listener owned by this test's uid: `listenerIn` resolves its pid
    // from ss, so the uid check can pass and the signal lands on the process
    // that actually holds the port.
    child = spawn(process.execPath, ['-e', `
      const http = require('node:http');
      const fs = require('node:fs');
      const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
      server.listen(0, '0.0.0.0', () => {
        fs.writeFileSync(process.env.VH_PORT_FILE, String(server.address().port));
      });
      setInterval(() => {}, 1000);
    `], { env: { ...process.env, VH_PORT_FILE: portFile }, stdio: 'ignore' });
    let port = 0;
    const deadline = Date.now() + 5_000;
    while (port === 0 && Date.now() < deadline) {
      try {
        port = Number(await readFile(portFile, 'utf8'));
      } catch (error) {
        // The listener has not published its port yet.
        void error;
      }
      if (port === 0) await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.ok(port > 0);

    const record = user(subject, process.getuid(), port);
    const cookie = 'dsh-auth-g=v1';
    const { statePath } = await registryWithInstance(root, subject, record, port, cookie);
    const adopted = await ensureInstance({
      record,
      stateRoot: root,
      dshBin: join(root, 'no-dsh'),
      nodeBin: process.execPath,
      statePath,
      userHelper: join(root, 'no-userctl'),
    });
    assert.equal(adopted.adopted, true);

    assert.equal(await stopInstance(subject), true);
    const stopDeadline = Date.now() + 8_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < stopDeadline) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'the port holder is gone');
    assert.equal(instanceBoot(subject), 0);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('migration converts legacy keys and backfills in one boot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-migrate-'));
  try {
    await mkdir(join(root, '.vh'), { recursive: true });
    const statePath = join(root, '.vh', 'state-instances.json');
    const usersPath = join(root, '.vh', 'users.json');
    const record = user('subject-g', 20_007, await freePort());
    const expiresAt = Date.now() + COOKIE_MAX_AGE_MS;
    await writeRegistry(statePath, {
      [record.namespace]: { cookie: 'dsh-auth-g=v1', cookieExpiresAt: expiresAt },
    });
    await writeFile(usersPath, JSON.stringify({ [record.subject]: record }), 'utf8');

    await migrateInstanceStateKeys(statePath, usersPath);
    const migrated = await readRegistry(statePath);
    assert.equal(migrated[record.namespace], undefined);
    assert.equal(migrated[record.subject].cookie, 'dsh-auth-g=v1');
    assert.equal(migrated[record.subject].port, record.port);
    assert.equal(migrated[record.subject].uid, record.uid);
    assert.ok(migrated[record.subject].bootedAt > 0);
    const before = await readFile(statePath, 'utf8');
    await migrateInstanceStateKeys(statePath, usersPath);
    assert.equal(await readFile(statePath, 'utf8'), before, 'a second boot leaves the file alone');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability keys are recovered, while a new launch still rotates one', async () => {
  const namespace = 'adoption-test-namespace';
  restoreSchedulerKey(namespace, 'restored-scheduler');
  assert.equal(schedulerEnvironment(namespace).VH_SCHEDULER_KEY, 'restored-scheduler');

  // mcphubEnvironment only issues a key when its upstream answers, so give it
  // a stand-in instead of depending on a deployment-only MCPHub URL.
  const upstream = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const { port } = upstream.address();
  const previousUrl = process.env.MCPHUB_URL;
  process.env.MCPHUB_URL = `http://127.0.0.1:${String(port)}/base`;
  try {
    restoreMcphubKey(namespace, 'restored-mcphub');
    const fresh = (await mcphubEnvironment(namespace)).VH_MCPHUB_KEY;
    assert.equal(typeof fresh, 'string');
    assert.ok(fresh.length > 0);
    assert.notEqual(fresh, 'restored-mcphub', 'a new process gets its own key');
  } finally {
    if (previousUrl === undefined) delete process.env.MCPHUB_URL;
    else process.env.MCPHUB_URL = previousUrl;
    await closeServer(upstream);
  }
});
