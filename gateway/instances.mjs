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
import { closeSync, fchmodSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, access, open, readdir, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { instanceAddress, tenantLoopback } from './addressing.mjs';
import { rememberProfile, restoreProfile } from './last-good.mjs';
import { capabilitiesPluginShipped, syncPlugins } from './plugins.mjs';
import {
  CAPABILITY_ENV,
  rememberCapabilityContract,
  removeCapabilityContract,
  rolloutCapabilities,
  writeCapabilityContract,
} from './capability-registry.mjs';
import {
  dropMcphubLaunchPatch, mcphubEnvironment, mcphubLaunchPatch, saveMcphubSelection,
} from './mcphub.mjs';
import { schedulerEnvironment } from './scheduler.mjs';
import { listUsers } from './users.mjs';
import {
  COOKIE_MAX_AGE_MS, adoptable, backfillInstanceState, probeInstance,
  readRegistry, writeRegistry,
} from './instance-state.mjs';

// A cold dsh boot spends tens of seconds on plugin and session setup before it
// announces its listener. A tight budget turns a merely slow boot into a
// sign-in failure, and the retry it triggers competes with the boot it just
// abandoned.
const LAUNCH_TIMEOUT_MS = 90_000;
/** One loopback round trip: a slow exchange means the instance is not answering. */
const EXCHANGE_TIMEOUT_MS = 15_000;
/**
 * dsh prints its launch URL from the listener callback, but the socket may not
 * accept a dial yet: the first connect can be refused even though the URL is
 * already on stdout. Retrying that window is what keeps a healthy boot from
 * being killed and launched again.
 */
const EXCHANGE_RETRY_MS = 250;
const RETRYABLE_EXCHANGE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT',
]);
/** An adopted process has no child handle, so re-prove it on this cadence. */
const ADOPT_RECHECK_MS = 30_000;
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
 * @property {number} bootedAt - real process start time, persisted in the registry.
 * @property {number} [pid] - host-side jail pid, for stopping an adopted instance.
 * @property {boolean} [adopted] - the process predates this gateway process.
 * @property {number} [checkedAt] - last successful probe of an adopted process.
 */

/** @type {Map<string, Instance>} */
const instances = new Map();

/** Boot identity survives a gateway restart even before the first adoption.
 * @type {Map<string, number>}
 */
const bootStamps = new Map();

/** Subjects the owner just stopped: their old process must not be adopted
 * back before a fresh launch replaces it.
 * @type {Set<string>}
 */
const retired = new Set();

/** @type {Map<string, Promise<unknown>>} */
const launchChains = new Map();

/**
 * Why the last launch of one tenant failed, when it did.
 *
 * The starting page reads it so a workspace that cannot come up says what
 * happened instead of turning a spinner forever.
 * @type {Map<string, string>}
 */
const launchFailures = new Map();

/**
 * A forwarding failure invalidates at most once per window: every concurrent
 * request to a dead instance reports the same error, and one relaunch answers
 * all of them.
 */
const INVALIDATE_THROTTLE_MS = 5_000;

/** @type {Map<string, number>} */
const invalidatedAt = new Map();

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
 * Convert the persistent instance state from namespace keys to subject keys,
 * then give cookie-only entries the fields adoption needs. One boot finishes
 * both migrations; later boots find nothing to move and leave the file alone.
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
  const state = await readRegistry(statePath);
  const users = await listUsers(usersPath);
  let changed = false;
  for (const record of users) {
    if (record.namespace === record.subject) continue;
    const legacy = state[record.namespace];
    if (legacy === undefined) continue;
    if (state[record.subject] === undefined) {
      state[record.subject] = legacy;
    }
    delete state[record.namespace];
    changed = true;
  }
  if (backfillInstanceState(state, users)) changed = true;
  if (changed) await writeRegistry(statePath, state);
}

/**
 * Publish the persisted boot identities before the first request is served,
 * so `/__vh/boot` answers with the same value the previous gateway did.
 * @param {Record<string, import('./instance-state.mjs').InstanceState>} registry
 * @returns {void}
 */
export function primeInstanceBoots(registry) {
  for (const [subject, entry] of Object.entries(registry)) {
    if (typeof entry?.bootedAt === 'number' && entry.bootedAt > 0) {
      bootStamps.set(subject, entry.bootedAt);
    }
  }
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
 *
 * The process writes straight to a log file instead of a gateway-owned pipe:
 * when the gateway exits, a pipe's read end closes and dsh's next write would
 * hit EPIPE. dsh is the init of its own pid namespace, so losing it takes the
 * whole tenant down — exactly what a gateway restart must not do. Only bytes
 * appended by this attempt are scanned, so a URL from an earlier boot cannot
 * be replayed as a single-use launch token.
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} logPath
 * @param {number} fromOffset - log size before this attempt started.
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
export async function waitForLaunchUrl(child, logPath, fromOffset, timeoutMs) {
  const pattern = /dsh web: (https?:\/\/[^\s"'<>]+)/;
  const deadline = Date.now() + timeoutMs;
  let scanned = fromOffset;
  let carry = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('dsh exited before announcing its URL');
    }
    /** @type {import('node:fs/promises').FileHandle | undefined} */
    let handle;
    try {
      handle = await open(logPath, 'r');
      const { size } = await handle.stat();
      if (size > scanned) {
        const buffer = Buffer.alloc(size - scanned);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, scanned);
        const text = carry + buffer.subarray(0, bytesRead).toString('utf8');
        const match = text.match(pattern);
        if (match) return match[1];
        // A line may straddle two polls; keep its tail for the next read.
        carry = text.slice(-512);
        scanned += bytesRead;
      }
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error)?.code !== 'ENOENT') throw error;
    } finally {
      await handle?.close();
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  throw new Error('timed out waiting for the dsh launch URL');
}

/**
 * Whether a failed exchange never reached dsh at all.
 *
 * A refused or dropped connection is proof the single-use launch token was not
 * consumed, so the same URL stays valid and another dial is safe. A non-303
 * answer is different: dsh did read the token, and repeating it would only
 * trade a clear error for a confusing one.
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableExchangeError(error) {
  const code = String(/** @type {{ code?: string }} */ (error)?.code ?? '');
  if (RETRYABLE_EXCHANGE_CODES.has(code)) return true;
  const message = String(/** @type {{ message?: string }} */ (error)?.message ?? '');
  return /socket hang up|timed out exchanging/i.test(message);
}

/**
 * One exchange attempt against the tenant's loopback address.
 * @param {string} launchUrl - the URL dsh printed on its own stdout.
 * @param {string} host - the tenant's private loopback address.
 * @returns {Promise<{ cookie: string, expiresAt: number }>}
 */
async function exchangeOnce(launchUrl, host) {
  const target = new URL(launchUrl);
  const secure = target.protocol === 'https:';
  const port = Number(target.port === '' ? (secure ? 443 : 80) : target.port);
  const response = await new Promise((resolve, reject) => {
    const request = secure ? httpsRequest : httpRequest;
    const upstream = request({
      host,
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
 * Exchange the launch URL for dsh's signed browser cookie.
 *
 * dsh announces its launch URL on the tenant's own loopback address (the one
 * its uid maps to). The request dials that address, while the Host header
 * keeps naming `127.0.0.1:<port>`: that authority is what the handed-back
 * cookie is bound to, and what every later forwarded request replays.
 *
 * The URL is announced from the listener callback, which is not the same thing
 * as the socket accepting connections: the first dial of a freshly printed URL
 * can be refused. Retrying that window is deliberate — giving up on it kills a
 * boot that was going to succeed, and the relaunch then races the boot it just
 * abandoned.
 * @param {string} launchUrl - the URL dsh printed on its own stdout.
 * @param {number} uid - tenant uid, which selects its private loopback address.
 * @param {{ host?: string, timeoutMs?: number }} [options] - dial and budget,
 *   overridable so a test can point the exchange at a local listener.
 * @returns {Promise<{ cookie: string, expiresAt: number }>}
 */
export async function exchangeCookie(launchUrl, uid, options = {}) {
  const host = options.host ?? instanceAddress(uid);
  const deadline = Date.now() + (options.timeoutMs ?? EXCHANGE_TIMEOUT_MS);
  for (;;) {
    try {
      return await exchangeOnce(launchUrl, host);
    } catch (error) {
      if (!isRetryableExchangeError(error) || Date.now() + EXCHANGE_RETRY_MS >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, EXCHANGE_RETRY_MS));
    }
  }
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
/**
 * Signal whoever holds a tenant port until the port is actually free.
 *
 * dsh is the init of its own pid namespace, so SIGTERM may never reach a
 * handler; SIGKILL from this namespace always lands. A stop that leaves the
 * port held lets the next request adopt the very process the owner just
 * stopped.
 * @param {{ pid: number, uid: number }} owner
 * @param {number} port
 * @param {string} account
 * @returns {Promise<boolean>} whether the port came free.
 */
async function stopListener(owner, port, account) {
  process.kill(owner.pid, 'SIGTERM');
  if (await waitForFreePort(port, 50)) return true;
  console.warn(`SIGKILL pid ${String(owner.pid)} (${account}) kept its port through SIGTERM`);
  process.kill(owner.pid, 'SIGKILL');
  return waitForFreePort(port, 30);
}

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
  if (await stopListener(owner, port, account)) return;
  throw new Error(`port ${String(port)} is still held after reclaiming it from pid ${String(owner.pid)}`);
}

/**
 * Watch one port until nothing listens on it.
 * @param {number} port
 * @param {number} attempts - times to look, 100ms apart.
 * @returns {Promise<boolean>} whether the port came free.
 */
export async function waitForFreePort(port, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (listenerIn(port) === undefined) return true;
  }
  return false;
}

/**
 * Destinations a tenant may reach outside its own address.
 *
 * The jail drops every private range, so any VOS service the agent has to call
 * has to be named here — that list is the only way out. Hosts are resolved at
 * launch instead of being pinned as addresses: a recreated container gets a new
 * address, and a stale `/32` in a deployment file is a rule that silently stops
 * matching while looking correct.
 *
 * `VH_NET_ALLOW_CIDRS` stays as the literal form for ranges (an office subnet,
 * a resolver); `VH_NET_ALLOW_HOSTS` names single services by their compose name.
 * @returns {Promise<string>} comma-separated destinations; empty when none apply.
 */
async function allowedDestinations() {
  const entries = [];
  for (const raw of String(process.env.VH_NET_ALLOW_CIDRS ?? '').split(',')) {
    const cidr = raw.trim();
    if (cidr !== '') entries.push(cidr);
  }
  for (const raw of String(process.env.VH_NET_ALLOW_HOSTS ?? '').split(',')) {
    const host = raw.trim();
    if (host === '') continue;
    try {
      const { address, family } = await lookup(host);
      entries.push(family === 6 ? `${address}/128` : `${address}/32`);
    } catch (error) {
      // A host that cannot be resolved is a deployment mistake worth seeing, and
      // the launch continues: the rest of the allow-list still applies.
      console.warn(`cannot resolve VH_NET_ALLOW_HOSTS entry ${host}:`, error instanceof Error ? error.message : error);
    }
  }
  return entries.join(',');
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

  const state = await readRegistry(statePath);
  await adoptTenantRoots(paths.home, paths.dshHome, record.uid, account);
  await rewriteJailPaths(paths.dshHome, record.namespace, account);

  // vh-jail drops to the user *after* entering a mount+pid+uts namespace. The
  // jailed paths are what the process sees and what dsh records, so HOME and
  // everything derived from it use the jail's own view of the home —
  // /home/<account>, bound from the physical <HOME_ROOT>/<account> — and never
  // an internal identifier.
  const jailHome = `/home/${account}`;

  // The MCPHub panel row and the Agent's MCP capability are issued only where
  // the sibling application answers; the probe is cached, so a platform without
  // MCPHub pays for one miss per minute rather than one per launch.
  const mcphub = await mcphubEnvironment(record.namespace);
  // A tenant that chose services mounts one MCP client per service instead of
  // the aggregate endpoint; the overlay is regenerated on every launch so a
  // rotated capability key never has to be chased through the tenant home.
  const mcphubChoice = mcphub.VH_MCPHUB === undefined ? {} : await mcphubLaunchPatch({
    namespace: record.namespace,
    home: paths.home,
    linuxName: account,
    jailHome,
    uid: record.uid,
  });

  /**
   * The jail's arguments for one launch.
   * @param {{ patch?: string }} choice - the MCP overlay to add, if any.
   * @returns {string[]} the arguments.
   */
  const launchArgsFor = (choice) => [
    account, String(record.uid), paths.home,
    nodeBin, dshBin, '--profile', 'web',
    '--patch', '/usr/local/share/v-harness/vos.patch.yml',
    ...(choice.patch === undefined ? [] : ['--patch', choice.patch]),
    // The tenant's own loopback address: the kernel treats all of 127/8 as
    // local, and the per-tenant iptables rules keep every other uid off it.
    '--host', tenantLoopback(record.uid),
    // The cookie authority stays the shared-loopback form every forwarding
    // path already speaks; the fence accepts it through this declaration.
    '--trusted-host', `127.0.0.1:${String(record.port)}`,
    '--port', String(record.port),
    '--no-open',
  ];
  // One lookup per launch: the allow-list is what lets the agent reach a VOS
  // service, so it has to reflect the address that service has right now.
  const allowed = await allowedDestinations();
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
      // VOS services the agent may call past its own address. vh-jail drops
      // every private range, so this list is the only opening it gets.
      ...(allowed === '' ? {} : { VH_NET_ALLOW_CIDRS: allowed }),
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
      ...mcphub,
      // Without a UTF-8 locale bash escapes non-ASCII names: the default
      // workspace `日常` shows up as $'\346\227\245\345\270\270' in terminals
      // and in tool output.
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    },
  };
  // Update profile-local overrides before dsh snapshots its browser bundles,
  // then stage the agent-side tool plugins and their carrier: the loader reads
  // the carrier row list at this same boot. A refresh that fails leaves the
  // profile the previous boot used, which is worth more than a dead workspace —
  // but it also means this process cannot vouch for the capability plugin, so
  // delegation is withheld below instead of handing the sockets to a listener
  // that may not exist.
  let pluginsReady = false;
  try {
    pluginsReady = await syncPlugins({ home: paths.home, linuxName: account, uid: record.uid });
    if (!pluginsReady) {
      console.error(
        `plugin sync incomplete for ${account}, launching with the profile already on disk and keeping gateway-owned capability sockets`,
      );
    }
  } catch (error) {
    console.error(
      `plugin sync failed for ${account}, launching with the profile already on disk and keeping gateway-owned capability sockets:`,
      error instanceof Error ? error.message : error,
    );
  }

  // Hand this tenant's capability sockets to its own dsh when the image ships
  // the plugin and this launch proved it is staged. The contract is the entire
  // switch: the plugin listens only for the names it lists, the authoritative
  // copy lives under STATE_ROOT, and the gateway reads that copy back on every
  // boot instead of remembering what it decided here. A payload without the
  // plugin, or a failed stage, keeps the gateway-owned sockets untouched and
  // drops any contract an earlier image left behind.
  if (pluginsReady && await capabilitiesPluginShipped()) {
    try {
      const contract = await writeCapabilityContract({
        stateRoot,
        home: paths.home,
        subject: record.subject,
        account,
        uid: record.uid,
        capabilities: rolloutCapabilities(CAPABILITY_ENV, record.namespace),
      });
      if (contract === undefined) {
        await removeCapabilityContract({ stateRoot, home: paths.home, subject: record.subject });
      } else {
        rememberCapabilityContract(record.subject, {
          home: paths.home,
          namespace: record.namespace,
          subject: record.subject,
          account,
          uid: record.uid,
          ...contract,
        });
      }
    } catch (error) {
      // A contract that cannot be written must not be guessed at: the gateway
      // keeps its own sockets rather than leaving the tenant with none.
      console.error(
        `capability contract write failed for ${account}, keeping gateway sockets:`,
        error instanceof Error ? error.message : error,
      );
      await removeCapabilityContract({ stateRoot, home: paths.home, subject: record.subject })
        .catch((cleanupError) => { console.error('capability contract cleanup failed:', cleanupError); });
    }
  } else {
    await removeCapabilityContract({ stateRoot, home: paths.home, subject: record.subject })
      .catch((error) => { console.error(`capability contract cleanup failed for ${account}:`, error); });
  }

  /**
   * Spawn the jail once and wait for the line it writes to the log.
   * @param {string[]} argv - the jail's arguments.
   * @returns {Promise<{ child: import('node:child_process').ChildProcess, launchUrl: string }>}
   *   the running child and the URL it announced.
   */
  const startOnce = async (argv) => {
    await reclaimPort(record.port, record.uid, account);
    // The child keeps its own fd to the log file; the gateway closes its copy
    // right after spawn. A plain file cannot break when this gateway exits,
    // which is what lets dsh survive a gateway restart. The launch URL carries
    // a single-use token, so the log stays 0600.
    const logFd = openSync(paths.log, 'a', 0o600);
    fchmodSync(logFd, 0o600);
    const fromOffset = fstatSync(logFd).size;
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(JAIL_BIN, argv, { ...launchOptions, stdio: ['ignore', logFd, logFd] });
    } finally {
      closeSync(logFd);
    }
    try {
      const launchUrl = await waitForLaunchUrl(child, paths.log, fromOffset, LAUNCH_TIMEOUT_MS);
      return { child, launchUrl };
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }
  };

  /**
   * Start the tenant, stepping down to configurations that cannot be the cause.
   *
   * A restart re-reads everything the boot composes, including files this
   * gateway wrote, so an invalid one of those turns every later launch into an
   * immediate exit. The ladder is deliberate: what the tenant chose, then what
   * the gateway generated, then what last worked. A workspace without a
   * preference is recoverable; a workspace that does not start is not.
   * @returns {Promise<{ child: import('node:child_process').ChildProcess, launchUrl: string }>}
   *   the running child and the URL it announced.
   */
  const start = async () => {
    /** @type {string[]} */
    const failures = [];
    /** @param {unknown} error */
    const note = (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(detail);
      return detail;
    };

    try {
      Object.assign(launchOptions.env, mcphubChoice.env ?? {});
      return await startOnce(launchArgsFor(mcphubChoice));
    } catch (error) {
      console.error(`launch failed for ${account}:`, note(error));
    }

    // The service choice is a preference, so it goes first: an owner who picked
    // services is better served by a workspace without them than by none.
    if (mcphubChoice.patch !== undefined) {
      try {
        console.error(`dropping the MCP service choice for ${account} and launching again`);
        await dropMcphubLaunchPatch({ home: paths.home });
        // The record goes with the file: a choice that cannot start would
        // otherwise cost two extra launch attempts on every boot from here on.
        await saveMcphubSelection(record.namespace, undefined);
        delete launchOptions.env.VH_MCPHUB_SELECT;
        return await startOnce(launchArgsFor({}));
      } catch (error) {
        console.error(`launch without the MCP service choice failed for ${account}:`, note(error));
      }
    }

    // Then the configuration this tenant last booted with: what the gateway
    // writes between boots is the only input it can also put back.
    try {
      const restored = await restoreProfile({
        home: paths.home, stateRoot, account, uid: record.uid, linuxName: account,
      });
      if (restored) {
        console.error(`restored the last known good profile for ${account} and launching again`);
        delete launchOptions.env.VH_MCPHUB_SELECT;
        return await startOnce(launchArgsFor({}));
      }
    } catch (error) {
      console.error(`last known good profile not restored for ${account}:`, note(error));
    }

    launchFailures.set(record.subject, failures.at(-1) ?? 'launch failed');
    throw new Error(`${failures.at(-1) ?? 'launch failed'} (log: ${paths.log})`);
  };

  /** @type {{ child: import('node:child_process').ChildProcess, launchUrl: string }} */
  let started;
  try {
    started = await start();
  } catch (error) {
    // The contract was written before the spawn so the plugin could read it at
    // boot. A launch that never produced a process leaves nobody listening: the
    // next boot would skip this tenant's sockets and report a missing plugin
    // for a capability this gateway can still serve itself.
    await removeCapabilityContract({ stateRoot, home: paths.home, subject: record.subject })
      .catch((cleanupError) => { console.error(`capability contract cleanup failed for ${account}:`, cleanupError); });
    throw error;
  }
  const { child, launchUrl } = started;

  try {
    const { cookie, expiresAt } = await exchangeCookie(launchUrl, record.uid);
    const bootedAt = Date.now();
    // Everything a later gateway needs to adopt this process: the cookie it
    // forwards with, the address and boot identity it must not change, the pid
    // it may have to stop, and the capability keys already baked into this
    // process's environment (a running process cannot be given new env).
    if (record.namespace !== record.subject) delete state[record.namespace];
    state[record.subject] = {
      cookie,
      cookieExpiresAt: expiresAt,
      port: record.port,
      uid: record.uid,
      bootedAt,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      ...(typeof launchOptions.env.VH_SCHEDULER_KEY === 'string'
        ? { schedulerKey: launchOptions.env.VH_SCHEDULER_KEY } : {}),
      ...(typeof launchOptions.env.VH_MCPHUB_KEY === 'string'
        ? { mcphubKey: launchOptions.env.VH_MCPHUB_KEY } : {}),
    };
    await writeRegistry(statePath, state);
    // Only a boot that answered becomes the fallback: a snapshot of anything
    // else would restore the reason the next launch fails.
    await rememberProfile({ home: paths.home, stateRoot, account }).catch((error) => {
      console.error(`last known good profile not recorded for ${account}:`, error?.message ?? error);
    });
    launchFailures.delete(record.subject);
    return {
      subject: record.subject,
      linuxName: account,
      uid: record.uid,
      port: record.port,
      child,
      cookie,
      cookieExpiresAt: expiresAt,
      bootedAt,
      pid: child.pid,
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
  if (existing?.adopted) {
    if (Date.now() - (existing.checkedAt ?? 0) < ADOPT_RECHECK_MS) return existing;
    if (existing.cookie !== undefined && await probeInstance({
      uid: record.uid, port: record.port, cookie: existing.cookie,
    })) {
      existing.checkedAt = Date.now();
      return existing;
    }
    instances.delete(record.subject);
    bootStamps.delete(record.subject);
  } else if (existing?.child && existing.child.exitCode === null && !existing.child.killed) {
    return existing;
  }

  // A process launched by a previous gateway is still healthy: adopt it rather
  // than spawning a replacement that would reclaim its port from a live dsh.
  // An owner-requested stop is different: that same process is the one being
  // retired, and adopting it would undo the restart (or the logout).
  const state = await readRegistry(options.statePath);
  const entry = state[record.subject];
  if (!retired.has(record.subject) && adoptable(record, entry) && await probeInstance({
    uid: record.uid, port: record.port, cookie: /** @type {string} */ (entry.cookie),
  })) {
    /** @type {Instance} */
    const adopted = {
      subject: record.subject,
      linuxName: account,
      uid: record.uid,
      port: record.port,
      child: undefined,
      cookie: entry.cookie,
      cookieExpiresAt: /** @type {number} */ (entry.cookieExpiresAt),
      bootedAt: /** @type {number} */ (entry.bootedAt),
      pid: entry.pid,
      adopted: true,
      checkedAt: Date.now(),
      starting: undefined,
    };
    instances.set(record.subject, adopted);
    bootStamps.set(record.subject, adopted.bootedAt);
    console.log(`instance adopted: ${account} port=${String(record.port)} boot=${String(adopted.bootedAt)}`);
    return adopted;
  }

  /** @type {Instance} */
  const placeholder = {
    subject: record.subject,
    linuxName: account,
    uid: record.uid,
    port: record.port,
    child: undefined,
    cookie: undefined,
    cookieExpiresAt: 0,
    bootedAt: 0,
    starting: undefined,
  };
  // Claim the slot before the first await. The helper call below outlasts a
  // page load, and a request that arrived in that window used to see no entry
  // at all, queue a second attempt behind this one, and start it the moment the
  // first finished — reclaiming the port from the process that had just begun
  // listening, which is what a tab saw as a white screen after a restart.
  instances.set(record.subject, placeholder);
  // Launches for one tenant are serialized even across failures. A timed-out
  // attempt leaves the map before its jail has exited, so a retry that arrived
  // in that window used to start a second launch beside the dying one — two
  // processes writing the same profile (`plugin sync failed` with EEXIST) and
  // racing for the same port.
  const previous = launchChains.get(record.subject) ?? Promise.resolve();
  const attempt = previous
    .catch(() => {})
    .then(() => runUserHelper(options.userHelper, [
      'ensure', account, String(record.uid), userPaths(stateRoot, account).home,
    ]))
    .then(() => {
      // A cold boot is the slowest path a user sees, and it used to leave no
      // trace in the gateway log at all. One line per attempt makes the wait
      // attributable before deciding where to optimise it.
      const begun = Date.now();
      return launch(options).finally(() => {
        console.log(`instance launch for ${account} took ${String(Date.now() - begun)}ms`);
      });
    });
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
    bootStamps.set(record.subject, launched.bootedAt);
    retired.delete(record.subject);
  });

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
 * Whether one tenant's dsh still answers HTTP.
 *
 * Used when a delegated capability socket does not respond: the gateway only
 * takes the socket back from a tenant that is running, because an offline
 * tenant cannot serve or call anything and deleting its contract would fight
 * the next launch. The in-memory instance is the fast answer; a gateway that
 * just restarted has to recover the same answer from the registry, which keeps
 * the cookie the process signed.
 * @param {{ subject: string, uid: number, port: number }} record - the tenant.
 * @param {string} statePath - the instance registry file.
 * @returns {Promise<boolean>} whether the recorded process answered.
 */
export async function instanceAnswers(record, statePath) {
  const cached = instances.get(record.subject);
  if (cached?.cookie !== undefined) return true;
  let registry;
  try {
    registry = await readRegistry(statePath);
  } catch {
    return false;
  }
  const entry = registry[record.subject];
  if (entry?.cookie === undefined) return false;
  return probeInstance({ uid: record.uid, port: record.port, cookie: entry.cookie });
}

/**
 * Why the last launch of one tenant failed.
 *
 * The starting page reads this so a workspace that cannot come up says what
 * happened instead of waiting forever; a successful launch clears it.
 * @param {string} subject - the tenant.
 * @returns {string | undefined} the failure, or undefined when the last launch
 *   succeeded or nothing has been attempted yet.
 */
export function launchFailure(subject) {
  return launchFailures.get(subject);
}

/**
 * The boot identity of one tenant's instance.
 *
 * A document is served by one process; that process stamps every bundle URL
 * with a revision of its own graph, so a document outlives its usefulness the
 * moment the process behind it is replaced. This number lets the injected
 * script notice that replacement — the alternative is a tab that keeps asking
 * the new process for the old graph and dies on the first plugin it still has
 * to mount.
 * @param {string} subject
 * @returns {number} the process's real start time, or 0 when it never booted.
 */
export function instanceBoot(subject) {
  return instances.get(subject)?.bootedAt ?? bootStamps.get(subject) ?? 0;
}

/**
 * Boot identity to publish to a browser, or 0 while nothing can serve it.
 *
 * `instanceBoot` is deliberately durable: a gateway restart must not make an
 * open workspace look replaced. But the starting page treats any non-zero boot
 * as "reload now", so publishing that persisted value during a cold launch
 * made it reload in a loop and queue another launch on every navigation. Only
 * an instance that has exchanged its cookie can actually serve a document.
 * @param {string} subject
 * @returns {number}
 */
export function readyBoot(subject) {
  const instance = instances.get(subject);
  return instance?.cookie !== undefined ? instanceBoot(subject) : 0;
}

/**
 * Whether a recorded pid still belongs to this tenant's `vh-jail` wrapper.
 *
 * A pid written by a previous gateway can be stale and reused. Signalling it
 * blindly could take down an unrelated process, so require both the owner uid
 * and the wrapper's own command line first.
 * @param {number} pid
 * @returns {boolean}
 */
function isJailWrapper(pid) {
  try {
    const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8');
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    const ownUid = typeof process.getuid === 'function' ? process.getuid() : 0;
    if (uid !== 0 && uid !== ownUid) return false;
    const cmdline = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8');
    return cmdline.includes('vh-jail');
  } catch (error) {
    // The wrapper already followed its child out, or /proc is unavailable.
    void error;
    return false;
  }
}

/**
 * Signal whoever holds a tenant port until the port is actually free, then
 * the jail wrapper. dsh is the init of its own pid namespace, so the port
 * owner is the authoritative target: the wrapper does not forward signals,
 * and a pid restored from the registry may point at a reused, unrelated
 * process, so both owners are checked before being signalled.
 * @param {Instance} instance
 * @returns {Promise<void>}
 */
async function stopProcesses(instance) {
  const owner = listenerIn(instance.port);
  if (owner !== undefined) {
    if (owner.uid === instance.uid) {
      await stopListener(owner, instance.port, instance.linuxName);
    } else {
      console.warn(`stop ${instance.linuxName}: port ${String(instance.port)} held by uid ${String(owner.uid)}, not the tenant`);
    }
  }
  const wrapper = instance.child?.pid ?? instance.pid;
  if (wrapper !== undefined && isJailWrapper(wrapper)) {
    try {
      process.kill(wrapper, 'SIGTERM');
    } catch (error) {
      // The wrapper exited with its child; nothing left to stop.
      void error;
    }
  }
}

/**
 * Stop one instance at the owner's request; the next request starts it again.
 * @param {string} subject
 * @returns {Promise<boolean>} whether an instance was being tracked.
 */
export async function stopInstance(subject) {
  const instance = instances.get(subject);
  if (instance === undefined) return false;
  instances.delete(subject);
  bootStamps.delete(subject);
  retired.add(subject);
  await stopProcesses(instance);
  return true;
}

/**
 * Retire an instance a forwarded request could not reach, so the next request
 * proves it again or launches a replacement.
 *
 * A process can outlive its listener: the child handle stays alive while every
 * connect times out, and a record that only checks `exitCode` keeps publishing
 * readiness forever. Dropping the record returns `readyBoot` to 0 and routes
 * the next document through the starting page. The kill is deliberate but
 * deferred: a mid-stream reset on a healthy instance also lands here, so the
 * process is only stopped after a probe confirms it cannot serve, inside the
 * launch chain so a relaunch cannot race the kill for the port. A healthy
 * probe leaves the process alone; adoption restores the record without a
 * restart.
 * @param {string} subject - the tenant whose upstream failed.
 * @returns {void}
 */
export function invalidateInstance(subject) {
  const now = Date.now();
  if (now - (invalidatedAt.get(subject) ?? 0) < INVALIDATE_THROTTLE_MS) return;
  const instance = instances.get(subject);
  if (instance === undefined) return;
  invalidatedAt.set(subject, now);
  instances.delete(subject);
  bootStamps.delete(subject);
  console.warn(`instance invalidated: ${instance.linuxName} port=${String(instance.port)} (upstream unreachable)`);
  const previous = launchChains.get(subject) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    // A concurrent request may have re-adopted or already relaunched.
    if (instances.has(subject)) return;
    if (instance.cookie !== undefined && await probeInstance({
      uid: instance.uid, port: instance.port, cookie: instance.cookie,
    })) return;
    await stopProcesses(instance);
  }).catch((error) => {
    console.error(`instance invalidation cleanup failed for ${instance.linuxName}:`, error instanceof Error ? error.message : error);
  });
  launchChains.set(subject, task);
}

/**
 * Drop this process's handles on shutdown without stopping tenant instances:
 * they are independent pid-namespace inits, and the next gateway adopts them.
 * A container teardown still reclaims every process through the kernel.
 * @returns {Promise<void>}
 */
export function stopAll() {
  instances.clear();
  launchChains.clear();
  launchFailures.clear();
  invalidatedAt.clear();
  retired.clear();
  return Promise.resolve();
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
