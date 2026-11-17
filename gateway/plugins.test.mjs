import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import registryPlugins from './agent-plugins/registry-plugins.json' with { type: 'json' };

/** Deployed browser plugins every image carries; the sync refuses a payload without them. */
const MANAGED = ['dsh-client-ui-settings-models', 'dsh-llm-pi-ai', 'dsh-api-session-controller', 'dsh-api-remotes'];

/**
 * Write a package directory with its manifest.
 * @param {string} dir - package directory.
 * @param {string} name - package name.
 * @param {string} version - package version.
 * @returns {Promise<void>}
 */
async function packageDir(dir, name, version) {
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }));
  await writeFile(join(dir, 'lib', 'index.js'), '');
}

// Both payload roots are read when the module loads, so they are fixed first.
const plugins = await mkdtemp(join(tmpdir(), 'vh-plugins-'));
const agent = await mkdtemp(join(tmpdir(), 'vh-agent-plugins-'));
const installation = await mkdtemp(join(tmpdir(), 'vh-installation-'));
process.env.VH_PLUGIN_DIR = plugins;
process.env.VH_AGENT_PLUGIN_DIR = agent;
process.env.VH_DSH_MODULES_DIR = installation;
for (const name of MANAGED) {
  await packageDir(join(plugins, name), name, '0.2.1-rc.2');
  await packageDir(join(installation, name), name, '0.2.1-rc.2');
}
await writeFile(join(agent, 'manifest.json'), JSON.stringify({
  plugins: [...Object.keys(registryPlugins), 'vh-agent-plugins'],
}));
for (const [name, version] of Object.entries(registryPlugins)) {
  await packageDir(join(agent, 'node_modules', name), name, version);
}
await writeFile(join(agent, 'node_modules', 'dsh-mnemon', 'package.json'), JSON.stringify({
  name: 'dsh-mnemon', version: registryPlugins['dsh-mnemon'],
  dependencies: { 'dsh-mnemon-source-runtime': '0.5.21' },
}));
await packageDir(join(agent, 'node_modules', 'dsh-mnemon-source-runtime'), 'dsh-mnemon-source-runtime', '0.5.21');
await packageDir(join(agent, 'node_modules', 'vh-agent-plugins'), 'vh-agent-plugins', '0.0.0');

const { syncPlugins } = await import('./plugins.mjs');

// Module-level fixtures used to leak a fresh set of temp directories on every
// test run; the suite is run often enough that /tmp filled with them.
after(async () => {
  await Promise.all([plugins, agent, installation].map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * One tenant home.
 * @returns {Promise<{ home: string, linuxName: string, uid: number, profile: string }>} the tenant.
 */
async function tenant() {
  const home = await mkdtemp(join(tmpdir(), 'vh-tenant-'));
  return { home, linuxName: 'tenant', uid: 0, profile: join(home, '.dsh', 'profiles', 'web') };
}

test('a new profile declares the published payload plugins as dependencies', async () => {
  const user = await tenant();

  assert.equal(await syncPlugins(user), true);

  const manifest = JSON.parse(await readFile(join(user.profile, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, registryPlugins);
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'vh-agent-plugins', ...Object.keys(registryPlugins),
  ]);
  for (const name of Object.keys(registryPlugins)) {
    assert.equal(existsSync(join(user.profile, 'node_modules', name, 'package.json')), true, name);
  }
  assert.equal(existsSync(join(user.profile, 'node_modules', 'ds-bot')), false);
  assert.equal(existsSync(join(user.profile, 'node_modules', 'dsh-mnemon-source-runtime', 'package.json')), true);
  // The undeclared ones live in the shared layer, out of every profile install's reach.
  assert.equal(existsSync(join(user.home, '.dsh', 'profiles', 'node_modules', 'vh-agent-plugins')), true);
  assert.equal(existsSync(join(user.profile, 'node_modules', 'vh-agent-plugins')), false);
  await rm(user.home, { recursive: true, force: true });
});

test('an existing profile drops DS Bot and keeps other user plugins and Bot data', async (t) => {
  const user = await tenant();
  t.after(() => rm(user.home, { recursive: true, force: true }));
  const botDir = join(user.profile, 'node_modules', 'ds-bot');
  const sharedBotDir = join(user.profile, '..', 'node_modules', 'ds-bot');
  const botData = join(user.home, '.dsh', 'ds-bot-data.json');
  await packageDir(botDir, 'ds-bot', '0.3.6');
  await packageDir(sharedBotDir, 'ds-bot', '0.3.6');
  await writeFile(botData, '{}');
  await writeFile(join(user.profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-pet': '0.4.4', 'ds-bot': '0.3.6' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot', 'dsh-pet', 'ds-bot'] } },
  }));

  assert.equal(await syncPlugins(user), true);
  const path = join(user.profile, 'package.json');
  const upgraded = await readFile(path, 'utf8');
  const manifest = JSON.parse(upgraded);
  assert.deepEqual(manifest.dependencies, { 'dsh-pet': '0.4.4', ...registryPlugins });
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-pet', 'vh-agent-plugins', ...Object.keys(registryPlugins),
  ]);
  assert.equal(existsSync(botDir), false);
  assert.equal(existsSync(sharedBotDir), false);
  assert.equal(await readFile(botData, 'utf8'), '{}');
  assert.equal(await syncPlugins(user), true);
  assert.equal(await readFile(path, 'utf8'), upgraded);
});

test('an unchanged payload neither recopies packages nor rewrites the ledger', async () => {
  const user = await tenant();
  assert.equal(await syncPlugins(user), true);
  const modules = join(user.home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai');
  const ledger = join(modules, '.vh-sync.json');
  const first = await readFile(ledger, 'utf8');
  const inodes = () => Promise.all(MANAGED.map(async (name) => (await stat(join(modules, name))).ino));
  const before = await inodes();

  assert.equal(await syncPlugins(user), true);

  assert.deepEqual(await inodes(), before, 'matching stamps skip the copy');
  assert.equal(await readFile(ledger, 'utf8'), first, 'the ledger is written once, not once per package');
  await rm(user.home, { recursive: true, force: true });
});

test('one stale package is refreshed without losing the other stamps', async () => {
  const user = await tenant();
  assert.equal(await syncPlugins(user), true);
  const modules = join(user.home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai');
  const source = join(plugins, MANAGED[0], 'lib', 'index.js');
  await writeFile(source, 'updated');
  try {
    assert.equal(await syncPlugins(user), true);
    const stamps = JSON.parse(await readFile(join(modules, '.vh-sync.json'), 'utf8'));
    assert.equal(Object.keys(stamps).length, MANAGED.length, 'the ledger keeps every package');
    assert.equal(await readFile(join(modules, MANAGED[0], 'lib', 'index.js'), 'utf8'), 'updated');
  } finally {
    await writeFile(source, '');
    await rm(user.home, { recursive: true, force: true });
  }
});

test('a rebuild that only changes source mtimes does not recopy plugins', async () => {
  const user = await tenant();
  assert.equal(await syncPlugins(user), true);
  const modules = join(user.home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai');
  const inodes = () => Promise.all(MANAGED.map(async (name) => (await stat(join(modules, name))).ino));
  const before = await inodes();
  const source = join(plugins, MANAGED[0], 'lib', 'index.js');
  const original = await stat(source);
  await utimes(source, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
  try {
    assert.equal(await syncPlugins(user), true);
    assert.deepEqual(await inodes(), before, 'mtime alone is not a content change');
  } finally {
    await utimes(source, original.atime, original.mtime);
    await rm(user.home, { recursive: true, force: true });
  }
});

test('a stage that failed inside the sync is reported, not swallowed', async () => {
  const user = await tenant();
  const manifestPath = join(agent, 'manifest.json');
  const original = await readFile(manifestPath, 'utf8');
  try {
    const manifest = JSON.parse(original);
    // The payload lacks this package: the per-package copy loop only walks
    // packages that exist, so the missing name is the silent failure this flag
    // exists to surface.
    await writeFile(manifestPath, JSON.stringify({ plugins: [...manifest.plugins, 'vh-missing-plugin'] }));
    assert.equal(await syncPlugins(user), false);
  } finally {
    await writeFile(manifestPath, original);
    await rm(user.home, { recursive: true, force: true });
  }
});
