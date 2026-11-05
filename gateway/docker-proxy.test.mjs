/**
 * Tenant Docker capability policy tests.
 *
 * These cover the filter, not the forwarding: every case is a shape an agent
 * could send that must be refused before it reaches the host daemon, plus the
 * rewrites that keep a tenant inside its own port range, resource ceilings and
 * home directory.
 *
 * @module v-harness/gateway/docker-proxy.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bindRefusal,
  classify,
  filterListing,
  handleTenantRequest,
  hostName,
  mutateContainerCreate,
  mutateNamedObject,
  namespaceContainerPath,
  namespaceObjectName,
  portRange,
  prepareContainerCreate,
  resolveContainerPort,
  stripApiVersion,
  tenantName,
  tenantNetwork,
  tenantSubnet,
  translateNetworkMode,
  translateToHostPath,
} from './docker-proxy.mjs';

/** @type {{ subject: string, account: string, uid: number, home: string }} */
const tenant = { subject: 'sub-1', account: 'alice', uid: 1001, home: '/data/alice' };

/**
 * Run one container-create body through the filter and return the refusal, if any.
 * @param {Record<string, unknown>} hostConfig
 * @returns {string | undefined}
 */
function refusal(hostConfig) {
  const result = mutateContainerCreate(tenant, { Image: 'node:22', HostConfig: hostConfig });
  return result.error;
}

describe('container create filter', () => {
  it('refuses privileged containers', () => {
    assert.match(String(refusal({ Privileged: true })), /privileged/);
  });

  it('refuses CAP_SYS_ADMIN expressed as ALL', () => {
    assert.match(String(refusal({ CapAdd: ['ALL'] })), /CAP_SYS_ADMIN/);
    assert.match(String(refusal({ CapAdd: ['SYS_ADMIN'] })), /CAP_SYS_ADMIN/);
  });

  it('allows a capability that does not lift the boundary', () => {
    assert.equal(refusal({ CapAdd: ['NET_BIND_SERVICE'] }), undefined);
  });

  it('refuses every host namespace mode', () => {
    for (const field of ['NetworkMode', 'PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode']) {
      assert.notEqual(refusal({ [field]: 'host' }), undefined, field);
    }
  });

  it('refuses devices, unconfined profiles and net sysctls', () => {
    assert.notEqual(refusal({ Devices: [{ PathOnHost: '/dev/mem' }] }), undefined);
    assert.notEqual(refusal({ SecurityOpt: ['seccomp=unconfined'] }), undefined);
    assert.notEqual(refusal({ Sysctls: { 'net.ipv4.ip_forward': '1' } }), undefined);
  });

  it('refuses bind sources outside the tenant home', () => {
    assert.notEqual(refusal({ Binds: ['/:/host'] }), undefined);
    assert.notEqual(refusal({ Binds: ['/etc/passwd:/etc/passwd'] }), undefined);
    assert.notEqual(refusal({ Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] }), undefined);
  });

  it('refuses mounting the Docker socket even from inside the home path', () => {
    assert.match(String(refusal({ Binds: ['/var/run/docker.sock:/var/run/docker.sock'] })), /Docker socket/);
  });

  it('translates a tenant bind source to its host path', () => {
    const result = mutateContainerCreate(tenant, {
      HostConfig: { Binds: ['/home/alice/project:/app:ro'] },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(/** @type {any} */ (result.body).HostConfig.Binds, ['/data/alice/project:/app:ro']);
  });

  it('refuses a volume that belongs to another tenant', () => {
    assert.match(String(refusal({ Mounts: [{ Type: 'volume', Name: 'vh-bob-data', Target: '/data' }] })), /not yours/);
  });

  it('clamps memory, cpu and pids to the configured ceilings', () => {
    const result = mutateContainerCreate(tenant, {
      HostConfig: { Memory: 64 * 1024 * 1024 * 1024, NanoCpus: 64_000_000_000, PidsLimit: -1 },
    });
    const host = /** @type {any} */ (result.body).HostConfig;
    assert.ok(host.Memory <= 2048 * 1024 * 1024, 'memory ceiling');
    assert.ok(host.NanoCpus <= 2_000_000_000, 'cpu ceiling');
    assert.equal(host.PidsLimit, 512);
  });

  it('forces a published port onto tenant loopback inside its range', () => {
    const [lo, hi] = portRange(tenant);
    const result = mutateContainerCreate(tenant, {
      HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }] } },
    });
    const binding = /** @type {any} */ (result.body).HostConfig.PortBindings['8080/tcp'][0];
    assert.equal(binding.HostIp, '127.0.0.1');
    assert.ok(Number(binding.HostPort) >= lo && Number(binding.HostPort) <= hi);
  });

  it('gives each published port its own host port', () => {
    const [lo] = portRange(tenant);
    const result = mutateContainerCreate(tenant, {
      HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '80' }], '443/tcp': [{ HostPort: '' }] } },
    });
    const bindings = /** @type {any} */ (result.body).HostConfig.PortBindings;
    const ports = [bindings['80/tcp'][0].HostPort, bindings['443/tcp'][0].HostPort].map(Number).sort((a, b) => a - b);
    assert.deepEqual(ports, [lo, lo + 1]);
  });

  it('skips a host port the tenant already holds', () => {
    const [lo] = portRange(tenant);
    const result = mutateContainerCreate(
      tenant,
      { HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '' }] } } },
      { usedHostPorts: new Set([lo]) },
    );
    assert.equal(/** @type {any} */ (result.body).HostConfig.PortBindings['80/tcp'][0].HostPort, String(lo + 1));
  });

  it('keeps a requested host port that is inside the range', () => {
    const [lo] = portRange(tenant);
    const requested = String(lo + 5);
    const result = mutateContainerCreate(tenant, {
      HostConfig: { PortBindings: { '80/tcp': [{ HostPort: requested }] } },
    });
    assert.equal(/** @type {any} */ (result.body).HostConfig.PortBindings['80/tcp'][0].HostPort, requested);
  });
});

describe('tenant networks', () => {
  it('turns the default network into the tenant bridge', () => {
    assert.equal(tenantNetwork(tenant), 'vh-alice-default');
    assert.equal(translateNetworkMode(tenant, '').name, 'vh-alice-default');
    assert.equal(translateNetworkMode(tenant, 'bridge').name, 'vh-alice-default');
    assert.equal(translateNetworkMode(tenant, 'none').name, 'none');
  });

  it('prefixes a network the tenant names', () => {
    assert.equal(translateNetworkMode(tenant, 'db-net').name, 'vh-alice-db-net');
    assert.equal(translateNetworkMode(tenant, 'vh-alice-db-net').name, 'vh-alice-db-net');
  });

  it('refuses the host network and shared namespaces', () => {
    assert.ok('error' in translateNetworkMode(tenant, 'host'));
    assert.ok('error' in translateNetworkMode(tenant, 'container:abc'));
    assert.match(String(translateNetworkMode(tenant, 'vh-bob-net').error), /not yours/);
  });

  it('refuses an endpoint on another tenant network', () => {
    const result = mutateContainerCreate(tenant, {
      HostConfig: {},
      NetworkingConfig: { EndpointsConfig: { 'vh-bob-net': {} } },
    });
    assert.match(String(result.error), /not yours/);
  });

  it('namespaces networks and volumes the tenant creates', () => {
    assert.deepEqual(namespaceObjectName(tenant, 'network', 'db-net'), { name: 'vh-alice-db-net' });
    assert.deepEqual(namespaceObjectName(tenant, 'volume', 'dbdata'), { name: 'vh-alice-dbdata' });
    assert.match(String(namespaceObjectName(tenant, 'volume', 'vh-bob-data').error), /not yours/);
  });

  it('prefixes a named volume used as a bind source', () => {
    const result = mutateContainerCreate(tenant, { HostConfig: { Binds: ['dbdata:/var/lib/postgresql/data'] } });
    assert.deepEqual(/** @type {any} */ (result.body).HostConfig.Binds, ['vh-alice-dbdata:/var/lib/postgresql/data']);
  });
});

describe('endpoint classification', () => {
  it('refuses cluster-wide and host-wide endpoints', () => {
    for (const path of ['/swarm/init', '/services', '/nodes', '/info', '/system/df', '/auth']) {
      assert.equal(classify('GET', path).action, 'deny', path);
    }
  });

  it('refuses prune on every resource', () => {
    assert.equal(classify('POST', '/containers/prune').action, 'deny');
    assert.equal(classify('POST', '/images/prune').action, 'deny');
    assert.equal(classify('POST', '/volumes/prune').action, 'deny');
  });

  it('refuses an endpoint it does not know', () => {
    assert.equal(classify('GET', '/made-up/thing').action, 'deny');
  });

  it('routes the endpoints an agent needs', () => {
    assert.equal(classify('POST', '/containers/create').action, 'mutate');
    assert.equal(classify('GET', '/containers/json').action, 'filter');
    assert.equal(classify('POST', '/containers/abc/start').action, 'allow');
    assert.equal(classify('GET', '/images/json').action, 'filter');
    assert.equal(classify('POST', '/build').action, 'allow');
    assert.equal(classify('GET', '/version').action, 'allow');
  });

  it('routes a versioned path the way the CLI sends it', () => {
    assert.equal(stripApiVersion('/v1.43/containers/json'), '/containers/json');
    assert.equal(stripApiVersion('/v1.43/containers/json?all=1'), '/containers/json?all=1');
    assert.equal(stripApiVersion('/containers/json'), '/containers/json');
    assert.equal(stripApiVersion('/version'), '/version');
    assert.equal(classify('POST', '/v1.43/containers/create').action, 'mutate');
    assert.equal(classify('GET', '/v1.43/containers/json').action, 'filter');
    assert.equal(classify('DELETE', '/v1.43/containers/abc').action, 'allow');
    assert.equal(classify('GET', '/v1.43/system/df').action, 'deny');
    assert.equal(classify('GET', '/v1.43/made-up/thing').action, 'deny');
  });
});

describe('naming and paths', () => {
  it('prefixes created objects and strips the prefix on the way back', () => {
    assert.equal(hostName(tenant, 'db'), 'vh-alice-db');
    assert.equal(tenantName(tenant, 'vh-alice-db'), 'db');
    assert.equal(tenantName(tenant, 'vh-bob-db'), undefined);
    assert.equal(tenantName(tenant, 'vh-shared-postgres'), 'vh-shared-postgres');
  });

  it('refuses paths that escape the tenant home', () => {
    assert.equal(translateToHostPath(tenant, '/home/alice/../bob'), undefined);
    assert.equal(translateToHostPath(tenant, '/home/alice/x'), '/data/alice/x');
    assert.notEqual(bindRefusal(tenant, '/home/alice/../../etc/passwd'), undefined);
    assert.notEqual(bindRefusal(tenant, '/root'), undefined);
  });
});

describe('listing filters', () => {
  it('shows only the tenant containers, without the prefix', () => {
    const listed = filterListing(tenant, '/containers/json', [
      { Names: ['/vh-alice-db'], Id: '1' },
      { Names: ['/vh-bob-db'], Id: '2' },
      { Names: ['/vh-shared-postgres'], Id: '3' },
    ]);
    assert.deepEqual(/** @type {any} */ (listed).map((entry) => entry.Names[0]), ['/db', '/vh-shared-postgres']);
  });

  it('shows only the tenant images and the shared layer', () => {
    const listed = filterListing(tenant, '/images/json', [
      { RepoTags: ['vh-alice-app:latest'] },
      { RepoTags: ['vh-bob-app:latest'] },
      { RepoTags: ['vh-shared-postgres:16'] },
      { RepoTags: null },
    ]);
    assert.deepEqual(/** @type {any} */ (listed).map((entry) => entry.RepoTags[0]), [
      'app:latest',
      'vh-shared-postgres:16',
    ]);
  });
});

/**
 * Serve a fake Engine API on a Unix socket.
 *
 * The policy that decides a host port and a network reads daemon state, so
 * these cases need a daemon to answer — and the real one is the host's.
 * @param {(method: string, path: string) => { status: number, body?: unknown }} answer
 * @param {(context: { calls: { method: string, path: string, body: string }[] }) => Promise<void>} work
 * @param {{ self?: string }} [options] - id of the container the gateway runs
 *   in; defaults to none, which is the host-networked deployment.
 */
async function withFakeDaemon(answer, work, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vh-docker-'));
  const socketPath = join(dir, 'daemon.sock');
  /** @type {{ method: string, path: string, body: string }[]} */
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const path = req.url ?? '/';
      const method = req.method ?? 'GET';
      calls.push({ method, path, body: Buffer.concat(chunks).toString('utf8') });
      const reply = answer(method, path.split('?')[0]);
      const text = JSON.stringify(reply.body ?? {});
      res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((resolve) => { server.listen(socketPath, () => { resolve(undefined); }); });
  const previous = process.env.VH_DOCKER_SOCK;
  const previousSelf = process.env.VH_SELF_CONTAINER;
  process.env.VH_DOCKER_SOCK = socketPath;
  process.env.VH_SELF_CONTAINER = options.self ?? '';
  try {
    await work({ calls });
  } finally {
    if (previous === undefined) delete process.env.VH_DOCKER_SOCK;
    else process.env.VH_DOCKER_SOCK = previous;
    if (previousSelf === undefined) delete process.env.VH_SELF_CONTAINER;
    else process.env.VH_SELF_CONTAINER = previousSelf;
    await new Promise((resolve) => { server.close(() => { resolve(undefined); }); });
    await rm(dir, { recursive: true, force: true });
  }
}

describe('published ports reaching the panel', () => {
  /** Two tenants, one shared host, as the daemon would report it. */
  const hosted = [
    { Names: ['/vh-alice-web'], State: 'running', Created: 2, Ports: [{ IP: '127.0.0.1', PrivatePort: 80, PublicPort: 20_000, Type: 'tcp' }] },
    { Names: ['/vh-bob-web'], State: 'running', Created: 3, Ports: [{ IP: '127.0.0.1', PrivatePort: 80, PublicPort: 21_000, Type: 'tcp' }] },
    { Names: ['/vh-alice-wide'], State: 'running', Created: 1, Ports: [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 20_001, Type: 'tcp' }] },
    { Names: ['/vh-alice-dns'], State: 'running', Created: 1, Ports: [{ IP: '127.0.0.1', PrivatePort: 53, PublicPort: 20_002, Type: 'udp' }] },
  ];

  it('resolves either side of the port mapping', async () => {
    await withFakeDaemon(() => ({ status: 200, body: hosted }), async () => {
      assert.deepEqual(await resolveContainerPort('alice', 80), { host: '127.0.0.1', port: 20_000 });
      assert.deepEqual(await resolveContainerPort('alice', 20_000), { host: '127.0.0.1', port: 20_000 });
    });
  });

  it('keeps the port the agent asked for reachable', async () => {
    const aliased = [{
      Names: ['/vh-alice-web'],
      State: 'running',
      Created: 5,
      Ports: [{ IP: '127.0.0.1', PrivatePort: 80, PublicPort: 20_000, Type: 'tcp' }],
      Labels: { 'vh.requested-port.80': '8080' },
    }];
    await withFakeDaemon(() => ({ status: 200, body: aliased }), async () => {
      assert.deepEqual(await resolveContainerPort('alice', 8080), { host: '127.0.0.1', port: 20_000 });
      assert.equal(await resolveContainerPort('alice', 9090), undefined);
    });
  });

  it('ignores another tenant, a non-loopback publish and udp', async () => {
    await withFakeDaemon(() => ({ status: 200, body: hosted }), async () => {
      assert.equal(await resolveContainerPort('alice', 21_000), undefined);
      assert.equal(await resolveContainerPort('alice', 3000), undefined);
      assert.equal(await resolveContainerPort('alice', 53), undefined);
      assert.equal(await resolveContainerPort('carol', 80), undefined);
    });
  });

  it('returns nothing when the daemon does not answer', async () => {
    await withFakeDaemon(() => ({ status: 500, body: {} }), async () => {
      assert.equal(await resolveContainerPort('alice', 80), undefined);
    });
  });

  it('prepares the network once and reserves a free host port', async () => {
    const carol = { subject: 'sub-3', account: 'carol', uid: 1003, home: '/data/carol' };
    const [lo] = portRange(carol);
    await withFakeDaemon((method, path) => {
      if (path === '/containers/json') {
        return {
          status: 200,
          body: [{ Names: ['/vh-carol-web'], Ports: [{ IP: '127.0.0.1', PrivatePort: 80, PublicPort: lo, Type: 'tcp' }] }],
        };
      }
      if (path === '/networks/create') return { status: 201, body: { Id: 'net-1' } };
      return { status: 404, body: {} };
    }, async ({ calls }) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await prepareContainerCreate(carol, {
          HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '' }] } },
        });
        assert.equal(result.error, undefined);
        const host = /** @type {any} */ (result.body).HostConfig;
        assert.equal(host.NetworkMode, 'vh-carol-default');
        assert.equal(host.PortBindings['80/tcp'][0].HostPort, String(lo + 1));
        assert.equal(host.PortBindings['80/tcp'][0].HostIp, '127.0.0.1');
      }
      const created = calls.filter((call) => call.path === '/networks/create');
      assert.equal(created.length, 1, 'the network is created once');
      assert.equal(JSON.parse(created[0].body).Name, 'vh-carol-default');
    });
  });

  it('dials the container address when the gateway runs in a container', async () => {
    const inContainer = [{
      Names: ['/vh-alice-web'],
      State: 'running',
      Created: 5,
      Ports: [{ IP: '127.0.0.1', PrivatePort: 80, PublicPort: 20_000, Type: 'tcp' }],
      NetworkSettings: { Networks: { 'vh-alice-default': { IPAddress: '172.30.0.7' } } },
    }];
    const joins = [];
    await withFakeDaemon((method, path) => {
      if (path === '/containers/json') return { status: 200, body: inContainer };
      if (path.startsWith('/networks/') && path.endsWith('/connect')) {
        joins.push(path);
        return { status: 204 };
      }
      return { status: 404, body: {} };
    }, async () => {
      assert.deepEqual(await resolveContainerPort('alice', 80), { host: '172.30.0.7', port: 80 });
      assert.deepEqual(await resolveContainerPort('alice', 20_000), { host: '172.30.0.7', port: 80 });
      assert.equal(joins.length, 1, 'the gateway joins the tenant network once');
    }, { self: 'abcdef123456' });
  });
});

describe('published port aliases', () => {
  it('records the port the agent asked for beside the allocated one', () => {
    const [lo] = portRange(tenant);
    const result = mutateContainerCreate(tenant, {
      Image: 'node:22',
      HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8080' }] } },
    });
    const body = /** @type {any} */ (result.body);
    assert.equal(body.HostConfig.PortBindings['80/tcp'][0].HostPort, String(lo));
    assert.equal(body.Labels['vh.requested-port.80'], '8080');
  });

  it('replaces a label the tenant wrote itself', () => {
    const result = mutateContainerCreate(tenant, {
      Image: 'node:22',
      Labels: { 'vh.requested-port.80': '9', keep: 'me' },
      HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8080' }] } },
    });
    const body = /** @type {any} */ (result.body);
    assert.equal(body.Labels['vh.requested-port.80'], '8080');
    assert.equal(body.Labels.keep, 'me');
  });

  it('adds no label when the publish already fits the tenant range', () => {
    const [lo] = portRange(tenant);
    const result = mutateContainerCreate(tenant, {
      Image: 'node:22',
      HostConfig: { PortBindings: { '80/tcp': [{ HostPort: String(lo) }] } },
    });
    assert.equal(/** @type {any} */ (result.body).Labels, undefined);
  });
});

describe('container references in the path', () => {
  it('prefixes the name the CLI passes in the path', async () => {
    assert.deepEqual(await namespaceContainerPath(tenant, '/containers/web/json'), { path: '/containers/vh-alice-web/json' });
    assert.deepEqual(await namespaceContainerPath(tenant, '/containers/web/start'), { path: '/containers/vh-alice-web/start' });
    assert.deepEqual(await namespaceContainerPath(tenant, '/containers/web/logs?stdout=1'), { path: '/containers/vh-alice-web/logs?stdout=1' });
    assert.deepEqual(await namespaceContainerPath(tenant, '/containers/vh-alice-web/json'), { path: '/containers/vh-alice-web/json' });
    assert.deepEqual(await namespaceContainerPath(tenant, '/containers/json?all=1'), { path: '/containers/json?all=1' });
  });

  it('prefixes the name the CLI passes on create', async () => {
    assert.deepEqual(await namespaceContainerPath(tenant, '/containers/create?name=web'), { path: '/containers/create?name=vh-alice-web' });
    const named = await namespaceContainerPath(tenant, '/containers/create');
    assert.match(String(named.path), /^\/containers\/create\?name=vh-alice-[0-9a-f]{12}$/);
    assert.match(
      String((await namespaceContainerPath(tenant, '/containers/create?name=vh-bob-web')).error),
      /not yours/,
    );
  });

  it('refuses another tenant by name', async () => {
    assert.match(String((await namespaceContainerPath(tenant, '/containers/vh-bob-web/json')).error), /not yours/);
  });

  it('accepts only ids of this tenant containers', async () => {
    const listed = [
      { Names: ['/vh-alice-web'], Id: 'aaaa1111bbbb2222', State: 'running' },
      { Names: ['/vh-bob-web'], Id: 'cccc3333dddd4444', State: 'running' },
    ];
    await withFakeDaemon((method, path) => {
      if (path === '/containers/json') return { status: 200, body: listed };
      return { status: 404, body: {} };
    }, async () => {
      assert.deepEqual(
        await namespaceContainerPath(tenant, '/containers/aaaa1111bbbb2222/json'),
        { path: '/containers/aaaa1111bbbb2222/json' },
      );
      assert.match(
        String((await namespaceContainerPath(tenant, '/containers/cccc3333dddd4444/json')).error),
        /not yours/,
      );
    });
  });
});

/**
 * Send one plain HTTP request to the capability under test.
 * @param {number} port
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string }} spec
 * @returns {Promise<{ status: number, body: string }>}
 */
function ask(port, spec) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: spec.method ?? 'GET',
      path: spec.path,
      headers: spec.headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, body: raw.toString('utf8'), raw });
      });
    });
    req.on('error', reject);
    req.end(spec.body);
  });
}

describe('allowed requests are relayed as bytes', () => {
  it('keeps the exec body and the daemon answer verbatim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vh-relay-'));
    const daemonSocket = join(dir, 'daemon.sock');
    /** @type {Array<{ path: string | undefined, body: string }>} */
    const seen = [];
    const daemon = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => { chunks.push(chunk); });
      req.on('end', () => {
        seen.push({ path: req.url, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' });
        res.end('hello\n');
      });
    });
    await new Promise((resolve) => { daemon.listen(daemonSocket, () => { resolve(undefined); }); });

    const previous = process.env.VH_DOCKER_SOCK;
    process.env.VH_DOCKER_SOCK = daemonSocket;
    const gateway = createServer((req, res) => { void handleTenantRequest(tenant, req, res); });
    await new Promise((resolve) => { gateway.listen(0, '127.0.0.1', () => { resolve(undefined); }); });
    const { port } = /** @type {import('node:net').AddressInfo} */ (gateway.address());

    try {
      const exec = await ask(port, {
        method: 'POST',
        path: '/v1.43/containers/web/exec',
        headers: { 'content-type': 'application/json' },
        body: '{"Cmd":["echo","hello"]}',
      });
      assert.equal(exec.status, 200);
      assert.equal(exec.body, 'hello\n', 'the stream is passed through, not JSON-wrapped');
      assert.equal(seen[0]?.path, '/containers/vh-alice-web/exec', 'the name is still namespaced');
      assert.equal(seen[0]?.body, '{"Cmd":["echo","hello"]}', 'the body reaches the daemon');

      const refused = await ask(port, {
        method: 'POST',
        path: '/v1.43/containers/web/attach',
        headers: { connection: 'Upgrade', upgrade: 'tcp' },
      });
      assert.equal(refused.status, 501);
      assert.match(refused.body, /interactive connections/);
    } finally {
      if (previous === undefined) delete process.env.VH_DOCKER_SOCK;
      else process.env.VH_DOCKER_SOCK = previous;
      await new Promise((resolve) => { gateway.close(() => { resolve(undefined); }); });
      await new Promise((resolve) => { daemon.close(() => { resolve(undefined); }); });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('relays a container archive as opaque bytes in both directions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vh-archive-'));
    const daemonSocket = join(dir, 'daemon.sock');
    /** @type {Array<{ method: string, path: string | undefined, body: Buffer }>} */
    const seen = [];
    // A gzip header plus NUL and 0xff: not valid UTF-8, and JSON would mangle it.
    const tar = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0xff, 0x00, 0x61, 0x62]);
    const daemon = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => { chunks.push(chunk); });
      req.on('end', () => {
        seen.push({ method: req.method ?? '', path: req.url, body: Buffer.concat(chunks) });
        if (req.method === 'PUT') {
          res.writeHead(200);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/x-tar' });
        res.end(tar);
      });
    });
    await new Promise((resolve) => { daemon.listen(daemonSocket, () => { resolve(undefined); }); });

    const previous = process.env.VH_DOCKER_SOCK;
    process.env.VH_DOCKER_SOCK = daemonSocket;
    const gateway = createServer((req, res) => { void handleTenantRequest(tenant, req, res); });
    await new Promise((resolve) => { gateway.listen(0, '127.0.0.1', () => { resolve(undefined); }); });
    const { port } = /** @type {import('node:net').AddressInfo} */ (gateway.address());

    try {
      const put = await ask(port, {
        method: 'PUT',
        path: '/v1.43/containers/web/archive?path=/tmp',
        headers: { 'content-type': 'application/x-tar' },
        body: tar,
      });
      assert.equal(put.status, 200);
      assert.equal(seen[0]?.method, 'PUT');
      assert.equal(seen[0]?.path, '/containers/vh-alice-web/archive?path=/tmp', 'the name is namespaced, the query kept');
      assert.ok(seen[0]?.body.equals(tar), 'the tar bytes reach the daemon unchanged');

      const get = await ask(port, { path: '/v1.43/containers/web/archive?path=/etc/hosts' });
      assert.equal(get.status, 200);
      assert.ok(get.raw.equals(tar), 'the tar bytes come back unchanged');

      const refused = await ask(port, { method: 'DELETE', path: '/v1.43/containers/web/archive?path=/tmp' });
      assert.equal(refused.status, 403);
      assert.match(refused.body, /method not allowed/);
    } finally {
      if (previous === undefined) delete process.env.VH_DOCKER_SOCK;
      else process.env.VH_DOCKER_SOCK = previous;
      await new Promise((resolve) => { gateway.close(() => { resolve(undefined); }); });
      await new Promise((resolve) => { daemon.close(() => { resolve(undefined); }); });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe('tenant network addressing', () => {
  it('pins each tenant to its own /24 inside the configured pool', () => {
    assert.equal(tenantSubnet({ ...tenant, uid: 20000 }), '10.240.189.0/24');
    assert.equal(tenantSubnet({ ...tenant, uid: 20001 }), '10.240.190.0/24');
  });

  it('keeps the address stable for the same uid', () => {
    assert.equal(tenantSubnet({ ...tenant, uid: 20000 }), tenantSubnet({ ...tenant, uid: 20000 }));
  });

  it('namespaces a network without an address block', () => {
    const created = mutateNamedObject(tenant, '/networks/create', { Name: 'web', Driver: 'bridge' });
    assert.equal(created.error, undefined);
    assert.equal(created.body?.Name, 'vh-alice-web');
  });

  it('refuses a caller-chosen subnet', () => {
    const created = mutateNamedObject(tenant, '/networks/create', {
      Name: 'web',
      IPAM: { Driver: 'default', Config: [{ Subnet: '10.0.0.0/24' }] },
    });
    assert.match(String(created.error), /网段/);
  });

  it('refuses a gateway or range without a subnet', () => {
    for (const config of [{ Gateway: '10.0.0.1' }, { IPRange: '10.0.0.0/25' }]) {
      const created = mutateNamedObject(tenant, '/networks/create', { Name: 'web', IPAM: { Config: [config] } });
      assert.match(String(created.error), /网段/);
    }
  });

  it('still namespaces a volume create', () => {
    const created = mutateNamedObject(tenant, '/volumes/create', { Name: 'data' });
    assert.equal(created.body?.Name, 'vh-alice-data');
  });
});
