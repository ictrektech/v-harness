/**
 * Per-user dsh instance lifecycle.
 *
 * Each user owns one `dsh --profile web` process running as `vh-xxxxxxxx`, on a
 * fixed port of the container's network. The gateway never speaks dsh's auth
 * protocol itself: it reads the launch URL the process prints, exchanges it for
 * dsh's own signed cookie, and replays that cookie on every forwarded request.
 * Both the exchange and the replay dial `addressing.mjs`, which is loopback
 * today.
 *
 * The cookie outlives the process because its signing key lives in the user's
 * `.credentials.yaml` and its authority is the fixed instance port. Only the
 * 30-day expiry forces a re-exchange.
 *
 * @module v-harness/gateway/instances
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, access, readdir, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { instanceAddress, tenantLoopback } from './addressing.mjs';
import { syncPlugins } from './plugins.mjs';
import { schedulerEnvironment } from './scheduler.mjs';
import { listUsers } from './users.mjs';

// A cold dsh boot spends tens of seconds on plugin and session setup before it
// announces its listener. A tight budget turns a merely slow boot into a
// sign-in failure, and the retry it triggers competes with the boot it just
// abandoned.
const LAUNCH_TIMEOUT_MS = 90_000;
/** One loopback round trip: a slow exchange means the instance is not answering. */
const EXCHANGE_TIMEOUT_MS = 15_000;
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
const HOME_ROOT = process.env.HOME_ROOT ?? process.env.DATA_ROOT ?? '/data';

/**
 * @typedef {object} Instance
 * @property {string} subject - VOS immutable subject; the instance map key.
 * @property {string} linuxName
 * @property {number} uid - tenant uid; also the source of its published address.
 * @property {number} port - the port dsh listens on inside the tenant namespace.
 * @property {import('node:child_process').ChildProcess | undefined} child
 * @property {string | undefined} cookie - dsh `dsh-auth-*` value.
 * @property {number} cookieExpiresAt
 * @property {Promise<void> | undefined} starting
 */

/** @type {Map<string, Instance>} */
const instances = new Map();

/** @type {Map<string, Promise<unknown>>} */
const launchChains = new Map();

/**
 * Directory layout for one tenant. The home is `<DATA_ROOT>/<account>` and nothing
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
 * Convert the persistent instance state from namespace keys to subject keys.
 *
 * Instances used to be addressed by the tenant's internal namespace; sessions
 * and routing now key on the immutable subject. The cookie each entry holds
 * belongs to the tenant's own `.credentials.yaml`, so it stays valid under the
 * new key. Entries naming no current user are dropped.
 * @param {string} statePath
 * @param {string} usersPath
 * @returns {Promise<void>}
 */
export async function migrateInstanceStateKeys(statePath, usersPath) {
  const state = await readState(statePath);
  let changed = false;
  for (const record of await listUsers(usersPath)) {
    if (record.namespace === record.subject) continue;
    const legacy = state[record.namespace];
    if (legacy === undefined) continue;
    if (state[record.subject] === undefined) {
      state[record.subject] = legacy;
    }
    delete state[record.namespace];
    changed = true;
  }
  if (changed) await writeState(statePath, state);
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
 *
 * dsh announces its launch URL on the tenant's own loopback address (the one
 * its uid maps to). The request dials that address, while the Host header
 * keeps naming `127.0.0.1:<port>`: that authority is what the handed-back
 * cookie is bound to, and what every later forwarded request replays.
 * @param {string} launchUrl - the URL dsh printed on its own stdout.
 * @param {number} uid - tenant uid, which selects its private loopback address.
 * @returns {Promise<{ cookie: string, expiresAt: number }>}
 */
async function exchangeCookie(launchUrl, uid) {
  const target = new URL(launchUrl);
  const secure = target.protocol === 'https:';
  const port = Number(target.port === '' ? (secure ? 443 : 80) : target.port);
  const response = await new Promise((resolve, reject) => {
    const request = secure ? httpsRequest : httpRequest;
    const upstream = request({
      host: instanceAddress(uid),
      port,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      headers: { host: `127.0.0.1:${String(port)}` },
      ...(secure ? { servername: '127.0.0.1' } : {}),
    }, (reply) => {
      resolve({ status: reply.statusCode ?? 0, cookies: reply.headers['set-cookie'] ?? [] });
      reply.resume();
    });
    upstream.setTimeout(EXCHANGE_TIMEOUT_MS, () => {
      upstream.destroy(new Error('timed out exchanging the dsh launch URL'));
    });
    upstream.on('error', reject);
    upstream.end();
  });
  // A valid exchange answers 303 with exactly one Set-Cookie.
  if (response.status !== 303) {
    throw new Error(`dsh launch exchange returned HTTP ${String(response.status)}`);
  }
  const raw = response.cookies.find((value) => value.trimStart().startsWith('dsh-auth-'));
  if (!raw) throw new Error('dsh launch exchange returned no dsh-auth cookie');
  const pair = raw.split(';', 1)[0]?.trim();
  if (!pair) throw new Error('dsh launch exchange returned a malformed cookie');
  return { cookie: pair, expiresAt: Date.now() + COOKIE_MAX_AGE_MS };
}

/**
 * Rewrite session and workspace records that still point at a path the jail no
 * longer presents.
 *
 * dsh stores whatever home path its process saw. Three layouts produced three
 * prefixes: the mirrored `/data/users/<namespace>` tree, the account-named
 * `/data/<account>` one, and the current `/home/<account>` jail view (the
 * physical volume has stayed `<HOME_ROOT>/<account>` throughout). Rewriting
 * the prefixes makes the migration idempotent, including for tenants created
 * before the layout changed; the marker names the layout it migrated to, so a
 * future change re-runs the rewrite by bumping the version instead of
 * silently skipping.
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
  const current = `/home/${account}`;
  const stale = [`/data/users/${namespace}`, `/home/${namespace}`, `/data/${account}`]
    .filter((prefix) => prefix !== current);
  const storages = join(dshHome, 'storages');
  // The marker names the layout it migrated to, so a future layout change
  // re-runs the rewrite by bumping the version instead of silently skipping.
  const marker = join(dshHome, '.jail-paths-home-v3');
  try {
    await access(marker);
    return;
  } catch {
    // Not migrated yet.
  }
  await rm(join(storages, 'session_projcache'), { recursive: true, force: true });
  // Walk recursively: sessions, attachments and plugin stores nest below the
  // top level, and a one-level scan silently skipped every nested path.
  const stack = [storages];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const text = await readFile(path, 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      let rewritten = text;
      for (const prefix of stale) rewritten = rewritten.split(prefix).join(current);
      if (rewritten === text) continue;
      await writeFile(path, rewritten, 'utf8');
    }
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
 * Who listens on one port in the container network.
 *
 * Tenants no longer get their own network namespace, so the ordinary socket
 * table is the whole answer: every instance listens on loopback and the port is
 * allocated per tenant, which is what keeps two tenants apart now.
 * @param {number} port
 * @returns {{ pid: number, uid: number } | undefined}
 */
function listenerIn(port) {
  let output;
  try {
    output = execFileSync('ss', ['-lntpH'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    // No ss to ask: the launch reports its own port conflict if there is one.
    void error;
    return undefined;
  }
  const pattern = new RegExp(`:${String(port)}\\s`);
  const line = output.split('\n').find((entry) => pattern.test(entry));
  const pid = line === undefined ? undefined : /pid=(\d+)/.exec(line)?.[1];
  if (pid === undefined) return undefined;
  let status;
  try {
    status = readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch (error) {
    void error;
    return undefined;
  }
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  return { pid: Number(pid), uid: Number(uid) };
}

/**
 * Reclaim the instance port from a daemon this gateway no longer owns.
 *
 * The gateway restarts far more often than its container, and a launched jail
 * outlives it: the instance map is empty while the old dsh still holds the
 * port, so the next dsh dies on EADDRINUSE and the workspace never opens. The
 * port is allocated per tenant, so the conflict is always between two of
 * *this* tenant's processes.
 * @param {number} port
 * @param {number} uid
 * @param {string} account
 * @returns {Promise<void>}
 */
async function reclaimPort(port, uid, account) {
  const owner = listenerIn(port);
  if (owner === undefined) return;
  // A listener belonging to another uid is never ours to kill: ports are
  // allocated per tenant, so this is a deployment mistake to report.
  if (owner.uid !== uid) {
    throw new Error(
      `port ${String(port)} is held by pid ${String(owner.pid)} (uid ${String(owner.uid)}), not tenant ${account}`,
    );
  }
  console.warn(`instance launch: reclaiming port ${String(port)} from pid ${String(owner.pid)} (${account})`);
  process.kill(owner.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (listenerIn(port) === undefined) return;
  }
  throw new Error(`port ${String(port)} is still held after reclaiming it from pid ${String(owner.pid)}`);
}

/**
 * Start one dsh process and capture its cookie.
 * @param {{
 *   record: import('./users.mjs').UserRecord,
 *   stateRoot: string,
 *   dshBin: string,
 *   nodeBin: string,
 *   statePath: string,
 * }} options
 * @returns {Promise<Instance>}
 */
async function launch(options) {
  const { record, stateRoot, dshBin, nodeBin, statePath } = options;
  const account = record.account ?? record.linuxName;
  const paths = userPaths(stateRoot, account);
  await mkdir(join(stateRoot, LOG_DIR_NAME), { recursive: true, mode: 0o700 });

  const state = await readState(statePath);
  await adoptTenantRoots(paths.home, paths.dshHome, record.uid, account);
  await rewriteJailPaths(paths.dshHome, record.namespace, account);

  // vh-jail drops to the user *after* entering a mount+pid+uts namespace. The
  // jailed paths are what the process sees and what dsh records, so HOME and
  // everything derived from it use the jail's own view of the home —
  // /home/<account>, bound from the physical <HOME_ROOT>/<account> — and never
  // an internal identifier.
  const jailHome = `/home/${account}`;

  const launchArgs = [
    account, String(record.uid), paths.home,
    nodeBin, dshBin, '--profile', 'web',
    '--patch', '/usr/local/share/v-harness/vos.patch.yml',
    // The tenant's own loopback address: the kernel treats all of 127/8 as
    // local, and the per-tenant iptables rules keep every other uid off it.
    '--host', tenantLoopback(record.uid),
    // The cookie authority stays the shared-loopback form every forwarding
    // path already speaks; the fence accepts it through this declaration.
    '--trusted-host', `127.0.0.1:${String(record.port)}`,
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
      // vh-jail allow-lists the gateway port on the shared loopback so the
      // instance can call back (scheduler, model proxying) under the strict
      // per-tenant 127/8 policy it installs.
      VH_GATEWAY_PORT: String(process.env.PORT ?? 8080),
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
      // Package managers that predate the XDG convention keep their own cache
      // variables; unset, they still resolve to the (now writable) home, but
      // naming them keeps a stray `HOME` from sending writes elsewhere.
      NPM_CONFIG_CACHE: `${jailHome}/.npm`,
      PIP_CACHE_DIR: `${jailHome}/.cache/pip`,
      UV_CACHE_DIR: `${jailHome}/.cache/uv`,
      PNPM_HOME: `${jailHome}/.local/share/pnpm`,
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
  await reclaimPort(record.port, record.uid, account);
  const child = spawn(JAIL_BIN, launchArgs, launchOptions);

  const log = createWriteStream(paths.log, { flags: 'a', mode: 0o600 });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  try {
    const launchUrl = await waitForLaunchUrl(child, LAUNCH_TIMEOUT_MS);
    const { cookie, expiresAt } = await exchangeCookie(launchUrl, record.uid);
    // Instances are keyed by the immutable subject. Drop the legacy namespace
    // key the same time the subject key is written, so one launch finishes
    // the persistent-state migration for its tenant.
    if (record.namespace !== record.subject) delete state[record.namespace];
    state[record.subject] = { cookie, cookieExpiresAt: expiresAt };
    await writeState(statePath, state);
    return {
      subject: record.subject,
      linuxName: account,
      uid: record.uid,
      port: record.port,
      child,
      cookie,
      cookieExpiresAt: expiresAt,
      starting: undefined,
    };
  } catch (error) {
    child.kill('SIGTERM');
    const detail = error instanceof Error ? error.message : String(error);
    // The jail can die without writing anything to its own log, so the log path
    // is the only pointer an operator has from the gateway's line.
    throw new Error(`${detail} (log: ${paths.log})`);
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
 *   stateRoot: string,
 *   dshBin: string,
 *   nodeBin: string,
 *   statePath: string,
 *   userHelper: string,
 * }} options
 * @returns {Promise<Instance>}
 */
export async function ensureInstance(options) {
  const { record, stateRoot } = options;
  const account = record.account ?? record.linuxName;
  const existing = instances.get(record.subject);
  if (existing?.starting) {
    await existing.starting;
    return instances.get(record.subject) ?? existing;
  }
  if (existing?.child && existing.child.exitCode === null && !existing.child.killed) {
    return existing;
  }

  await runUserHelper(options.userHelper, [
    'ensure', account, String(record.uid), userPaths(stateRoot, account).home,
  ]);


  /** @type {Instance} */
  const placeholder = {
    subject: record.subject,
    linuxName: account,
    uid: record.uid,
    port: record.port,
    child: undefined,
    cookie: undefined,
    cookieExpiresAt: 0,
    starting: undefined,
  };
  // Launches for one tenant are serialized even across failures. A timed-out
  // attempt leaves the map before its jail has exited, so a retry that arrived
  // in that window used to start a second launch beside the dying one — two
  // processes writing the same profile (`plugin sync failed` with EEXIST) and
  // racing for the same port.
  const previous = launchChains.get(record.subject) ?? Promise.resolve();
  const attempt = previous.catch(() => {}).then(() => launch(options));
  launchChains.set(record.subject, attempt);
  placeholder.starting = attempt.then((launched) => {
    // Every process start exchanges its own launch URL for a cookie. A cached
    // cookie belongs to the `.credentials.yaml` that signed it: once the home
    // was moved or replaced by a new image, that key is gone and replaying the
    // stale value lands the browser on "authentication required".
    launched.child?.once('exit', () => {
      const current = instances.get(record.subject);
      if (current?.child === launched.child) instances.delete(record.subject);
    });
    instances.set(record.subject, launched);
  });
  instances.set(record.subject, placeholder);

  try {
    await placeholder.starting;
  } catch (error) {
    instances.delete(record.subject);
    throw error;
  }
  return instances.get(record.subject) ?? placeholder;
}

/**
 * Return the live instance without starting one.
 * @param {string} subject
 * @returns {Instance | undefined}
 */
export function liveInstance(subject) {
  return instances.get(subject);
}

/**
 * Stop one instance; the next request starts it again.
 * @param {string} subject
 * @returns {boolean} whether an instance was running.
 */
export function stopInstance(subject) {
  const instance = instances.get(subject);
  if (!instance?.child) return false;
  instance.child.kill('SIGTERM');
  instances.delete(subject);
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
