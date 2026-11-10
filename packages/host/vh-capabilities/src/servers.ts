/**
 * Listen on the tenant's capability socket paths.
 *
 * Each listener is created only when the gateway's contract names it. The
 * gateway skips the same names when it builds its own sockets, so exactly one
 * process owns each path; ownership can change only across a tenant restart,
 * which also replaces this process.
 *
 * The gateway and this plugin can still race for a path: a gateway restart
 * removes and rebinds its sockets while a tenant process is starting up. The
 * rules here make the gateway win that race without losing the tenant's other
 * capabilities: only a socket this process owns may be unlinked, a socket
 * bound by another uid is left alone, and a non-socket at the path is never
 * removed. A disposer also must not wait for long-lived streams to finish, so
 * closing tears connections down and bounds the wait.
 * @module @deepseek-ai/dsh-host-vh-capabilities/servers
 */

import { chmodSync } from 'node:fs'
import { link, lstat, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'

import { CAPABILITY_SOCKETS } from './contract.ts'
import type { CapabilityName } from './contract.ts'
import { forwardCapability } from './forward.ts'

/** Longest a disposer waits for `server.close` before unlinking anyway. */
const CLOSE_TIMEOUT_MS = 5_000

/** Makes tombstone names unique within this process. */
let tombstoneSeq = 0

/** What to listen for and where to forward it. */
export interface CapabilityServerOptions {
  /** DSH_HOME; sockets sit directly below it, matching the skill contract. */
  readonly directory: string
  /** Capabilities the gateway delegated to this process. */
  readonly capabilities: readonly CapabilityName[]
  /** Gateway origin. */
  readonly gatewayUrl: string
  /** Tenant capability key. */
  readonly key: string
  /** Idle budget for one forwarded request. */
  readonly timeoutMs?: number | undefined
}

/** The running listeners, and how to stop them. */
export interface CapabilityServers {
  /** Stop every listener and resolve once their sockets are closed. */
  close(): Promise<void>
}

/**
 * Start one listener per delegated capability.
 *
 * A capability whose path belongs to another process is skipped rather than
 * failing the whole set: the gateway is serving that socket, and losing the
 * other capabilities would leave the skill with none. A failure part-way
 * closes what already started.
 * @param options - directory, capabilities, and forward target.
 * @returns the running listeners.
 */
export async function startCapabilityServers(options: CapabilityServerOptions): Promise<CapabilityServers> {
  const listeners: Listener[] = []
  try {
    for (const capability of options.capabilities) {
      const listener = await listen(capability, options)
      if (listener !== undefined) listeners.push(listener)
    }
  } catch (error) {
    await closeListeners(listeners)
    throw error
  }
  return { close: () => closeListeners(listeners) }
}

/** One bound socket and the inode it must release on close. */
interface Listener {
  readonly server: Server
  readonly socketPath: string
  readonly ino: number
  readonly dev: number
  readonly ctimeMs: number
}

/**
 * Bind one capability socket.
 * @param capability - capability the socket serves.
 * @param options - directory and forward target.
 * @returns the listening server, or `undefined` when another process owns the
 *   path.
 */
async function listen(capability: CapabilityName, options: CapabilityServerOptions): Promise<Listener | undefined> {
  const socketPath = join(options.directory, CAPABILITY_SOCKETS[capability])
  if (!(await claimPath(socketPath))) {
    console.warn(`vh-capabilities: ${socketPath} belongs to another process; leaving it alone`)
    return undefined
  }
  const server = createServer((req, res) => {
    forwardCapability({
      gatewayUrl: options.gatewayUrl,
      capability,
      key: options.key,
      timeoutMs: options.timeoutMs,
    }, req, res)
  })
  server.on('clientError', (_error, socket) => { socket.destroy() })
  try {
    await bind(server, socketPath)
  } catch (error) {
    server.close()
    /* v8 ignore next 4 -- losing the race between claimPath and bind requires the gateway to bind in that window. */
    if (isAddressInUse(error)) {
      console.warn(`vh-capabilities: ${socketPath} was bound by another process; leaving it alone`)
      return undefined
    }
    throw error
  }
  chmodSync(socketPath, 0o600)
  const bound = await lstat(socketPath)
  return { server, socketPath, ino: bound.ino, dev: bound.dev, ctimeMs: bound.ctimeMs }
}

/**
 * Whether this process may replace the path.
 *
 * A socket this uid left behind is stale and is unlinked. A socket another uid
 * owns is the gateway's. Anything else — a directory, a regular file, a FIFO, a
 * symlink — is not ours to delete, and treating it as absent keeps a tenant
 * from planting a link that this process would then unlink.
 * @param socketPath - capability socket path.
 * @returns whether the path is free or held by a stale socket of this process.
 */
async function claimPath(socketPath: string): Promise<boolean> {
  const info = await lstat(socketPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return true
  /* v8 ignore next -- Node defines getuid wherever a unix socket can exist; the guard only keeps the comparison typed. */
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  /* v8 ignore next -- a foreign owner can only be produced by root-owned test fixtures. */
  if (uid !== undefined && info.uid !== uid) return false
  if (!info.isSocket()) return false
  await rm(socketPath, { force: true })
  return true
}

/**
 * Listen on one path and resolve once it accepts connections.
 * @param server - server to bind.
 * @param socketPath - unix socket path.
 * @returns resolves on `listening`, rejects on the first bind error.
 */
function bind(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

/**
 * @param error - bind failure.
 * @returns whether another process won the path first.
 */
function isAddressInUse(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'EADDRINUSE'
}

/**
 * Close every listener, bound the wait, and leave a path this process no longer
 * owns in place.
 *
 * `server.close` waits for every accepted connection, and a capability stream
 * (SSE, an upload) can be long-lived, so the disposer would otherwise hang for
 * as long as the skill keeps the socket open; connections are torn down first
 * and the wait is capped. Node also unlinks the bound path when a unix socket
 * server closes, whatever now lives at that path: the path is moved aside
 * before closing, deleted when it is still this process's stale socket, and
 * hard-linked back when the gateway rebound it in the meantime. Without that
 * last step a tenant shutdown would silently delete the gateway's live socket.
 * @param listeners - listeners to stop.
 * @returns resolves after all of them released their paths.
 */
async function closeListeners(listeners: readonly Listener[]): Promise<void> {
  await Promise.all(listeners.map(async (listener) => {
    listener.server.closeAllConnections()
    const moved = await moveAside(listener)
    await closeServer(listener.server)
    if (moved === undefined) return
    if (moved.ours) {
      await rm(moved.tombstone, { force: true })
      return
    }
    // The path belongs to the gateway now. Restore it unless the gateway has
    // already bound a newer socket there; the hard link keeps the same inode,
    // so the gateway's listener stays connected.
    try {
      await link(moved.tombstone, listener.socketPath)
    } catch (error) {
      /* v8 ignore next 3 -- requires the gateway to bind a newer socket between the rename and the restore. */
      console.warn(`vh-capabilities: could not restore ${listener.socketPath}; the gateway rebound it:`, error)
    }
    await rm(moved.tombstone, { force: true })
  }))
}

/**
 * Move a socket path out of the way before the server closes.
 * @param listener - listener whose path may have been replaced.
 * @returns the tombstone and whether it is this process's stale socket, or
 *   `undefined` when there is nothing to move.
 */
async function moveAside(listener: Listener): Promise<{ tombstone: string; ours: boolean } | undefined> {
  const info = await lstat(listener.socketPath).catch(() => undefined)
  if (info === undefined || info.isDirectory()) return undefined
  const tombstone = `${listener.socketPath}.closing-${String(process.pid)}-${String(tombstoneSeq++)}`
  try {
    await rename(listener.socketPath, tombstone)
  } catch {
    /* v8 ignore next -- requires a permission change on the socket directory during unload. */
    return undefined
  }
  const ours = info.isSocket() && info.ino === listener.ino && info.dev === listener.dev
    && info.ctimeMs === listener.ctimeMs
  return { tombstone, ours }
}

/**
 * `server.close` with a deadline, so a stream that ignores the connection
 * teardown cannot hang plugin unload.
 * @param server - listener being stopped.
 * @returns resolves when closed or when the deadline passes.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
    timer.unref()
    server.close(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
