/**
 * Tenant capability registry: which capability sockets a tenant's dsh owns,
 * and the key the gateway accepts from that process.
 *
 * A capability socket used to have exactly one owner, the gateway. During the
 * migration to in-process plugins it has two possible owners, and both the
 * gateway and the tenant process must agree on which one. The agreement has two
 * copies with different authority:
 *
 * - `$STATE_ROOT/capabilities/<subject>.json` is the authoritative copy. It is
 *   root-owned, `0600`, outside every tenant home, and the only one the gateway
 *   reads when it rebuilds the key index or decides socket ownership.
 * - `$DSH_HOME/capabilities.json` is the delivery copy the plugin reads. The
 *   tenant owns it, so it carries no authority: rewriting it can at most make
 *   that tenant's own plugin misbehave, never widen access or redirect another
 *   tenant's identity.
 *
 * The key authorises capability forwarding only. It is not a VOS credential,
 * and neither copy contains one.
 *
 * @module v-harness/gateway/capability-registry
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, chmodSync } from 'node:fs';
import { chown, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Name of the delivery copy inside the tenant's DSH_HOME. */
export const CONTRACT_FILE_NAME = 'capabilities.json';
/** Bumped only when an older plugin would misread a newer file. */
export const CONTRACT_VERSION = 1;
/** Keys are 32 random bytes in hex; anything else cannot be one we minted. */
const KEY_PATTERN = /^[0-9a-f]{64}$/;
/** A contract is a handful of names; anything larger is not one. */
const MAX_CONTRACT_BYTES = 64 * 1024;

/**
 * Every capability socket, its file name, whether the gateway can already serve
 * it through `/__vh/egress/*`, and whether this build may hand it to the plugin.
 *
 * `vh-services` stays gateway-owned even though its egress handler exists. Its
 * panel can start and stop containers, and no test yet proves one tenant cannot
 * reach another tenant's; the P6 gate requires that measurement before the
 * listener moves. Until then the rollout filter below drops the name even when
 * a deployment lists it, so a misconfigured environment cannot move it.
 */
export const CAPABILITIES = [
  { name: 'voffice', socket: 'voffice.sock', egress: true, delegable: true },
  { name: 'album', socket: 'album.sock', egress: true, delegable: true },
  { name: 'photocraft', socket: 'photocraft.sock', egress: true, delegable: true },
  { name: 'image-studio', socket: 'image-studio.sock', egress: true, delegable: true },
  { name: 'weknora', socket: 'weknora.sock', egress: true, delegable: true },
  { name: 'vh-services', socket: 'vh-services.sock', egress: true, delegable: false },
];

const KNOWN_CAPABILITIES = new Set(CAPABILITIES.map((entry) => entry.name));
/** Capabilities that can be handed to the plugin at all. */
export const EGRESS_CAPABILITIES = new Set(
  CAPABILITIES.filter((entry) => entry.egress && entry.delegable).map((entry) => entry.name),
);

/**
 * The rollout this process decides from.
 *
 * Socket ownership is reconciled per gateway boot and per tenant launch;
 * authorization is checked per request. Both must read the same rollout, or a
 * live `process.env` edit would answer 403 for a capability whose plugin socket
 * is still owned and listening — with no rebind until the next restart. The
 * snapshot only changes with the process, which is exactly when ownership is
 * recomputed.
 */
export const CAPABILITY_ENV = Object.freeze({ ...process.env });

/** Parsed per-namespace rollout, cached until the env value changes. */
let overrideCache = { raw: undefined, value: {} };

/**
 * Parse `VH_PLUGIN_CAPABILITIES_BY_NAMESPACE`: a JSON object mapping one
 * namespace to a comma-separated list or an array.
 *
 * Malformed configuration falls back to the global list instead of failing a
 * request path; the gateway logs it once per distinct value.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string[]>} namespace → configured names.
 */
function namespaceOverrides(env) {
  const raw = env.VH_PLUGIN_CAPABILITIES_BY_NAMESPACE ?? '';
  if (overrideCache.raw === raw) return overrideCache.value;
  /** @type {Record<string, string[]>} */
  const value = {};
  if (raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [namespace, names] of Object.entries(parsed)) {
          if (typeof names === 'string') {
            value[namespace] = names.split(',').map((name) => name.trim()).filter(Boolean);
          } else if (Array.isArray(names)) {
            value[namespace] = names.filter((name) => typeof name === 'string');
          }
        }
      } else {
        console.warn('VH_PLUGIN_CAPABILITIES_BY_NAMESPACE is not a JSON object; using the global rollout');
      }
    } catch (error) {
      console.warn('VH_PLUGIN_CAPABILITIES_BY_NAMESPACE is not valid JSON; using the global rollout:', error.message);
    }
  }
  overrideCache = { raw, value };
  return value;
}

/**
 * Capabilities this deployment may hand to one tenant process.
 *
 * Per-namespace overrides replace the global list, so opening one tenant is a
 * one-line change and never widens another. Empty or unknown names are ignored:
 * enabling a capability the gateway cannot serve through egress would leave the
 * skill talking to a socket nobody binds.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [namespace] tenant namespace; omitted means the global list.
 * @returns {string[]} capability names in rollout order.
 */
export function rolloutCapabilities(env = process.env, namespace) {
  const overrides = namespaceOverrides(env);
  const configured = namespace !== undefined && overrides[namespace] !== undefined
    ? overrides[namespace].join(',')
    : env.VH_PLUGIN_CAPABILITIES ?? 'image-studio';
  const names = configured.split(',').map((name) => name.trim()).filter(Boolean);
  const seen = new Set();
  return names.filter((name) => {
    if (!EGRESS_CAPABILITIES.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/**
 * Where one tenant's delivery copy lives.
 * @param {string} home absolute tenant home
 * @returns {string} absolute path
 */
export function contractPath(home) {
  return join(home, '.dsh', CONTRACT_FILE_NAME);
}

/**
 * Where the authoritative copy lives. The subject is hashed so a subject can
 * never introduce a path separator, a dot segment, or a name collision.
 * @param {string} stateRoot gateway state directory
 * @param {string} subject immutable tenant subject
 * @returns {string} absolute path
 */
export function stateContractPath(stateRoot, subject) {
  const digest = createHash('sha256').update(subject).digest('hex');
  return join(stateRoot, 'capabilities', `${digest}.json`);
}

/**
 * Read one JSON contract without following links or blocking on a special file.
 *
 * The open uses `O_NOFOLLOW` and `O_NONBLOCK`, and the file must be a regular
 * file with an allowed owner and no group/world bits. A FIFO, device, symlink or
 * foreign-owned file is treated as absent: these files carry a bearer key, and
 * "cannot be trusted" must mean "not a contract" rather than "read it anyway".
 * @param {string} path absolute path
 * @param {{ owner: number | undefined }} options expected owner, or undefined
 *   when ownership is not part of the trust decision (a developer checkout).
 * @returns {Promise<{ key: string, capabilities: string[] } | undefined>}
 */
async function readSecureContract(path, options) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    console.warn(`capability contract ${path} is not a readable regular file:`, error?.code ?? error);
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      console.warn(`capability contract ${path} is not a regular file; ignoring it`);
      return undefined;
    }
    if ((info.mode & 0o077) !== 0) {
      console.warn(`capability contract ${path} is group- or world-accessible; ignoring it`);
      return undefined;
    }
    if (options.owner !== undefined && info.uid !== options.owner) {
      console.warn(`capability contract ${path} is not owned by uid ${String(options.owner)}; ignoring it`);
      return undefined;
    }
    if (info.size > MAX_CONTRACT_BYTES) {
      console.warn(`capability contract ${path} is unexpectedly large; ignoring it`);
      return undefined;
    }
    let parsed;
    try {
      parsed = JSON.parse(await handle.readFile('utf8'));
    } catch (error) {
      console.warn(`capability contract ${path} is unreadable:`, error instanceof Error ? error.message : error);
      return undefined;
    }
    return validateContract(parsed, path);
  } finally {
    await handle.close();
  }
}

/**
 * Validate the parsed payload shared by both copies.
 * @param {unknown} parsed
 * @param {string} path source path, for the warning only
 * @returns {{ key: string, capabilities: string[] } | undefined}
 */
function validateContract(parsed, path) {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const record = /** @type {{ version?: unknown, key?: unknown, capabilities?: unknown }} */ (parsed);
  if (record.version !== CONTRACT_VERSION) return undefined;
  if (typeof record.key !== 'string' || !KEY_PATTERN.test(record.key)) {
    console.warn(`capability contract ${path} carries a malformed key; ignoring it`);
    return undefined;
  }
  if (!Array.isArray(record.capabilities)) return undefined;
  const capabilities = record.capabilities.filter((name) => typeof name === 'string' && KNOWN_CAPABILITIES.has(name));
  if (capabilities.length === 0) return undefined;
  return { key: record.key, capabilities };
}

/**
 * Read the authoritative copy. This is the only contract that may decide which
 * key the gateway accepts or which sockets it stops binding.
 * @param {string} stateRoot gateway state directory
 * @param {string} subject immutable tenant subject
 * @returns {Promise<{ key: string, capabilities: string[] } | undefined>}
 */
export async function readAuthoritativeContract(stateRoot, subject) {
  const owner = process.getuid?.();
  return readSecureContract(stateContractPath(stateRoot, subject), { owner });
}

/**
 * Read the delivery copy. Used by tests and diagnostics; authorization never
 * reads this file.
 * @param {string} home absolute tenant home
 * @returns {Promise<{ key: string, capabilities: string[] } | undefined>}
 */
export async function readDeliveryContract(home) {
  // The tenant owns this copy, so the gateway's uid is not the expected owner.
  return readSecureContract(contractPath(home), { owner: undefined });
}

/**
 * Create the tenant `.dsh` directory if needed, refusing a symlinked path.
 *
 * The gateway writes into this directory as root. A symlink there would let one
 * tenant place its key in another tenant's home, so it is treated as a failure
 * rather than followed.
 * @param {string} home absolute tenant home
 * @param {string | undefined} account group name for the hand-over
 * @param {number | undefined} uid tenant uid
 * @returns {Promise<string>} the `.dsh` directory
 */
async function tenantHome(home, account, uid) {
  const info = await lstat(home).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (info !== undefined && (info.isSymbolicLink() || !info.isDirectory())) {
    throw new Error(`${home} is not a tenant home directory`);
  }
  const dshHome = join(home, '.dsh');
  let dshInfo;
  try {
    dshInfo = await lstat(dshHome);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(dshHome, { recursive: true, mode: 0o700 });
    dshInfo = await lstat(dshHome);
  }
  if (dshInfo.isSymbolicLink() || !dshInfo.isDirectory()) {
    throw new Error(`${dshHome} is not a directory owned by the deployment`);
  }
  // The plugin runs as the tenant and must traverse this directory. `syncPlugins`
  // normally owns this hand-over; repeating it keeps a contract written after a
  // failed sync from landing behind a root-only path.
  if (process.getuid?.() === 0 && uid !== undefined) {
    await chown(home, uid, account ?? uid);
    await chown(dshHome, uid, account ?? uid);
  }
  return dshHome;
}

/**
 * Write one `0600` file atomically, optionally handing it to the tenant.
 * @param {string} path destination
 * @param {string} text contents
 * @param {{ uid?: number, account?: string }} [owner] tenant hand-over
 * @returns {Promise<void>}
 */
async function writeAtomic(path, text, owner = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  chmodSync(tmp, 0o600);
  if (process.getuid?.() === 0 && owner.uid !== undefined) {
    await chown(tmp, owner.uid, owner.account ?? owner.uid);
  }
  await rename(tmp, path);
  chmodSync(path, 0o600);
  if (process.getuid?.() === 0 && owner.uid !== undefined) {
    await chown(path, owner.uid, owner.account ?? owner.uid);
  }
}

/**
 * Write both copies of a tenant contract.
 *
 * The key is minted once and preserved across launches, so restarting a gateway
 * does not invalidate a plugin that survived in an adopted dsh. Rotation is
 * deliberate: remove the contract and restart the tenant. If the delivery copy
 * cannot be written the authoritative copy is removed again, because a contract
 * the plugin cannot read must not make the gateway stop binding sockets.
 * @param {{
 *   stateRoot: string,
 *   home: string,
 *   subject: string,
 *   account?: string,
 *   uid?: number,
 *   capabilities: string[],
 * }} options
 * @returns {Promise<{ key: string, capabilities: string[] } | undefined>} the
 *   contract, or undefined when no requested capability can be delegated.
 */
export async function writeCapabilityContract(options) {
  const { stateRoot, home, subject, account, uid, capabilities } = options;
  const enabled = capabilities.filter((name) => EGRESS_CAPABILITIES.has(name));
  if (enabled.length === 0) return undefined;
  const previous = await readAuthoritativeContract(stateRoot, subject);
  const key = previous?.key ?? randomBytes(32).toString('hex');
  const payload = `${JSON.stringify({ version: CONTRACT_VERSION, key, capabilities: enabled }, null, 2)}\n`;
  const authoritative = stateContractPath(stateRoot, subject);
  await writeAtomic(authoritative, payload);
  try {
    await tenantHome(home, account, uid);
    await writeAtomic(contractPath(home), payload, { uid, account });
  } catch (error) {
    await rm(authoritative, { force: true });
    throw error;
  }
  return { key, capabilities: enabled };
}

/**
 * Remove both copies of a tenant's contract so the gateway owns its sockets
 * again, and drop the key from the authorization index.
 * @param {{ stateRoot: string, home: string, subject: string }} options
 * @returns {Promise<void>}
 */
export async function removeCapabilityContract(options) {
  await rm(stateContractPath(options.stateRoot, options.subject), { recursive: true, force: true });
  await rm(contractPath(options.home), { recursive: true, force: true });
  forgetCapabilityContract(options.subject);
}

/**
 * Capabilities a tenant's plugin owns, derived from the authoritative copy and
 * this deployment's rollout for that namespace.
 *
 * The intersection matters: after a rollback the file still lists a capability,
 * and the gateway must take that socket back rather than leave it to a plugin
 * this build no longer enables.
 * @param {{
 *   stateRoot: string,
 *   subject: string,
 *   namespace: string,
 *   shipped: boolean,
 *   env?: NodeJS.ProcessEnv,
 * }} options
 * @returns {Promise<Set<string>>}
 */
export async function pluginOwnedCapabilities(options) {
  const { stateRoot, subject, namespace, shipped, env = process.env } = options;
  // Without the plugin in the image no contract can be honoured, even if a
  // previous image left one behind.
  if (!shipped) return new Set();
  const rollout = rolloutCapabilities(env, namespace);
  if (rollout.length === 0) return new Set();
  let contract;
  try {
    contract = await readAuthoritativeContract(stateRoot, subject);
  } catch (error) {
    console.warn(`capability contract lookup failed for ${subject}:`, error);
    return new Set();
  }
  if (contract === undefined) return new Set();
  const allowed = new Set(rollout);
  return new Set(contract.capabilities.filter((name) => allowed.has(name)));
}

/**
 * A tenant contract as the gateway remembers it.
 *
 * `subject`/`account`/`uid` are present whenever the gateway wrote the contract
 * itself; `/__vh/egress` handlers that need tenant identity (the services
 * registry) read them there rather than re-deriving it per request.
 * @typedef {object} CapabilityContractRecord
 * @property {string} home absolute tenant home
 * @property {string} namespace tenant namespace
 * @property {string} key capability key
 * @property {string[]} capabilities delegated capabilities
 * @property {string} [subject] immutable tenant subject
 * @property {string} [account] tenant account name
 * @property {number} [uid] tenant uid
 */

/**
 * Live contracts by subject. The key and the home travel together so a rewrite
 * can drop the previous key and a removal can find it without scanning.
 * @type {Map<string, CapabilityContractRecord>}
 */
const contractsBySubject = new Map();
/** @type {Map<string, string>} key → subject, the authorization index. */
const subjectsByKey = new Map();

/**
 * Remember a tenant contract for `/__vh/egress` authorization.
 * @param {string} subject immutable tenant subject
 * @param {CapabilityContractRecord} contract
 * @returns {void}
 */
export function rememberCapabilityContract(subject, contract) {
  const previous = contractsBySubject.get(subject);
  if (previous !== undefined) subjectsByKey.delete(previous.key);
  contractsBySubject.set(subject, { ...contract });
  subjectsByKey.set(contract.key, subject);
}

/**
 * Drop every key a tenant had, for logout and deletion.
 * @param {string} subject immutable tenant subject
 * @returns {void}
 */
export function forgetCapabilityContract(subject) {
  const previous = contractsBySubject.get(subject);
  if (previous === undefined) return;
  subjectsByKey.delete(previous.key);
  contractsBySubject.delete(subject);
}

/**
 * Resolve a presented key to its tenant contract.
 *
 * Every candidate is compared in constant time so a caller learns nothing from
 * how long a rejection took.
 * @param {string} presented
 * @returns {CapabilityContractRecord | undefined}
 */
export function capabilityContractFor(presented) {
  if (typeof presented !== 'string' || !KEY_PATTERN.test(presented)) return undefined;
  const candidate = Buffer.from(presented);
  let found;
  for (const key of subjectsByKey.keys()) {
    const known = Buffer.from(key);
    if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
      found = contractsBySubject.get(subjectsByKey.get(key));
    }
  }
  return found;
}

/**
 * Capabilities a presented key may use, intersected with the rollout for its
 * own namespace so a tampered delivery copy cannot widen its access.
 * @param {string} presented
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Set<string> | undefined} undefined when the key is unknown.
 */
export function capabilityScopeFor(presented, env = process.env) {
  const contract = capabilityContractFor(presented);
  if (contract === undefined) return undefined;
  const allowed = new Set(rolloutCapabilities(env, contract.namespace));
  return new Set(contract.capabilities.filter((name) => allowed.has(name)));
}
