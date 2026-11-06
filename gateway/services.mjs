/**
 * Tenant-run web services, surfaced in the portal UI.
 *
 * A tenant may run its own web app inside the jail (say, `127.0.0.1:3004`).
 * That is the container's loopback: a browser cannot reach it, and the gateway
 * dials it directly (see `addressing.mjs`). Three jobs here:
 *
 *   1. Accept registrations and heartbeats on a per-tenant Unix socket
 *      (`<home>/.dsh/vh-services.sock`, 0600, owner = the tenant). The tenant's
 *      own CLI is the only caller, exactly like the V-Office capability.
 *   2. Keep one registry keyed by VOS subject so the UI can list a tenant's
 *      services, mark stale ones stopped, and offer restart. The registry is
 *      persisted under the state root, so a service outlives a gateway
 *      restart ("关掉之后还能找回来").
 *   3. Resolve `/__vh/svc/<port>/...` proxy targets: only a port this subject
 *      registered may be forwarded, and only for that subject's session.
 *
 * The wrapped command is the registration: `vh-service run -- myapp` is what
 * later gets replayed on restart. Commands stay in gateway state, never in the
 * tenant home or the session log.
 *
 * @module v-harness/gateway/services
 */

import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { runUserHelper } from './instances.mjs';


const SOCKET_NAME = 'vh-services.sock';
const STATE_FILE = 'services.json';
/** A heartbeat older than this marks the service stopped in the UI. */
export const STALE_MS = 30_000;
/** CLI heartbeats every 10s; the staleness window tolerates two missed beats. */
export const HEARTBEAT_MS = 10_000;
const MAX_SERVICES_PER_TENANT = 20;
const MAX_CMD_ITEMS = 32;
const MAX_CMD_ITEM_LENGTH = 512;
const MAX_NAME_LENGTH = 64;

// The instance ports are a reserved range: `/__vh/svc/<port>` reaches whatever
// listens on the tenant's address, and inside that range the listener is the
// tenant's own dsh, not a service the panel could sensibly own.
const RESERVED_PORT_MIN = 3100;
const RESERVED_PORT_MAX = 3999;

const HOME_ROOT = process.env.HOME_ROOT ?? process.env.DATA_ROOT ?? '/data';
const JAIL_BIN = process.env.JAIL_BIN ?? '/opt/v-harness/bin/vh-jail';
/** The tenant CLI, reachable inside the jail through the read-only /usr bind. */
const SERVICE_BIN = process.env.VH_SERVICE_BIN ?? '/usr/local/bin/vh-service';

/**
 * @typedef {object} ServiceRecord
 * @property {string} subject - VOS immutable subject; the registry key.
 * @property {string} account - tenant account name (jail argument).
 * @property {number} uid - tenant uid (jail argument).
 * @property {number} port - loopback port the service listens on.
 * @property {string} name - user-facing display name.
 * @property {string[]} cmd - the wrapped command, replayed on restart.
 * @property {number | undefined} pid - the supervisor's pid inside the tenant
 *   pid namespace; meaningful only to same-namespace callers (stop, liveness).
 * @property {string | undefined} basePath - path prefix the app expects.
 * @property {boolean | undefined} stopped - the owner asked for this service to
 *   stand down. The record is kept so the panel can still offer restart, and
 *   the supervisor that keeps heartbeating it is refused on its next beat.
 * @property {'user' | 'gateway'} source - who last (re)started it.
 * @property {number} registeredAt - epoch milliseconds.
 * @property {number} lastSeen - last heartbeat, epoch milliseconds.
 */

/** @type {string | undefined} */
let statePath;
/** @type {Map<string, Map<number, ServiceRecord>>} */
const registry = new Map();
/** @type {Map<string, Promise<import('node:http').Server>>} */
const capabilities = new Map();
/** Gateway-restarted jails, keyed `<subject>:<port>`; killing one stops the service. */
/** @type {Map<string, import('node:child_process').ChildProcess>} */
const restartedJails = new Map();

/**
 * How long a restart watches its jail before answering.
 *
 * A replay that cannot run at all — a missing entry file, a `--cwd` the record
 * never carried — exits within milliseconds. Answering `200` before that
 * happens left the row reading "stopped" with no error, which the panel showed
 * as a button that did nothing at all.
 */
const EARLY_EXIT_MS = 1_500;

/**
 * @param {string} subject
 * @returns {Map<number, ServiceRecord>}
 */
function tenantServices(subject) {
  let map = registry.get(subject);
  if (!map) {
    map = new Map();
    registry.set(subject, map);
  }
  return map;
}

/**
 * @param {ServiceRecord} record
 * @returns {boolean} whether the heartbeat is recent enough to call it running.
 */
function isRunning(record) {
  return record.stopped !== true && Date.now() - record.lastSeen < STALE_MS;
}

/** @returns {Record<string, ServiceRecord[]>} the persisted shape. */
function snapshot() {
  /** @type {Record<string, ServiceRecord[]>} */
  const subjects = {};
  for (const [subject, services] of registry) {
    const records = [...services.values()];
    if (records.length > 0) subjects[subject] = records;
  }
  return { subjects };
}

/** Serializes registry writes: overlapping persists would steal each other's temp file. */
let persisting = Promise.resolve();

/** Queue one registry write; failures are logged, never thrown into callers. */
function persist() {
  if (statePath === undefined) return;
  const run = async () => {
    const body = `${JSON.stringify(snapshot(), null, 2)}\n`;
    const temporary = `${statePath}.${String(process.pid)}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, statePath);
  };
  persisting = persisting.then(run, run).catch((error) => {
    console.error('services persist failed:', error);
  });
}

/**
 * Load the persisted registry. Stale heartbeats are kept: a stopped service
 * stays findable, which is the whole point of the restart path.
 * @param {{ stateRoot: string }} options
 */
export async function initServices(options) {
  statePath = join(options.stateRoot, STATE_FILE);
  await mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
  const raw = await readFile(statePath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return;
  try {
    const parsed = JSON.parse(raw);
    for (const [subject, records] of Object.entries(parsed?.subjects ?? {})) {
      if (!Array.isArray(records)) continue;
      const services = tenantServices(subject);
      for (const record of records) {
        // `stopped` is written by this module only; anything else on disk is
        // read as "not stopped" rather than as a truthy accident.
        if (isValidRecord(record)) services.set(record.port, { ...record, stopped: record.stopped === true });
      }
    }
  } catch (error) {
    console.warn(`services registry unreadable, starting empty: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @param {unknown} value
 * @returns {value is ServiceRecord}
 */
function isValidRecord(value) {
  const record = /** @type {any} */ (value);
  return typeof record?.subject === 'string'
    && typeof record?.account === 'string'
    && Number.isInteger(record?.uid)
    && Number.isInteger(record?.port)
    && typeof record?.name === 'string'
    && Array.isArray(record?.cmd);
}

/**
 * @param {number} port
 * @returns {string | undefined} rejection reason, or undefined when usable.
 */
function portProblem(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) return 'port 必须在 1024-65535 之间';
  if (port >= RESERVED_PORT_MIN && port <= RESERVED_PORT_MAX) {
    return `端口 ${String(port)} 在实例保留段 3100-3999 内，请换一个`;
  }
  return undefined;
}

/**
 * @param {unknown} cmd
 * @returns {string | undefined} rejection reason, or undefined when usable.
 */
function cmdProblem(cmd) {
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > MAX_CMD_ITEMS) {
    return '启动命令不能为空且不能超过 32 段';
  }
  for (const item of cmd) {
    if (typeof item !== 'string' || item === '' || item.length > MAX_CMD_ITEM_LENGTH) {
      return '启动命令格式不正确';
    }
  }
  return undefined;
}

/**
 * @typedef {object} TenantIdentity
 * @property {string} subject
 * @property {string} account
 * @property {number} uid
 */

/**
 * Register or refresh one service. Called from the tenant's own socket.
 * @param {TenantIdentity} tenant
 * @param {{ name: string, port: number, cmd: string[], pid?: number, basePath?: string }} body
 * @returns {{ status: number, error?: string, message?: string }}
 */
function register(tenant, body) {
  const port = Number(body.port);
  const portIssue = portProblem(port);
  if (portIssue) return { status: 400, error: 'invalid-port', message: portIssue };
  const cmdIssue = cmdProblem(body.cmd);
  if (cmdIssue) return { status: 400, error: 'invalid-command', message: cmdIssue };
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_LENGTH) : '';
  if (name === '') return { status: 400, error: 'invalid-name', message: '服务名称不能为空' };
  const basePath = typeof body.basePath === 'string' && body.basePath.startsWith('/') && body.basePath.length <= 128
    ? body.basePath
    : undefined;

  const services = tenantServices(tenant.subject);
  const existing = services.get(port);
  if (!existing && services.size >= MAX_SERVICES_PER_TENANT) {
    // A stopped record is a bookmark, not a service: it must not be the reason
    // the owner cannot register the next one. Drop the least recently seen.
    const disposable = [...services.values()]
      .filter((record) => record.stopped === true)
      .sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (disposable === undefined) {
      return { status: 429, error: 'too-many-services', message: `每个用户最多登记 ${String(MAX_SERVICES_PER_TENANT)} 个服务` };
    }
    services.delete(disposable.port);
  }
  const pid = Number.isInteger(body.pid) ? Number(body.pid) : undefined;
  if (existing && existing.pid !== pid && isRunning(existing) && existing.source === 'user') {
    return { status: 409, error: 'port-in-use', message: `端口 ${String(port)} 已被「${existing.name}」占用` };
  }

  services.set(port, {
    subject: tenant.subject,
    account: tenant.account,
    uid: tenant.uid,
    port,
    name,
    cmd: body.cmd,
    pid,
    basePath,
    // The directory the command was started in. Recorded so a restart can
    // replay it; without it the jail's landing directory is used and a
    // relative entry file is not found.
    cwd: typeof body.cwd === 'string' && body.cwd.startsWith('/') && body.cwd.length <= 512 ? body.cwd : undefined,
    // An explicit `vh-service run` is the owner starting it again.
    stopped: false,
    source: 'user',
    registeredAt: Date.now(),
    lastSeen: Date.now(),
  });
  persist();
  return { status: 200 };
}

/**
 * Heartbeat: the supervisor is alive. Re-registration after a gateway restart
 * happens here too — the ping of an unregistered port re-creates the record,
 * so a live process is never orphaned by a registry rebuild. A stopped record
 * is the one answer that is not a heartbeat: the owner asked for the service to
 * stand down, so its supervisor must take the child down and exit.
 * @param {TenantIdentity} tenant
 * @param {number} port
 * @param {{ name: string, cmd: string[], pid?: number, basePath?: string, cwd?: string }} body
 * @returns {{ status: number, error?: string, message?: string }}
 */
function heartbeat(tenant, port, body) {
  const existing = registry.get(tenant.subject)?.get(port);
  if (existing) {
    if (existing.stopped === true) {
      return { status: 409, error: 'stopped', message: `「${existing.name}」已停止` };
    }
    existing.lastSeen = Date.now();
    if (Number.isInteger(body.pid)) existing.pid = Number(body.pid);
    // Records written before the CLI sent its working directory cannot be
    // replayed. The next heartbeat from a supervisor that knows it repairs the
    // record in place, so nobody has to re-register a running service.
    if (existing.cwd === undefined && typeof body.cwd === 'string' && body.cwd.startsWith('/')) {
      existing.cwd = body.cwd;
    }
    persist();
    return { status: 200 };
  }
  const result = register(tenant, { ...body, port });
  return result.status === 200 ? { status: 200 } : { status: 404, error: 'not-registered' };
}

/**
 * The tenant's own listeners on one port, as the kernel sees them.
 *
 * A tenant-held supervisor only learns about a stop on its next heartbeat (up
 * to one 10s beat), and until then the port is still taken — a restart in that
 * window would die on EADDRINUSE. The uid check keeps this from ever touching
 * another tenant's listener on the same port number.
 * @param {number} port
 * @param {number} uid
 * @returns {number[]}
 */
function listenerPids(port, uid) {
  /** @type {string} */
  let listing;
  try {
    listing = execFileSync('ss', ['-Hltnp', `sport = :${String(port)}`], { encoding: 'utf8' });
  } catch {
    return []; // no ss here: the heartbeat still stops the service
  }
  const pids = [];
  for (const match of listing.matchAll(/pid=(\d+)/g)) {
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pids.includes(pid)) continue;
    let owner;
    try {
      owner = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${String(pid)}/status`, 'utf8'))?.[1]);
    } catch {
      continue; // exited between the listing and the lookup
    }
    if (owner === uid) pids.push(pid);
  }
  return pids;
}

/**
 * @param {number} port
 * @param {number} uid
 * @param {NodeJS.Signals} signal
 */
function signalListeners(port, uid, signal) {
  for (const pid of listenerPids(port, uid)) {
    try { process.kill(pid, signal); } catch { /* exited already */ }
  }
}

/**
 * Revoke one registration: the owner wants it down. The record is kept as a
 * stopped row (so the panel can still offer restart, and so a stale supervisor
 * cannot re-register itself by heartbeating); a tenant-held supervisor learns
 * about the revocation on its next heartbeat and shuts its child down, and a
 * gateway-held jail is killed here.
 * @param {string} subject
 * @param {number} port
 * @returns {ServiceRecord | undefined} the stopped record, or undefined.
 */
function unregister(subject, port) {
  const record = tenantServices(subject).get(port);
  if (!record) return undefined;
  record.stopped = true;
  const jail = restartedJails.get(`${subject}:${String(port)}`);
  if (jail) {
    restartedJails.delete(`${subject}:${String(port)}`);
    // The jail is a process-group leader (`detached: true`), and the outer bash
    // does not forward signals to the unshare/supervisor below it: signalling
    // only that pid leaves the service running with nobody reporting it.
    if (jail.pid !== undefined && jail.exitCode === null) {
      try { process.kill(-jail.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
  // Ask the listener itself, so the stop lands now instead of on the next
  // heartbeat; repeat without mercy for a service that ignores SIGTERM.
  signalListeners(port, record.uid, 'SIGTERM');
  const escalate = setTimeout(() => { signalListeners(port, record.uid, 'SIGKILL'); }, 5_000);
  escalate.unref();
  persist();
  return record;
}

/**
 * List one tenant's services for the UI.
 * @param {string} subject
 * @returns {{ port: number, name: string, running: boolean, basePath: string | undefined, lastSeen: number, restartable: boolean }[]}
 */
export function listServices(subject) {
  return [...(registry.get(subject)?.values() ?? [])]
    .sort((a, b) => a.port - b.port)
    .map((record) => ({
      port: record.port,
      name: record.name,
      running: isRunning(record),
      basePath: record.basePath,
      lastSeen: record.lastSeen,
      restartable: record.cmd.length > 0,
    }));
}

/**
 * Resolve the proxy target for `/__vh/svc/<port>`. Only a port this subject
 * registered is ever returned; stale heartbeats still resolve so the upstream
 * connection error (not a local 404) tells the user the service is down. A
 * stopped service does not resolve: its supervisor gets a beat to exit, and
 * until then nothing may be served through the panel.
 * @param {string} subject
 * @param {number} port
 * @returns {ServiceRecord | undefined}
 */
export function resolveService(subject, port) {
  const record = registry.get(subject)?.get(port);
  return record?.stopped === true ? undefined : record;
}

/**
 * The argv that replays one registration inside the tenant's jail. The tenant's
 * own CLI wraps the command, so the restarted service is supervised and
 * heartbeats like one the tenant started by hand — which is what makes the
 * panel show it running instead of leaving the row stopped forever.
 * @param {ServiceRecord} record
 * @returns {string[]} argv for `vh-jail`, after the account/uid/home.
 */
function replayArgs(record) {
  const cwd = jailCwd(record);
  return [
    SERVICE_BIN, 'run',
    '--name', record.name,
    '--port', String(record.port),
    ...(record.basePath === undefined ? [] : ['--basePath', record.basePath]),
    ...(cwd === undefined ? [] : ['--cwd', cwd]),
    '--', ...record.cmd,
  ];
}

/**
 * The recorded working directory as the jail sees it.
 *
 * A registration made from inside the jail records `/home/<account>/…`; one
 * written by hand, or by a client that only knows the container's paths, can
 * carry `/data/<account>/…` instead. The chroot has no `/data`, so the replay
 * died with `spawn ENOENT` — the button looked dead because the command could
 * not even reach its own directory.
 * @param {ServiceRecord} record
 * @returns {string | undefined}
 */
function jailCwd(record) {
  if (record.cwd === undefined) return undefined;
  const host = join(HOME_ROOT, record.account);
  const jailHome = `/home/${record.account}`;
  if (record.cwd === host) return jailHome;
  if (record.cwd.startsWith(`${host}/`)) return `${jailHome}${record.cwd.slice(host.length)}`;
  return record.cwd;
}

/**
 * Restart one service as its tenant: a fresh jail running the tenant's CLI
 * around the registered command, in the directory it was registered from.
 * Independent of the dsh instance — workspace files come from the same
 * physical home, while /tmp stays private to each jail.
 *
 * The jail needs nothing but its identity: the service listens on the same
 * container loopback the gateway dials, and the instance's port belongs to the
 * instance process, not to this one.
 * @param {string} subject
 * @param {number} port - the service's own port on the container loopback.
 * @returns {Promise<{ status: number, error?: string, message?: string }>}
 */
export async function restartService(subject, port) {
  const record = registry.get(subject)?.get(port);
  if (!record) return { status: 404, error: 'not-found', message: '服务不存在' };
  if (isRunning(record)) return { status: 409, error: 'already-running', message: `「${record.name}」正在运行` };
  const cmdIssue = cmdProblem(record.cmd);
  if (cmdIssue) return { status: 400, error: 'invalid-command', message: cmdIssue };

  const existing = restartedJails.get(`${subject}:${String(port)}`);
  if (existing?.exitCode === null && !existing.killed) {
    return { status: 409, error: 'already-running', message: `「${record.name}」正在启动` };
  }

  // The record has to stop reading as revoked before the supervisor's first
  // heartbeat lands, or that heartbeat would be refused as a stop; and it must
  // read as not-running until that heartbeat actually arrives, so a replay that
  // dies shows stopped instead of borrowing the old heartbeat's freshness.
  record.stopped = false;
  record.lastSeen = 0;
  persist();

  const child = spawn(
    JAIL_BIN,
    [record.account, String(record.uid), join(HOME_ROOT, record.account), ...replayArgs(record)],
    {
      env: {
        HOME_ROOT,
        // vh-jail allow-lists this port on the shared loopback under the
        // strict per-tenant 127/8 policy it installs.
        VH_GATEWAY_PORT: process.env.PORT ?? '8080',
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      },
      // stderr only, and for the record: `stdio: 'ignore'` used to swallow the
      // reason a replayed command never came up.
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    },
  );
  /** @type {string | undefined} */
  let failure;
  child.stderr?.on('data', (chunk) => {
    // One line only: a failing command reports a stack, and the gateway log is
    // shared with every tenant. The line worth keeping names the problem, which
    // is not always the first one — a module loader prints its frame header
    // before the file it could not find.
    const lines = String(chunk).split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const named = lines.find((line) => /error|cannot|no such|not found|ENOENT/i.test(line)) ?? lines[0];
    if (named === undefined) return;
    failure ??= named;
    console.warn(`service restart (${record.account} port=${String(port)}): ${named}`);
  });
  // Without a listener an unspawnable jail (missing JAIL_BIN) emits 'error' and
  // takes the whole gateway down.
  child.on('error', (error) => {
    failure ??= error.message;
    console.error(`service restart failed (${record.account} port=${String(port)}):`, error);
  });
  child.unref();
  const key = `${subject}:${String(port)}`;
  restartedJails.set(key, child);
  child.once('exit', () => {
    if (restartedJails.get(key) === child) restartedJails.delete(key);
  });
  console.log(`service restart: ${record.account} port=${String(port)} pid=${String(child.pid)} cwd=${record.cwd ?? '-'}`);

  // Give the jail a moment to fail. A replay that cannot run at all exits at
  // once, and answering 200 before that left the row reading "stopped" with no
  // error anywhere the owner could see it — a button that looked like it did
  // nothing.
  const exitCode = await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(undefined);
    }, EARLY_EXIT_MS);
    /** @param {number | null} code */
    function onExit(code) {
      clearTimeout(timer);
      resolve(code ?? -1);
    }
    child.once('exit', onExit);
  });
  if (exitCode !== undefined) {
    restartedJails.delete(key);
    const reason = failure === undefined ? '' : `：${failure}`;
    const hint = record.cwd === undefined
      ? '（这条登记没有启动目录，相对路径的命令找不到入口文件，请用 vh-service run --cwd 重新登记）'
      : '';
    return {
      status: 502,
      error: 'exited',
      message: `「${record.name}」启动后立即退出（退出码 ${String(exitCode)}）${reason}${hint}`,
    };
  }
  return { status: 200 };
}

/**
 * Stop one service on behalf of its owner (UI button or tenant CLI). The
 * registration is revoked rather than deleted: the panel keeps the row so
 * restart stays reachable, and the supervisor that owns the process learns of
 * the revocation on its next heartbeat and shuts its child down. Without that,
 * deleting the record let the supervisor register itself straight back on the
 * next beat — which is what made the panel's Stop button look like a no-op.
 * @param {string} subject
 * @param {number} port
 * @returns {{ status: number, error?: string, message?: string }}
 */
export function stopService(subject, port) {
  const stopped = unregister(subject, port);
  if (stopped === undefined) return { status: 404, error: 'not-found', message: '服务不存在' };
  return { status: 200 };
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {Error & { status: number, code: string }}
 */
function serviceError(status, code, message) {
  const error = /** @type {Error & { status: number, code: string }} */ (new Error(message));
  error.status = status;
  error.code = code;
  return error;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) throw serviceError(413, 'body-too-large', '请求体过大');
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw serviceError(400, 'invalid-body', '请求体必须是 JSON 对象');
  }
  return parsed;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} payload
 */
function json(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength) });
  res.end(body);
}

/**
 * Serve one tenant's registration socket. Identity closes over the socket, so
 * two tenants' sockets can never answer for each other.
 * @param {TenantIdentity} tenant
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function handle(tenant, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/services') {
    json(res, 200, { services: listServices(tenant.subject) });
    return;
  }

  if (method === 'POST' && url.pathname === '/services') {
    const body = await readJsonBody(req);
    const result = register(tenant, /** @type {any} */ (body));
    json(res, result.status, result.status === 200 ? { ok: true } : { error: result.error, message: result.message });
    return;
  }

  const ping = /^\/services\/(\d+)\/ping$/.exec(url.pathname);
  if (method === 'POST' && ping) {
    const body = await readJsonBody(req);
    const result = heartbeat(tenant, Number(ping[1]), /** @type {any} */ (body));
    json(res, result.status, result.status === 200 ? { ok: true } : { error: result.error, message: result.message });
    return;
  }

  const single = /^\/services\/(\d+)$/.exec(url.pathname);
  if (single && (method === 'DELETE' || method === 'POST')) {
    const result = stopService(tenant.subject, Number(single[1]));
    json(res, result.status, result.status === 200 ? { ok: true } : { error: result.error, message: result.message });
    return;
  }

  json(res, 404, { error: 'route-not-found', message: '未知的服务端点' });
}

/**
 * Start (once) the listening socket for one tenant.
 * @param {{ subject: string, account: string, uid: number, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
async function start(options) {
  const tenant = { subject: options.subject, account: options.account, uid: options.uid };
  const socketPath = join(options.home, '.dsh', SOCKET_NAME);
  // The gateway runs as root and the tenant home is 0700, so only root can
  // prepare the directory the socket lives in.
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await unlink(socketPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });

  const server = createServer((req, res) => {
    void handle(tenant, req, res).catch((error) => {
      console.error(`services capability failed (${tenant.account}):`, error);
      if (!res.headersSent) json(res, 500, { error: 'capability-failed' });
      else res.destroy();
    });
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      // Shut the door before handing the key over: until `claim` runs, the
      // socket belongs to root, and nobody may call the capability.
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });

  await runUserHelper(options.userHelper, ['claim', options.account, socketPath]);
  return server;
}

/**
 * Make sure this tenant's service socket exists.
 * @param {{ subject: string, account: string, uid: number, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
export async function ensureServicesCapability(options) {
  const existing = capabilities.get(options.subject);
  if (existing) {
    await existing;
    return;
  }
  const starting = start(options);
  capabilities.set(options.subject, starting);
  try {
    await starting;
  } catch (error) {
    capabilities.delete(options.subject);
    throw error;
  }
}

/**
 * Close every service socket; called on gateway shutdown. Registered services
 * survive in the state file and come back findable on the next boot.
 * @returns {Promise<void>}
 */
export async function closeServicesCapabilities() {
  const entries = [...capabilities.entries()];
  capabilities.clear();
  await Promise.all(entries.map(async ([_subject, starting]) => {
    try {
      const server = await starting;
      await new Promise((resolve) => { server.close(() => { resolve(); }); });
    } catch {
      // A capability that never started owns no socket; nothing to close.
    }
  }));
  persist();
}
