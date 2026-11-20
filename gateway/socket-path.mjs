/**
 * Bind a capability socket without letting the two possible owners fight.
 *
 * The gateway and a tenant's dsh can both be asked to serve the same path: the
 * gateway rebinds its sockets on every restart, while a tenant process that
 * survived that restart still holds the old listener. Ownership is decided by
 * the contract, and the gateway wins the race by replacing the path atomically.
 *
 * Replacing matters because the reverse order is unsafe: unlinking the path
 * first creates a window in which the path exists for nobody, and if the bind
 * then fails the path stays missing while the old listener keeps running on an
 * unlinked inode. Every dialer gets ECONNREFUSED until somebody restarts the
 * gateway. Binding beside the target and renaming it into place has neither
 * failure mode: the path a client dials always names a live listener, and a
 * failed bind leaves the previous one untouched.
 *
 * A symlink is replaced, never followed, so a tenant cannot aim this rename at
 * a file elsewhere. A directory is refused rather than deleted.
 * @module v-harness/gateway/socket-path
 */

import { lstat, rename, unlink } from 'node:fs/promises';

/**
 * Listen on a unix socket path, replacing whatever may be left there.
 * @param {import('node:net').Server} server server to bind
 * @param {string} socketPath absolute socket path
 * @returns {Promise<void>} resolves once the server is listening at socketPath
 */
export async function listenOnSocket(server, socketPath) {
  // The staging path stays beside the target: rename is only atomic within one
  // directory, and a different filesystem would turn it into a copy.
  const staging = `${socketPath}.${String(process.pid)}.new`;
  await clearSocketPath(staging);
  try {
    await bind(server, staging);
    await rename(staging, socketPath);
  } catch (error) {
    await unlink(staging).catch(() => {});
    throw error;
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
