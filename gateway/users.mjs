/**
 * Durable user table shared by the gateway and the root-side user helper.
 *
 * One record answers every routing question: which namespace owns the data,
 * which Linux account runs the instance, which port it listens on, and which
 * uid owns the files. `uid` and `port` are allocated once and never reused,
 * so a container rebuild re-adopts the existing volume instead of orphaning it.
 *
 * @module v-harness/gateway/users
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const FIRST_UID = 20_000;
const FIRST_PORT = 3_101;

/**
 * @typedef {object} UserRecord
 * @property {string} subject - VOS immutable subject.
 * @property {string} namespace - 40-hex directory name derived from subject.
 * @property {string} username - display name, refreshed on every sign-in.
 * @property {string} linuxName - `vh-xxxxxxxx`, stable OS account.
 * @property {number} uid - filesystem owner, allocated once.
 * @property {number} port - loopback port of this user's dsh instance.
 * @property {number} createdAt - epoch milliseconds.
 * @property {number} [lastSeenAt] - epoch milliseconds.
 */

/** Serializes read-modify-write cycles inside this process. */
let queue = Promise.resolve();

/**
 * Load the table; an absent file is an empty table.
 * @param {string} path
 * @returns {Promise<Record<string, UserRecord>>}
 */
async function readTable(path) {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('users.json must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * Atomically persist the table.
 * @param {string} path
 * @param {Record<string, UserRecord>} table
 */
async function writeTable(path, table) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`;
  await writeFile(temporary, `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Run one read-modify-write cycle under the process-wide queue.
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
function serialize(work) {
  const next = queue.then(work, work);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Derive the OS account name from a namespace.
 * Deterministic, collision-resistant, and within Linux's 32-char limit.
 * @param {string} namespace
 * @returns {string}
 */
export function linuxNameOf(namespace) {
  return `vh-${namespace.slice(0, 8)}`;
}

/**
 * @param {Record<string, UserRecord>} table
 * @param {'uid' | 'port'} field
 * @param {number} first
 * @returns {number}
 */
function nextFree(table, field, first) {
  const taken = new Set(Object.values(table).map((record) => record[field]));
  let candidate = first;
  while (taken.has(candidate)) candidate += 1;
  return candidate;
}

/**
 * Insert or refresh one user and return the stored record.
 *
 * Sign-in is the only writer: display names change, while subject, namespace,
 * uid, and port are immutable once allocated.
 *
 * @param {string} path
 * @param {{ subject: string, namespace: string, username: string }} identity
 * @param {number} [now]
 * @returns {Promise<{ record: UserRecord, created: boolean }>}
 */
export async function upsertUser(path, identity, now = Date.now()) {
  return serialize(async () => {
    const table = await readTable(path);
    const existing = table[identity.subject];
    if (existing) {
      const updated = {
        ...existing,
        username: identity.username,
        lastSeenAt: now,
      };
      table[identity.subject] = updated;
      await writeTable(path, table);
      return { record: updated, created: false };
    }

    /** @type {UserRecord} */
    const record = {
      subject: identity.subject,
      namespace: identity.namespace,
      username: identity.username,
      linuxName: linuxNameOf(identity.namespace),
      uid: nextFree(table, 'uid', FIRST_UID),
      port: nextFree(table, 'port', FIRST_PORT),
      createdAt: now,
      lastSeenAt: now,
    };
    table[identity.subject] = record;
    await writeTable(path, table);
    return { record, created: true };
  });
}

/**
 * Read one record by subject.
 * @param {string} path
 * @param {string} subject
 * @returns {Promise<UserRecord | undefined>}
 */
export async function findUser(path, subject) {
  const table = await readTable(path);
  return table[subject];
}

/**
 * List every record, newest first.
 * @param {string} path
 * @returns {Promise<UserRecord[]>}
 */
export async function listUsers(path) {
  const table = await readTable(path);
  return Object.values(table).sort((left, right) => right.createdAt - left.createdAt);
}
