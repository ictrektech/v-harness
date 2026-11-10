/**
 * Capability ownership: a contract records intent, not a listener.
 *
 * These cases pin the probe and the fallback that keep a skill from dialing a
 * path nobody serves. A delegated socket that answers is left to the plugin; a
 * delegated socket that does not answer while the tenant runs is taken back,
 * contract and key included; a tenant that is not running keeps its contract
 * for the next launch.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  CAPABILITIES,
  capabilityContractFor,
  readAuthoritativeContract,
  readDeliveryContract,
  rememberCapabilityContract,
  writeCapabilityContract,
} from './capability-registry.mjs';
import { capabilitySocketAnswers, missingCapabilitySockets, startOwnedCapabilities } from './capability-ownership.mjs';

const UID = process.getuid?.() ?? 0;
const ENV = { VH_PLUGIN_CAPABILITIES: 'image-studio' };

describe('capability socket probe', () => {
  /** @type {string} */
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'vh-capability-probe-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts a live listener the tenant owns and rejects anything else', async () => {
    const live = join(root, 'live.sock');
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(live, () => resolve());
    });
    assert.equal(await capabilitySocketAnswers(live, UID), true);
    await new Promise((resolve) => { server.close(() => { resolve(); }); });

    await writeFile(join(root, 'regular.sock'), '');
    assert.equal(await capabilitySocketAnswers(join(root, 'regular.sock'), UID), false, 'a regular file is not a socket');
    assert.equal(await capabilitySocketAnswers(join(root, 'absent.sock'), UID), false);
    assert.equal(await capabilitySocketAnswers(join(root, 'absent.sock'), UID + 1), false);
  });

  it('rejects a stale inode a killed plugin left behind', async () => {
    const stale = join(root, 'stale.sock');
    const child = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${JSON.stringify(stale)}, () => console.log('ready')); setInterval(() => {}, 1000);`],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await once(child.stdout, 'data');
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.equal(existsSync(stale), true, 'SIGKILL leaves the socket file behind');
    assert.equal(await capabilitySocketAnswers(stale, UID), false, 'an inode without a listener must not pass');
  });

  it('waits the bounded budget before reporting a missing socket', async () => {
    const missing = await missingCapabilitySockets(['image-studio'], {
      home: root,
      uid: UID,
      attempts: 3,
      delayMs: 1,
    });
    assert.deepEqual(missing, [{ name: 'image-studio', socketPath: join(root, '.dsh', 'image-studio.sock') }]);
  });
});

describe('capability ownership at launch', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let stateRoot;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'vh-capability-ownership-'));
    stateRoot = join(root, 'state');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * One tenant's launch inputs and recording binders.
   * @param {string} subject
   * @param {string} home
   * @returns {{ options: Record<string, unknown>, bind: Record<string, () => Promise<void>>, bindDocker: () => Promise<void>, calls: string[], forget: Record<string, (target: string) => void>, forgot: string[] }}
   */
  function fixture(subject, home) {
    const calls = [];
    const forgot = [];
    const bind = Object.fromEntries(CAPABILITIES.map((entry) => [
      entry.name,
      async () => { calls.push(entry.name); },
    ]));
    return {
      options: { subject, namespace: `namespace-${subject}`, home, uid: UID },
      bind,
      bindDocker: async () => { calls.push('docker'); },
      calls,
      forget: Object.fromEntries(CAPABILITIES.map((entry) => [
        entry.name,
        (target) => { forgot.push(target); },
      ])),
      forgot,
    };
  }

  /**
   * Publish one live capability socket for a tenant home.
   * @param {string} home
   * @param {string} name
   * @returns {Promise<import('node:net').Server>}
   */
  async function serveSocket(home, name) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(home, '.dsh', `${name}.sock`), () => resolve());
    });
    return server;
  }

  it('leaves an answering delegated socket to the plugin and binds the rest', async () => {
    const home = join(root, 'tenant-live');
    const contract = await writeCapabilityContract({
      stateRoot,
      home,
      subject: 'subject-live',
      capabilities: ['image-studio'],
    });
    assert.ok(contract !== undefined);
    rememberCapabilityContract('subject-live', { home, namespace: 'namespace-subject-live', ...contract });
    const { options, bind, bindDocker, calls, forget } = fixture('subject-live', home);
    const server = await serveSocket(home, 'image-studio');
    try {
      const result = await startOwnedCapabilities({
        stateRoot,
        shipped: true,
        env: ENV,
        options,
        bind,
        bindDocker,
        forget,
        probe: { attempts: 1, delayMs: 0 },
      });
      assert.deepEqual([...result.delegated], ['image-studio']);
      assert.equal(result.takenBack, false);
      assert.deepEqual(result.missing, []);
      assert.equal(calls.includes('image-studio'), false, 'a delegated socket must not be rebound');
      assert.equal(calls.includes('voffice'), true);
      assert.equal(calls.includes('docker'), true);
      assert.ok(await readAuthoritativeContract(stateRoot, 'subject-live'));
    } finally {
      await new Promise((resolve) => { server.close(() => { resolve(); }); });
    }
  });

  it('takes the capability back when a running tenant has no listener', async () => {
    const home = join(root, 'tenant-dead');
    const contract = await writeCapabilityContract({
      stateRoot,
      home,
      subject: 'subject-dead',
      capabilities: ['image-studio'],
    });
    assert.ok(contract !== undefined);
    rememberCapabilityContract('subject-dead', { home, namespace: 'namespace-subject-dead', ...contract });
    const { options, bind, bindDocker, calls, forget, forgot } = fixture('subject-dead', home);
    const result = await startOwnedCapabilities({
      stateRoot,
      shipped: true,
      env: ENV,
      options,
      bind,
      bindDocker,
      forget,
      tenantRunning: async () => true,
      probe: { attempts: 2, delayMs: 1 },
      logger: { error: () => {} },
    });
    assert.deepEqual([...result.delegated], []);
    assert.deepEqual(result.missing, ['image-studio']);
    assert.equal(result.takenBack, true);
    assert.equal(calls.includes('image-studio'), true, 'the gateway must bind what it took back');
    assert.equal(calls.includes('voffice'), true);
    assert.equal(forgot.every((subject) => subject === 'subject-dead'), true, 'every cached listener is dropped');
    assert.equal(forgot.length, CAPABILITIES.length);
    assert.equal(await readAuthoritativeContract(stateRoot, 'subject-dead'), undefined);
    assert.equal(await readDeliveryContract(home), undefined);
    assert.equal(capabilityContractFor(contract.key), undefined, 'a taken-back key must stop authorizing');
  });

  it('keeps the contract when the tenant is not running', async () => {
    const home = join(root, 'tenant-offline');
    const contract = await writeCapabilityContract({
      stateRoot,
      home,
      subject: 'subject-offline',
      capabilities: ['image-studio'],
    });
    assert.ok(contract !== undefined);
    const { options, bind, bindDocker, calls, forget, forgot } = fixture('subject-offline', home);
    const result = await startOwnedCapabilities({
      stateRoot,
      shipped: true,
      env: ENV,
      options,
      bind,
      bindDocker,
      forget,
      tenantRunning: async () => false,
      probe: { attempts: 1, delayMs: 0 },
      logger: { error: () => {} },
    });
    assert.deepEqual([...result.delegated], ['image-studio']);
    assert.equal(result.takenBack, false);
    assert.equal(calls.includes('image-studio'), false, 'an offline tenant keeps its socket claim');
    assert.equal(calls.includes('voffice'), true);
    assert.deepEqual(forgot, []);
    assert.ok(await readAuthoritativeContract(stateRoot, 'subject-offline'));
  });

  it('binds every capability when the image ships no plugin', async () => {
    const home = join(root, 'tenant-old');
    // An old image carries no contract, but a stale one may have survived a
    // payload rollback; `shipped: false` must ignore it and bind the gateway's
    // own sockets instead of delegating into a listener that cannot exist.
    await writeCapabilityContract({
      stateRoot,
      home,
      subject: 'subject-old',
      capabilities: ['image-studio'],
    });
    const { options, bind, bindDocker, calls } = fixture('subject-old', home);
    const result = await startOwnedCapabilities({
      stateRoot,
      shipped: false,
      env: ENV,
      options,
      bind,
      bindDocker,
      probe: { attempts: 1, delayMs: 0 },
    });
    assert.deepEqual([...result.delegated], []);
    for (const entry of CAPABILITIES) {
      assert.equal(calls.includes(entry.name), true, `${entry.name} must be served by the gateway`);
    }
    assert.equal(calls.includes('docker'), true);
  });

  it('binds a capability the rollout removed even while the contract still lists it', async () => {
    const home = join(root, 'tenant-narrowed');
    // A restart after narrowing the rollout: the previous contract still names
    // both capabilities, the rollout only enables one. The dropped one must be
    // bound by the gateway now, or the plugin socket would answer 403 forever.
    await writeCapabilityContract({
      stateRoot,
      home,
      subject: 'subject-narrowed',
      capabilities: ['image-studio', 'voffice'],
    });
    const { options, bind, bindDocker, calls } = fixture('subject-narrowed', home);
    const server = await serveSocket(home, 'image-studio');
    try {
      const result = await startOwnedCapabilities({
        stateRoot,
        shipped: true,
        env: ENV,
        options,
        bind,
        bindDocker,
        probe: { attempts: 1, delayMs: 0 },
      });
      assert.deepEqual([...result.delegated], ['image-studio']);
      assert.equal(calls.includes('voffice'), true, 'a narrowed capability returns to the gateway');
      assert.equal(calls.includes('image-studio'), false);
    } finally {
      await new Promise((resolve) => { server.close(() => { resolve(); }); });
    }
  });

  it('binds every capability once the contract is gone', async () => {
    const home = join(root, 'tenant-switched');
    // Logout and account switch delete the contract and stop the tenant; the
    // capability path must still be answered immediately, without waiting for
    // the next launch or gateway restart.
    const { options, bind, bindDocker, calls } = fixture('subject-switched', home);
    const result = await startOwnedCapabilities({
      stateRoot,
      shipped: true,
      env: ENV,
      options,
      bind,
      bindDocker,
      probe: { attempts: 1, delayMs: 0 },
    });
    assert.deepEqual([...result.delegated], []);
    for (const entry of CAPABILITIES) {
      assert.equal(calls.includes(entry.name), true, `${entry.name} must keep an answer`);
    }
    assert.equal(calls.includes('docker'), true);
  });
});
