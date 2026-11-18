import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { deploymentTrustPatch, dropTrustPatch, isTrustPatch, trustPatchDoc, trustRows, trustRowsForRoots } from './deployment-trust.mjs';

/** A mnemon-shaped bundle: an insert op whose child entry declares remoteAccess. */
const EXAMPLE_BUNDLE = `# Bundle layer: DSH loads this file automatically when the plugin is enabled.
- insert:
    - id: example-bundle
      name: dsh-example/bundle
      group: true
      disabled: !!js >-
        Boolean(true)
      config:
        - id: example
          name: dsh-example
          config:
            routingGuidance: true
            writeEnabled: true
            remoteAccess: read-only
            timeoutMs: 10000
            embedding:
              enabled: false
        - id: example-strategy-off
          name: dsh-example-strategy
          disabled: true
`;

function withRoot(t) {
  return mkdtemp(join(tmpdir(), 'deployment-trust-')).then(async (root) => {
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
  });
}

/** Stage one package's bundle layer under a node_modules root. */
async function stageBundle(modules, name, bundleText) {
  const dir = join(modules, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'cordis.patch.yml'), bundleText);
}

test('trustRows restates a declaring entry with trusted-host and keeps its config', () => {
  const rows = trustRows(EXAMPLE_BUNDLE, 'dsh-example');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 'example',
    name: 'dsh-example',
    config: {
      routingGuidance: true,
      writeEnabled: true,
      remoteAccess: 'trusted-host',
      timeoutMs: 10000,
      embedding: { enabled: false },
    },
  });
});

test('trustRows skips entries that already declare trusted-host or declare nothing', () => {
  const bundle = `
- insert:
    - id: bundle
      name: dsh-x/bundle
      group: true
      config:
        - id: already
          name: dsh-x
          config:
            remoteAccess: trusted-host
        - id: silent
          name: dsh-x-silent
          config:
            other: true
`;
  assert.deepEqual(trustRows(bundle, 'dsh-x'), []);
});

test('trustRows refuses a config carrying !!js expressions instead of restating it', () => {
  const bundle = `
- insert:
    - id: bundle
      name: dsh-x/bundle
      group: true
      config:
        - id: expr
          name: dsh-x
          config:
            remoteAccess: read-only
            persona: !!js process.env.EXAMPLE
`;
  assert.throws(() => trustRows(bundle, 'dsh-x'), /!!js/);
});

test('trustPatchDoc emits an empty patch list when nothing declares remoteAccess', () => {
  const doc = trustPatchDoc([]);
  assert.ok(isTrustPatch(doc));
  const lines = doc.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
  assert.deepEqual(lines, ['[]']);
});

test('trustRowsForRoots deduplicates by entry id with the last root winning', async (t) => {
  const root = await withRoot(t);
  const payload = join(root, 'payload', 'node_modules');
  const layer = join(root, 'layer', 'node_modules');
  const profile = join(root, 'profile', 'node_modules');
  await stageBundle(payload, 'dsh-example', EXAMPLE_BUNDLE.replace('timeoutMs: 10000', 'timeoutMs: 20000'));
  await stageBundle(layer, 'dsh-example', EXAMPLE_BUNDLE.replace('timeoutMs: 10000', 'timeoutMs: 30000'));
  // The profile copy is what dsh resolves, so its bundle decides.
  await stageBundle(profile, 'dsh-example', EXAMPLE_BUNDLE);
  await stageBundle(profile, 'dsh-market', `
- insert:
    - id: market-bundle
      name: dsh-market/bundle
      group: true
      config:
        - id: market
          name: dsh-market
          config:
            remoteAccess: read-only
            keep: yes
`);
  await mkdir(join(profile, 'dsh-plain'), { recursive: true });
  await writeFile(join(profile, 'dsh-plain', 'package.json'), '{}');

  const rows = await trustRowsForRoots([payload, layer, profile]);
  assert.deepEqual(rows.map((row) => row.id), ['example', 'market']);
  const example = rows[0];
  assert.equal(example.config.timeoutMs, 10000);
  assert.equal(example.config.routingGuidance, true);
  const market = rows[1];
  // YAML 1.2 keeps `yes` a plain string; the clone must not reinterpret it.
  assert.equal(market.config.keep, 'yes');
});

test('deploymentTrustPatch writes, hands over, and dropTrustPatch removes the overlay', async (t) => {
  const root = await withRoot(t);
  const home = join(root, 'home');
  const profileModules = join(home, '.dsh', 'profiles', 'web', 'node_modules');
  await stageBundle(profileModules, 'dsh-example', EXAMPLE_BUNDLE);

  const result = await deploymentTrustPatch({
    home,
    jailHome: '/home/tester',
    uid: process.getuid(),
    linuxName: process.env.USER ?? 'tester',
    payloadModules: join(root, 'payload', 'node_modules'),
    layerModules: join(home, '.dsh', 'profiles', 'node_modules'),
    profileModules,
  });
  assert.deepEqual(result, { patch: '/home/tester/.dsh/profiles/web/trust.patch.yml' });
  const text = await readFile(join(home, '.dsh', 'profiles', 'web', 'trust.patch.yml'), 'utf8');
  assert.ok(isTrustPatch(text));
  const body = yaml.load(text.split('\n').filter((line) => !line.startsWith('#')).join('\n'));
  assert.equal(body.length, 1);
  assert.equal(body[0].config.remoteAccess, 'trusted-host');

  await dropTrustPatch({ home });
  await assert.rejects(readFile(join(home, '.dsh', 'profiles', 'web', 'trust.patch.yml'), 'utf8'));
});

test('deploymentTrustPatch removes a stale overlay when no package declares the field', async (t) => {
  const root = await withRoot(t);
  const home = join(root, 'home');
  const profileModules = join(home, '.dsh', 'profiles', 'web', 'node_modules');
  await stageBundle(profileModules, 'dsh-example', EXAMPLE_BUNDLE);
  const options = {
    home,
    jailHome: '/home/tester',
    uid: process.getuid(),
    // chown accepts a numeric group, which is all a test environment has.
    linuxName: String(process.getgid()),
    payloadModules: join(root, 'payload', 'node_modules'),
    layerModules: join(home, '.dsh', 'profiles', 'node_modules'),
    profileModules,
  };
  assert.notDeepEqual(await deploymentTrustPatch(options), {});
  // A bundle that no longer declares the field takes the overlay with it.
  await rm(join(profileModules, 'dsh-example'), { recursive: true, force: true });
  assert.deepEqual(await deploymentTrustPatch(options), {});
  await assert.rejects(readFile(join(home, '.dsh', 'profiles', 'web', 'trust.patch.yml'), 'utf8'));
});

test('deploymentTrustPatch skips derivation entirely under the kill switch', async (t) => {
  const root = await withRoot(t);
  const home = join(root, 'home');
  const profileModules = join(home, '.dsh', 'profiles', 'web', 'node_modules');
  await stageBundle(profileModules, 'dsh-example', EXAMPLE_BUNDLE);
  process.env.VH_TRUSTED_REMOTE = 'false';
  t.after(() => { delete process.env.VH_TRUSTED_REMOTE; });
  const result = await deploymentTrustPatch({
    home,
    jailHome: '/home/tester',
    uid: process.getuid(),
    linuxName: String(process.getgid()),
    payloadModules: join(root, 'payload', 'node_modules'),
    layerModules: join(home, '.dsh', 'profiles', 'node_modules'),
    profileModules,
  });
  assert.deepEqual(result, {});
  await assert.rejects(readFile(join(home, '.dsh', 'profiles', 'web', 'trust.patch.yml'), 'utf8'));
});

test('isTrustPatch rejects documents that are not a top-level patch row list', () => {
  assert.ok(!isTrustPatch('- insert:\n    - id: row\n'));
  assert.ok(!isTrustPatch('- id: spaced id\n  config: {}\n'));
  assert.ok(!isTrustPatch('id: no-dash\n'));
  assert.ok(!isTrustPatch(''));
  assert.ok(isTrustPatch('# header only\n[]\n'));
  assert.ok(isTrustPatch('- id: one\n  name: dsh-one\n  config:\n    remoteAccess: trusted-host\n'));
});
