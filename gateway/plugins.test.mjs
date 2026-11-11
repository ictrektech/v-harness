import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  plugins: ['dshmarket', 'ds-bot', '@xmanrui/dsh-im', 'dsh-mcp-connector', 'dsh-media-desk', 'vh-agent-plugins'],
}));
await packageDir(join(agent, 'node_modules', 'dshmarket'), 'dshmarket', '1.73.17');
await packageDir(join(agent, 'node_modules', 'ds-bot'), 'ds-bot', '0.3.2');
await packageDir(join(agent, 'node_modules', '@xmanrui', 'dsh-im'), '@xmanrui/dsh-im', '5.10.0');
await packageDir(join(agent, 'node_modules', 'dsh-mcp-connector'), 'dsh-mcp-connector', '0.2.100');
await packageDir(join(agent, 'node_modules', 'dsh-media-desk'), 'dsh-media-desk', '2.6.2');
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
  assert.deepEqual(manifest.dependencies, {
    dshmarket: '1.73.17', 'ds-bot': '0.3.2', '@xmanrui/dsh-im': '5.10.0', 'dsh-mcp-connector': '0.2.100', 'dsh-media-desk': '2.6.2',
  });
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'vh-agent-plugins', 'dshmarket', '@xmanrui/dsh-im', 'dsh-mcp-connector', 'dsh-media-desk',
  ]);
  // Declared dependencies stay inside the profile: pnpm installs and repairs them.
  assert.equal(existsSync(join(user.profile, 'node_modules', 'dshmarket')), true);
  assert.equal(existsSync(join(user.profile, 'node_modules', 'ds-bot')), true);
  assert.equal(existsSync(join(user.profile, 'node_modules', '@xmanrui', 'dsh-im')), true);
  assert.equal(existsSync(join(user.profile, 'node_modules', 'dsh-mcp-connector')), true);
  assert.equal(existsSync(join(user.profile, 'node_modules', 'dsh-media-desk')), true);
  // The undeclared ones live in the shared layer, out of every profile install's reach.
  assert.equal(existsSync(join(user.home, '.dsh', 'profiles', 'node_modules', 'vh-agent-plugins')), true);
  assert.equal(existsSync(join(user.profile, 'node_modules', 'vh-agent-plugins')), false);
  await rm(user.home, { recursive: true, force: true });
});

test('an existing profile keeps its DS Bot selection and receives the other bundled plugins', async () => {
  const user = await tenant();
  await mkdir(join(user.profile, 'node_modules'), { recursive: true });
  await writeFile(join(user.profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-pet': '0.4.4' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'] } },
  }));

  await syncPlugins(user);

  const manifest = JSON.parse(await readFile(join(user.profile, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, {
    'dsh-pet': '0.4.4', dshmarket: '1.73.17', 'ds-bot': '0.3.2', '@xmanrui/dsh-im': '5.10.0', 'dsh-mcp-connector': '0.2.100', 'dsh-media-desk': '2.6.2',
  });
  assert.equal(manifest.dsh.profile.bundles.includes('vh-agent-plugins'), true);
  assert.equal(manifest.dsh.profile.bundles.includes('ds-bot'), true);
  assert.equal(manifest.dsh.profile.bundles.includes('@xmanrui/dsh-im'), true);
  assert.equal(manifest.dsh.profile.bundles.includes('dsh-mcp-connector'), true);
  assert.equal(manifest.dsh.profile.bundles.includes('dsh-media-desk'), true);
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'ds-bot');
  await writeFile(join(user.profile, 'package.json'), JSON.stringify(manifest));
  await syncPlugins(user);
  const disabled = JSON.parse(await readFile(join(user.profile, 'package.json'), 'utf8'));
  assert.equal(disabled.dsh.profile.bundles.includes('ds-bot'), false);
  assert.equal(disabled.dependencies['ds-bot'], '0.3.2');
  await rm(user.home, { recursive: true, force: true });
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
