import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listShippedSkills,
  readSkillToggles,
  saveSkillToggles,
  skillTogglesFile,
  syncTenantSkillToggles,
  tenantTogglesPath,
} from './skill-toggles.mjs';

const created = [];
after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'vh-skill-toggles-'));
  created.push(dir);
  process.env.SKILL_TOGGLES_FILE = join(dir, 'skill-toggles.json');
  return dir;
}

test('records one validated list per tenant and drops duplicates', async () => {
  await sandbox();
  const saved = await saveSkillToggles('tenant-a', ['voffice', 'voffice', 'Not-Kebab', '../escape', 7]);
  assert.deepEqual(saved, ['voffice']);
  assert.deepEqual(await readSkillToggles('tenant-a'), ['voffice']);
});

test('keeps tenants apart', async () => {
  await sandbox();
  await saveSkillToggles('tenant-a', ['voffice']);
  await saveSkillToggles('tenant-b', ['album']);
  assert.deepEqual(await readSkillToggles('tenant-a'), ['voffice']);
  assert.deepEqual(await readSkillToggles('tenant-b'), ['album']);
});

test('treats an emptied list as the default-on state', async () => {
  await sandbox();
  await saveSkillToggles('tenant-a', ['voffice']);
  await saveSkillToggles('tenant-a', []);
  assert.deepEqual(await readSkillToggles('tenant-a'), []);
  const text = await readFile(skillTogglesFile(), 'utf8');
  assert.equal(JSON.parse(text)['tenant-a'], undefined);
});

test('reads an unreadable record as "nothing disabled"', async () => {
  await sandbox();
  await writeFile(skillTogglesFile(), '{ not json', 'utf8');
  assert.deepEqual(await readSkillToggles('tenant-a'), []);
});

test('ignores a document that is an array', async () => {
  await sandbox();
  await writeFile(skillTogglesFile(), '["voffice"]', 'utf8');
  assert.deepEqual(await readSkillToggles('tenant-a'), []);
});

test('hands the instance a watchable copy inside the tenant home', async () => {
  const dir = await sandbox();
  await saveSkillToggles('tenant-a', ['voffice', 'weknora']);
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  const written = await syncTenantSkillToggles({ home, namespace: 'tenant-a' });
  assert.deepEqual(written, ['voffice', 'weknora']);
  const copy = JSON.parse(await readFile(tenantTogglesPath(home), 'utf8'));
  assert.deepEqual(copy, { exclude: ['voffice', 'weknora'] });
});

test('lists the shipped skills, grouped by kind', async () => {
  const dir = await sandbox();
  const root = join(dir, 'skills');
  await mkdir(join(root, 'voffice'), { recursive: true });
  await mkdir(join(root, 'album'), { recursive: true });
  await mkdir(join(root, 'archify'), { recursive: true });
  await mkdir(join(root, 'pgv'), { recursive: true });
  await writeFile(join(root, 'THIRD_PARTY.md'), '# notices', 'utf8');
  process.env.BUNDLED_SKILL_DIR = root;
  const listed = await listShippedSkills();
  assert.deepEqual(listed, [
    { name: 'album', service: true },
    { name: 'archify', service: false },
    { name: 'pgv', service: true },
    { name: 'voffice', service: true },
  ]);
});

test('lists nothing when the bundled root is absent', async () => {
  const dir = await sandbox();
  process.env.BUNDLED_SKILL_DIR = join(dir, 'missing');
  assert.deepEqual(await listShippedSkills(), []);
});
