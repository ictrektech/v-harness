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

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { join } from 'node:path';

const LAUNCH_TIMEOUT_MS = 45_000;
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const LOG_DIR_NAME = 'logs';

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
 * Directory layout for one user under the shared data root.
 * @param {string} dataRoot
 * @param {string} namespace
 */
export function userPaths(dataRoot, namespace) {
  const home = join(dataRoot, 'users', namespace);
  return {
    home,
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    workspace: join(home, 'workspace'),
    log: join(dataRoot, LOG_DIR_NAME, `${namespace}.log`),
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
async function runUserHelper(helper, args) {
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
  const paths = userPaths(dataRoot, record.namespace);
  await mkdir(join(dataRoot, LOG_DIR_NAME), { recursive: true, mode: 0o700 });

  const state = await readState(statePath);

  const child = spawn('runuser', [
    '-u', record.linuxName, '--',
    nodeBin, dshBin, '--profile', 'web',
    '--host', '127.0.0.1',
    '--port', String(record.port),
    '--no-open',
  ], {
    cwd: paths.workspace,
    env: {
      HOME: paths.home,
      DSH_HOME: paths.dshHome,
      DSH_AGENTS_HOME: paths.agentsHome,
      DSH_PERMISSION_MODE: 'workspace-write',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
      linuxName: record.linuxName,
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
  const existing = instances.get(record.namespace);
  if (existing?.starting) {
    await existing.starting;
    return instances.get(record.namespace) ?? existing;
  }
  if (existing?.child && existing.child.exitCode === null && !existing.child.killed) {
    return existing;
  }

  await runUserHelper(options.userHelper, [
    'ensure', record.linuxName, String(record.uid), userPaths(dataRoot, record.namespace).home,
  ]);


  /** @type {Instance} */
  const placeholder = {
    namespace: record.namespace,
    linuxName: record.linuxName,
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
