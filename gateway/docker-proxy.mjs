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
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { chmodSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';

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
 * neither the instance range (3100-3999, the tenant's own dsh) nor the pasta
 * forwarded ranges (3000-3099, 5173, 8000-8099, 9000-9099) — a port in those
 * would be shadowed by the tenant's own namespace. 100 ports per tenant, keyed
 * by uid so two tenants never collide.
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
    if (query === undefined) return { path: apiPath };
    const params = new URLSearchParams(query);
    const name = params.get('name');
    if (name === null || name === '') return { path: apiPath };
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
 * rewrites the response, `deny` answers 403 locally.
 * @param {string} method
 * @param {string} apiPath
 * @returns {{ action: 'allow' } | { action: 'mutate' } | { action: 'filter' } | { action: 'deny', reason: string }}
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

  if (clean === '/networks/json' || clean === '/volumes') {
    return method === 'GET' ? { action: 'filter' } : { action: 'deny', reason: 'method not allowed' };
  }
  if (clean === '/networks/create' || clean === '/volumes/create') {
    return method === 'POST' ? { action: 'mutate' } : { action: 'deny', reason: 'method not allowed' };
  }

  return { action: 'deny', reason: `${method} ${clean} is not part of the tenant Docker capability` };
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
  // `docker exec`, `attach` and `run -it` switch the connection to a raw
  // stream (`Upgrade: hijack`, or `tcp` for a non-tty exec); a plain HTTP
  // forward cannot carry that, and answering 101 while dropping the stream
  // would look like it worked. Refuse both instead of hanging the CLI.
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
  } catch (error) {
    capabilities.delete(options.subject);
    throw error;
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
