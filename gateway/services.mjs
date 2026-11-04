/**
 * Tenant-run web services, surfaced in the portal UI.
 *
 * A tenant may run its own web app inside the jail (say, `127.0.0.1:3004`).
 * That address belongs to the tenant's own network namespace, so neither the
 * browser nor another tenant can reach it; the gateway publishes the namespace
 * on a per-tenant host address (see `netns.mjs`) and does three jobs here:
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
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { runUserHelper } from './instances.mjs';
import { GATEWAY_IP, previewIp } from './netns.mjs';

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
  return Date.now() - record.lastSeen < STALE_MS;
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
        if (isValidRecord(record)) services.set(record.port, record);
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
  if (!services.has(port) && services.size >= MAX_SERVICES_PER_TENANT) {
    return { status: 429, error: 'too-many-services', message: `每个用户最多登记 ${String(MAX_SERVICES_PER_TENANT)} 个服务` };
  }
  const existing = services.get(port);
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
 * so a live process is never orphaned by a registry rebuild.
 * @param {TenantIdentity} tenant
 * @param {number} port
 * @param {{ name: string, cmd: string[], pid?: number, basePath?: string }} body
 * @returns {{ status: number, error?: string, message?: string }}
 */
function heartbeat(tenant, port, body) {
  const existing = registry.get(tenant.subject)?.get(port);
  if (existing) {
    existing.lastSeen = Date.now();
    if (Number.isInteger(body.pid)) existing.pid = Number(body.pid);
    persist();
    return { status: 200 };
  }
  const result = register(tenant, { ...body, port });
  return result.status === 200 ? { status: 200 } : { status: 404, error: 'not-registered' };
}

/**
 * Remove one registration; stop a gateway-held jail if this one is ours.
 * @param {string} subject
 * @param {number} port
 * @returns {boolean} whether a record was removed.
 */
function unregister(subject, port) {
  const removed = tenantServices(subject).get(port);
  if (!removed) return false;
  tenantServices(subject).delete(port);
  const jail = restartedJails.get(`${subject}:${String(port)}`);
  if (jail) {
    restartedJails.delete(`${subject}:${String(port)}`);
    jail.kill('SIGTERM');
  }
  persist();
  return true;
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
 * connection error (not a local 404) tells the user the service is down.
 * @param {string} subject
 * @param {number} port
 * @returns {ServiceRecord | undefined}
 */
export function resolveService(subject, port) {
  return registry.get(subject)?.get(port);
}

/**
 * Restart one service as its tenant: a fresh jail running the registered
 * command. Independent of the dsh instance — workspace files come from the
 * same physical home, while /tmp stays private to each jail.
 *
 * The jail joins the tenant's existing network namespace, so it is handed the
 * same network values an instance launch is: pasta forwards the instance port
 * for whichever jail starts it, and a restart that omitted the port would leave
 * the running instance unreachable from the gateway.
 * @param {string} subject
 * @param {number} port - the service's own port inside the namespace.
 * @param {number} instancePort - the tenant's dsh port, forwarded by the same pasta.
 * @returns {{ status: number, error?: string, message?: string }}
 */
export function restartService(subject, port, instancePort) {
  const record = registry.get(subject)?.get(port);
  if (!record) return { status: 404, error: 'not-found', message: '服务不存在' };
  if (isRunning(record)) return { status: 409, error: 'already-running', message: `「${record.name}」正在运行` };
  const cmdIssue = cmdProblem(record.cmd);
  if (cmdIssue) return { status: 400, error: 'invalid-command', message: cmdIssue };

  const existing = restartedJails.get(`${subject}:${String(port)}`);
  if (existing?.exitCode === null && !existing.killed) {
    return { status: 409, error: 'already-running', message: `「${record.name}」正在启动` };
  }

  const child = spawn(
    JAIL_BIN,
    [record.account, String(record.uid), join(HOME_ROOT, record.account), ...record.cmd],
    {
      env: {
        HOME_ROOT,
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        VH_JAIL_PORT: String(instancePort),
        VH_PREVIEW_IP: previewIp(record.uid),
        VH_GATEWAY_IP: GATEWAY_IP,
      },
      stdio: 'ignore',
      detached: true,
    },
  );
  child.unref();
  restartedJails.set(`${subject}:${String(port)}`, child);
  child.once('exit', () => {
    if (restartedJails.get(`${subject}:${String(port)}`) === child) {
      restartedJails.delete(`${subject}:${String(port)}`);
    }
  });
  console.log(`service restart: ${record.account} port=${String(port)} pid=${String(child.pid)}`);
  return { status: 200 };
}

/**
 * Stop one service on behalf of its owner (UI button or tenant CLI). The
 * registry entry goes first, so the supervisor's next heartbeat finds nothing
 * and the supervisor shuts its child down; a gateway-held jail is killed here.
 * @param {string} subject
 * @param {number} port
 * @returns {{ status: number, error?: string, message?: string }}
 */
export function stopService(subject, port) {
  const record = registry.get(subject)?.get(port);
  if (!record) return { status: 404, error: 'not-found', message: '服务不存在' };
  unregister(subject, port);
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
