/**
 * Bind a capability socket without letting the two possible owners fight.
 *
 * The gateway and a tenant's dsh can both be asked to serve the same path: the
 * gateway rebinds its sockets on every restart, while a tenant process that
 * survived that restart still holds the old listener. Ownership is decided by
 * the contract, but the two processes can still race between reading it and
 * binding. The gateway always wins that race, because it is the process that
 * survives: it unlinks whatever sits at the path, retries an `EADDRINUSE` a
 * bounded number of times, and never deletes a directory.
 *
 * A symlink is unlinked, never followed, so a tenant cannot aim this deletion
 * at a file elsewhere.
 * @module v-harness/gateway/socket-path
 */

import { lstat, unlink } from 'node:fs/promises';

/** How many times a bind may lose the path before the failure is real. */
const BIND_ATTEMPTS = 3;

/**
 * Listen on a unix socket path, replacing whatever may be left there.
 * @param {import('node:net').Server} server server to bind
 * @param {string} socketPath absolute socket path
 * @returns {Promise<void>} resolves once the server is listening
 */
export async function listenOnSocket(server, socketPath) {
  for (let attempt = 1; ; attempt += 1) {
    await clearSocketPath(socketPath);
    try {
      await bind(server, socketPath);
      return;
    } catch (error) {
      if (attempt >= BIND_ATTEMPTS || error?.code !== 'EADDRINUSE') throw error;
    }
  }
}

/**
 * Remove a stale socket so the next bind can take the path.
 * @param {string} socketPath absolute socket path
 * @returns {Promise<void>}
 */
async function clearSocketPath(socketPath) {
  const info = await lstat(socketPath).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (info.isDirectory()) {
    throw new Error(`${socketPath} is a directory; refusing to replace it`);
  }
  await unlink(socketPath);
}

/**
 * @param {import('node:net').Server} server
 * @param {string} socketPath
 * @returns {Promise<void>}
 */
function bind(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}
