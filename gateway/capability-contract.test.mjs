/**
 * Capability contract: the sockets, their route tables, the tenant key, and the
 * two transport paths that must stay interchangeable.
 *
 * The migration moves a socket from the gateway process into the tenant's dsh
 * without changing what a skill sees. These cases pin both halves: every
 * capability module still declares the route table named by the registry, and
 * one real request answers identically whether it arrives on a gateway-owned
 * socket or through `/__vh/egress/*`.
 *
 * The tenant owns the delivery copy but not the authoritative one, so the cases
 * here also prove that a rewritten delivery copy cannot mint a key, change
 * ownership, or survive a sign-out. The delegated half uses the plugin's built
 * `lib/index.js`, which is the code a tenant actually runs; without that build
 * the dual-track suite skips rather than testing a stand-in.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import * as album from './album.mjs';
import * as imageStudio from './image-studio.mjs';
import * as photocraft from './photocraft.mjs';
import * as services from './services.mjs';
import * as weknora from './weknora.mjs';
import * as office from './office.mjs';
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  capabilityContractFor,
  capabilityScopeFor,
  contractPath,
  pluginOwnedCapabilities,
  readAuthoritativeContract,
  readDeliveryContract,
  rememberCapabilityContract,
  removeCapabilityContract,
  rolloutCapabilities,
  stateContractPath,
  writeCapabilityContract,
} from './capability-registry.mjs';
import { EGRESS_PREFIX, egressRefusal, handleEgress, parseEgressPath } from './egress.mjs';

const MODULES = [
  { name: 'voffice', module: office },
  { name: 'album', module: album },
  { name: 'photocraft', module: photocraft },
  { name: 'image-studio', module: imageStudio },
  { name: 'weknora', module: weknora },
  { name: 'vh-services', module: services },
];

/** Every capability this build may hand to the plugin, as a rollout. */
const ALL = CAPABILITIES.filter((entry) => entry.delegable).map((entry) => entry.name).join(',');

/** The same names as a list, for the contract and the plugin's bind set. */
const DELEGATED = ALL.split(',');

/** The plugin build under test, when this checkout built it. */
const plugin = await import(new URL('../packages/host/vh-capabilities/lib/index.js', import.meta.url))
  .catch(() => undefined);

const UID = process.getuid?.() ?? 0;
const ACCOUNT = userInfo().username;

/** Every capability module's egress entry point, as `handleEgress` dispatches. */
const HANDLERS = {
  voffice: office.handleOfficeEgress,
  album: album.handleAlbumEgress,
  photocraft: photocraft.handlePhotocraft,
  'image-studio': imageStudio.handleImageStudioEgress,
  weknora: weknora.handleWeknoraEgress,
  'vh-services': (_namespace, req, res, contract) => services.handleServicesEgress({
    subject: contract.subject,
    account: contract.account,
    uid: contract.uid,
  }, req, res),
};

/**
 * Ask one HTTP server for a path, optionally over a unix socket.
 * @param {{ socketPath?: string, port?: number, path: string, method?: string, headers?: Record<string, string> }} target
 * @returns {Promise<{ status: number, body: string, headers: import('node:http').IncomingHttpHeaders }>}
 */
function ask(target) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      ...(target.socketPath === undefined ? {} : { socketPath: target.socketPath }),
      ...(target.port === undefined ? {} : { host: '127.0.0.1', port: target.port }),
      path: target.path,
      method: target.method ?? 'GET',
      headers: target.headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 * @returns {Promise<void>}
 */
function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * @param {{ stateRoot: string, home: string, subject: string, capabilities: string[] }} options
 * @returns {Promise<{ key: string, capabilities: string[] } | undefined>}
 */
function delegate({ stateRoot, home, subject, capabilities }) {
  return writeCapabilityContract({ stateRoot, home, subject, account: ACCOUNT, uid: UID, capabilities });
}

describe('capability registry', () => {
  it('names every capability socket exactly once', () => {
    const names = CAPABILITIES.map((entry) => entry.name);
    const sockets = CAPABILITIES.map((entry) => entry.socket);
    assert.equal(new Set(names).size, names.length);
    assert.equal(new Set(sockets).size, sockets.length);
    assert.deepEqual(
      names,
      ['voffice', 'album', 'photocraft', 'image-studio', 'weknora', 'vh-services'],
    );
  });

  it('matches each module socket to the registry', () => {
    for (const { name, module } of MODULES) {
      const entry = CAPABILITIES.find((candidate) => candidate.name === name);
      assert.equal(module.SOCKET_NAME, entry?.socket, `${name} socket drifted`);
      assert.equal(entry?.egress, true, `${name} must be egress-capable`);
      // The services panel can start and stop containers; delegation waits for
      // the cross-tenant measurement P6 requires, whatever the rollout says.
      assert.equal(entry?.delegable, name !== 'vh-services', `${name} delegability drifted`);
    }
  });

  it('declares an anchored, unique route table per capability', () => {
    const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    for (const { name, module } of MODULES) {
      assert.ok(module.ROUTES.length > 0, `${name} has no routes`);
      const seen = new Set();
      for (const route of module.ROUTES) {
        const pattern = route.path ?? route.pattern;
        assert.ok(methods.has(route.method), `${name} declares method ${route.method}`);
        assert.ok(pattern instanceof RegExp, `${name} route is not a RegExp`);
        assert.match(pattern.source, /^\^/, `${name} route ${String(pattern)} is not anchored`);
        const key = `${route.method} ${pattern.source}`;
        assert.equal(seen.has(key), false, `${name} repeats ${key}`);
        seen.add(key);
      }
    }
  });

  it('reads rollout from the deployment and drops names it cannot serve', () => {
    assert.deepEqual(rolloutCapabilities({}), ['image-studio']);
    assert.deepEqual(rolloutCapabilities({ VH_PLUGIN_CAPABILITIES: 'image-studio, voffice' }), [
      'image-studio',
      'voffice',
    ]);
    // `vh-services` stays on the gateway until P6 measures container isolation,
    // so listing it must not move the listener.
    assert.deepEqual(rolloutCapabilities({ VH_PLUGIN_CAPABILITIES: 'vh-services,nope,image-studio' }), [
      'image-studio',
    ]);
    assert.deepEqual(rolloutCapabilities({ VH_PLUGIN_CAPABILITIES: 'image-studio,image-studio' }), [
      'image-studio',
    ]);
  });

  it('lets one namespace widen or narrow the global rollout without touching another', () => {
    const env = {
      VH_PLUGIN_CAPABILITIES: 'image-studio',
      VH_PLUGIN_CAPABILITIES_BY_NAMESPACE: '{"ns-a":"voffice","ns-b":["album","nope"]}',
    };
    assert.deepEqual(rolloutCapabilities(env, 'ns-a'), ['voffice']);
    assert.deepEqual(rolloutCapabilities(env, 'ns-b'), ['album']);
    assert.deepEqual(rolloutCapabilities(env, 'ns-c'), ['image-studio']);
    assert.deepEqual(rolloutCapabilities({ VH_PLUGIN_CAPABILITIES_BY_NAMESPACE: 'not json' }), ['image-studio']);
    assert.deepEqual(rolloutCapabilities({ VH_PLUGIN_CAPABILITIES_BY_NAMESPACE: '["a"]' }), ['image-studio']);
  });
});

describe('tenant capability contract', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let stateRoot;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'vh-capability-contract-'));
    stateRoot = join(root, 'state');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes a root-owned authoritative copy and a tenant-owned delivery copy', async () => {
    const home = join(root, 'tenant-a');
    const written = await delegate({ stateRoot, home, subject: 'subject-a', capabilities: ['image-studio', 'voffice'] });
    assert.deepEqual(written?.capabilities, ['image-studio', 'voffice']);

    const authoritative = await stat(stateContractPath(stateRoot, 'subject-a'));
    assert.equal(authoritative.mode & 0o777, 0o600);
    const delivered = await stat(contractPath(home));
    assert.equal(delivered.mode & 0o777, 0o600);

    const raw = JSON.parse(await readFile(contractPath(home), 'utf8'));
    assert.equal(raw.version, CONTRACT_VERSION);
    assert.equal(raw.key, written?.key);
    assert.equal((await readAuthoritativeContract(stateRoot, 'subject-a'))?.key, written?.key);
    assert.equal((await readDeliveryContract(home))?.key, written?.key);

    const again = await delegate({ stateRoot, home, subject: 'subject-a', capabilities: ['image-studio'] });
    assert.equal(again?.key, written?.key, 'a relaunch must not invalidate a live plugin');
  });

  it('does not let the tenant-authored copy mint a key or widen ownership', async () => {
    const home = join(root, 'tenant-forged');
    const contract = await delegate({ stateRoot, home, subject: 'subject-forged', capabilities: ['image-studio'] });
    rememberCapabilityContract('subject-forged', {
      home,
      namespace: 'namespace-forged',
      subject: 'subject-forged',
      ...contract,
    });
    const forged = 'e'.repeat(64);
    await writeFile(
      contractPath(home),
      JSON.stringify({ version: CONTRACT_VERSION, key: forged, capabilities: ['voffice'] }),
      { mode: 0o600 },
    );
    assert.equal(capabilityContractFor(forged), undefined, 'a self-minted key is not accepted');
    assert.deepEqual(
      [...(await pluginOwnedCapabilities({
        stateRoot, subject: 'subject-forged', namespace: 'namespace-forged', shipped: true, env: {},
      }))],
      ['image-studio'],
      'ownership follows the authoritative copy, not the delivery copy',
    );
  });

  it('ignores a delivery copy other users could read without losing ownership', async () => {
    const home = join(root, 'tenant-wide');
    const contract = await delegate({ stateRoot, home, subject: 'subject-wide', capabilities: ['image-studio'] });
    assert.ok(contract !== undefined);
    await chmod(contractPath(home), 0o644);
    assert.equal(await readDeliveryContract(home), undefined);
    assert.deepEqual(
      [...(await pluginOwnedCapabilities({
        stateRoot, subject: 'subject-wide', namespace: 'ns', shipped: true, env: {},
      }))],
      ['image-studio'],
    );
  });

  it('ignores a malformed or oversized authoritative contract', async () => {
    const subject = 'subject-bad';
    const path = stateContractPath(stateRoot, subject);
    await mkdir(join(stateRoot, 'capabilities'), { recursive: true, mode: 0o700 });
    const cases = [
      'not json',
      JSON.stringify({ version: 2, key: 'a'.repeat(64), capabilities: ['image-studio'] }),
      JSON.stringify({ version: CONTRACT_VERSION, key: 'short', capabilities: ['image-studio'] }),
      JSON.stringify({ version: CONTRACT_VERSION, key: 'k'.repeat(64), capabilities: 'image-studio' }),
      JSON.stringify({ version: CONTRACT_VERSION, key: 'k'.repeat(64), capabilities: ['nope'] }),
      'x'.repeat(70 * 1024),
    ];
    for (const body of cases) {
      await writeFile(path, body, { mode: 0o600 });
      assert.equal(await readAuthoritativeContract(stateRoot, subject), undefined, body.slice(0, 40));
    }
  });

  it('never follows a symlink or blocks on a FIFO', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX file types');
      return;
    }
    const first = await delegate({ stateRoot, home: join(root, 'tenant-link-a'), subject: 'subject-link-a', capabilities: ['image-studio'] });
    assert.ok(first !== undefined);
    const linked = stateContractPath(stateRoot, 'subject-link-b');
    await mkdir(join(stateRoot, 'capabilities'), { recursive: true, mode: 0o700 });
    await symlink(stateContractPath(stateRoot, 'subject-link-a'), linked);
    assert.equal(await readAuthoritativeContract(stateRoot, 'subject-link-b'), undefined);

    await rm(linked, { force: true });
    execFileSync('mkfifo', [linked]);
    const started = Date.now();
    assert.equal(await readAuthoritativeContract(stateRoot, 'subject-link-b'), undefined);
    assert.ok(Date.now() - started < 2_000, 'reading a FIFO must not wait for a writer');
  });

  it('derives ownership from the authoritative copy, rollout, and image', async () => {
    const home = join(root, 'tenant-owned');
    const contract = await delegate({ stateRoot, home, subject: 'subject-owned', capabilities: ['image-studio', 'voffice'] });
    assert.ok(contract !== undefined);
    const owned = (env = {}) => pluginOwnedCapabilities({
      stateRoot, subject: 'subject-owned', namespace: 'ns-owned', shipped: true, env,
    });
    assert.deepEqual([...(await owned({ VH_PLUGIN_CAPABILITIES: 'image-studio' }))], ['image-studio']);
    assert.deepEqual([...(await owned({ VH_PLUGIN_CAPABILITIES: 'voffice' }))], ['voffice']);
    assert.deepEqual([...(await owned({ VH_PLUGIN_CAPABILITIES: 'album' }))], []);
    assert.deepEqual([...(await pluginOwnedCapabilities({
      stateRoot, subject: 'subject-owned', namespace: 'ns-owned', shipped: false,
    }))], []);
  });

  it('removes both copies and revokes the key', async () => {
    const home = join(root, 'tenant-rollback');
    const contract = await delegate({ stateRoot, home, subject: 'subject-rollback', capabilities: ['image-studio'] });
    assert.ok(contract !== undefined);
    rememberCapabilityContract('subject-rollback', {
      home, namespace: 'ns-rollback', subject: 'subject-rollback', ...contract,
    });
    assert.equal(capabilityContractFor(contract.key)?.namespace, 'ns-rollback');

    await removeCapabilityContract({ stateRoot, home, subject: 'subject-rollback' });
    assert.equal(await readAuthoritativeContract(stateRoot, 'subject-rollback'), undefined);
    assert.equal(await readDeliveryContract(home), undefined);
    assert.equal(capabilityContractFor(contract.key), undefined, 'removal must drop the key index');
  });

  it('authorises a known key only for the rollout of its own namespace', async () => {
    const home = join(root, 'tenant-key');
    const contract = await delegate({ stateRoot, home, subject: 'subject-key', capabilities: ['image-studio', 'voffice'] });
    assert.ok(contract !== undefined);
    rememberCapabilityContract('subject-key', {
      home, namespace: 'ns-key', subject: 'subject-key', ...contract,
    });
    const env = { VH_PLUGIN_CAPABILITIES: 'image-studio' };
    assert.equal(capabilityContractFor(contract.key)?.namespace, 'ns-key');
    assert.deepEqual([...capabilityScopeFor(contract.key, env)], ['image-studio']);
    assert.deepEqual([...capabilityScopeFor(contract.key, {
      VH_PLUGIN_CAPABILITIES: 'image-studio',
      VH_PLUGIN_CAPABILITIES_BY_NAMESPACE: '{"ns-key":"voffice"}',
    })], ['voffice']);
    assert.equal(capabilityScopeFor(contract.key, { VH_PLUGIN_CAPABILITIES: 'album' }).size, 0);
    assert.equal(capabilityContractFor('f'.repeat(64)), undefined);
    assert.equal(capabilityContractFor('short'), undefined);
  });
});

describe('egress transport', () => {
  it('splits the capability from the path it serves', () => {
    assert.deepEqual(parseEgressPath('/__vh/egress/image-studio/api/v1/about'), {
      capability: 'image-studio',
      path: '/api/v1/about',
    });
    assert.deepEqual(parseEgressPath('/__vh/egress/image-studio'), { capability: 'image-studio', path: '/' });
    assert.equal(parseEgressPath('/__vh/egress/'), undefined);
    assert.equal(parseEgressPath('/__vh/egress'), undefined);
    assert.equal(parseEgressPath('/__vh/other'), undefined);
    assert.equal(parseEgressPath('/__vh/egress//x'), undefined);
  });

  it('refuses browsers, foreign hosts, and traversal before looking at the key', () => {
    const base = { host: '127.0.0.1:8080', remoteAddress: '127.0.0.1', capability: 'image-studio', path: '/api' };
    assert.deepEqual(
      egressRefusal({ ...base, headers: { host: base.host, origin: 'https://evil.example' } }),
      { status: 403, error: 'browser-forbidden' },
    );
    assert.deepEqual(
      egressRefusal({ ...base, headers: { host: base.host, 'sec-fetch-site': 'none' } }),
      { status: 403, error: 'browser-forbidden' },
    );
    assert.deepEqual(
      egressRefusal({ ...base, headers: { host: base.host }, remoteAddress: '192.168.64.2' }),
      { status: 403, error: 'not-loopback' },
    );
    assert.deepEqual(
      egressRefusal({ ...base, headers: {} }),
      { status: 403, error: 'host-forbidden' },
    );
    assert.deepEqual(
      egressRefusal({ ...base, headers: { host: 'evil.example' } }),
      { status: 403, error: 'host-forbidden' },
    );
    assert.deepEqual(
      egressRefusal({ ...base, headers: { host: base.host }, path: '/../voffice/x' }),
      { status: 400, error: 'path-forbidden' },
    );
    assert.deepEqual(
      egressRefusal({ ...base, headers: { host: base.host }, path: '/%2e%2e/voffice/x' }),
      { status: 400, error: 'path-forbidden' },
    );
    assert.deepEqual(
      egressRefusal({ ...base, headers: { host: base.host }, path: '/a\\b' }),
      { status: 400, error: 'path-forbidden' },
    );
    assert.deepEqual(
      egressRefusal({ ...base, headers: { host: base.host }, path: '/%zz' }),
      { status: 400, error: 'path-forbidden' },
    );
    assert.deepEqual(
      egressRefusal({ ...base, headers: { host: base.host }, capability: '' }),
      { status: 404, error: 'capability-unknown' },
    );
    assert.equal(egressRefusal({ ...base, headers: { host: base.host } }), undefined);
    assert.equal(egressRefusal({ ...base, headers: { host: 'localhost:8080' } }), undefined);
    assert.equal(egressRefusal({ ...base, headers: { host: '[::1]:8080' }, remoteAddress: '::ffff:127.0.0.1' }), undefined);
    assert.equal(EGRESS_PREFIX, '/__vh/egress/');
  });
});

describe('dual-track capability sockets', () => {
  /** @type {import('node:http').Server} */
  let upstream;
  /** @type {string} */
  let root;
  /** @type {string} */
  let key;
  /** @type {number} */
  let egressPort;
  /** @type {import('node:http').Server} */
  let egressServer;
  /** @type {{ close(): Promise<void> } | undefined} */
  let servers;

  before(async () => {
    upstream = createServer((req, res) => {
      const body = JSON.stringify({ method: req.method, url: req.url });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
    });
    await listen(upstream);
    const address = upstream.address();
    assert.ok(address !== null && typeof address === 'object');
    process.env.VH_IMAGE_STUDIO_URL = `http://127.0.0.1:${String(address.port)}`;

    root = await mkdtemp(join(tmpdir(), 'vh-dual-track-'));
    const contract = await delegate({ stateRoot: join(root, 'state'), home: join(root, 'home'), subject: 'subject-track', capabilities: DELEGATED });
    assert.ok(contract !== undefined);
    key = contract.key;
    rememberCapabilityContract('subject-track', {
      home: join(root, 'home'),
      namespace: 'namespace-track',
      subject: 'subject-track',
      account: ACCOUNT,
      uid: UID,
      ...contract,
    });
    // A fresh module instance reads the upstream address set above.
    const capability = await import(`./image-studio.mjs?dual-track=${String(Date.now())}`);
    const handlers = { ...HANDLERS, 'image-studio': capability.handleImageStudioEgress };
    egressServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      void handleEgress(req, res, url, handlers, { VH_PLUGIN_CAPABILITIES: ALL });
    });
    await listen(egressServer);
    const egressAddress = egressServer.address();
    assert.ok(egressAddress !== null && typeof egressAddress === 'object');
    egressPort = egressAddress.port;
  });

  after(async () => {
    await servers?.close();
    await new Promise((resolve) => egressServer.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
    delete process.env.VH_IMAGE_STUDIO_URL;
  });

  it('answers the same fields on a gateway socket and through the real plugin', async (t) => {
    if (plugin === undefined) {
      t.skip('packages/host/vh-capabilities/lib is not built');
      return;
    }
    // The gateway-owned socket for the direct half.
    const gatewaySocket = join(root, 'gateway.sock');
    const capability = await import(`./image-studio.mjs?dual-track-gateway=${String(Date.now())}`);
    const gatewayServer = createServer((req, res) => {
      void capability.handleImageStudioEgress('namespace-track', req, res);
    });
    await new Promise((resolve, reject) => {
      gatewayServer.once('error', reject);
      gatewayServer.listen(gatewaySocket, () => resolve());
    });

    // The tenant-owned sockets, served by the built plugin a tenant runs.
    servers = await plugin.startCapabilityServers({
      directory: join(root, 'home'),
      capabilities: DELEGATED,
      gatewayUrl: `http://127.0.0.1:${String(egressPort)}`,
      key,
    });
    const path = '/api/v1/about';
    const [direct, delegated] = await Promise.all([
      ask({ socketPath: gatewaySocket, path }),
      ask({ socketPath: join(root, 'home', 'image-studio.sock'), path }),
    ]);
    assert.equal(direct.status, 200);
    assert.equal(delegated.status, 200);
    assert.deepEqual(JSON.parse(delegated.body), JSON.parse(direct.body));
    assert.equal(delegated.headers['content-type'], direct.headers['content-type']);

    await new Promise((resolve) => gatewayServer.close(resolve));
  });

  it('forwards every capability socket through the capability prefix', async (t) => {
    if (plugin === undefined) {
      t.skip('packages/host/vh-capabilities/lib is not built');
      return;
    }
    if (servers === undefined) {
      servers = await plugin.startCapabilityServers({
        directory: join(root, 'home'),
        capabilities: DELEGATED,
        gatewayUrl: `http://127.0.0.1:${String(egressPort)}`,
        key,
      });
    }
    for (const entry of CAPABILITIES) {
      // `vh-services` is gateway-held: the plugin must not even have a socket
      // for it, so dialing one here would answer ENOENT instead of a refusal.
      if (!entry.delegable) continue;
      const answer = await ask({
        socketPath: join(root, 'home', entry.socket),
        path: '/nope',
      });
      // The plugin forwarded a path the capability's own route table refuses;
      // an unforwarded request would have produced a different failure.
      assert.equal(answer.status, 403, `${entry.name} was not forwarded`);
      assert.match(answer.body, /route-not-(allowed|found)/);
    }

    const missing = await ask({ port: egressPort, path: `/__vh/egress/image-studio${'/api/v1/about'}` });
    assert.equal(missing.status, 401, 'egress must not answer without a capability key');
    const invalid = await ask({
      port: egressPort,
      path: '/__vh/egress/image-studio/api/v1/about',
      headers: { 'x-vh-capability-key': 'f'.repeat(64) },
    });
    assert.equal(invalid.status, 401);
    const browser = await ask({
      port: egressPort,
      path: '/__vh/egress/image-studio/api/v1/about',
      headers: { 'x-vh-capability-key': key, origin: 'https://evil.example' },
    });
    assert.equal(browser.status, 403);
  });
});

describe('delegated capability dispatch', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let key;
  /** @type {import('node:http').Server} */
  let egressServer;
  /** @type {number} */
  let port;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'vh-dispatch-'));
    const contract = await delegate({
      stateRoot: join(root, 'state'),
      home: join(root, 'home'),
      subject: 'subject-dispatch',
      capabilities: DELEGATED,
    });
    assert.ok(contract !== undefined);
    key = contract.key;
    rememberCapabilityContract('subject-dispatch', {
      home: join(root, 'home'),
      namespace: 'namespace-dispatch',
      subject: 'subject-dispatch',
      account: ACCOUNT,
      uid: UID,
      ...contract,
    });
    const handlers = { ...HANDLERS };
    egressServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      void handleEgress(req, res, url, handlers, { VH_PLUGIN_CAPABILITIES: ALL });
    });
    await listen(egressServer);
    const address = egressServer.address();
    assert.ok(address !== null && typeof address === 'object');
    port = address.port;
  });

  after(async () => {
    await new Promise((resolve) => egressServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  it('routes every delegated capability to its own module', async () => {
    const headers = { 'x-vh-capability-key': key };
    const origin = await ask({ port, path: '/__vh/egress/voffice/__vh/origin', headers });
    assert.equal(origin.status, 200);
    assert.deepEqual(JSON.parse(origin.body), { origin: '' });

    for (const capability of ['album', 'photocraft', 'image-studio', 'weknora']) {
      const answer = await ask({ port, path: `/__vh/egress/${capability}/nope`, headers });
      assert.equal(answer.status, 403, `${capability} must refuse the route before any upstream`);
      assert.equal(JSON.parse(answer.body).error, 'route-not-allowed');
    }

    // `vh-services` is not delegable: even a deployment that lists it in the
    // rollout must refuse its egress path before reaching the handler.
    const list = await ask({ port, path: '/__vh/egress/vh-services/services', headers });
    assert.equal(list.status, 403);
    assert.equal(JSON.parse(list.body).error, 'capability-not-enabled');
  });

  it('refuses a capability the namespace rollout no longer enables', async () => {
    const answer = await ask({
      port,
      path: '/__vh/egress/voffice/__vh/origin',
      headers: { 'x-vh-capability-key': key },
    });
    assert.equal(answer.status, 200, 'the dispatch fixture enables every capability');

    const narrow = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      void handleEgress(req, res, url, { voffice: office.handleOfficeEgress }, { VH_PLUGIN_CAPABILITIES: 'image-studio' });
    });
    await listen(narrow);
    const wide = narrow.address();
    assert.ok(wide !== null && typeof wide === 'object');
    const denied = await ask({
      port: wide.port,
      path: '/__vh/egress/voffice/__vh/origin',
      headers: { 'x-vh-capability-key': key },
    });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).error, 'capability-not-enabled');
    await new Promise((resolve) => narrow.close(resolve));
  });

  it('refuses the services socket when the contract carries no identity', async () => {
    const answer = await new Promise((resolve) => {
      const res = {
        /** @type {number | undefined} */
        status: undefined,
        writeHead(status) { this.status = status; },
        end(body) { resolve({ status: this.status, body: String(body) }); },
      };
      void services.handleServicesEgress(undefined, { url: '/services', method: 'GET', headers: {} }, res);
    });
    assert.equal(answer.status, 500);
    assert.equal(JSON.parse(answer.body).error, 'capability-identity-unavailable');
  });
});
