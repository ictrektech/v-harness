import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  plugins: ['dshmarket', 'ds-bot', '@xmanrui/dsh-im', 'vh-agent-plugins'],
}));
await packageDir(join(agent, 'node_modules', 'dshmarket'), 'dshmarket', '1.73.8');
await packageDir(join(agent, 'node_modules', 'ds-bot'), 'ds-bot', '0.2.5');
await packageDir(join(agent, 'node_modules', '@xmanrui', 'dsh-im'), '@xmanrui/dsh-im', '5.10.0');
await packageDir(join(agent, 'node_modules', 'vh-agent-plugins'), 'vh-agent-plugins', '0.0.0');

const { syncPlugins } = await import('./plugins.mjs');

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

  await syncPlugins(user);

  const manifest = JSON.parse(await readFile(join(user.profile, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, {
    dshmarket: '1.73.8', 'ds-bot': '0.2.5', '@xmanrui/dsh-im': '5.10.0',
  });
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'vh-agent-plugins', 'dshmarket', 'ds-bot', '@xmanrui/dsh-im',
  ]);
  // Declared dependencies stay inside the profile: pnpm installs and repairs them.
  assert.equal(existsSync(join(user.profile, 'node_modules', 'dshmarket')), true);
  assert.equal(existsSync(join(user.profile, 'node_modules', 'ds-bot')), true);
  assert.equal(existsSync(join(user.profile, 'node_modules', '@xmanrui', 'dsh-im')), true);
  // The undeclared ones live in the shared layer, out of every profile install's reach.
  assert.equal(existsSync(join(user.home, '.dsh', 'profiles', 'node_modules', 'vh-agent-plugins')), true);
  assert.equal(existsSync(join(user.profile, 'node_modules', 'vh-agent-plugins')), false);
  await rm(user.home, { recursive: true, force: true });
});

test('an existing profile receives the dependencies and the carrier it predates', async () => {
  const user = await tenant();
  await mkdir(join(user.profile, 'node_modules'), { recursive: true });
  await writeFile(join(user.profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-pet': '0.4.4' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }));

  await syncPlugins(user);

  const manifest = JSON.parse(await readFile(join(user.profile, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, {
    'dsh-pet': '0.4.4', dshmarket: '1.73.8', 'ds-bot': '0.2.5', '@xmanrui/dsh-im': '5.10.0',
  });
  assert.equal(manifest.dsh.profile.bundles.includes('vh-agent-plugins'), true);
  assert.equal(manifest.dsh.profile.bundles.includes('ds-bot'), true);
  assert.equal(manifest.dsh.profile.bundles.includes('@xmanrui/dsh-im'), true);
  await rm(user.home, { recursive: true, force: true });
});
