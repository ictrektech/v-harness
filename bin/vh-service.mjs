#!/usr/bin/env node
/**
 * Tenant CLI for the services panel: register a web service so it shows up in
 * the portal UI, keep it alive as its supervisor, and stop or list services.
 *
 * `run` wraps the service process: the wrapped command IS the registration,
 * and the heartbeat this process sends while the child lives is what marks the
 * service running. Exit the CLI (Ctrl-C) and the service goes with it; the
 * panel keeps the record so it can be found and restarted later.
 *
 * The gateway answers on the tenant's own capability socket
 * (`$HOME/.dsh/vh-services.sock`, 0600) — kernel permissions decide who may
 * call, so there is no token here.
 *
 * Usage:
 *   vh-service run --name <名称> --port <端口> [--basePath /前缀] -- <启动命令...>
 *   vh-service list
 *   vh-service stop --port <端口>
 * @module v-harness/bin/vh-service
 */

import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const HEARTBEAT_MS = 10_000;
// The instance ports are reserved (the tenant's own nft rule blocks them);
// registering there would promise a panel entry the browser cannot open.
const RESERVED_MIN = 3100;
const RESERVED_MAX = 3999;

const SOCKET_PATH = join(process.env.HOME ?? '', '.dsh', 'vh-services.sock');

/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
  process.stderr.write(`vh-service: ${message}\n`);
  process.exit(1);
}

/**
 * One JSON call over the capability socket.
 * @param {string} method
 * @param {string} path
 * @param {Record<string, unknown> | undefined} body
 * @returns {Promise<{ status: number, payload: Record<string, unknown> }>}
 */
function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const req = httpRequest({
      socketPath: SOCKET_PATH,
      path,
      method,
      headers: {
        'content-type': 'application/json',
        ...(data === undefined ? {} : { 'content-length': String(data.byteLength) }),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, payload: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
        } catch {
          reject(new Error('网关返回了无法解析的内容'));
        }
      });
    });
    req.setTimeout(5_000, () => {
      req.destroy(new Error('连接网关超时；服务能力端点未就绪（实例是否已启动？）'));
    });
    req.on('error', reject);
    if (data === undefined) req.end();
    else req.end(data);
  });
}

/** @returns {{ name: string, port: number, basePath: string | undefined, cmd: string[] }} */
function parseRunArgs() {
  // slice(3) skips node, the script and the `run` subcommand itself; keeping
  // `run` here made the loop below reject it as an unknown flag, so no service
  // could ever be registered.
  const argv = process.argv.slice(3);
  let name = '';
  let port = 0;
  let basePath;
  const dashdash = argv.indexOf('--');
  if (dashdash < 0) die('用法: vh-service run --name <名称> --port <端口> -- <启动命令...>');
  const cmd = argv.slice(dashdash + 1);
  for (let i = 0; i < dashdash; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--name' && value !== undefined) { name = value.trim(); i += 1; }
    else if (flag === '--port' && value !== undefined) { port = Number(value); i += 1; }
    else if (flag === '--basePath' && value !== undefined) { basePath = value; i += 1; }
    else die(`未知参数: ${flag}`);
  }
  if (name === '' || name.length > 64) die('服务名称不能为空且不超过 64 个字符');
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) die('端口必须在 1024-65535 之间');
  if (port >= RESERVED_MIN && port <= RESERVED_MAX) die(`端口 ${String(port)} 在实例保留段 3100-3999 内，请换一个`);
  if (cmd.length === 0) die('-- 后面必须跟启动命令');
  if (basePath !== undefined && !basePath.startsWith('/')) die('--basePath 必须以 / 开头');
  return { name, port, basePath, cmd };
}

/** Register, supervise, heartbeat. */
async function run() {
  const { name, port, basePath, cmd } = parseRunArgs();
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  const registration = { name, port, cmd, pid: child.pid, basePath };

  let registered = false;
  const register = async () => {
    const { status, payload } = await call('POST', '/services', registration);
    if (status === 200) { registered = true; return true; }
    process.stderr.write(`vh-service: 注册失败 (${String(status)}): ${String(payload.message ?? payload.error ?? '')}\n`);
    return false;
  };
  if (!(await register())) {
    child.kill('SIGTERM');
    process.exit(1);
  }

  const goodbye = () => {
    void call('DELETE', `/services/${String(port)}`, undefined).catch(() => {});
  };
  child.on('exit', (code, signal) => {
    goodbye();
    process.exit(signal === null ? (code ?? 0) : 0);
  });
  const forward = (signal) => {
    if (child.pid !== undefined && child.exitCode === null) child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  setInterval(() => {
    void (async () => {
      const { status, payload } = await call('POST', `/services/${String(port)}/ping`, registration);
      if (status === 200) return;
      // The registry forgot this port (gateway state rebuilt): re-register so
      // a live process is never orphaned. A conflict means another supervisor
      // owns the port now; this one stands down.
      if (status === 404 && registered) {
        registered = await register();
        return;
      }
      if (status === 409 || status === 404) {
        process.stderr.write(`vh-service: ${String(payload.message ?? '登记已失效')}，退出\n`);
        goodbye();
        child.kill('SIGTERM');
      }
    })().catch(() => {});
    // Ref'd on purpose: the heartbeat is the only handle this process holds
    // between ticks, and an unref'd timer let node exit right after spawn —
    // leaving the service alive with nobody reporting it, which the panel then
    // showed as "stopped".
  }, HEARTBEAT_MS);

  process.stderr.write(`vh-service: 「${name}」已登记 (127.0.0.1:${String(port)})，Ctrl-C 停止\n`);
}

/** List this tenant's registered services as JSON. */
async function list() {
  const { status, payload } = await call('GET', '/services', undefined);
  if (status !== 200) die(`读取失败 (${String(status)})`);
  process.stdout.write(`${JSON.stringify(payload.services ?? [], null, 2)}\n`);
}

/** Stop one service: unregister, then kill the supervisor's child if visible. */
async function stop() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--port');
  const port = at >= 0 ? Number(argv[at + 1]) : Number.NaN;
  if (!Number.isInteger(port)) die('用法: vh-service stop --port <端口>');

  const { payload } = await call('GET', '/services', undefined);
  const services = Array.isArray(payload.services) ? payload.services : [];
  const record = services.find((service) => service?.port === port);
  const { status } = await call('DELETE', `/services/${String(port)}`, undefined);
  if (status !== 200) die(`停止失败 (${String(status)})`);
  // The pid is the supervisor's child inside this same pid namespace; the
  // gateway-held restarts are killed gateway-side. ESRCH is normal.
  if (record && Number.isInteger(record.pid)) {
    try { process.kill(Number(record.pid), 'SIGTERM'); } catch { /* already gone */ }
  }
  process.stdout.write(`vh-service: 端口 ${String(port)} 已停止\n`);
}

const command = process.argv[2];
if (command === 'run') await run();
else if (command === 'list') await list();
else if (command === 'stop') await stop();
else die('用法: vh-service <run|list|stop> ...（run 用法: run --name <名称> --port <端口> -- <启动命令...>）');
