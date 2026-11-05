/**
 * Upgrade-path tests: the only place the capability yields a raw byte stream.
 *
 * The assertions are about ordering as much as about status codes. A refusal
 * must arrive without the proxy having opened the host daemon socket at all,
 * because after `101` there is no API shape left to filter.
 *
 * @module v-harness/gateway/docker-upgrade.test
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer, connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyUpgrade, handleTenantRequest, handleTenantUpgrade } from './docker-proxy.mjs';

const ALICE_ID = 'a'.repeat(64);
const BOB_ID = 'b'.repeat(64);

/** @type {{ subject: string, account: string, uid: number, home: string }} */
const alice = { subject: 'sub-a', account: 'alice', uid: 1001, home: '/data/alice' };
/** @type {{ subject: string, account: string, uid: number, home: string }} */
const bob = { subject: 'sub-b', account: 'bob', uid: 1002, home: '/data/bob' };

/** @type {string} */
let daemonPath;
/** @type {string} */
let workdir;

/** What the fake daemon was actually asked to do. */
const seen = {
  upgrades: /** @type {string[]} */ ([]),
  requests: /** @type {string[]} */ ([]),
  /** Bytes that arrived after the upgrade was accepted, i.e. the tunnel body. */
  stream: /** @type {string[]} */ ([]),
  connections: 0,
};

/**
 * @param {string} path
 * @returns {string}
 */
function replyFor(path) {
  if (path.startsWith('/containers/json')) {
    return JSON.stringify([
      { Id: ALICE_ID, Names: ['/vh-alice-web'] },
      { Id: BOB_ID, Names: ['/vh-bob-web'] },
    ]);
  }
  if (path === '/exec/e1/json') return JSON.stringify({ ContainerID: ALICE_ID });
  if (path === '/exec/e2/json') return JSON.stringify({ ContainerID: BOB_ID });
  return '{}';
}

/**
 * A daemon stand-in that records each connection, so a test can assert that a
 * refused upgrade never reached it.
 * @returns {Promise<import('node:net').Server>}
 */
function startDaemon() {
  return new Promise((resolve) => {
    const server = createNetServer((socket) => {
      seen.connections += 1;
      let buffer = '';
      let handled = false;
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1 || handled) return;
        handled = true;
        const head = buffer.slice(0, end);
        const [method, path] = head.split('\r\n')[0].split(' ');
        seen.requests.push(`${method} ${path}`);
        if (/^upgrade: tcp/im.test(head)) {
          seen.upgrades.push(path);
          socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
          socket.write('STREAM-OPEN');
          // Whatever shared the first TCP segment with the request line is
          // tunnel data too; it never becomes a second request to the daemon.
          const rest = buffer.slice(end + 4);
          if (rest !== '') seen.stream.push(rest);
          socket.on('data', (chunk) => { seen.stream.push(chunk.toString('utf8')); });
          return;
        }
        const body = replyFor(path);
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
    });
    server.listen(daemonPath, () => resolve(server));
  });
}

/**
 * @param {{ subject: string, account: string, uid: number, home: string }} tenant
 * @returns {Promise<import('node:http').Server>}
 */
function startProxy(tenant) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => { void handleTenantRequest(tenant, req, res); });
    server.on('upgrade', (req, socket, head) => {
      void handleTenantUpgrade(tenant, req, socket, head).catch(() => { socket.destroy(); });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Send a raw upgrade and collect whatever the proxy answers before the socket
 * closes (or the timeout fires).
 * @param {number} port
 * @param {string} path
 * @returns {Promise<string>}
 */
function rawUpgrade(port, path, extra = '') {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    socket.on('connect', () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`);
      if (extra !== '') socket.write(extra);
    });
    setTimeout(() => { socket.destroy(); }, 400);
  });
}

/** @type {import('node:net').Server} */
let daemon;
/** @type {import('node:http').Server} */
let aliceProxy;
/** @type {import('node:http').Server} */
let bobProxy;
/** @type {number} */
let alicePort;
/** @type {number} */
let bobPort;

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vh-upgrade-'));
  daemonPath = join(workdir, 'docker.sock');
  process.env.VH_DOCKER_SOCK = daemonPath;
  daemon = await startDaemon();
  aliceProxy = await startProxy(alice);
  bobProxy = await startProxy(bob);
  alicePort = /** @type {{ port: number }} */ (aliceProxy.address()).port;
  bobPort = /** @type {{ port: number }} */ (bobProxy.address()).port;
});

after(async () => {
  aliceProxy?.close();
  bobProxy?.close();
  daemon?.close();
  await rm(workdir, { recursive: true, force: true });
  delete process.env.VH_DOCKER_SOCK;
});

describe('upgrade classification', () => {
  it('admits attaching to a container and starting an exec', () => {
    assert.equal(classifyUpgrade('/v1.43/containers/web/attach?stream=1').action, 'allow');
    assert.equal(classifyUpgrade('/exec/abc/start').action, 'allow');
  });

  it('refuses every other upgrade', () => {
    for (const path of ['/grpc', '/containers/web/start', '/containers/web/attach/x', '/exec/abc/json']) {
      assert.equal(classifyUpgrade(path).action, 'deny', path);
    }
  });
});

describe('upgrade forwarding', () => {
  it('forwards an attach for the tenant own container', async () => {
    const before = seen.connections;
    const out = await rawUpgrade(alicePort, '/v1.43/containers/vh-alice-web/attach?stream=1');
    assert.match(out, /^HTTP\/1\.1 101/);
    assert.ok(out.includes('STREAM-OPEN'));
    assert.ok(seen.upgrades.includes('/containers/vh-alice-web/attach?stream=1'));
    assert.equal(seen.connections, before + 1);
  });

  it('refuses attaching to another tenant container without dialing the daemon', async () => {
    const before = seen.connections;
    const out = await rawUpgrade(bobPort, '/containers/vh-alice-web/attach');
    assert.match(out, /^HTTP\/1\.1 403/);
    assert.equal(seen.connections, before);
  });

  it('refuses attaching to a shared container', async () => {
    const before = seen.connections;
    const out = await rawUpgrade(alicePort, '/containers/vh-shared-db/attach');
    assert.match(out, /^HTTP\/1\.1 403/);
    assert.equal(seen.connections, before);
  });

  it('refuses BuildKit gRPC and non-attach upgrades without dialing the daemon', async () => {
    for (const path of ['/grpc', '/containers/vh-alice-web/start']) {
      const before = seen.connections;
      const out = await rawUpgrade(alicePort, path);
      assert.match(out, /^HTTP\/1\.1 501/, path);
      assert.equal(seen.connections, before, path);
    }
  });

  it('forwards an exec that belongs to the tenant own container', async () => {
    const out = await rawUpgrade(alicePort, '/exec/e1/start');
    assert.match(out, /^HTTP\/1\.1 101/);
    assert.ok(seen.upgrades.includes('/exec/e1/start'));
  });

  it('refuses an exec that belongs to another tenant container', async () => {
    const out = await rawUpgrade(alicePort, '/exec/e2/start');
    assert.match(out, /^HTTP\/1\.1 403/);
    assert.ok(!seen.upgrades.includes('/exec/e2/start'));
  });

  it('refuses attaching by another tenant container id', async () => {
    const out = await rawUpgrade(alicePort, `/containers/${BOB_ID}/attach`);
    assert.match(out, /^HTTP\/1\.1 403/);
    assert.ok(!seen.upgrades.includes(`/containers/${BOB_ID}/attach`));
  });

  it('treats bytes sent right after the upgrade as tunnel data, not a second request', async () => {
    const before = seen.connections;
    await rawUpgrade(alicePort, '/containers/vh-alice-web/attach', 'POST /containers/create HTTP/1.1\r\n\r\n');
    assert.equal(seen.connections, before + 1);
    assert.ok(!seen.requests.some((line) => line.includes('/containers/create')));
    assert.ok(seen.stream.join('').includes('POST /containers/create'));
  });

  it('refuses a path traversal attempt in the container reference', async () => {
    const before = seen.connections;
    const out = await rawUpgrade(alicePort, '/containers/vh-alice-web/../vh-bob-web/attach');
    assert.match(out, /^HTTP\/1\.1 501/);
    assert.equal(seen.connections, before);
  });

  it('refuses a doubled slash before the endpoint', async () => {
    const before = seen.connections;
    const out = await rawUpgrade(alicePort, '//containers/vh-bob-web/attach');
    assert.match(out, /^HTTP\/1\.1 501/);
    assert.equal(seen.connections, before);
  });

  it('refuses a reference with trailing junk', async () => {
    const out = await rawUpgrade(alicePort, '/containers/vh-bob-web/attach%20');
    assert.match(out, /^HTTP\/1\.1 501/);
  });

  it('refuses an exec id that tries to reshape the daemon path', async () => {
    const out = await rawUpgrade(alicePort, '/exec/..%2Fjson/start');
    assert.match(out, /^HTTP\/1\.1 403/);
  });

  it('never turns an encoded slash into another tenant path', async () => {
    const out = await rawUpgrade(alicePort, '/containers/vh-alice-web%2F..%2Fvh-bob-web/attach');
    assert.ok(
      !seen.upgrades.some((path) => path === '/containers/vh-bob-web/attach'),
      'the daemon must never be asked for bob\'s path',
    );
    if (/^HTTP\/1\.1 101/.test(out)) {
      assert.ok(seen.upgrades.some((path) => path.includes('%2F')), 'forwarded as one opaque name');
    } else {
      assert.match(out, /^HTTP\/1\.1 (403|501)/);
    }
  });
});
