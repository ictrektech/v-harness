import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rememberProfile, restoreProfile } from './last-good.mjs';

const root = await mkdtemp(join(tmpdir(), 'vh-last-good-'));
after(async () => { await rm(root, { recursive: true, force: true }); });

/** The tenant-and-state shape both calls take. */
function options(name) {
  const home = join(root, name, 'home');
  const stateRoot = join(root, name, 'state');
  return {
    options: { home, stateRoot, account: name, uid: process.getuid(), linuxName: String(process.getgid()) },
    home,
    patch: join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
    overlay: join(home, '.dsh', 'profiles', 'web', 'mcphub.patch.yml'),
  };
}

/**
 * Write one profile file, creating its directory.
 * @param {string} path - where the file goes.
 * @param {string} body - what it holds.
 * @returns {Promise<void>}
 */
async function put(path, body) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
}

test('a successful boot is remembered, and only the files it actually had', async () => {
  const tenant = options('alice');
  await put(tenant.patch, 'profile patch\n');

  await rememberProfile(tenant.options);

  const manifest = JSON.parse(
    await readFile(join(root, 'alice', 'state', 'last-good', 'alice', 'manifest.json'), 'utf8'),
  );
  assert.deepEqual(manifest.files, [join('.dsh', 'profiles', 'web', 'cordis.patch.yml')]);
});

test('a profile that fails is put back to the one that booted', async () => {
  const tenant = options('bob');
  await put(tenant.patch, 'good patch\n');
  await put(tenant.overlay, '- insert:\n');
  await rememberProfile(tenant.options);

  // What a broken boot looks like: the generated inputs changed underneath it.
  await writeFile(tenant.patch, 'broken patch\n');
  await writeFile(tenant.overlay, 'plugins:\n');

  assert.equal(await restoreProfile(tenant.options), true);
  assert.equal(await readFile(tenant.patch, 'utf8'), 'good patch\n');
});

test('a tracked file the snapshot never held is removed, not left behind', async () => {
  const tenant = options('carol');
  await put(tenant.patch, 'good patch\n');
  await rememberProfile(tenant.options);

  // The overlay did not exist when this profile last booted; keeping it is what
  // keeps the launch failing.
  await put(tenant.overlay, 'plugins:\n');
  assert.equal(await restoreProfile(tenant.options), true);
  await assert.rejects(readFile(tenant.overlay), /ENOENT/u);
});

test('without a snapshot there is nothing to restore', async () => {
  const tenant = options('dave');
  assert.equal(await restoreProfile(tenant.options), false);
});
