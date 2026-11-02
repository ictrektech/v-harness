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
 * @property {string} account - stable, human-readable OS account and home name.
 * @property {string} linuxName - the OS account; equal to `account` for records
 *   created after the rename, `vh-xxxxxxxx` for older ones.
 * @property {number} uid - filesystem owner, allocated once.
 * @property {number} port - loopback port of this user's dsh instance.
 * @property {number} createdAt - epoch milliseconds.
 * @property {number} [lastSeenAt] - epoch milliseconds.
 * @property {string} [locale] - last known VOS interface language (`zh` / `en`).
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

/** Names the image or the platform already uses; a tenant may never take one. */
const RESERVED_ACCOUNTS = new Set([
  'root', 'bin', 'daemon', 'nobody', 'nogroup', 'node', 'npm', 'dsh', 'mail', 'news',
  'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'games', 'man', 'lp', 'sync',
  'sys', 'adm', 'operator', 'ssh', 'systemd', 'polkitd', 'messagebus',
]);

const ACCOUNT_MAX = 32;
const ACCOUNT_RE = /^[a-z_][a-z0-9_-]*$/;

/**
 * Reduce a display name to an account-shaped slug.
 * @param {string} username
 * @returns {string} `''` when nothing ASCII survives (a CJK-only name).
 */
export function accountSlug(username) {
  const normalized = String(username ?? '').normalize('NFKC').toLowerCase();
  let slug = normalized
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '');
  if (slug === '') return '';
  if (!/^[a-z_]/u.test(slug)) slug = `u${slug}`;
  return slug.slice(0, ACCOUNT_MAX).replace(/[-_]+$/u, '');
}

/**
 * Allocate the account this user keeps for life.
 *
 * Two accounts may share a display name (renames, homonyms, CJK names that
 * slug to nothing), so the name is only a starting point: the allocator
 * suffixes it until it is unique in the table. `namespace` stays the internal
 * key; `account` is what the home directory, the OS user, and the prompt use.
 * @param {string} username - display name as reported by VOS.
 * @param {Record<string, UserRecord>} table - current table, used for uniqueness.
 * @returns {string} a legal Linux account name, unique among existing records.
 */
export function accountOf(username, table) {
  const taken = new Set(
    Object.values(table).map((record) => record.account ?? record.linuxName),
  );
  let base = accountSlug(username);
  if (base === '') base = 'user';
  if (RESERVED_ACCOUNTS.has(base)) base = `${base}-user`;
  let candidate = base;
  let counter = 1;
  while (taken.has(candidate) || !ACCOUNT_RE.test(candidate)) {
    counter += 1;
    candidate = `${base.slice(0, ACCOUNT_MAX - String(counter).length - 1)}-${counter}`;
  }
  return candidate;
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
 * uid, and port are immutable once allocated. A sign-in that names no language
 * keeps the one already stored, so a gateway that cannot read VOS's locale
 * never erases the answer of one that could.
 *
 * @param {string} path
 * @param {{ subject: string, namespace: string, username: string, locale?: string }} identity
 * @param {number} [now]
 * @returns {Promise<{ record: UserRecord, created: boolean }>}
 */
export async function upsertUser(path, identity, now = Date.now()) {
  return serialize(async () => {
    const table = await readTable(path);
    const existing = table[identity.subject];
    if (existing) {
      // Records written before accounts existed keep the name they are already
      // addressed by, so upgrading never renames a live tenant's home.
      const others = { ...table };
      delete others[identity.subject];
      const account = existing.account ?? existing.linuxName ?? accountOf(identity.username, others);
      const updated = {
        ...existing,
        account,
        username: identity.username,
        ...identity.locale ? { locale: identity.locale } : {},
        lastSeenAt: now,
      };
      table[identity.subject] = updated;
      await writeTable(path, table);
      return { record: updated, created: false };
    }

    const account = accountOf(identity.username, table);
    /** @type {UserRecord} */
    const record = {
      subject: identity.subject,
      namespace: identity.namespace,
      username: identity.username,
      account,
      linuxName: account,
      uid: nextFree(table, 'uid', FIRST_UID),
      port: nextFree(table, 'port', FIRST_PORT),
      createdAt: now,
      lastSeenAt: now,
      ...identity.locale ? { locale: identity.locale } : {},
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
