import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { installAgentPayload } = await import('./install-installation-plugins.mjs');

/**
 * Write a package directory with a marker file naming where it came from.
 * @param {string} root - `node_modules` directory to write into.
 * @param {string} name - package name, scope included.
 * @param {string} origin - value of the marker file.
 * @returns {Promise<void>}
 */
async function packageDir(root, name, origin) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: origin }));
  await writeFile(join(dir, 'origin.txt'), origin);
}

/**
 * A payload and an installation to copy it into.
 * @param {readonly string[]} plugins - packages the payload manifest lists as image-owned.
 * @returns {Promise<{ payload: string, installation: string, shared: string }>} the two roots.
 */
async function roots(plugins) {
  const payload = await mkdtemp(join(tmpdir(), 'vh-payload-'));
  const installation = await mkdtemp(join(tmpdir(), 'vh-installation-'));
  await writeFile(join(payload, 'manifest.json'), JSON.stringify({ plugins }));
  await writeFile(join(installation, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }));
  // Every image ships the carrier bundle; the profile layer list names it.
  await packageDir(join(payload, 'node_modules'), 'vh-agent-plugins', 'payload');
  return { payload, installation, shared: join(installation, 'node_modules') };
}

test('replaces an image-owned package the installation already carries', async () => {
  const { payload, installation, shared } = await roots(['dshmarket']);
  await packageDir(join(payload, 'node_modules'), 'dshmarket', 'payload');
  await packageDir(shared, 'dshmarket', 'installation');

  installAgentPayload({ payload, installation });

  assert.equal(await readFile(join(shared, 'dshmarket', 'origin.txt'), 'utf8'), 'payload');
  await rm(payload, { recursive: true, force: true });
  await rm(installation, { recursive: true, force: true });
});

test('places the carrier bundle and scoped image-owned packages whole', async () => {
  const { payload, installation, shared } = await roots(['@deepseek-ai/dsh-skill-image-studio']);
  await packageDir(join(payload, 'node_modules'), '@deepseek-ai/dsh-skill-image-studio', 'payload');

  const report = installAgentPayload({ payload, installation });

  assert.deepEqual(report.placed.sort(), ['@deepseek-ai/dsh-skill-image-studio', 'vh-agent-plugins']);
  assert.equal(await readFile(join(shared, 'vh-agent-plugins', 'origin.txt'), 'utf8'), 'payload');
  await rm(payload, { recursive: true, force: true });
  await rm(installation, { recursive: true, force: true });
});

test('keeps a runtime package the installation already resolves, and places one it lacks', async () => {
  const { payload, installation, shared } = await roots([]);
  await packageDir(join(payload, 'node_modules'), 'js-yaml', 'payload');
  await packageDir(shared, 'js-yaml', 'installation');
  await packageDir(join(payload, 'node_modules'), 'undici', 'payload');

  const report = installAgentPayload({ payload, installation });

  assert.equal(await readFile(join(shared, 'js-yaml', 'origin.txt'), 'utf8'), 'installation');
  assert.equal(await readFile(join(shared, 'undici', 'origin.txt'), 'utf8'), 'payload');
  assert.deepEqual(report.kept, ['js-yaml']);
  await rm(payload, { recursive: true, force: true });
  await rm(installation, { recursive: true, force: true });
});

test('fails when the manifest names a package the payload does not carry', async () => {
  const { payload, installation } = await roots(['dshmarket', 'ds-bot']);
  await packageDir(join(payload, 'node_modules'), 'dshmarket', 'payload');

  assert.throws(() => installAgentPayload({ payload, installation }), /carries no ds-bot/);
  await rm(payload, { recursive: true, force: true });
  await rm(installation, { recursive: true, force: true });
});
