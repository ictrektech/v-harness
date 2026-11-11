/**
 * Per-tenant Docker capability: a filtered Docker Engine API endpoint.
 *
 * A tenant's agent has to be able to do the job it exists for — write code,
 * build an image, start a container — and those containers must show up where
 * the operator looks for them, on the host daemon. Handing a tenant
 * `/var/run/docker.sock` would be handing out host root (`docker run -v /:/host`
 * reads the whole machine), so the gateway keeps the socket and publishes a
 * filtered API on a per-tenant Unix socket inside that tenant's own home
 * (`<home>/.dsh/docker.sock`, 0600, owner = the tenant). The jail exports
 * `DOCKER_HOST` at it; nothing else in the tenant can reach the daemon.
 *
 * The filter is written as a deny list over the request shape, with two rules
 * that override it: an unknown endpoint or an unexpected field is a denial, not
 * a pass. Docker adds fields between API versions, and a filter that enumerates
 * only the shapes it rejects becomes a hole the day a new one ships.
 *
 * Names are namespaced the way `docker` itself would: objects a tenant creates
 * carry `vh-<account>-` on the host and are presented without it, so
 * `docker run --name db` creates `vh-alice-db` while the tenant keeps seeing
 * `db`.
 *
 * @module v-harness/gateway/docker-proxy
 */

import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { chmodSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { tenantPacketMark } from './addressing.mjs';

const SOCKET_NAME = 'docker.sock';
const STATE_FILE = 'docker-objects.json';

/**
 * Host-side daemon socket. Read per call, not at import, so a test can point a
 * single call at a fake daemon without reloading the module.
 * @returns {string}
 */
function dockerSock() {
  return process.env.VH_DOCKER_SOCK ?? '/var/run/docker.sock';
}

const HOME_ROOT = process.env.HOME_ROOT ?? process.env.DATA_ROOT ?? '/data';

/**
 * Published container ports land on the host, so they need a range that is
 * neither the instance range (3100-3999, the tenant's own dsh) nor a port a
 * tenant may already be listening on inside its jail. 100 ports per tenant,
 * keyed by uid so two tenants never collide.
 */
const PORT_RANGE_BASE = Number(process.env.VH_DOCKER_PORT_BASE ?? 20_000);
const PORT_RANGE_SLOTS = Number(process.env.VH_DOCKER_PORT_SLOTS ?? 90);
const PORT_RANGE_WIDTH = Number(process.env.VH_DOCKER_PORT_WIDTH ?? 100);

/** Resource ceilings, in the shape `docker` accepts. Zero disables the ceiling. */
const MAX_MEMORY_BYTES = Number(process.env.VH_CONTAINER_MAX_MEMORY_MB ?? 2048) * 1024 * 1024;
const MAX_NANO_CPUS = Math.round(Number(process.env.VH_CONTAINER_MAX_CPUS ?? 2) * 1e9);
const MAX_PIDS = Number(process.env.VH_CONTAINER_MAX_PIDS ?? 512);

/** Objects the platform owns and shares read-only, e.g. a shared database image. */
const SHARED_PREFIX = 'vh-shared-';
const OBJECT_PREFIX = 'vh-';
/** Label naming the published port the tenant asked for: `vh.requested-port.80=8080`. */
const PORT_ALIAS_PREFIX = 'vh.requested-port.';
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * Endpoints the filter refuses outright. `system` and `info` stay out on
 * purpose: they report host-wide state (disk usage, container counts, kernel
 * version) that belongs to the deployment, not to a tenant.
 */
const BLOCKED_TOP = new Set([
  'swarm', 'nodes', 'services', 'secrets', 'configs', 'plugins',
  'session', 'auth', 'info', 'system', 'distribution', 'debug',
]);

/** @typedef {{ subject: string, account: string, uid: number, home: string }} Tenant */

/** @typedef {{ containers: string[], images: string[], networks: string[], volumes: string[] }} TenantObjects */

function statePath(tenant) {
  return join(tenant.home, '.dsh', STATE_FILE);
}

/**
 * Objects this tenant owns, as host-side names. Loaded per request so a
 * gateway restart does not strand a running container.
 * @param {Tenant} tenant
 * @returns {Promise<TenantObjects>}
 */
async function loadObjects(tenant) {
  try {
    const raw = JSON.parse(await readFile(statePath(tenant), 'utf8'));
    return {
      containers: Array.isArray(raw?.containers) ? raw.containers.map(String) : [],
      images: Array.isArray(raw?.images) ? raw.images.map(String) : [],
      networks: Array.isArray(raw?.networks) ? raw.networks.map(String) : [],
      volumes: Array.isArray(raw?.volumes) ? raw.volumes.map(String) : [],
    };
  } catch {
    return { containers: [], images: [], networks: [], volumes: [] };
  }
}

/**
 * @param {Tenant} tenant
 * @param {TenantObjects} objects
 * @returns {Promise<void>}
 */
async function saveObjects(tenant, objects) {
  const target = statePath(tenant);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(objects, undefined, 2)}\n`, { mode: 0o600 });
}

/** Host-side name for an object the tenant named `name`. */
export function hostName(tenant, name) {
  return `${OBJECT_PREFIX}${tenant.account}-${name}`;
}

/**
 * Tenant-side name for a host-side object name, or `undefined` when the object
 * is not this tenant's. The shared layer keeps its prefix: it is read-only and
 * visibly not the tenant's.
 * @param {Tenant} tenant
 * @param {string} name
 * @returns {string | undefined}
 */
export function tenantName(tenant, name) {
  const own = `${OBJECT_PREFIX}${tenant.account}-`;
  if (name.startsWith(own)) return name.slice(own.length);
  if (name.startsWith(SHARED_PREFIX)) return name;
  return undefined;
}

/**
 * Whether one daemon event belongs to this tenant.
 *
 * The stream carries every tenant's containers, networks and volumes. The
 * `name` attribute is the field that identifies the owner, and every object the
 * gateway creates carries the tenant prefix; the ownership label is accepted
 * too because it survives a rename.
 * @param {Tenant} tenant
 * @param {unknown} event
 * @returns {boolean}
 */
export function eventVisible(tenant, event) {
  if (event === null || typeof event !== 'object') return false;
  const actor = /** @type {Record<string, unknown>} */ (event).Actor;
  if (actor === null || typeof actor !== 'object') return false;
  const attributes = /** @type {Record<string, unknown>} */ (actor).Attributes;
  if (attributes === null || typeof attributes !== 'object') return false;
  const fields = /** @type {Record<string, unknown>} */ (attributes);
  if (String(fields['vh.tenant'] ?? '') === tenant.account) return true;
  return String(fields.name ?? '').startsWith(`${OBJECT_PREFIX}${tenant.account}-`);
}

/**
 * The host port range reserved for this tenant. Derived from uid so it is
 * stable across restarts without persisting an allocation.
 * @param {Tenant} tenant
 * @returns {[number, number]}
 */
export function portRange(tenant) {
  const slot = tenant.uid % PORT_RANGE_SLOTS;
  const lo = PORT_RANGE_BASE + slot * PORT_RANGE_WIDTH;
  return [lo, lo + PORT_RANGE_WIDTH - 1];
}

/**
 * The network this tenant's containers attach to when they ask for the default.
 *
 * Docker's built-in `bridge` is one network for every container on the host,
 * so a container left on it reaches every other tenant's container directly by
 * address. A user-defined bridge per tenant keeps the default behaviour — NAT
 * out, published ports in — without the shared segment.
 * @param {Tenant} tenant
 * @returns {string} host-side network name.
 */
export function tenantNetwork(tenant) {
  return `${OBJECT_PREFIX}${tenant.account}-default`;
}

/**
 * Translate the network a tenant named into the one the daemon must attach.
 *
 * The tenant works in unprefixed names (`db-net`), so an unprefixed value is
 * prefixed here; a value that already carries a prefix belongs to whoever owns
 * it and is refused unless it is this tenant's. `bridge` and the empty default
 * both mean "the normal NAT network", which for a tenant is its own bridge.
 * @param {Tenant} tenant
 * @param {unknown} mode
 * @returns {{ name: string } | { error: string }}
 */
export function translateNetworkMode(tenant, mode) {
  const value = String(mode ?? '');
  const own = `${OBJECT_PREFIX}${tenant.account}-`;
  if (value === '' || value === 'default' || value === 'bridge') return { name: tenantNetwork(tenant) };
  if (value === 'host') return { error: 'the host network is not allowed' };
  if (value === 'none') return { name: value };
  if (value.startsWith('container:')) {
    return { error: 'sharing another container network namespace is not allowed' };
  }
  if (value.startsWith(OBJECT_PREFIX)) {
    if (!value.startsWith(own)) return { error: `network "${value}" is not yours` };
    return { name: value };
  }
  return { name: `${own}${value}` };
}

/**
 * Pick a host port for one published container port.
 *
 * The requested port is honoured only inside the tenant's own range; anything
 * else — `80`, `0.0.0.0:8080`, an empty host port from `-p 8080` — takes the
 * first free slot. The allocated set threads through one create request so two
 * bindings in the same container never collide.
 * @param {Tenant} tenant
 * @param {Set<number>} used - ports already taken, extended with the result.
 * @param {unknown} requested
 * @returns {number | undefined} the host port, or `undefined` when the range is full.
 */
function allocateHostPort(tenant, used, requested) {
  const [lo, hi] = portRange(tenant);
  const wanted = Number(requested ?? 0);
  if (Number.isInteger(wanted) && wanted >= lo && wanted <= hi && !used.has(wanted)) {
    used.add(wanted);
    return wanted;
  }
  for (let port = lo; port <= hi; port += 1) {
    if (used.has(port)) continue;
    used.add(port);
    return port;
  }
  return undefined;
}

/**
 * Map a tenant-visible path to the host path the daemon will resolve.
 *
 * The daemon resolves bind sources on the host, while the tenant passes paths
 * from its own view. Only `$HOME` has a mapping; every other absolute path is
 * resolved as-is and then rejected by the containment check below.
 * @param {Tenant} tenant
 * @param {string} source
 * @returns {string | undefined} Host path, or `undefined` when outside the tenant home.
 */
export function translateToHostPath(tenant, source) {
  if (!source.startsWith('/')) return undefined;
  const clean = normalize(source);
  const tenantHomeInJail = `/home/${tenant.account}`;
  let hostPath;
  if (clean === tenantHomeInJail) hostPath = join(HOME_ROOT, tenant.account);
  else if (clean.startsWith(`${tenantHomeInJail}${sep}`)) {
    hostPath = join(HOME_ROOT, tenant.account, clean.slice(tenantHomeInJail.length + 1));
  } else hostPath = clean;

  const root = join(HOME_ROOT, tenant.account);
  if (hostPath !== root && !hostPath.startsWith(`${root}${sep}`)) return undefined;
  return hostPath;
}

/**
 * Whether a bind/mount source may enter a container.
 *
 * The Docker socket itself is refused even though it sits outside the home: a
 * container that mounts it can drive the daemon without the filter.
 * @param {Tenant} tenant
 * @param {string} source
 * @returns {string | undefined} Refusal reason, or `undefined` when allowed.
 */
export function bindRefusal(tenant, source) {
  // Checked before containment on purpose: the socket lives outside the home,
  // so the containment refusal would otherwise answer first and name the wrong
  // reason — and a reader would fix the path instead of dropping the mount.
  const clean = normalize(source);
  if (clean === dockerSock() || clean === '/var/run/docker.sock') {
    return 'mounting the Docker socket into a container is not allowed';
  }
  const translated = translateToHostPath(tenant, source);
  if (translated === undefined) {
    return `bind source "${source}" is outside this tenant's home`;
  }
  return undefined;
}

/**
 * Put a tenant-named object into the tenant's namespace.
 *
 * Networks and volumes are named by the agent (`dbdata`, `db-net`), while the
 * daemon sees one namespace for the whole host. The prefix is the tenant's; a
 * name that already carries another prefix is somebody else's object, and
 * saying so is better than attaching to it by accident.
 * @param {Tenant} tenant
 * @param {'network' | 'volume'} kind
 * @param {string} name
 * @returns {{ name: string } | { error: string }}
 */
export function namespaceObjectName(tenant, kind, name) {
  const own = `${OBJECT_PREFIX}${tenant.account}-`;
  if (name === '') return { error: `${kind} name is required` };
  if (name.startsWith(own) || name.startsWith(SHARED_PREFIX)) return { name };
  if (name.startsWith(OBJECT_PREFIX)) return { error: `${kind} "${name}" is not yours` };
  if (/[\\/]/.test(name)) return { error: `${kind} name "${name}" is not valid` };
  return { name: `${own}${name}` };
}

const CONTAINER_PATH = /^\/containers\/([^/]+)(\/.*)?$/;

/**
 * Translate the container reference in a path to the name the daemon knows.
 *
 * `docker run --name web` puts the name in the query, and every later
 * `docker start web` / `docker inspect web` puts it in the path, so both places
 * carry the tenant's own name and both must become `vh-<account>-web`.
 * A reference that is already an id is only accepted when it names one of this
 * tenant's containers: the daemon accepts ids from any namespace, and a listing
 * filter is no barrier to an id somebody already knows.
 * @param {Tenant} tenant
 * @param {string} apiPath
 * @returns {Promise<{ path: string } | { error: string }>}
 */
export async function namespaceContainerPath(tenant, apiPath) {
  const [path, query] = apiPath.split('?');
  const match = CONTAINER_PATH.exec(path ?? '');
  if (match === null) return { path: apiPath };
  const [, ref, rest] = match;
  const suffix = query === undefined ? '' : `?${query}`;

  if (ref === 'json') return { path: apiPath };
  if (ref === 'create') {
    const params = new URLSearchParams(query ?? '');
    const name = params.get('name');
    // The CLI sends no `name` unless the tenant typed one. An unprefixed
    // container never matches this tenant's own listing, so start, wait and
    // inspect are each refused as "not yours" one call after the create.
    if (name === null || name === '') {
      const auto = randomUUID().replaceAll('-', '').slice(0, 12);
      params.set('name', `${OBJECT_PREFIX}${tenant.account}-${auto}`);
      return { path: `${String(path)}?${params.toString()}` };
    }
    const translated = namespaceObjectName(tenant, 'container', name);
    if ('error' in translated) return translated;
    params.set('name', translated.name);
    return { path: `${String(path)}?${params.toString()}` };
  }

  if (/^[0-9a-f]{12,64}$/i.test(ref)) {
    const own = await ownContainers(tenant.account);
    const mine = own.some((entry) => String(entry.Id ?? '').startsWith(ref));
    return mine ? { path: apiPath } : { error: `container "${ref}" is not yours` };
  }

  const translated = namespaceObjectName(tenant, 'container', ref);
  if ('error' in translated) return translated;
  return { path: `/containers/${translated.name}${rest ?? ''}${suffix}` };
}

/**
 * Translate one `Binds`/`Mounts` source into what the daemon must be given.
 *
 * A path is translated through `bindRefusal`; anything else (`dbdata:/var/lib`)
 * is a named volume and only needs its namespace prefix.
 * @param {Tenant} tenant
 * @param {string} source
 * @returns {{ path: string } | { error: string }}
 */
export function translateBindSource(tenant, source) {
  if (!source.startsWith('/')) return translateVolume(tenant, source);
  const refusal = bindRefusal(tenant, source);
  const translated = refusal === undefined ? translateToHostPath(tenant, source) : undefined;
  if (refusal !== undefined || translated === undefined) {
    return { error: refusal ?? `bind source "${source}" is outside this tenant's home` };
  }
  return { path: translated };
}

/**
 * @param {Tenant} tenant
 * @param {string} name
 * @returns {{ path: string } | { error: string }}
 */
function translateVolume(tenant, name) {
  const translated = namespaceObjectName(tenant, 'volume', name);
  return 'error' in translated ? translated : { path: translated.name };
}

/**
 * Parse one `Binds` entry (`source:target[:opts]`) and return its source.
 * @param {string} bind
 * @returns {string | undefined}
 */
function bindSource(bind) {
  const parts = String(bind).split(':');
  // `C:\path:...` on Windows hosts is not reachable here (the daemon is POSIX),
  // so a two-part split is enough and a single part is a malformed entry.
  if (parts.length < 2) return undefined;
  return parts[0];
}

/**
 * Apply a resource ceiling.
 *
 * Docker reads a negative limit as "unbounded", so a requested value that is
 * zero, negative or not a number must resolve to the ceiling rather than be
 * passed through: `PidsLimit: -1` is a request for every PID on the host.
 * @param {unknown} requested
 * @param {number} max
 * @returns {number | undefined} The limit to set, or `undefined` when ceilings are off.
 */
function ceiling(requested, max) {
  if (max <= 0) return undefined;
  const value = Number(requested ?? 0);
  if (!Number.isFinite(value) || value <= 0) return max;
  return Math.min(value, max);
}

/**
 * Rewrite `HostConfig` for a container create request.
 *
 * Two jobs: refuse the shapes that break the isolation boundary, and force the
 * values the tenant is not allowed to choose (port range, resource ceilings).
 * @param {Tenant} tenant
 * @param {Record<string, unknown>} body
 * @param {{ usedHostPorts?: Iterable<number> }} [options] - host ports the
 *   tenant's running containers already hold, from `prepareContainerCreate`.
 * @returns {{ body?: Record<string, unknown>, error?: string }}
 */
export function mutateContainerCreate(tenant, body, options = {}) {
  const host = body.HostConfig;
  /** @type {Record<string, unknown>} */
  const hc = host && typeof host === 'object' ? { ...host } : {};

  if (hc.Privileged === true) return { error: 'privileged containers are not allowed' };
  if (hc.PublishAllPorts === true) {
    return { error: 'publishing all ports is not allowed; publish explicit ports' };
  }
  const network = translateNetworkMode(tenant, hc.NetworkMode);
  if ('error' in network) return { error: network.error };
  hc.NetworkMode = network.name;
  for (const [field, value] of [
    ['PidMode', 'the host PID namespace'],
    ['IpcMode', 'the host IPC namespace'],
    ['UTSMode', 'the host UTS namespace'],
    ['UsernsMode', 'the host user namespace'],
    ['CgroupnsMode', 'the host cgroup namespace'],
  ]) {
    if (hc[field] === 'host') return { error: `${value} is not allowed` };
  }
  if (hc.Runtime !== undefined && String(hc.Runtime) !== 'runc') {
    return { error: `container runtime "${String(hc.Runtime)}" is not allowed` };
  }
  if (Array.isArray(hc.CapAdd)) {
    for (const cap of hc.CapAdd) {
      // `ALL` is the hole a literal `SYS_ADMIN` check leaves open: the daemon
      // expands it to every capability, SYS_ADMIN included.
      const upper = String(cap).toUpperCase();
      if (upper === 'ALL' || upper === 'SYS_ADMIN' || upper === 'CAP_SYS_ADMIN') {
        return { error: 'adding CAP_SYS_ADMIN (or ALL) is not allowed' };
      }
    }
  }
  if (Array.isArray(hc.Devices) && hc.Devices.length > 0) {
    return { error: 'device mappings are not allowed' };
  }
  if (Array.isArray(hc.SecurityOpt) && hc.SecurityOpt.some((opt) => /unconfined/i.test(String(opt)))) {
    return { error: 'unconfined seccomp/apparmor is not allowed' };
  }
  if (hc.Sysctls && typeof hc.Sysctls === 'object') {
    for (const key of Object.keys(hc.Sysctls)) {
      if (/^(net|kernel)\./.test(key)) return { error: `sysctl "${key}" is not allowed` };
    }
  }

  if (Array.isArray(hc.Binds)) {
    for (const bind of hc.Binds) {
      const source = bindSource(bind);
      if (source === undefined) return { error: `malformed bind "${String(bind)}"` };
      const translated = translateBindSource(tenant, source);
      if ('error' in translated) return { error: translated.error };
      const index = hc.Binds.indexOf(bind);
      hc.Binds[index] = `${translated.path}${String(bind).slice(source.length)}`;
    }
  }
  if (Array.isArray(hc.Mounts)) {
    for (const mount of hc.Mounts) {
      if (!mount || typeof mount !== 'object') return { error: 'malformed mount' };
      const entry = /** @type {Record<string, unknown>} */ (mount);
      if (String(entry.Type ?? '') === 'bind') {
        const translated = translateBindSource(tenant, String(entry.Source ?? ''));
        if ('error' in translated) return { error: translated.error };
        entry.Source = translated.path;
      } else if (entry.Name !== undefined) {
        const translated = translateVolume(tenant, String(entry.Name));
        if ('error' in translated) return { error: translated.error };
        entry.Name = translated.path;
      }
    }
  }

  const memory = ceiling(hc.Memory, MAX_MEMORY_BYTES);
  if (memory !== undefined) hc.Memory = memory;
  const cpus = ceiling(hc.NanoCpus, MAX_NANO_CPUS);
  if (cpus !== undefined) hc.NanoCpus = cpus;
  const pids = ceiling(hc.PidsLimit, MAX_PIDS);
  if (pids !== undefined) hc.PidsLimit = pids;

  // A tenant container publishes on host loopback only: the gateway proxies to
  // it, and nothing else on the host should be able to reach it.
  const used = new Set(options.usedHostPorts ?? []);
  /** Requested host port → container port, so `-p 8080:80` stays addressable as 8080. */
  /** @type {Record<string, string>} */
  const requested = {};
  if (hc.PortBindings && typeof hc.PortBindings === 'object') {
    const bindings = /** @type {Record<string, Array<Record<string, unknown>>>} */ (hc.PortBindings);
    for (const [containerPort, list] of Object.entries(bindings)) {
      if (!Array.isArray(list)) continue;
      for (const binding of list) {
        if (!binding || typeof binding !== 'object') return { error: 'malformed port binding' };
        const wanted = Number(binding.HostPort ?? 0);
        const hostPort = allocateHostPort(tenant, used, binding.HostPort);
        if (hostPort === undefined) {
          const [lo, hi] = portRange(tenant);
          return { error: `published port range ${String(lo)}-${String(hi)} is used up; remove a container first` };
        }
        binding.HostIp = '127.0.0.1';
        binding.HostPort = String(hostPort);
        if (Number.isInteger(wanted) && wanted > 0 && wanted !== hostPort) {
          requested[`${PORT_ALIAS_PREFIX}${containerPort.split('/')[0]}`] = String(wanted);
        }
      }
    }
  }

  // `docker run --network X` and `--network-alias` arrive here as well; a name
  // left untranslated would attach the container to somebody else's segment.
  const networking = body.NetworkingConfig;
  let rewrittenNetworking = networking;
  if (networking && typeof networking === 'object') {
    const config = /** @type {Record<string, unknown>} */ (networking);
    const endpoints = config.EndpointsConfig;
    if (endpoints && typeof endpoints === 'object') {
      /** @type {Record<string, unknown>} */
      const rewritten = {};
      for (const [name, endpoint] of Object.entries(endpoints)) {
        const translated = translateNetworkMode(tenant, name);
        if ('error' in translated) return { error: translated.error };
        rewritten[translated.name] = endpoint;
      }
      rewrittenNetworking = { ...config, EndpointsConfig: rewritten };
    }
  }

  /** @type {Record<string, unknown>} */
  const nextBody = { ...body, HostConfig: hc };
  if (rewrittenNetworking !== undefined) nextBody.NetworkingConfig = rewrittenNetworking;
  if (Object.keys(requested).length > 0) {
    // The label is the gateway's record of the port the tenant asked for; a
    // tenant label with the same prefix would be a forged mapping.
    const labels = /** @type {Record<string, unknown>} */ (body.Labels && typeof body.Labels === 'object' ? { ...body.Labels } : {});
    for (const key of Object.keys(labels)) {
      if (key.startsWith(PORT_ALIAS_PREFIX)) delete labels[key];
    }
    nextBody.Labels = { ...labels, ...requested };
  }
  return { body: nextBody };
}

/**
 * Rewrite a network or volume create body so the object lands in the tenant's
 * own namespace instead of the host's flat one.
 * @param {Tenant} tenant
 * @param {string} apiPath
 * @param {Record<string, unknown>} body
 * @returns {{ body?: Record<string, unknown>, error?: string }}
 */
export function mutateNamedObject(tenant, apiPath, body) {
  const kind = apiPath === '/networks/create' ? 'network' : 'volume';
  if (kind === 'network') {
    // The host firewall keys on the tenant pool; a caller-chosen range would
    // step outside it and reach the platform subnets directly.
    const ipam = /** @type {Record<string, unknown> | undefined} */ (body.IPAM);
    const configs = Array.isArray(ipam?.Config) ? ipam.Config : [];
    for (const config of configs) {
      if (config === null || typeof config !== 'object') continue;
      const entry = /** @type {Record<string, unknown>} */ (config);
      if (entry.Subnet !== undefined || entry.IPRange !== undefined || entry.Gateway !== undefined) {
        return { error: '自定义网段不被允许：租户网络由网关分配地址' };
      }
    }
  }
  const translated = namespaceObjectName(tenant, kind, String(body.Name ?? ''));
  if ('error' in translated) return { error: translated.error };
  return { body: { ...body, Name: translated.name } };
}

/**
 * Refuse a network connect/disconnect that names somebody else's container.
 *
 * The path is already this tenant's network, but the body names the container
 * by id, which carries no prefix the gateway can inspect inline. Letting it
 * through would join a foreign container to this tenant's segment — a two-way
 * path between tenants that the create filter never sees.
 * @param {Tenant} tenant
 * @param {Record<string, unknown>} body
 * @returns {Promise<{ body?: Record<string, unknown>, error?: string }>}
 */
async function validateNetworkMember(tenant, body) {
  const id = String(body.Container ?? '');
  if (id === '') return { error: 'container is required' };
  const own = await ownContainers(tenant.account);
  return own.some((entry) => String(entry.Id ?? '').startsWith(id))
    ? { body }
    : { error: `container "${id}" is not yours` };
}

const OBJECT_PATH = /^\/(networks|volumes)\/([^/]+)(\/.*)?$/;

/**
 * Translate the network or volume reference in a path.
 *
 * Compose addresses both by name (`app_default`, `dbdata`), and the daemon
 * keeps every tenant's objects in the same flat namespace, so the same rewrite
 * that applies at create time has to apply on every later call. Ids are
 * rejected: unlike a container id there is no listing this module can check
 * them against cheaply, and compose never uses one.
 * @param {Tenant} tenant
 * @param {string} apiPath
 * @param {string} method
 * @returns {Promise<{ path: string } | { error: string }>}
 */
export async function namespaceObjectPath(tenant, apiPath, method) {
  const [path, query] = apiPath.split('?');
  const match = OBJECT_PATH.exec(path ?? '');
  if (match === null) return { path: apiPath };
  const [, kind, ref, rest] = match;

  if (kind === 'networks' && ref === 'create') return { path: apiPath };
  if (kind === 'volumes' && ref === 'create') return { path: apiPath };

  const noun = kind === 'networks' ? 'network' : 'volume';
  const suffix = query === undefined ? '' : `?${query}`;

  if (/^[0-9a-f]{12,64}$/i.test(ref)) {
    // Compose removes a network by the id it read from the listing, so an id
    // that names one of this tenant's networks has to be accepted. The owner
    // check uses the same prefix rule as the listing filter.
    if (kind !== 'networks') return { error: `${noun} "${ref}" is not addressable by id` };
    const ids = await ownNetworkIds(tenant);
    if (!ids.some((id) => id === ref || id.startsWith(ref))) {
      return { error: `network "${ref}" is not yours` };
    }
    return { path: `/networks/${ref}${rest ?? ''}${suffix}` };
  }

  const translated = namespaceObjectName(tenant, noun, ref);
  if ('error' in translated) return translated;
  if (method === 'DELETE' && translated.name.startsWith(SHARED_PREFIX)) {
    return { error: `${noun} "${ref}" is shared and cannot be removed` };
  }
  return { path: `/${kind}/${translated.name}${rest ?? ''}${suffix}` };
}

/**
 * Ids of the networks this tenant owns.
 * @param {Tenant} tenant
 * @returns {Promise<string[]>}
 */
async function ownNetworkIds(tenant) {
  const listed = await daemonCall('GET', '/networks');
  if (listed.status !== 200 || !Array.isArray(listed.payload)) return [];
  const own = `${OBJECT_PREFIX}${tenant.account}-`;
  const ids = [];
  for (const entry of listed.payload) {
    if (!entry || typeof entry !== 'object') continue;
    const item = /** @type {Record<string, unknown>} */ (entry);
    if (String(item.Name ?? '').startsWith(own)) ids.push(String(item.Id ?? ''));
  }
  return ids;
}

const API_VERSION = /^\/v\d+(?:\.\d+)?(?=\/|$)/;

/**
 * Drop a version prefix (`/v1.43/containers/json`).
 *
 * The CLI always sends one, so a filter that matches only the unversioned
 * shape refuses every real client as "not part of the capability". The daemon
 * accepts unversioned paths and answers with its own current version.
 * @param {string} apiPath
 * @returns {string}
 */
export function stripApiVersion(apiPath) {
  return apiPath.replace(API_VERSION, '');
}

/**
 * Decide what to do with one Engine API request.
 *
 * `allow` forwards unchanged, `mutate` rewrites the body first, `filter`
 * rewrites the response, `events` streams only this tenant's own events, and
 * `deny` answers 403 locally.
 * @param {string} method
 * @param {string} apiPath
 * @returns {{ action: 'allow' } | { action: 'mutate' } | { action: 'filter' } | { action: 'events' } | { action: 'deny', reason: string }}
 */
export function classify(method, apiPath) {
  const clean = stripApiVersion(apiPath).split('?')[0];
  const top = clean.split('/')[1] ?? '';
  if (BLOCKED_TOP.has(top)) {
    return { action: 'deny', reason: `/${top} is not available through the tenant Docker capability` };
  }
  if (clean.includes('/prune')) {
    return { action: 'deny', reason: 'prune operations are not allowed' };
  }

  if (clean === '/_ping' || clean === '/version') return { action: 'allow' };

  if (clean === '/containers/json') {
    return method === 'GET' ? { action: 'filter' } : { action: 'deny', reason: 'method not allowed' };
  }
  if (clean === '/containers/create') {
    return method === 'POST' ? { action: 'mutate' } : { action: 'deny', reason: 'method not allowed' };
  }
  if (/^\/containers\/[^/]+\/archive$/.test(clean)) {
    // `docker cp`: a tar stream in the request body (PUT) or in the response
    // (GET). It is not JSON, so it rides the byte relay; those two methods are
    // all the CLI uses. The path lives in the query string, which
    // namespaceContainerPath leaves alone, and the archive can only reach the
    // container's own filesystem plus whatever the create filter let it mount.
    return method === 'GET' || method === 'PUT'
      ? { action: 'allow' }
      : { action: 'deny', reason: 'method not allowed' };
  }
  if (/^\/containers\/[^/]+\/(json|logs|stats|top|changes|export|start|stop|restart|kill|wait|exec)$/.test(clean)) {
    return { action: 'allow' };
  }
  if (/^\/containers\/[^/]+$/.test(clean) && method === 'DELETE') return { action: 'allow' };
  if (clean === '/exec/start' || /^\/exec\/[^/]+(\/json|\/resize)?$/.test(clean)) return { action: 'allow' };

  if (clean === '/images/json') {
    return method === 'GET' ? { action: 'filter' } : { action: 'deny', reason: 'method not allowed' };
  }
  if (clean === '/images/create' || clean === '/build') {
    return method === 'POST' ? { action: 'allow' } : { action: 'deny', reason: 'method not allowed' };
  }
  if (/^\/images\/[^/]+\/(json|history|tag)$/.test(clean)) return { action: 'allow' };

  if (clean === '/networks' || clean === '/volumes') {
    return method === 'GET' ? { action: 'filter' } : { action: 'deny', reason: 'method not allowed' };
  }
  if (clean === '/networks/create' || clean === '/volumes/create') {
    return method === 'POST' ? { action: 'mutate' } : { action: 'deny', reason: 'method not allowed' };
  }
  if (/^\/networks\/[^/]+$/.test(clean)) {
    if (method === 'GET') return { action: 'filter' };
    if (method === 'DELETE') return { action: 'allow' };
    return { action: 'deny', reason: 'method not allowed' };
  }
  if (/^\/networks\/[^/]+\/(connect|disconnect)$/.test(clean)) {
    // The body names the container by id, so it needs the same ownership check
    // the container paths get before the request is forwarded.
    return method === 'POST' ? { action: 'mutate' } : { action: 'deny', reason: 'method not allowed' };
  }
  if (/^\/volumes\/[^/]+$/.test(clean)) {
    if (method === 'GET') return { action: 'filter' };
    if (method === 'DELETE') return { action: 'allow' };
    return { action: 'deny', reason: 'method not allowed' };
  }
  // Compose follows container state through this stream. It is long-lived and
  // unfiltered by the daemon, so the events themselves are filtered below.
  if (clean === '/events') {
    return method === 'GET' ? { action: 'events' } : { action: 'deny', reason: 'method not allowed' };
  }

  return { action: 'deny', reason: `${method} ${clean} is not part of the tenant Docker capability` };
}

/**
 * The only upgrades a tenant CLI legitimately opens.
 *
 * `docker run`, `docker exec` and `docker attach` switch the connection to a
 * raw stream after the daemon answers `101`. That stream carries no API shape to
 * filter, so the decision has to be made on the path before the daemon socket is
 * opened: attaching to a container, or starting an exec, and nothing else.
 * BuildKit's `/grpc` is deliberately not here — it is a full control plane, not
 * one container's stdio.
 * @param {string} apiPath - version prefix allowed.
 * @returns {{ action: 'allow' } | { action: 'deny', reason: string }}
 */
export function classifyUpgrade(apiPath) {
  const clean = stripApiVersion(apiPath).split('?')[0] ?? '';
  if (/^\/containers\/[^/]+\/attach$/.test(clean)) return { action: 'allow' };
  if (/^\/exec\/[^/]+\/start$/.test(clean)) return { action: 'allow' };
  return {
    action: 'deny',
    reason: `upgrade of ${clean} is not available through the tenant Docker capability`,
  };
}

/**
 * One JSON call to the host daemon.
 * @param {string} method
 * @param {string} apiPath
 * @param {string | undefined} body
 * @returns {Promise<{ status: number, payload: unknown }>}
 */
function daemonCall(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    const req = httpRequest({
      socketPath: dockerSock(),
      path: apiPath,
      method,
      headers: {
        'content-type': 'application/json',
        ...(payload === undefined ? {} : { 'content-length': String(payload.byteLength) }),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode ?? 0, payload: JSON.parse(raw || '{}') });
        } catch {
          resolve({ status: res.statusCode ?? 0, payload: raw });
        }
      });
    });
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('docker daemon timeout')));
    req.on('error', reject);
    if (payload === undefined) req.end();
    else req.end(payload);
  });
}

/**
 * Containers on the host that belong to one tenant, running or not.
 *
 * The listing is the daemon's, so nothing here depends on state a tenant could
 * write; the name prefix is what the create filter put on them.
 * @param {string} account
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function ownContainers(account) {
  const listed = await daemonCall('GET', '/containers/json?all=1');
  if (listed.status !== 200 || !Array.isArray(listed.payload)) return [];
  const own = `/${OBJECT_PREFIX}${account}-`;
  return listed.payload.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const names = Array.isArray(entry.Names) ? entry.Names.map(String) : [];
    return names.some((name) => name.startsWith(own));
  });
}

/**
 * Host ports this tenant's containers already publish.
 * @param {Tenant} tenant
 * @returns {Promise<Set<number>>}
 */
async function usedHostPorts(tenant) {
  const used = new Set();
  for (const entry of await ownContainers(tenant.account)) {
    for (const published of Array.isArray(entry.Ports) ? entry.Ports : []) {
      if (!published || typeof published !== 'object') continue;
      const hostPort = Number(/** @type {Record<string, unknown>} */ (published).PublicPort);
      if (Number.isInteger(hostPort) && hostPort > 0) used.add(hostPort);
    }
  }
  return used;
}

/**
 * The container this gateway itself runs in, when it runs in one.
 *
 * A containerized gateway has its own loopback, so a tenant container published
 * to the host's `127.0.0.1:<port>` is unreachable from it. The daemon record
 * still names the network the container sits on, and joining that network is
 * what makes its address dialable; a host-networked gateway needs none of this.
 * @returns {string | undefined}
 */
function selfContainerId() {
  const declared = process.env.VH_SELF_CONTAINER;
  if (declared !== undefined) return declared === '' ? undefined : declared;
  try {
    const id = readFileSync('/etc/hostname', 'utf8').trim();
    return /^[0-9a-f]{12,64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Networks already joined by this gateway container. */
const attachedNetworks = new Set();

/**
 * Put this gateway container on a tenant network, so `/__vh/svc` can dial the
 * tenant's containers by address.
 *
 * Being on the network is also what the tenant network is for: one bridge per
 * tenant, so two tenants still share no segment without the gateway in the
 * middle. `403` and `409` are the daemon saying this container is already in
 * it, which is the outcome asked for.
 * @param {string} name - host-side network name.
 * @returns {Promise<void>}
 */
async function attachSelf(name) {
  const self = selfContainerId();
  if (self === undefined || attachedNetworks.has(name)) return;
  const joined = await daemonCall('POST', `/networks/${encodeURIComponent(name)}/connect`, JSON.stringify({ Container: self }));
  if (joined.status === 200 || joined.status === 201 || joined.status === 204 || joined.status === 403 || joined.status === 409) {
    attachedNetworks.add(name);
    return;
  }
  throw new Error(`cannot join network ${name}: ${JSON.stringify(joined.payload)}`);
}

/** Networks already confirmed to exist; the daemon keeps them across restarts. */
const knownNetworks = new Set();

/**
 * Address pool the tenant bridges are confined to.
 *
 * The deployment installs one host rule — drop everything from this pool to the
 * platform subnets — so the pool has to be an address block the daemon would
 * never allocate on its own (it hands out 172.17 onwards) and that no host route
 * already uses. `10.240.0.0/16` is empty on the reference host; override it when
 * a deployment's LAN uses it.
 */
const TENANT_SUBNET = process.env.VH_TENANT_SUBNET ?? '10.240.0.0/16';

/**
 * One /24 per tenant, keyed on the uid so a recreated network keeps its address
 * and the host rules stay valid without re-reading docker.
 * @param {Tenant} tenant
 * @returns {string}
 */
export function tenantSubnet(tenant) {
  const octets = TENANT_SUBNET.split('/')[0].split('.');
  const slot = (Math.abs(Number(tenant.uid ?? 0)) % 254) + 1;
  return `${octets[0]}.${octets[1]}.${slot}.0/24`;
}

/**
 * Create the tenant's network the first time a container asks for it, then make
 * sure the gateway is on it.
 *
 * `409` is the daemon saying it is already there, which is the same outcome as
 * creating it. Anything else is a real failure and must stop the create:
 * without the network the container would either fall back to a shared one or
 * never be reachable from the gateway.
 * @param {string} name - host-side network name.
 * @returns {Promise<void>}
 */
async function ensureNetwork(tenant, name) {
  if (!knownNetworks.has(name)) {
    const created = await daemonCall('POST', '/networks/create', JSON.stringify({
      Name: name,
      Driver: 'bridge',
      IPAM: { Driver: 'default', Config: [{ Subnet: tenantSubnet(tenant) }] },
    }));
    if (created.status !== 200 && created.status !== 201 && created.status !== 409) {
      throw new Error(`cannot prepare network ${name}: ${JSON.stringify(created.payload)}`);
    }
    knownNetworks.add(name);
  }
  await attachSelf(name);
  await syncNetworkIsolation(tenant, name);
}

/** The gateway port a container may open on this container's interfaces. */
const GATEWAY_PORT = process.env.PORT ?? '8080';

/** Networks whose isolation rules this process has already installed. */
const isolatedNetworks = new Set();

/** Probe result memo: false once iptables turned out to be unusable here. */
let iptablesUsable;

/**
 * Install one iptables rule unless it is already present.
 * @param {string[]} args - the rule spec exactly as `iptables -A` would take it.
 */
function iptablesOnce(args) {
  if (iptablesUsable === false) return;
  if (typeof process.getuid === 'function' && process.getuid() !== 0) return;
  try {
    execFileSync('iptables', ['-C', ...args.slice(1)], { stdio: 'ignore' });
    return;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') iptablesUsable = false;
  }
  try {
    execFileSync('iptables', args, { stdio: 'ignore' });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') iptablesUsable = false;
    console.warn(`docker-proxy: could not install the network rule (${String(/** @type {Error} */ (error).message)})`);
  }
}

/**
 * Remove one rule, quietly.
 *
 * Only the upgrade path uses this: the rule this file installed before the
 * packet mark existed matched on `--uid-owner`. On a kernel without xt_owner
 * that rule never loaded, and on one with it the mark rule replaces it, so a
 * missing rule — or a match the kernel cannot load — is the expected answer
 * rather than an error worth logging.
 * @param {string[]} args - the rule spec exactly as `iptables -D` would take it.
 */
function iptablesDelete(args) {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) return;
  try {
    execFileSync('iptables', ['-D', ...args.slice(1)], { stdio: 'ignore' });
  } catch {
    // Not there, or the match cannot load here: nothing to remove.
  }
}

/**
 * Install the network isolation rules for one tenant container network.
 *
 * The jail's per-uid chain drops the private ranges wholesale, so the
 * tenant's own bridges must be accepted ahead of it — and containers on the
 * tenant-facing interfaces may open only the gateway port on this container,
 * which keeps one tenant's container off every other tenant's loopback-bound
 * service. Rules key on the network's real subnet (an existing network may
 * predate the pinned pool) and are idempotent, so sync and re-sync are the
 * same call. Any failure is a warning: without CAP_NET_ADMIN the deployment
 * runs without this layer.
 * @param {{ uid: number, account?: string }} tenant
 * @param {string} name - host-side network name.
 * @returns {Promise<void>}
 */
async function syncNetworkIsolation(tenant, name) {
  if (isolatedNetworks.has(name)) return;
  isolatedNetworks.add(name);
  let subnet = tenantSubnet(tenant);
  try {
    const inspected = await daemonCall('GET', `/networks/${encodeURIComponent(name)}`);
    const ipam = inspected.payload && typeof inspected.payload === 'object'
      ? /** @type {Record<string, unknown>} */ (inspected.payload).IPAM
      : undefined;
    const config = Array.isArray(/** @type {Record<string, unknown>} */ (ipam ?? {}).Config)
      ? /** @type {Record<string, unknown>[]} */ (/** @type {Record<string, unknown>} */ (ipam).Config)[0]
      : undefined;
    const reported = config && typeof config === 'object' ? config.Subnet : undefined;
    if (typeof reported === 'string' && reported !== '') subnet = reported;
  } catch (error) {
    console.warn(`docker-proxy: could not read the subnet of ${name} (${String(/** @type {Error} */ (error).message)})`);
  }
  // The jail stamps this uid's packets with the tenant mark and its own chain
  // matches that mark. An owner match cannot stand in for it: the deployment
  // kernel may have no xt_owner (the arm hosts do not), and then this rule
  // never loads — leaving the tenant unable to reach its own containers while
  // the jail's DROP of the private ranges still applies.
  const mark = tenantPacketMark(tenant.uid);
  iptablesDelete(['-D', 'OUTPUT', '-m', 'owner', '--uid-owner', String(tenant.uid), '-d', subnet, '-j', 'ACCEPT']);
  iptablesOnce(['-I', 'OUTPUT', '-m', 'mark', '--mark', mark, '-d', subnet, '-j', 'ACCEPT']);
  iptablesOnce(['-A', 'INPUT', '-s', subnet, '-p', 'tcp', '-m', 'conntrack', '--ctstate', 'NEW', '-m', 'tcp', '!', '--dport', GATEWAY_PORT, '-j', 'DROP']);
  iptablesOnce(['-A', 'INPUT', '-s', subnet, '-p', 'udp', '-m', 'conntrack', '--ctstate', 'NEW', '-m', 'udp', '!', '--dport', GATEWAY_PORT, '-j', 'DROP']);
}

/**
 * Every network one create will attach the container to.
 *
 * `NetworkMode` covers `docker run --network X`; `EndpointsConfig` is what
 * `docker run --network X --net-alias Y` and compose-style creates send. Both
 * carry already-translated names.
 * @param {Record<string, unknown> | undefined} hostConfig
 * @param {unknown} networking
 * @returns {Set<string>}
 */
function requestedNetworks(hostConfig, networking) {
  const names = new Set();
  const mode = String(hostConfig?.NetworkMode ?? '');
  if (mode !== '' && mode !== 'none') names.add(mode);
  const endpoints = networking && typeof networking === 'object'
    ? /** @type {Record<string, unknown>} */ (networking).EndpointsConfig
    : undefined;
  if (endpoints && typeof endpoints === 'object') {
    for (const name of Object.keys(endpoints)) names.add(name);
  }
  return names;
}

/**
 * Everything a container create needs before it is forwarded.
 *
 * Three pieces of daemon state decide the rewrite: which host ports the tenant
 * already holds, which networks exist, and whether the gateway is on them.
 * @param {Tenant} tenant
 * @param {Record<string, unknown>} body
 * @returns {Promise<{ body?: Record<string, unknown>, error?: string }>}
 */
export async function prepareContainerCreate(tenant, body) {
  const mutated = mutateContainerCreate(tenant, body, { usedHostPorts: await usedHostPorts(tenant) });
  if (mutated.error !== undefined || mutated.body === undefined) return mutated;
  const hostConfig = /** @type {Record<string, unknown> | undefined} */ (mutated.body.HostConfig);
  for (const name of requestedNetworks(hostConfig, mutated.body.NetworkingConfig)) await ensureNetwork(tenant, name);
  return mutated;
}

/**
 * The address on which the gateway can reach one tenant container.
 *
 * Only networks this tenant owns are candidates — a container attached to
 * anything else was not made by the filter.
 * @param {string} account
 * @param {Record<string, unknown>} entry
 * @returns {Promise<string | undefined>}
 */
async function dialAddress(account, entry) {
  if (selfContainerId() === undefined) return undefined;
  const networks = entry.NetworkSettings && typeof entry.NetworkSettings === 'object'
    ? /** @type {Record<string, unknown>} */ (entry.NetworkSettings).Networks
    : undefined;
  if (!networks || typeof networks !== 'object') return undefined;
  const own = `${OBJECT_PREFIX}${account}-`;
  for (const [name, detail] of Object.entries(networks)) {
    if (!name.startsWith(own)) continue;
    const ip = detail && typeof detail === 'object'
      ? String(/** @type {Record<string, unknown>} */ (detail).IPAddress ?? '')
      : '';
    if (ip === '') continue;
    // The container is on it, so the network exists; only the join is missing.
    await attachSelf(name);
    return ip;
  }
  return undefined;
}

/**
 * Container ports this container published under a port the tenant asked for.
 *
 * The create filter replaces the requested host port with a tenant-owned one,
 * so `-p 8080:80` publishes on the allocated port and 8080 would otherwise
 * name nothing. The requested value survives as a label the filter writes.
 * @param {Record<string, unknown>} entry
 * @param {number} port
 * @returns {Set<number>} container ports reachable as `port`.
 */
function aliasPorts(entry, port) {
  const found = new Set();
  const labels = entry.Labels && typeof entry.Labels === 'object'
    ? /** @type {Record<string, unknown>} */ (entry.Labels)
    : {};
  for (const [key, value] of Object.entries(labels)) {
    if (!key.startsWith(PORT_ALIAS_PREFIX) || Number(value) !== port) continue;
    const containerPort = Number(key.slice(PORT_ALIAS_PREFIX.length));
    if (Number.isInteger(containerPort) && containerPort > 0) found.add(containerPort);
  }
  return found;
}

/**
 * Where `/__vh/svc/<port>` must connect for one tenant container.
 *
 * `port` may name either side of the mapping — the published host port the
 * agent typed (`-p 8080:80`) or the container port the app listens on (`80`) —
 * because whoever writes the URL reads the agent's output, not the daemon.
 *
 * The mapping is read from the daemon rather than from gateway state: the host
 * port is what this filter forced, so the daemon's record is the one a tenant
 * cannot forge. A containerized gateway dials the container's own address;
 * only a host-networked gateway can use the published loopback port.
 * @param {string} account - tenant account, the container name prefix.
 * @param {number} port - port from the URL.
 * @returns {Promise<{ host: string, port: number } | undefined>}
 */
export async function resolveContainerPort(account, port) {
  /** @type {{ entry: Record<string, unknown>, privatePort: number, hostPort: number, created: number, running: boolean, publishedOn: string } | undefined} */
  let behind;
  for (const entry of await ownContainers(account)) {
    const running = entry.State === 'running';
    const created = Number(entry.Created ?? 0);
    const aliased = aliasPorts(entry, port);
    for (const published of Array.isArray(entry.Ports) ? entry.Ports : []) {
      if (!published || typeof published !== 'object') continue;
      const record = /** @type {Record<string, unknown>} */ (published);
      if (String(record.Type ?? 'tcp') !== 'tcp') continue;
      const hostPort = Number(record.PublicPort);
      const privatePort = Number(record.PrivatePort);
      if (!Number.isInteger(hostPort) || hostPort <= 0) continue;
      if (!Number.isInteger(privatePort) || privatePort <= 0) continue;
      const named = hostPort === port || privatePort === port || aliased.has(privatePort);
      if (!named) continue;
      // Prefer a running container, then the newest one.
      const better = behind === undefined
        || (running && !behind.running)
        || (running === behind.running && created > behind.created);
      if (better) behind = { entry, privatePort, hostPort, created, running, publishedOn: String(record.IP ?? '') };
    }
  }
  if (behind === undefined) return undefined;
  const address = await dialAddress(account, behind.entry);
  if (address !== undefined) return { host: address, port: behind.privatePort };
  // Only the loopback publish is the filter's doing; anything else was made
  // outside it, and the host has no address this gateway may hand out.
  if (behind.publishedOn !== '127.0.0.1') return undefined;
  return { host: '127.0.0.1', port: behind.hostPort };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function json(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Read a JSON request body, bounded.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** Response headers that describe this hop, not the payload. */
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

/**
 * Forward one allowed request to the daemon byte for byte.
 *
 * Most allowed endpoints are either streaming answers (`logs`, `export`,
 * `stats`, `build`) or carry their arguments in the body (`exec` create,
 * `build` context). Buffering them as JSON — what `daemonCall` does — either
 * corrupts the bytes or loses them, so this path only moves streams.
 * Authorisation has already happened in `classify`; nothing here re-reads the
 * payload.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} method
 * @param {string} apiPath
 * @returns {Promise<void>}
 */
function relay(req, res, method, apiPath) {
  return new Promise((resolve, reject) => {
    /** @type {Record<string, string>} */
    const headers = {};
    for (const name of ['content-type', 'content-length', 'content-encoding']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const upstream = httpRequest({
      socketPath: dockerSock(),
      path: apiPath,
      method,
      headers,
    }, (upstreamRes) => {
      /** @type {Record<string, string | string[]>} */
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_HEADERS.has(name)) continue;
        responseHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => { resolve(); });
      upstreamRes.on('error', () => { res.destroy(); resolve(); });
    });
    upstream.on('error', (error) => {
      if (!res.headersSent) json(res, 502, { message: `docker daemon unreachable: ${error.message}` });
      else res.destroy();
      resolve();
    });
    res.on('close', () => { upstream.destroy(); resolve(); });
    req.pipe(upstream);
  });
}

/** Longest single event line the feed may carry before it is treated as junk. */
const MAX_EVENT_LINE = 1024 * 1024;

/**
 * Stream the daemon's event feed, keeping only this tenant's objects.
 *
 * Compose depends on this stream to notice containers reaching `running`. The
 * daemon has no per-tenant view of it, so the filter happens here, line by line.
 * Anything that cannot be parsed or attributed is dropped rather than forwarded:
 * a leak on this stream names other tenants' containers and images.
 * @param {Tenant} tenant
 * @param {import('node:http').ServerResponse} res
 * @param {string} apiPath
 * @returns {Promise<void>}
 */
function relayEvents(tenant, res, apiPath) {
  return new Promise((resolve) => {
    const upstream = httpRequest({ socketPath: dockerSock(), path: apiPath, method: 'GET' }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, { 'content-type': 'application/json' });
      // The first event may be minutes away; without this the client waits on a
      // response whose headers were only staged, not sent.
      res.flushHeaders();
      let buffered = '';
      upstreamRes.setEncoding('utf8');

      const forward = (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (eventVisible(tenant, event)) res.write(`${line}\n`);
      };
      const drain = (final) => {
        let index = buffered.indexOf('\n');
        while (index !== -1) {
          const line = buffered.slice(0, index);
          buffered = buffered.slice(index + 1);
          if (line !== '') forward(line);
          index = buffered.indexOf('\n');
        }
        if (final && buffered !== '') {
          forward(buffered);
          buffered = '';
        }
      };

      upstreamRes.on('data', (chunk) => {
        buffered += chunk;
        drain(false);
        if (buffered.length > MAX_EVENT_LINE) {
          upstream.destroy();
          res.destroy();
          resolve();
        }
      });
      upstreamRes.on('end', () => { drain(true); res.end(); resolve(); });
      upstreamRes.on('error', () => { res.destroy(); resolve(); });
    });
    upstream.on('error', (error) => {
      if (!res.headersSent) json(res, 502, { message: `docker daemon unreachable: ${error.message}` });
      else res.destroy();
      resolve();
    });
    // `http.request` buffers the request line until the body is ended; without
    // this the daemon is never asked and the client waits forever.
    upstream.end();
    res.on('close', () => { upstream.destroy(); resolve(); });
  });
}

/** HTTP status text for the refusals this module writes itself. */
const UPGRADE_STATUS = { 403: 'Forbidden', 501: 'Not Implemented', 502: 'Bad Gateway' };

/**
 * Answer an upgrade with a plain HTTP response and close the client socket.
 * @param {import('node:net').Socket} socket
 * @param {number} status
 * @param {string} message
 */
function refuseUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ message });
  socket.end(
    `HTTP/1.1 ${status} ${UPGRADE_STATUS[status] ?? 'Error'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
}

/**
 * Resolve an exec id back to its container and check the owner.
 *
 * `/exec/{id}/start` names an id the daemon minted; unlike a container name it
 * carries no prefix the gateway could inspect. The lookup happens before the
 * upgrade, because once the stream is raw there is nothing left to check.
 * @param {Tenant} tenant
 * @param {string} clean - version-stripped path, query removed.
 * @returns {Promise<{ error?: string }>}
 */
async function authorizeExec(tenant, clean) {
  const match = /^\/exec\/([^/]+)\/start$/.exec(clean);
  if (match === null) return { error: 'exec stream is not available' };
  const id = match[1];
  const found = await daemonCall('GET', `/exec/${encodeURIComponent(id)}/json`);
  const containerId = found.status === 200 && found.payload !== null && typeof found.payload === 'object'
    ? String(/** @type {Record<string, unknown>} */ (found.payload).ContainerID ?? '')
    : '';
  if (containerId === '') return { error: `exec "${id}" is not yours` };
  const own = await ownContainers(tenant.account);
  return own.some((entry) => String(entry.Id ?? '').startsWith(containerId))
    ? {}
    : { error: `exec "${id}" is not yours` };
}

/**
 * One `Upgrade` connection.
 *
 * This is the only place the capability hands out a raw byte stream. Every
 * check — path, container ownership, exec ownership — runs before
 * `netConnect(dockerSock())`, so a refusal never opens the daemon socket at all.
 * @param {Tenant} tenant
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head - bytes already read after the upgrade request.
 * @returns {Promise<void>}
 */
export async function handleTenantUpgrade(tenant, req, socket, head) {
  socket.on('error', () => {});

  const requested = req.url ?? '/';
  const decision = classifyUpgrade(requested);
  if (decision.action === 'deny') {
    refuseUpgrade(socket, 501, decision.reason);
    return;
  }

  const clean = stripApiVersion(requested);
  const pathOnly = clean.split('?')[0] ?? '';
  let upstreamPath;
  if (pathOnly.endsWith('/attach')) {
    const named = await namespaceContainerPath(tenant, clean);
    if ('error' in named) {
      refuseUpgrade(socket, 403, named.error);
      return;
    }
    // `namespaceContainerPath` lets `vh-shared-*` objects through so a tenant
    // can read a shared image or database. A raw stream is not a read — it can
    // carry stdin — so only the tenant's own containers qualify here.
    const ref = /^\/containers\/([^/]+)\//.exec(named.path)?.[1] ?? '';
    if (!/^[0-9a-f]{12,64}$/i.test(ref) && !ref.startsWith(`${OBJECT_PREFIX}${tenant.account}-`)) {
      refuseUpgrade(socket, 403, `container "${ref}" is not yours`);
      return;
    }
    upstreamPath = named.path;
  } else {
    const owned = await authorizeExec(tenant, pathOnly);
    if (owned.error !== undefined) {
      refuseUpgrade(socket, 403, owned.error);
      return;
    }
    upstreamPath = clean;
  }

  const upstream = netConnect(dockerSock());
  upstream.on('error', (error) => {
    refuseUpgrade(socket, 502, `docker daemon unreachable: ${error.message}`);
  });
  upstream.on('connect', () => {
    const lines = [`${req.method ?? 'GET'} ${upstreamPath} HTTP/1.1`];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  socket.on('close', () => { upstream.destroy(); });
  upstream.on('close', () => { socket.destroy(); });
}

/**
 * One request through the filter.
 *
 * Exported for the tests: the socket server below is a thin wrapper, and the
 * body/stream behaviour cannot be checked without driving this directly.
 * @param {Tenant} tenant
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function handleTenantRequest(tenant, req, res) {
  // Upgrades are handled by `handleTenantUpgrade`; this branch is only the
  // fallback for a server that was started without that listener, and keeps the
  // CLI from hanging instead of seeing a refusal it can report.
  if (req.headers.upgrade !== undefined) {
    json(res, 501, {
      message: 'interactive connections (exec, attach, run -it) are not available through the tenant Docker capability',
    });
    return;
  }

  const method = req.method ?? 'GET';
  const requested = stripApiVersion(req.url ?? '/');
  const named = requested.startsWith('/containers/')
    ? await namespaceContainerPath(tenant, requested)
    : requested.startsWith('/networks/') || requested.startsWith('/volumes/')
      ? await namespaceObjectPath(tenant, requested, method)
      : { path: requested };
  if ('error' in named) {
    json(res, 403, { message: named.error });
    return;
  }
  const apiPath = named.path;
  const decision = classify(method, apiPath);
  if (decision.action === 'deny') {
    json(res, 403, { message: decision.reason });
    return;
  }

  if (decision.action === 'events') {
    await relayEvents(tenant, res, requested);
    return;
  }

  if (decision.action === 'allow') {
    await relay(req, res, method, apiPath);
    return;
  }

  const objects = await loadObjects(tenant);
  let body;
  if (decision.action === 'mutate') {
    const parsed = /** @type {Record<string, unknown>} */ (await readJson(req));
    const mutated = apiPath.startsWith('/containers/create')
      ? await prepareContainerCreate(tenant, parsed)
      : /\/(connect|disconnect)$/.test(apiPath.split('?')[0] ?? '')
        ? await validateNetworkMember(tenant, parsed)
        : mutateNamedObject(tenant, apiPath.split('?')[0], parsed);
    if (mutated.error !== undefined) {
      json(res, 403, { message: mutated.error });
      return;
    }
    body = JSON.stringify(mutated.body);
  }

  const upstream = await daemonCall(method, apiPath, body);
  if (decision.action === 'filter' && upstream.status === 200) {
    json(res, 200, filterListing(tenant, apiPath.split('?')[0], upstream.payload));
    return;
  }
  if (upstream.status === 200) remember(tenant, objects, apiPath.split('?')[0], upstream.payload);
  json(res, upstream.status, upstream.payload);
}

/**
 * Keep the tenant's object set current after a successful create/build/pull,
 * so listing and ownership checks do not depend on the daemon's answers.
 * @param {Tenant} tenant
 * @param {TenantObjects} objects
 * @param {string} apiPath
 * @param {unknown} payload
 */
function remember(tenant, objects, apiPath, payload) {
  if (apiPath === '/containers/create' && payload && typeof payload === 'object') {
    const id = String(/** @type {Record<string, unknown>} */ (payload).Id ?? '');
    if (id !== '') {
      objects.containers.push(id);
      void saveObjects(tenant, objects).catch(() => {});
    }
  }
}

/**
 * Present a daemon listing as the tenant's own view.
 * @param {Tenant} tenant
 * @param {string} apiPath
 * @param {unknown} payload
 * @returns {unknown}
 */
export function filterListing(tenant, apiPath, payload) {
  if (apiPath === '/containers/json' && Array.isArray(payload)) {
    const visible = [];
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      const item = /** @type {Record<string, unknown>} */ (entry);
      const names = Array.isArray(item.Names) ? item.Names.map((name) => String(name).replace(/^\//, '')) : [];
      const renamed = names.map((name) => tenantName(tenant, name));
      if (renamed.some((name) => name !== undefined)) {
        visible.push({ ...item, Names: renamed.filter((name) => name !== undefined).map((name) => `/${String(name)}`) });
      }
    }
    return visible;
  }
  if (apiPath === '/networks' && Array.isArray(payload)) {
    const visible = [];
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      const item = /** @type {Record<string, unknown>} */ (entry);
      const renamed = tenantName(tenant, String(item.Name ?? ''));
      if (renamed !== undefined) visible.push({ ...item, Name: renamed });
    }
    return visible;
  }
  if (apiPath === '/volumes' && payload !== null && typeof payload === 'object') {
    const source = /** @type {Record<string, unknown>} */ (payload);
    const list = Array.isArray(source.Volumes) ? source.Volumes : [];
    const visible = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const item = { .../** @type {Record<string, unknown>} */ (entry) };
      const renamed = tenantName(tenant, String(item.Name ?? ''));
      if (renamed === undefined) continue;
      // `Mountpoint` is a host path; it describes the host layout and is not
      // needed to use the volume.
      delete item.Mountpoint;
      visible.push({ ...item, Name: renamed });
    }
    return { ...source, Volumes: visible };
  }
  if (/^\/networks\/[^/]+$/.test(apiPath) && payload !== null && typeof payload === 'object') {
    const item = { .../** @type {Record<string, unknown>} */ (payload) };
    // The gateway joins every tenant network; that membership is host
    // infrastructure, not part of the tenant's view.
    delete item.Containers;
    const renamed = tenantName(tenant, String(item.Name ?? ''));
    if (renamed !== undefined) item.Name = renamed;
    return item;
  }
  if (/^\/volumes\/[^/]+$/.test(apiPath) && payload !== null && typeof payload === 'object') {
    const item = { .../** @type {Record<string, unknown>} */ (payload) };
    delete item.Mountpoint;
    const renamed = tenantName(tenant, String(item.Name ?? ''));
    if (renamed !== undefined) item.Name = renamed;
    return item;
  }
  if (apiPath === '/images/json' && Array.isArray(payload)) {
    const visible = [];
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      const item = /** @type {Record<string, unknown>} */ (entry);
      const tags = Array.isArray(item.RepoTags) ? item.RepoTags.map(String) : [];
      const kept = tags.filter((tag) => tenantName(tenant, tag.split(':')[0]) !== undefined);
      if (kept.length > 0) {
        visible.push({ ...item, RepoTags: kept.map((tag) => {
          const [repo, rest] = tag.split(':');
          const owned = tenantName(tenant, repo) ?? repo;
          return rest === undefined ? owned : `${owned}:${rest}`;
        }) });
      }
    }
    return visible;
  }
  return payload;
}

/** @type {Map<string, Promise<import('node:http').Server>>} */
const capabilities = new Map();

/**
 * Start (once) this tenant's Docker capability socket.
 * @param {{ subject: string, account: string, uid: number, home: string, userHelper: string }} options
 * @returns {Promise<import('node:http').Server>}
 */
async function start(options) {
  const tenant = { subject: options.subject, account: options.account, uid: options.uid, home: options.home };
  const socketPath = join(options.home, '.dsh', SOCKET_NAME);
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await unlink(socketPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });

  const server = createServer((req, res) => {
    void handleTenantRequest(tenant, req, res).catch((error) => {
      console.error(`docker capability failed (${tenant.account}):`, error);
      if (!res.headersSent) json(res, 500, { message: 'capability failed' });
      else res.destroy();
    });
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  // Upgrades never reach the request handler above: Node routes them here
  // instead, which keeps the checked path and the raw stream in one function.
  server.on('upgrade', (req, socket, head) => {
    void handleTenantUpgrade(tenant, req, socket, head).catch((error) => {
      console.error(`docker capability upgrade failed (${tenant.account}):`, error);
      socket.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      chmodSync(socketPath, 0o600);
      resolve(undefined);
    });
  });

  // Imported here rather than at module scope: the policy functions above are
  // pure and must stay importable by a test that never touches the gateway's
  // process machinery.
  const { runUserHelper } = await import('./instances.mjs');
  await runUserHelper(options.userHelper, ['claim', options.account, socketPath]);
  return server;
}

/**
 * Make sure this tenant's Docker capability socket exists.
 * @param {{ subject: string, account: string, uid: number, home: string, userHelper: string }} options
 * @returns {Promise<void>}
 */
export async function ensureDockerCapability(options) {
  const existing = capabilities.get(options.subject);
  if (existing) {
    await existing;
    return;
  }
  const starting = start(options);
  capabilities.set(options.subject, starting);
  try {
    await starting;
    // The default bridge is where every container the tenant starts lands
    // unless it names another network, so its rules ride along with the
    // capability: a gateway restart no longer waits for the next create to
    // restore the tenant's own-container route.
    await syncNetworkIsolation(options, `${OBJECT_PREFIX}${options.account}-default`);
  } catch (error) {
    capabilities.delete(options.subject);
    throw error;
  }
}

/**
 * Drop one tenant's cached listener so the next `ensure` binds a fresh inode.
 * @param {string} subject immutable tenant subject
 * @returns {Promise<void>}
 */
export async function forgetDockerCapability(subject) {
  const existing = capabilities.get(subject);
  capabilities.delete(subject);
  if (existing === undefined) return;
  try {
    const server = await existing;
    await new Promise((resolve) => { server.close(() => { resolve(); }); });
  } catch {
    // A capability that never started owns no socket.
  }
}

/**
 * Drop every capability socket; the gateway calls this as it shuts down.
 * @returns {Promise<void>}
 */
export async function closeDockerCapabilities() {
  const running = [...capabilities.values()];
  capabilities.clear();
  for (const started of running) {
    const server = await started.catch(() => undefined);
    server?.close();
  }
}
