#!/usr/bin/env node
/**
 * Prove the container network an instance and the gateway share is usable.
 *
 * Tenants no longer get a network namespace and pasta forwards: every instance
 * listens on loopback and the gateway dials it there. That removes the three
 * host facts this probe used to check (tun device, pasta options, forward
 * shape), but not the need for a check: if loopback cannot accept a
 * connection, no instance can start, and the failure would otherwise appear as
 * every sign-in timing out with nothing in the log.
 *
 * Exit code 1 when the arrangement does not work; 0 when it does.
 *
 * @module v-harness/bin/network-probe
 */

import { createConnection, createServer } from 'node:net';

const REPLY = 'vh-network-probe';
const LISTEN_TIMEOUT_MS = 5_000;
const REPLY_TIMEOUT_MS = 3_000;

/**
 * @returns {Promise<void>}
 */
async function checkLoopback() {
  const server = createServer((socket) => socket.end(REPLY));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
    setTimeout(() => reject(new Error('loopback listener did not come up')), LISTEN_TIMEOUT_MS).unref();
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('loopback listener reported no port');
  }

  try {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: address.port });
      let data = '';
      socket.setTimeout(REPLY_TIMEOUT_MS, () => socket.destroy(new Error('loopback reply timed out')));
      socket.on('connect', () => socket.write('probe'));
      socket.on('data', (chunk) => {
        data += String(chunk);
      });
      socket.on('end', () => {
        if (data === REPLY) resolve(undefined);
        else reject(new Error(`loopback returned ${JSON.stringify(data)}`));
      });
      socket.on('error', reject);
    });
  } finally {
    server.close();
  }
}

try {
  await checkLoopback();
  console.log('network probe: verdict ok (loopback reachable)');
} catch (error) {
  console.error(`network probe: verdict failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
