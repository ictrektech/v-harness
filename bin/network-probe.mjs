#!/usr/bin/env node
/**
 * Prove at startup that a tenant network can exist in this container.
 *
 * Each tenant runs in its own network namespace, published by pasta (see
 * `gateway/netns.mjs` and `bin/vh-jail`). Three of the facts that arrangement
 * depends on are properties of the host, not of the code: the kernel offers
 * /dev/net/tun, this image's pasta knows the options vh-jail passes, and its
 * forwards reach the tenant's own loopback in both directions. Missing any one
 * of them turns every sign-in into a timeout with nothing to read, so they are
 * exercised once here and the container refuses to start instead.
 *
 * Exit code 1 when the arrangement does not work; 0 when it does.
 *
 * @module v-harness/bin/network-probe
 */

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createConnection, createServer } from 'node:net';

const PROBE_NS = `vh-probe-${String(process.pid)}`;
const PROBE_NS_PATH = `/var/run/netns/${PROBE_NS}`;
/** One string both directions: the probe proves the path, not a service. */
const REPLY = 'vh-network-probe';
/** A tenant address of the probe's own; real ones are derived from uids. */
const PROBE_IP = '127.241.241.241';
const GATEWAY_IP = process.env.VH_GATEWAY_IP ?? '10.0.2.2';
const REQUIRED_PASTA_OPTIONS = ['--config-net', '--map-host-loopback', '--dns-forward'];
const COMMAND_TIMEOUT_MS = 5_000;
const LISTEN_TIMEOUT_MS = 5_000;
const REPLY_TIMEOUT_MS = 3_000;

/**
 * A namespace-local listener: this is what a tenant service is, and pasta has
 * to reach it through the namespace's own loopback.
 */
const GUEST_SERVER_SCRIPT = `
const net = require('node:net');
net.createServer((socket) => socket.end(process.env.VH_PROBE_REPLY))
  .listen(Number(process.env.VH_PROBE_PORT), '127.0.0.1', () => process.stdout.write('ready\\n'));
`;

/** A tenant process dialling the gateway address, as the model API does. */
const GUEST_CLIENT_SCRIPT = `
const net = require('node:net');
const socket = net.connect(Number(process.env.VH_PROBE_PORT), process.env.VH_PROBE_HOST);
let data = '';
socket.setTimeout(${String(REPLY_TIMEOUT_MS)}, () => process.exit(1));
socket.on('connect', () => socket.write('probe'));
socket.on('data', (chunk) => { data += chunk; });
socket.on('end', () => process.exit(data === process.env.VH_PROBE_REPLY ? 0 : 1));
socket.on('error', () => process.exit(1));
`;

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
/** Set once `ip netns add` succeeded, so cleanup deletes only what it made. */
let namespaceCreated = false;
/** @type {import('node:net').Server[]} */
const servers = [];
const checks = {
  tunDevice: false,
  pasta: /** @type {Record<string, boolean>} */ ({}),
  namespace: false,
  guestLoopbackReachable: false,
  gatewayReachableFromTenant: false,
};

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} [options]
 */
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, ...options });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function track(command, args, env = process.env) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  children.push(child);
  return child;
}

/** @param {import('node:child_process').ChildProcess} child @param {string} marker */
async function waitFor(child, marker) {
  return await new Promise((resolve) => {
    let seen = '';
    const timer = setTimeout(() => resolve(false), LISTEN_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      seen += chunk.toString('utf8');
      if (!seen.includes(marker)) return;
      clearTimeout(timer);
      resolve(true);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** @returns {Promise<number>} a port free on the gateway's own loopback. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return port;
}

/** @param {{ stdout?: string, stderr?: string }} result @returns {string} */
function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-1)[0] ?? '';
}

/** @param {number} port @returns {Promise<string>} */
async function readFromTenant(port) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: PROBE_IP, port });
    let data = '';
    socket.setTimeout(REPLY_TIMEOUT_MS, () => {
      socket.destroy(new Error(`no reply from ${PROBE_IP}:${String(port)}`));
    });
    socket.on('connect', () => socket.write('probe'));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(data));
  });
}

/** Create the probe namespace and let pasta configure it, as vh-jail does. */
async function publishNamespace(port) {
  const created = run('ip', ['netns', 'add', PROBE_NS]);
  if (created.status !== 0) {
    throw new Error(`ip netns add failed: ${outputOf(created) || String(created.status)}`);
  }
  namespaceCreated = true;
  const pasta = track('pasta', [
    '--foreground', '--config-net', '--netns', PROBE_NS_PATH, '-4',
    '--dns-forward', '10.0.2.3',
    '--map-host-loopback', GATEWAY_IP,
    '-t', `${PROBE_IP}/${String(port)}:${String(port)}`,
  ]);
  let complaint = '';
  pasta.stderr?.on('data', (chunk) => { complaint += chunk.toString('utf8'); });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const route = run('ip', ['netns', 'exec', PROBE_NS, 'ip', 'route']);
    if (route.status === 0 && /^default /m.test(route.stdout)) {
      checks.namespace = true;
      return;
    }
    if (pasta.exitCode !== null) {
      throw new Error(`pasta exited (${String(pasta.exitCode)}): ${complaint.trim() || 'no output'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pasta did not configure ${PROBE_NS}: ${complaint.trim() || 'no output'}`);
}

/** Tenant -> gateway, the direction every model call takes. */
async function probeGatewayDirection() {
  const port = await freePort();
  const server = createServer((socket) => socket.end(REPLY));
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(undefined));
  });

  const client = track('ip', ['netns', 'exec', PROBE_NS, process.execPath, '-e', GUEST_CLIENT_SCRIPT], {
    ...process.env,
    VH_PROBE_HOST: GATEWAY_IP,
    VH_PROBE_PORT: String(port),
    VH_PROBE_REPLY: REPLY,
  });
  let complaint = '';
  client.stderr?.on('data', (chunk) => { complaint += chunk.toString('utf8'); });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(-1), REPLY_TIMEOUT_MS + 2_000);
    client.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode ?? -1);
    });
  });
  if (code !== 0) {
    throw new Error(
      `${GATEWAY_IP} is not reachable from ${PROBE_NS} (exit ${String(code)})`
      + `${complaint.trim() === '' ? '' : `: ${complaint.trim()}`}`
      + '; pasta --map-host-loopback is what makes the gateway reachable from a tenant',
    );
  }
}

async function main() {
  try {
    accessSync('/dev/net/tun', constants.R_OK | constants.W_OK);
    checks.tunDevice = true;
  } catch {
    throw new Error('/dev/net/tun is missing; run the container with the tun device (see ictrek.app/src/docker-compose.yml)');
  }

  const help = run('pasta', ['--help']);
  if (help.error?.code === 'ENOENT') {
    throw new Error('pasta is missing from the image; the Dockerfile installs the passt package');
  }
  const helpText = `${help.stdout ?? ''}${help.stderr ?? ''}`;
  if (helpText.trim() === '') {
    throw new Error(`pasta --help printed nothing: ${outputOf(help) || 'no output'}`);
  }
  for (const option of REQUIRED_PASTA_OPTIONS) {
    checks.pasta[option] = helpText.includes(option);
    if (!checks.pasta[option]) {
      throw new Error(`pasta in this image does not support ${option}; vh-jail passes it for every tenant`);
    }
  }

  const port = await freePort();
  await publishNamespace(port);

  // Gateway -> tenant: an instance listening on its own loopback must be
  // reachable at the address the gateway forwards to.
  const server = track('ip', ['netns', 'exec', PROBE_NS, process.execPath, '-e', GUEST_SERVER_SCRIPT], {
    ...process.env,
    VH_PROBE_PORT: String(port),
    VH_PROBE_REPLY: REPLY,
  });
  if (!await waitFor(server, 'ready')) {
    throw new Error(`the probe listener did not start inside ${PROBE_NS}`);
  }
  const reply = await readFromTenant(port);
  if (reply !== REPLY) {
    throw new Error(`${PROBE_IP}:${String(port)} answered ${JSON.stringify(reply)} instead of the namespace listener`);
  }
  checks.guestLoopbackReachable = true;

  await probeGatewayDirection();
  checks.gatewayReachableFromTenant = true;
}

/** Kill children first: a namespace cannot be deleted while they still hold it. */
async function cleanup() {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const server of servers) {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
  if (namespaceCreated) {
    run('ip', ['netns', 'del', PROBE_NS]);
  }
}

/** @param {'ok' | 'failed'} verdict @param {string} [detail] */
function report(verdict, detail) {
  return {
    verdict,
    tenantAddress: PROBE_IP,
    gatewayAddress: GATEWAY_IP,
    ...checks,
    detail,
    note: verdict === 'ok'
      ? undefined
      : 'No tenant can sign in without this: vh-jail would publish a namespace nothing can reach.',
  };
}

let detail;
try {
  await main();
} catch (error) {
  detail = error instanceof Error ? error.message : String(error);
}
await cleanup();

if (detail === undefined) {
  console.log(JSON.stringify(report('ok'), null, 2));
} else {
  console.error(JSON.stringify(report('failed', detail), null, 2));
  process.exit(1);
}
