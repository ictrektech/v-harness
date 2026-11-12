import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exchangeCookie, isJailRefusal, LaunchRefusedError, waitForLaunchUrl } from './instances.mjs';

/**
 * Reserve a loopback port and hand it back unused, so a test can listen on it
 * after a deliberately late start.
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
 * A dsh stand-in that answers every launch URL with a fixed status and cookie.
 * @param {number} status
 * @param {string} cookie
 * @returns {import('node:http').Server}
 */
function launchServer(status, cookie) {
  return createServer((_req, res) => {
    res.writeHead(status, cookie === '' ? {} : { 'set-cookie': cookie });
    res.end();
  });
}

/**
 * A stand-in dsh that stays alive while the log scanner waits.
 * @returns {import('node:child_process').ChildProcess}
 */
function aliveProcess() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

test('reads only the launch URL appended by the current attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-launch-log-'));
  const path = join(root, 'instance.log');
  const child = aliveProcess();
  try {
    await writeFile(path, 'dsh web: http://127.0.0.1:3101/?token=STALE\n', 'utf8');
    const fromOffset = (await stat(path)).size;
    const pending = waitForLaunchUrl(child, path, fromOffset, 3_000);
    await appendFile(path, 'loading plugins\ndsh web: http://127.0.0.1:3101/?token=FRESH\n', 'utf8');
    assert.equal(await pending, 'http://127.0.0.1:3101/?token=FRESH');
  } finally {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('waits for a log file that appears after the process starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-launch-late-'));
  const path = join(root, 'instance.log');
  const child = aliveProcess();
  try {
    const pending = waitForLaunchUrl(child, path, 0, 3_000);
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    await writeFile(path, 'dsh web: http://127.0.0.1:3102/?token=LATE\n', 'utf8');
    assert.equal(await pending, 'http://127.0.0.1:3102/?token=LATE');
  } finally {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('fails fast when dsh exits and times out when no URL arrives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-launch-fail-'));
  const path = join(root, 'instance.log');
  try {
    await writeFile(path, 'booting\n', 'utf8');
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await once(exited, 'exit');
    await assert.rejects(waitForLaunchUrl(exited, path, 0, 500), /exited before announcing/);

    const alive = aliveProcess();
    try {
      await assert.rejects(waitForLaunchUrl(alive, path, 0, 250), /timed out/);
    } finally {
      alive.kill('SIGKILL');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a launch that dies says what the child printed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-launch-detail-'));
  const path = join(root, 'instance.log');
  try {
    await writeFile(
      path,
      'starting\nvh-jail: isolation check failed: no usable sandbox backend in the tenant jail\n',
      'utf8',
    );
    const exited = spawn(process.execPath, ['-e', 'process.exit(97)'], { stdio: 'ignore' });
    await once(exited, 'exit');
    await assert.rejects(waitForLaunchUrl(exited, path, 0, 500), (error) => {
      assert.match(error.message, /exited before announcing its URL/);
      assert.match(error.message, /no usable sandbox backend/);
      assert.equal(error.exitCode, 97);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('quotes only the lines the current attempt appended', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vh-launch-detail-tail-'));
  const path = join(root, 'instance.log');
  try {
    await writeFile(path, 'vh-jail: isolation check failed: an earlier attempt\n', 'utf8');
    const fromOffset = (await stat(path)).size;
    await appendFile(path, 'vh-jail: pivot_root failed\n', 'utf8');
    const exited = spawn(process.execPath, ['-e', 'process.exit(97)'], { stdio: 'ignore' });
    await once(exited, 'exit');
    await assert.rejects(waitForLaunchUrl(exited, path, fromOffset, 500), (error) => {
      assert.match(error.message, /pivot_root failed/);
      assert.doesNotMatch(error.message, /an earlier attempt/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a jail refusal is reported instead of stepping the configuration ladder', () => {
  assert.equal(isJailRefusal(new LaunchRefusedError('refused', 97)), true);
  assert.equal(isJailRefusal(new LaunchRefusedError('exited by itself', 0)), false);
  assert.equal(isJailRefusal(new LaunchRefusedError('killed', null)), false);
  assert.equal(isJailRefusal(new Error('vh-jail: refused')), false);
});

test('retries a refused dial until the freshly printed listener answers', async () => {
  const port = await freePort();
  const server = launchServer(303, 'dsh-auth-test=v1; Path=/; HttpOnly');
  // The URL is printed from the listener callback, but the socket is not
  // dialable for a moment. The exchange must outlast that window instead of
  // reporting a dead instance and relaunching it.
  const late = setTimeout(() => { server.listen(port, '127.0.0.1'); }, 600);
  try {
    const result = await exchangeCookie(`http://127.0.0.1:${port}/?token=probe`, 20_000, {
      host: '127.0.0.1',
      timeoutMs: 8_000,
    });
    assert.equal(result.cookie, 'dsh-auth-test=v1');
    assert.ok(result.expiresAt > Date.now());
  } finally {
    clearTimeout(late);
    await new Promise((resolve) => { server.close(resolve); });
  }
});

test('does not replay a launch token dsh already answered', async () => {
  const port = await freePort();
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(401);
    res.end();
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  try {
    await assert.rejects(
      exchangeCookie(`http://127.0.0.1:${port}/?token=used`, 20_000, {
        host: '127.0.0.1',
        timeoutMs: 2_000,
      }),
      /dsh launch exchange returned HTTP 401/,
    );
    assert.equal(hits, 1);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});

test('rejects an exchange that carries no dsh-auth cookie', async () => {
  const port = await freePort();
  const server = launchServer(303, '');
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  try {
    await assert.rejects(
      exchangeCookie(`http://127.0.0.1:${port}/?token=probe`, 20_000, {
        host: '127.0.0.1',
        timeoutMs: 2_000,
      }),
      /no dsh-auth cookie/,
    );
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});
