import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const supervisor = fileURLToPath(new URL('../bin/vh-supervisor.sh', import.meta.url));

// The stub records one line per start, exits on the first run, then stays up.
// That is the shape of a gateway that crashes once and is brought back.
const STUB = `
import { appendFileSync, readFileSync } from 'node:fs';
const mark = process.env.VH_STUB_MARK;
appendFileSync(mark, 'start\\n');
const runs = readFileSync(mark, 'utf8').trim().split('\\n').filter(Boolean).length;
if (runs < 2) process.exit(1);
setInterval(() => {}, 1000);
`;

/**
 * @param {() => Promise<boolean>} probe
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      // The mark file does not exist until the first gateway starts.
      void error;
    }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error('timed out waiting for the supervisor');
}

/**
 * @param {string} path
 * @returns {Promise<number>}
 */
async function starts(path) {
  const text = await readFile(path, 'utf8');
  return text.trim().split('\n').filter(Boolean).length;
}

test('the supervisor script is valid bash', () => {
  assert.equal(spawnSync('bash', ['-n', supervisor]).status, 0);
});

test('restarts the gateway after an exit and stops cleanly on SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-supervisor-'));
  const mark = join(root, 'starts.log');
  const pidFile = join(root, 'gateway.pid');
  const stub = join(root, 'stub.mjs');
  await writeFile(stub, STUB, 'utf8');

  const child = spawn('bash', [supervisor], {
    env: {
      ...process.env,
      VH_GATEWAY_ENTRY: stub,
      VH_GATEWAY_PID_FILE: pidFile,
      VH_STUB_MARK: mark,
      VH_SQLITE_FLAGS: '',
    },
    stdio: 'ignore',
  });
  try {
    await waitFor(async () => (await starts(mark)) >= 2, 8_000);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isInteger(pid) && pid > 0, 'the current gateway pid is published');

    child.kill('SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => { setTimeout(resolve, 4_000); }),
      ]);
    }
    assert.notEqual(child.exitCode, null, 'SIGTERM to PID 1 ends the supervisor');

    // No third start: signalling the supervisor is a container stop, not a
    // gateway crash to be restarted.
    await new Promise((resolve) => { setTimeout(resolve, 1_400); });
    assert.equal(await starts(mark), 2);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    try {
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      if (pid > 0) process.kill(pid, 'SIGKILL');
    } catch (error) {
      // A clean supervisor exit removes its pid file.
      void error;
    }
    await rm(root, { recursive: true, force: true });
  }
});

const DSH_STUB = `
setInterval(() => { process.stdout.write('tick\\n'); }, 40);
`;

const GATEWAY_WITH_TENANT = `
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const mark = process.env.VH_STUB_MARK;
appendFileSync(mark, 'start\\n');
const runs = readFileSync(mark, 'utf8').trim().split('\\n').filter(Boolean).length;
const log = process.env.VH_STUB_DSH_LOG;
if (runs === 1) {
  // The real launcher hands the tenant its own log fd, never a pipe the
  // gateway owns. When this gateway exits, that fd must stay writable.
  const fd = openSync(log, 'a', 0o600);
  const dsh = spawn(process.execPath, [process.env.VH_STUB_DSH_ENTRY], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  writeFileSync(process.env.VH_STUB_DSH_PID, String(dsh.pid));
  dsh.unref();
  process.exit(1);
}
const pid = Number(readFileSync(process.env.VH_STUB_DSH_PID, 'utf8'));
let alive = true;
try { process.kill(pid, 0); } catch { alive = false; }
const lines = () => readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length;
const before = lines();
await new Promise((resolve) => { setTimeout(resolve, 250); });
writeFileSync(process.env.VH_STUB_RESULT, JSON.stringify({ alive, growing: lines() > before }));
setInterval(() => {}, 1000);
`;

test('a tenant process survives a gateway restart and keeps writing its log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-supervisor-tenant-'));
  const mark = join(root, 'starts.log');
  const log = join(root, 'tenant.log');
  const pidFile = join(root, 'tenant.pid');
  const resultFile = join(root, 'result.json');
  const dshEntry = join(root, 'dsh.mjs');
  const gateway = join(root, 'gateway.mjs');
  await writeFile(dshEntry, DSH_STUB, 'utf8');
  await writeFile(gateway, GATEWAY_WITH_TENANT, 'utf8');

  const child = spawn('bash', [supervisor], {
    env: {
      ...process.env,
      VH_GATEWAY_ENTRY: gateway,
      VH_GATEWAY_PID_FILE: join(root, 'gateway.pid'),
      VH_STUB_MARK: mark,
      VH_STUB_DSH_LOG: log,
      VH_STUB_DSH_PID: pidFile,
      VH_STUB_DSH_ENTRY: dshEntry,
      VH_STUB_RESULT: resultFile,
      VH_SQLITE_FLAGS: '',
    },
    stdio: 'ignore',
  });
  try {
    await waitFor(async () => {
      try { await readFile(resultFile, 'utf8'); return true; } catch { return false; }
    }, 10_000);
    const result = JSON.parse(await readFile(resultFile, 'utf8'));
    assert.equal(result.alive, true, 'the tenant process outlives the gateway that spawned it');
    assert.equal(result.growing, true, 'its log fd is still writable after the gateway exited');
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => { setTimeout(resolve, 4_000); }),
      ]);
    }
    if (child.exitCode === null) child.kill('SIGKILL');
    try {
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      if (pid > 0) process.kill(pid, 'SIGKILL');
    } catch (error) {
      // The tenant stub may already have been reaped.
      void error;
    }
    await rm(root, { recursive: true, force: true });
  }
});
