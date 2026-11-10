/**
 * The contract the gateway writes before it launches a tenant dsh.
 *
 * The file is the entire switch between gateway-owned capability sockets and
 * tenant-owned ones. A dsh that finds no contract must not bind anything: the
 * gateway is still serving those sockets, and a second listener on the same
 * path would either fail or steal a socket the gateway believes it owns.
 * @module @deepseek-ai/dsh-host-vh-capabilities/contract
 */

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'

/** Capability socket the tenant process may own, by capability name. */
export const CAPABILITY_SOCKETS = {
  voffice: 'voffice.sock',
  album: 'album.sock',
  photocraft: 'photocraft.sock',
  'image-studio': 'image-studio.sock',
  weknora: 'weknora.sock',
  'vh-services': 'vh-services.sock',
} as const

/** A capability this plugin can serve. */
export type CapabilityName = keyof typeof CAPABILITY_SOCKETS

/** Name of the contract file inside DSH_HOME. */
export const CONTRACT_FILE_NAME = 'capabilities.json'

/** Version this reader understands. */
export const CONTRACT_VERSION = 1

/** Keys are 32 random bytes in hex; anything else cannot be one the gateway minted. */
const KEY_PATTERN = /^[0-9a-f]{64}$/

/** A contract is a handful of names; anything larger is not one. */
const MAX_CONTRACT_BYTES = 64 * 1024

/** Open flags that refuse links and never wait on a FIFO. */
const SAFE_OPEN = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/** What the gateway delegated to this process. */
export interface CapabilityContract {
  /** Per-tenant key the gateway accepts on `/__vh/egress/*`. */
  readonly key: string
  /** Capabilities this process must listen for. */
  readonly capabilities: readonly CapabilityName[]
}

/**
 * Read and validate the tenant contract.
 *
 * The file is opened without following links and without blocking, and must be
 * a `0600` regular file owned by this process. A FIFO, device, symlink, or
 * foreign-owned file is treated as absent: the contract carries a bearer key,
 * so "cannot be trusted" must mean "not a contract" rather than "read it
 * anyway".
 * @param path - absolute path of `capabilities.json`.
 * @returns the contract, or `undefined` when this process must not listen.
 */
export function readCapabilityContract(path: string): CapabilityContract | undefined {
  let fd: number
  try {
    fd = openSync(path, SAFE_OPEN)
  } catch {
    return undefined
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) return undefined
    if ((info.mode & 0o077) !== 0) return undefined
    /* v8 ignore next -- Node defines getuid wherever a unix socket can exist; the guard only keeps the comparison typed. */
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    /* v8 ignore next -- a foreign owner can only be produced by root-owned test fixtures. */
    if (uid !== undefined && info.uid !== uid) return undefined
    if (info.size > MAX_CONTRACT_BYTES) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(fd, 'utf8'))
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { version?: unknown; key?: unknown; capabilities?: unknown }
    if (record.version !== CONTRACT_VERSION) return undefined
    if (typeof record.key !== 'string' || !KEY_PATTERN.test(record.key)) return undefined
    if (!Array.isArray(record.capabilities)) return undefined
    const capabilities = record.capabilities.filter(
      (name): name is CapabilityName => typeof name === 'string' && name in CAPABILITY_SOCKETS,
    )
    if (capabilities.length === 0) return undefined
    return { key: record.key, capabilities }
  } finally {
    closeSync(fd)
  }
}
