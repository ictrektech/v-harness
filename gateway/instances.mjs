/**
 * Per-user dsh instance lifecycle.
 *
 * Each user owns one `dsh --profile web` process running as `vh-xxxxxxxx` on a
 * fixed loopback port. The gateway never speaks dsh's auth protocol itself: it
 * reads the launch URL the process prints, exchanges it for dsh's own signed
 * cookie, and replays that cookie on every forwarded request.
 *
 * The cookie outlives the process because its signing key lives in the user's
 * `.credentials.yaml` and its authority is the fixed loopback port. Only the
 * 30-day expiry forces a re-exchange.
 *
 * @module v-harness/gateway/instances
 */

import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, access, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { syncPlugins } from './plugins.mjs';
import { schedulerEnvironment } from './scheduler.mjs';

const LAUNCH_TIMEOUT_MS = 45_000;
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const LOG_DIR_NAME = 'logs';
const JAIL_BIN = process.env.JAIL_BIN ?? '/opt/v-harness/bin/vh-jail';
const BUNDLED_SKILL_DIR = process.env.BUNDLED_SKILL_DIR ?? '/opt/v-harness/skills';
/**
 * The one root every tenant home lives under.
 *
 * It follows DATA_ROOT so a deployment whose volume is still mounted at the
 * old path (`/data`) keeps finding its tenants there, instead of creating a
 * fresh home tree on the container's writable layer and losing it on the next
 * recreate.
 */
const HOME_ROOT = process.env.HOME_ROOT ?? process.env.DATA_ROOT ?? '/home';

/**
 * @typedef {object} Instance
 * @property {string} namespace
 * @property {string} linuxName
 * @property {number} port
 * @property {import('node:child_process').ChildProcess | undefined} child
 * @property {string | undefined} cookie - dsh `dsh-auth-*` value.
 * @property {number} cookieExpiresAt
 * @property {Promise<void> | undefined} starting
 */

/** @type {Map<string, Instance>} */
const instances = new Map();

/**
 * Directory layout for one tenant. The home is `/home/<account>` and nothing
 * else: the account is the only name a tenant ever sees, and its home is the
 * one writable tree in its world. Gateway state (user table, logs, instance
 * cookies) lives beside the homes under the state root, outside every tenant's
 * writable tree.
 * @param {string} stateRoot - gateway state directory (user table, logs).
 * @param {string} account - the tenant's stable account name.
 */
export function userPaths(stateRoot, account) {
  const home = join(HOME_ROOT, account);
  return {
    home,
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    workspace: join(home, 'workspace'),
    log: join(stateRoot, LOG_DIR_NAME, `${account}.log`),
  };
}

/**
 * Persistent instance state (cookie only); process handles are process-local.
 * @typedef {{ cookie?: string, cookieExpiresAt?: number }} InstanceState
 */

/**
 * @param {string} path
 * @returns {Promise<Record<string, InstanceState>>}
 */
async function readState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    return {};
  }
}

/**
 * @param {string} path
 * @param {Record<string, InstanceState>} state
 */
async function writeState(path, state) {
  const temporary = `${path}.tmp-${String(process.pid)}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Call the root helper that owns OS accounts and directory ownership.
 * @param {string} helper - absolute helper path.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
export async function runUserHelper(helper, args) {
  // Root (the container case) runs the helper directly; a non-root deployment
  // needs the fixed-path sudoers entry documented in the Dockerfile.
  const privileged = process.geteuid?.() === 0;
  const command = privileged ? helper : 'sudo';
  const argv = privileged ? args : ['-n', helper, ...args];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  if (result.code !== 0) {
    throw new Error(`user helper failed (${String(result.code)}): ${result.stderr.trim()}`);
  }
}

/**
 * Extract the launch URL dsh prints once its listener is up.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function waitForLaunchUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for the dsh launch URL'));
    }, timeoutMs);

    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/dsh web: (https?:\/\/[^\s"'<>]+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`dsh exited before announcing its URL (code ${String(code)})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

/**
 * Exchange the launch URL for dsh's signed browser cookie.
 * @param {string} launchUrl
 * @returns {Promise<{ cookie: string, expiresAt: number }>}
 */
async function exchangeCookie(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual' });
  // A valid exchange answers 303 with exactly one Set-Cookie.
  if (response.status !== 303) {
    throw new Error(`dsh launch exchange returned HTTP ${String(response.status)}`);
  }
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter((value) => value !== null);
  const raw = values.find((value) => value.trimStart().startsWith('dsh-auth-'));
  if (!raw) throw new Error('dsh launch exchange returned no dsh-auth cookie');
  const pair = raw.split(';', 1)[0]?.trim();
  if (!pair) throw new Error('dsh launch exchange returned a malformed cookie');
  return { cookie: pair, expiresAt: Date.now() + COOKIE_MAX_AGE_MS };
}

/**
 * Rewrite session and workspace records that still point at the physical host
 * path.
 *
 * The jail used to mirror /data, so dsh stored `/data/users/<ns>/workspace/...`
 * in its storages. Inside the jail that prefix no longer exists, and dsh treats
 * the missing directory as one it must create: `mkdir('/data')` fails with
 * EACCES before the first request ever reaches the session. Rewriting the
 * prefix makes the migration idempotent, including for tenants that were
 * created before the layout changed; the marker file keeps the scan to the
 * first start rather than reading every storage file on each one.
 *
 * The projected session cache is derived data: dropping it is both cheaper and
 * safer than rewriting it, and dsh rebuilds it from the storages.
 *
 * @param {string} dshHome absolute path of the tenant's `.dsh`
 * @param {string} namespace tenant namespace (the historical directory name)
 * @param {string} account tenant account (the home name now in use)
 * @returns {Promise<void>}
 */
async function rewriteJailPaths(dshHome, namespace, account) {
  const current = join(HOME_ROOT, account);
  // Both spellings predate the account-named home: the mirrored `/data/users`
  // tree and the earlier `/home/<namespace>` one.
  const stale = [`/data/users/${namespace}`, `/home/${namespace}`]
    .filter((prefix) => prefix !== current);
  const storages = join(dshHome, 'storages');
  // The marker names the layout it migrated to, so a future layout change
  // re-runs the rewrite by bumping the version instead of silently skipping.
  const marker = join(dshHome, '.jail-paths-home-v2');
  try {
    await access(marker);
    return;
  } catch {
    // Not migrated yet.
  }
  await rm(join(storages, 'session_projcache'), { recursive: true, force: true });
  let entries;
  try {
    entries = await readdir(storages, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = join(storages, entry.name);
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    let rewritten = text;
    for (const prefix of stale) rewritten = rewritten.split(prefix).join(current);
    if (rewritten === text) continue;
    await writeFile(file, rewritten, 'utf8');
  }
  await writeFile(marker, `${current}\n`, 'utf8');
}

/**
 * Hand a tenant's data roots to the tenant before anything starts.
 *
 * A home carried over from an earlier layout can still be owned by root, and a
 * root-owned `.dsh` is exactly the state in which two accounts write the same
 * plugin store: the process runs as the tenant but every write into that store
 * needs the gateway, so the newest writer wins and the previous content stays
 * readable. Repairing the owner is what closes that window; refusing the launch
 * instead would leave the account unable to sign in at all.
 *
 * @param {string} home absolute tenant home
 * @param {string} dshHome absolute tenant DSH_HOME
 * @param {number} uid tenant uid
 * @param {string} account tenant account, for the diagnostic
 * @returns {Promise<void>}
 */
async function adoptTenantRoots(home, dshHome, uid, account) {
  for (const path of [home, dshHome]) {
    let owner
    try {
      owner = (await stat(path)).uid
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (owner === uid) continue
    console.warn(`instance home ${path} was owned by uid ${String(owner)}; adopting it for ${account}`)
    await new Promise((resolve, reject) => {
      execFile('chown', ['-R', `${String(uid)}:${String(uid)}`, path], (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}

/**
 * Start one dsh process and capture its cookie.
 * @param {{
 *   record: import('./users.mjs').UserRecord,
 *   dataRoot: string,
 *   dshBin: string,
 *   nodeBin: string,
 *   statePath: string,
 * }} options
 * @returns {Promise<Instance>}
 */
async function launch(options) {
  const { record, dataRoot, dshBin, nodeBin, statePath } = options;
  const account = record.account ?? record.linuxName;
  const paths = userPaths(dataRoot, account);
  await mkdir(join(dataRoot, LOG_DIR_NAME), { recursive: true, mode: 0o700 });

  const state = await readState(statePath);
  await adoptTenantRoots(paths.home, paths.dshHome, record.uid, account);
  await rewriteJailPaths(paths.dshHome, record.namespace, account);

  // vh-jail drops to the user *after* entering a mount+pid+uts namespace. The
  // jailed paths are what the process sees and what dsh records, so HOME and
  // everything derived from it use /home/<account>: the tenant's own name, not
  // an internal identifier.
  const jailHome = join(HOME_ROOT, account);

  const launchArgs = [
    account, String(record.uid), paths.home,
    nodeBin, dshBin, '--profile', 'web',
    '--patch', '/usr/local/share/v-harness/vos.patch.yml',
    '--host', '127.0.0.1',
    '--port', String(record.port),
    '--no-open',
  ];
  const launchOptions = {
    cwd: paths.workspace,
    env: {
      // vh-jail checks the host home against this root before entering the
      // jail; without it the jail refuses every launch on a /data deployment.
      HOME_ROOT,
      HOME: jailHome,
      DSH_HOME: `${jailHome}/.dsh`,
      DSH_AGENTS_HOME: `${jailHome}/.agents`,
      DSH_PERMISSION_MODE: 'workspace-write',
      // Product skills shipped in the image (V-Office today). The provider
      // scans this root at rank 600, so a tenant cannot shadow them from
      // `$DSH_HOME/skills` or `.agents/skills`.
      DSH_BUNDLED_SKILL_DIR: BUNDLED_SKILL_DIR,
      // Same root under the name the Image Studio tool resolves its CLI by.
      VH_SKILLS_DIR: BUNDLED_SKILL_DIR,
      // The tenant's VOS interface language: vos.patch.yml turns it into the
      // persona's answer language, and the gateway publishes the same value to
      // the browser as its host locale.
      ...(record.locale === undefined || record.locale === ''
        ? {}
        : { VH_USER_LOCALE: record.locale }),
      // The generation tool stays off until a deployment names an endpoint;
      // the gateway forwards only what this environment actually sets.
      ...(process.env.IMAGE_STUDIO_BASE_URL === undefined
        ? {}
        : { IMAGE_STUDIO_BASE_URL: process.env.IMAGE_STUDIO_BASE_URL }),
      // User-level installs first: npm -g, bun, pip --user and friends must
      // land in the tenant home, never in the shared read-only runtime.
      PATH: [
        `${jailHome}/.local/bin`,
        `${jailHome}/.bun/bin`,
        `${jailHome}/.nvm/current/bin`,
        process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      ].join(':'),
      // Every plugin resolves its data root from HOME, DSH_HOME or an XDG
      // root. Pinning all of them is what keeps a plugin's first write inside
      // the tenant: one shared root (a root-owned ~/.dsh left by an earlier
      // layout, or a process inheriting the gateway's own XDG paths) is how a
      // tenant's input in a plugin store becomes visible to the next tenant.
      XDG_CONFIG_HOME: `${jailHome}/.config`,
      XDG_DATA_HOME: `${jailHome}/.local/share`,
      XDG_CACHE_HOME: `${jailHome}/.cache`,
      XDG_STATE_HOME: `${jailHome}/.local/state`,
      // ds-bot keeps its own store and team folder; both default to the
      // process home, which is only correct if they are named explicitly.
      DS_BOT_USER_DSH_HOME: `${jailHome}/.dsh`,
      DS_BOT_WORKSPACE: `${jailHome}/workspace`,
      NODE_ENV: 'production',
      ...schedulerEnvironment(record.namespace),
      // Without a UTF-8 locale bash escapes non-ASCII names: the default
      // workspace `日常` shows up as $'\346\227\245\345\270\270' in terminals
      // and in tool output.
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  // Update profile-local overrides before dsh snapshots its browser bundles,
  // then stage the agent-side tool plugins and their carrier: the loader reads
  // the carrier row list at this same boot.
  await syncPlugins({ home: paths.home, linuxName: account, uid: record.uid });
  const child = spawn(JAIL_BIN, launchArgs, launchOptions);

  const log = createWriteStream(paths.log, { flags: 'a', mode: 0o600 });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  try {
    const launchUrl = await waitForLaunchUrl(child, LAUNCH_TIMEOUT_MS);
    const { cookie, expiresAt } = await exchangeCookie(launchUrl);
    state[record.namespace] = { cookie, cookieExpiresAt: expiresAt };
    await writeState(statePath, state);
    return {
      namespace: record.namespace,
      linuxName: account,
      port: record.port,
      child,
      cookie,
      cookieExpiresAt: expiresAt,
      starting: undefined,
    };
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

/**
 * Ensure the user's instance is running, starting it when necessary.
 *
 * Concurrent callers share one launch attempt: the first sign-in storm must not
 * spawn several dsh processes on the same port.
 *
 * @param {{
 *   record: import('./users.mjs').UserRecord,
 *   dataRoot: string,
 *   dshBin: string,
 *   nodeBin: string,
 *   statePath: string,
 *   userHelper: string,
 * }} options
 * @returns {Promise<Instance>}
 */
export async function ensureInstance(options) {
  const { record, dataRoot, statePath } = options;
  const account = record.account ?? record.linuxName;
  const existing = instances.get(record.namespace);
  if (existing?.starting) {
    await existing.starting;
    return instances.get(record.namespace) ?? existing;
  }
  if (existing?.child && existing.child.exitCode === null && !existing.child.killed) {
    return existing;
  }

  await runUserHelper(options.userHelper, [
    'ensure', account, String(record.uid), userPaths(dataRoot, account).home,
  ]);


  /** @type {Instance} */
  const placeholder = {
    namespace: record.namespace,
    linuxName: account,
    port: record.port,
    child: undefined,
    cookie: undefined,
    cookieExpiresAt: 0,
    starting: undefined,
  };
  placeholder.starting = (async () => {
    const state = await readState(statePath);
    const cached = state[record.namespace];
    const launched = await launch(options);
    if (cached?.cookie && cached.cookieExpiresAt && cached.cookieExpiresAt > Date.now()) {
      launched.cookie = cached.cookie;
      launched.cookieExpiresAt = cached.cookieExpiresAt;
    }
    launched.child?.once('exit', () => {
      const current = instances.get(record.namespace);
      if (current?.child === launched.child) instances.delete(record.namespace);
    });
    instances.set(record.namespace, launched);
  })();
  instances.set(record.namespace, placeholder);

  try {
    await placeholder.starting;
  } catch (error) {
    instances.delete(record.namespace);
    throw error;
  }
  return instances.get(record.namespace) ?? placeholder;
}

/**
 * Return the live instance without starting one.
 * @param {string} namespace
 * @returns {Instance | undefined}
 */
export function liveInstance(namespace) {
  return instances.get(namespace);
}

/**
 * Stop one instance; the next request starts it again.
 * @param {string} namespace
 * @returns {boolean} whether an instance was running.
 */
export function stopInstance(namespace) {
  const instance = instances.get(namespace);
  if (!instance?.child) return false;
  instance.child.kill('SIGTERM');
  instances.delete(namespace);
  return true;
}

/**
 * Stop every instance on shutdown.
 * @returns {Promise<void>}
 */
export async function stopAll() {
  await Promise.all([...instances.values()].map(async (instance) => {
    instance.child?.kill('SIGTERM');
  }));
  instances.clear();
}

/**
 * Wait until a path exists.
 * @param {string} path
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function waitForPath(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}
