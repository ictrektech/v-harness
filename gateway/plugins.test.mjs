import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The packages every image must carry; the sync refuses a payload without them. */
const MANAGED = ['dsh-client-ui-settings-models', 'dsh-llm-pi-ai', 'dsh-api-session-controller', 'dsh-api-remotes'];

/** Age of a staging directory an interrupted copy left behind. */
const STALE_AGE_MS = 20 * 60 * 1000;

// Both roots are read when the module loads, so they are fixed before the import.
const payload = await mkdtemp(join(tmpdir(), 'vh-plugins-payload-'));
process.env.VH_PLUGIN_DIR = payload;
const installation = await mkdtemp(join(tmpdir(), 'vh-plugins-installation-'));
process.env.VH_DSH_MODULES_DIR = installation;
for (const name of MANAGED) {
  await mkdir(join(payload, name, 'lib'), { recursive: true });
  await writeFile(join(payload, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  await writeFile(join(payload, name, 'lib', 'build.txt'), 'image build');
  await mkdir(join(installation, name), { recursive: true });
  await writeFile(join(installation, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
}

const { syncClientPlugins } = await import('./plugins.mjs');

/**
 * One tenant whose profile already holds a package directory.
 * @returns {Promise<{ home: string, linuxName: string, uid: number, scope: string }>} the tenant.
 */
async function tenant() {
  const home = await mkdtemp(join(tmpdir(), 'vh-plugins-tenant-'));
  await mkdir(join(home, '.dsh', 'profiles', 'web', 'node_modules'), { recursive: true });
  const scope = join(home, '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai');
  await mkdir(scope, { recursive: true });
  return { home, linuxName: 'tenant', uid: 0, scope };
}

test('overwrites a profile copy with the image build', async () => {
  const user = await tenant();
  const target = join(user.scope, 'dsh-api-remotes');
  await mkdir(join(target, 'lib'), { recursive: true });
  await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'dsh-api-remotes', version: '0.0.0' }));
  await writeFile(join(target, 'lib', 'build.txt'), 'published build');

  await syncClientPlugins(user);

  assert.equal(await readFile(join(target, 'lib', 'build.txt'), 'utf8'), 'image build');
  await rm(user.home, { recursive: true, force: true });
});

test('removes a staging directory an interrupted copy left behind, keeping a live one', async () => {
  const user = await tenant();
  const stale = join(user.scope, 'dsh-api-remotes.vh-42-abcdef12');
  const live = join(user.scope, 'dsh-api-remotes.vh-43-abcdef34');
  await mkdir(stale, { recursive: true });
  await mkdir(live, { recursive: true });
  const old = new Date(Date.now() - STALE_AGE_MS);
  await utimes(stale, old, old);

  await syncClientPlugins(user);

  assert.equal(existsSync(stale), false);
  assert.equal((await stat(live)).isDirectory(), true);
  await rm(user.home, { recursive: true, force: true });
});
