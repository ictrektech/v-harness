/**
 * The contract reader is the plugin's only switch. These cases pin what it
 * accepts, because accepting a wider file would put a tenant key in a place the
 * gateway already refuses to trust.
 */

import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CONTRACT_FILE_NAME,
  CONTRACT_VERSION,
  readCapabilityContract,
} from '../src/contract.ts'

const KEY = 'a'.repeat(64)

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vh-plugin-contract-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * Write one contract file.
 * @param body - JSON value or raw text.
 * @param mode - file mode.
 * @returns path written.
 */
async function contract(body: unknown, mode = 0o600): Promise<string> {
  const path = join(root, CONTRACT_FILE_NAME)
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), { mode })
  await chmod(path, mode)
  return path
}

describe('readCapabilityContract', () => {
  it('returns undefined when the gateway has not delegated anything', () => {
    expect(readCapabilityContract(join(root, CONTRACT_FILE_NAME))).toBeUndefined()
  })

  it('reads a valid contract and keeps known capabilities only', async () => {
    const path = await contract({
      version: CONTRACT_VERSION,
      key: KEY,
      capabilities: ['image-studio', 'vh-services', 'unknown'],
    })
    expect(readCapabilityContract(path)).toEqual({ key: KEY, capabilities: ['image-studio', 'vh-services'] })
  })

  it('refuses a file other users can read', async () => {
    const path = await contract({ version: CONTRACT_VERSION, key: KEY, capabilities: ['image-studio'] }, 0o644)
    expect(readCapabilityContract(path)).toBeUndefined()
  })

  it('refuses malformed JSON', async () => {
    expect(readCapabilityContract(await contract('not json'))).toBeUndefined()
  })

  it('refuses a non-object document', async () => {
    expect(readCapabilityContract(await contract('null'))).toBeUndefined()
    expect(readCapabilityContract(await contract('[]'))).toBeUndefined()
  })

  it('refuses an unknown version, short key, or non-array capabilities', async () => {
    expect(readCapabilityContract(await contract({ version: 2, key: KEY, capabilities: ['image-studio'] })))
      .toBeUndefined()
    expect(readCapabilityContract(await contract({ version: CONTRACT_VERSION, key: 'short', capabilities: [] })))
      .toBeUndefined()
    expect(readCapabilityContract(await contract({ version: CONTRACT_VERSION, key: KEY, capabilities: 'image-studio' })))
      .toBeUndefined()
  })

  it('refuses a contract with no capability this plugin can serve', async () => {
    expect(readCapabilityContract(await contract({
      version: CONTRACT_VERSION,
      key: KEY,
      capabilities: ['nope'],
    }))).toBeUndefined()
  })

  it('refuses a key the gateway could not have minted', async () => {
    expect(readCapabilityContract(await contract({
      version: CONTRACT_VERSION,
      key: 'A'.repeat(64),
      capabilities: ['image-studio'],
    }))).toBeUndefined()
    expect(readCapabilityContract(await contract({
      version: CONTRACT_VERSION,
      key: 'a'.repeat(63),
      capabilities: ['image-studio'],
    }))).toBeUndefined()
  })

  it('refuses a directory or an oversized file at the contract path', async () => {
    const directory = join(root, 'directory.json')
    await mkdir(directory)
    expect(readCapabilityContract(directory)).toBeUndefined()
    expect(readCapabilityContract(await contract('x'.repeat(70 * 1024)))).toBeUndefined()
  })

  it('never follows a symlink to another tenant contract', async () => {
    const victim = join(root, 'victim.json')
    await writeFile(victim, JSON.stringify({ version: CONTRACT_VERSION, key: KEY, capabilities: ['image-studio'] }), { mode: 0o600 })
    const link = join(root, CONTRACT_FILE_NAME)
    await symlink(victim, link)
    expect(readCapabilityContract(link)).toBeUndefined()
  })

  it('treats a FIFO as absent instead of blocking the tenant boot', { skip: process.platform === 'win32' }, async () => {
    const path = join(root, CONTRACT_FILE_NAME)
    execFileSync('mkfifo', [path])
    const started = Date.now()
    expect(readCapabilityContract(path)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
