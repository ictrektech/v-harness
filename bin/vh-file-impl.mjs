#!/usr/bin/env node
/**
 * Workspace operations for the v-harness drawer, executed as the owning user.
 *
 * Invoked by `bin/vh-file` after `runuser`; never runs as root. Every path is
 * resolved against the workspace root and re-checked after `realpath`, so a
 * symlink cannot widen the drawer beyond `workspace/`. Hidden entries are
 * invisible and unreadable: `.dsh` and `.credentials.yaml` live outside the
 * workspace, but a `.env` inside it is still none of the drawer's business.
 *
 * @module v-harness/bin/vh-file-impl
 */

import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { once } from 'node:events';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_PUT_BYTES = 100 * 1024 * 1024;

/**
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolve a drawer-relative path inside the workspace.
 * @param {string} root - canonical workspace root.
 * @param {string} relative - caller-supplied relative path, '' for the root.
 * @returns {Promise<{ path: string, exists: boolean }>}
 */
async function resolveInside(root, relative) {
  const cleaned = relative.replace(/^\/+/, '');
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new Error('path escapes the workspace');
  }
  // Hidden entries name harness state (`.dsh`, `.env`); the drawer never reads
  // them, even though they can sit inside the workspace.
  if (segments.some((segment) => segment.startsWith('.'))) {
    throw new Error('hidden paths are not accessible');
  }
  const target = resolve(root, cleaned);
  if (target !== root && !isInside(root, target)) {
    throw new Error('path escapes the workspace');
  }
  try {
    const real = await realpath(target);
    if (!isInside(root, real)) throw new Error('path escapes the workspace');
    return { path: real, exists: true };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // A new entry: its parent must still resolve inside the root.
    const parent = await realpath(dirname(target));
    if (!isInside(root, parent)) throw new Error('path escapes the workspace');
    return { path: join(parent, basename(target)), exists: false };
  }
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function hidden(name) {
  return name.startsWith('.');
}

/**
 * @param {string} root
 * @param {string} relative
 */
async function list(root, relative) {
  const { path, exists } = await resolveInside(root, relative);
  if (!exists) throw new Error('directory not found');
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error('not a directory');

  const entries = [];
  for (const name of await readdir(path)) {
    if (hidden(name)) continue;
    const entryPath = join(path, name);
    const entry = await lstat(entryPath).catch(() => undefined);
    if (!entry) continue;
    if (entry.isSymbolicLink()) continue;
    entries.push({
      name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      size: entry.isFile() ? entry.size : undefined,
      mtime: Math.floor(entry.mtimeMs),
    });
  }
  entries.sort((left, right) => Number(right.type === 'directory') - Number(left.type === 'directory')
    || left.name.localeCompare(right.name));
  process.stdout.write(`${JSON.stringify({ path: relative, entries })}\n`);
}

/**
 * @param {string} root
 * @param {string} relative
 */
async function statEntry(root, relative) {
  const { path, exists } = await resolveInside(root, relative);
  if (!exists) throw new Error('not found');
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('not found');
  process.stdout.write(`${JSON.stringify({
    type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
    size: info.size,
    mtime: Math.floor(info.mtimeMs),
  })}\n`);
}

/**
 * @param {string} root
 * @param {string} relative
 */
async function readFile(root, relative) {
  const { path, exists } = await resolveInside(root, relative);
  if (!exists) throw new Error('not found');
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('not a file');
  // Never `pipeline(..., process.stdout)`: closing the process stream makes the
  // helper exit non-zero after a successful transfer.
  for await (const chunk of createReadStream(path)) {
    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
  }
}

/**
 * @param {string} root
 * @param {string} relativeDir
 * @param {string} name
 */
async function putFile(root, relativeDir, name) {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('invalid file name');
  }
  if (hidden(name)) throw new Error('hidden names are not writable');
  const { path: directory, exists } = await resolveInside(root, relativeDir);
  if (!exists) throw new Error('directory not found');
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error('not a directory');

  const target = join(directory, name);
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_PUT_BYTES) {
        callback(new Error('upload exceeds the size limit'));
        return;
      }
      callback(null, chunk);
    },
  });
  // O_NOFOLLOW keeps a planted symlink from redirecting the write.
  const sink = createWriteStream(target, {
    flags: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    mode: 0o644,
  });
  await pipeline(process.stdin, counter, sink);
  process.stdout.write(`${JSON.stringify({ bytes })}\n`);
}

const [operation, root, ...rest] = process.argv.slice(2);
if (!operation || !root) {
  process.stderr.write('usage: vh-file-impl <list|stat|read|put> <workspace> [args]\n');
  process.exit(2);
}

try {
  const rootReal = await realpath(root);
  switch (operation) {
    case 'list':
      await list(rootReal, rest[0] ?? '');
      break;
    case 'stat':
      await statEntry(rootReal, rest[0] ?? '');
      break;
    case 'read':
      await readFile(rootReal, rest[0] ?? '');
      break;
    case 'put':
      await putFile(rootReal, rest[0] ?? '', rest[1] ?? '');
      break;
    default:
      throw new Error(`unknown operation: ${operation}`);
  }
} catch (error) {
  process.stderr.write(`vh-file: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
