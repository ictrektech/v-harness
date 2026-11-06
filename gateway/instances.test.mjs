import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { exchangeCookie } from './instances.mjs';

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
