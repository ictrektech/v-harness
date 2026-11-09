/**
 * The last profile configuration that actually started.
 *
 * A restart re-reads everything the boot composes, and some of it is written by
 * this gateway rather than by the tenant. One invalid file there is enough to
 * make every later launch exit before it prints a URL, which reads to the owner
 * as "restart failed" — and it repeats, because a retry re-reads the same file.
 *
 * This module keeps the small, gateway-authored files that decide what mounts,
 * and can put them back. It deliberately does not touch what a package manager
 * owns (`package.json`, `node_modules`): rolling those back behind pnpm's back
 * trades one broken boot for another, less obvious one.
 *
 * @module v-harness/gateway/last-good
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The gateway-authored files a failed launch may roll back to. */
const TRACKED = [
  join('.dsh', 'profiles', 'web', 'cordis.patch.yml'),
  join('.dsh', 'profiles', 'web', 'mcphub.patch.yml'),
];

/** Where one tenant's snapshot lives. */
const MANIFEST = 'manifest.json';

/**
 * The directory holding one tenant's snapshot.
 * @param {string} stateRoot - the gateway state root.
 * @param {string} account - the tenant's Linux name.
 * @returns {string} the snapshot directory.
 */
function snapshotRoot(stateRoot, account) {
  return join(stateRoot, 'last-good', account);
}

/**
 * Give one file to the tenant, best effort.
 * @param {string} path - the file to hand over.
 * @param {number} uid - the tenant's uid.
 * @param {string} group - the tenant's group name.
 * @returns {Promise<void>}
 */
function handOver(path, uid, group) {
  return new Promise((resolve) => {
    execFile('chown', [`${String(uid)}:${group}`, path], () => { resolve(); });
  });
}

/**
 * Record the files this launch booted with, as the next failure's fallback.
 *
 * Called only after a launch succeeded: a snapshot taken from a boot that never
 * printed a URL would be a snapshot of the failure.
 * @param {{
 *   home: string,
 *   stateRoot: string,
 *   account: string,
 * }} options - the tenant home and where its snapshot belongs.
 * @returns {Promise<void>}
 */
export async function rememberProfile(options) {
  const { home, stateRoot, account } = options;
  const root = snapshotRoot(stateRoot, account);
  /** @type {string[]} */
  const present = [];
  for (const relative of TRACKED) {
    const source = join(home, relative);
    try {
      await mkdir(dirname(join(root, relative)), { recursive: true, mode: 0o700 });
      await copyFile(source, join(root, relative));
      present.push(relative);
    } catch (error) {
      // A file the boot did not need is not a file worth remembering.
      if (error?.code !== 'ENOENT') {
        console.error(`last-good: cannot snapshot ${relative} for ${account}:`, error?.message ?? error);
      }
    }
  }
  await writeFile(join(root, MANIFEST), `${JSON.stringify({ files: present })}\n`, { mode: 0o600 });
}

/**
 * Put back the files this tenant's last successful launch used.
 *
 * A tracked file the snapshot does not hold is removed: it did not exist when
 * the profile last booted, so keeping it would keep the reason it fails.
 * @param {{
 *   home: string,
 *   stateRoot: string,
 *   account: string,
 *   uid: number,
 *   linuxName: string,
 * }} options - the tenant and its snapshot.
 * @returns {Promise<boolean>} whether a snapshot existed and was applied.
 */
export async function restoreProfile(options) {
  const { home, stateRoot, account, uid, linuxName } = options;
  const root = snapshotRoot(stateRoot, account);
  const text = await readFile(join(root, MANIFEST), 'utf8').catch(() => undefined);
  if (text === undefined) return false;
  /** @type {string[]} */
  let files;
  try {
    const parsed = JSON.parse(text);
    files = Array.isArray(parsed?.files) ? parsed.files.filter((entry) => typeof entry === 'string') : [];
  } catch (error) {
    console.error(`last-good: unusable manifest for ${account}:`, error?.message ?? error);
    return false;
  }
  for (const relative of TRACKED) {
    const target = join(home, relative);
    if (!files.includes(relative)) {
      await rm(target, { force: true });
      continue;
    }
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(root, relative), target);
      await handOver(target, uid, linuxName);
    } catch (error) {
      console.error(`last-good: cannot restore ${relative} for ${account}:`, error?.message ?? error);
    }
  }
  return true;
}
