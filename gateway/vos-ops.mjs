// VOS operations. The Agent transport is read-only; writes require browser
// confirmation. No route accepts caller-supplied Docker API paths.
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';

export const OPS_PATH = '/__vh/vos-ops';
const APP_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const ACTIONS = new Set(['restart', 'stop-container', 'remove-container', 'remove-image']);

class OpsError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

const denied = () => new OpsError(403, 'forbidden');
const stale = () => new OpsError(409, 'target-changed');
const bounded = (value, size = 2000) => typeof value === 'string' ? value.slice(0, size) : '';

function engine(method, path, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const requestOptions = { method, path, socketPath: process.env.VH_DOCKER_SOCK ?? '/var/run/docker.sock',
      signal: AbortSignal.timeout(method === 'POST' ? 35000 : 8000) };
    const req = request(requestOptions, res => {
      const status = res.statusCode;
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new OpsError(status === 404 ? 404 : [304, 409].includes(status) ? 409 : 502,
          status === 404 ? 'not-found' : [304, 409].includes(status) ? 'target-changed' : 'docker-unavailable'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > limit) res.destroy(new OpsError(502, 'response-too-large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

async function dockerJson(path) {
  return JSON.parse(await engine('GET', path));
}

async function vos(token, path, body, base) {
  const res = await fetch(new URL(path, base), {
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}) },
    method: body ? 'POST' : 'GET',
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const response = await res.json();
  if (res.status === 401 || response.code === 10001) throw new OpsError(401, 'sign-in-required');
  if (res.status === 403 || response.code === 10002) throw denied();
  if (response.code === 10067) throw new OpsError(404, 'not-found');
  if (response.code === 10068) throw stale();
  if (!res.ok || response.code !== 0 || !response.data) throw new OpsError(502, 'vos-request-failed');
  return response.data;
}

function mainStack(container) {
  const labels = container.Labels ?? {};
  if (labels['io.vos.platform.managed'] !== 'true' || labels['io.vos.platform.kind'] !== 'app') return null;
  const project = labels['com.docker.compose.project'];
  if (!/^vos-app-[a-z0-9_-]+-[0-9a-hjkmnp-tv-z]{26}$/.test(project ?? '')) return null;
  const ordinal = labels['com.docker.compose.container-number'];
  const service = labels['com.docker.compose.service'];
  if (!/^[1-9][0-9]*$/.test(ordinal ?? '') || !/^[a-z0-9][a-z0-9_.-]*$/i.test(service ?? '') ||
      !(container.Names ?? []).some(name => name === `/${project}-${service}-${ordinal}`)) return null;
  const config = labels['com.docker.compose.project.config_files'];
  const match = /\/apps\/([a-z0-9][a-z0-9._-]{0,127})\/([a-zA-Z0-9.+-]+)\/rendered\/docker-compose\.yml$/.exec(config ?? '');
  if (!match || !project.startsWith(`vos-app-${match[1].toLowerCase().replace(/\./g, '-')}-`)) return null;
  return { appId: match[1], version: match[2], project };
}

function summarizeContainer(c, apps) {
  const stack = mainStack(c);
  const app = stack ? apps.find(a => a.appId === stack.appId) : undefined;
  const retired = Boolean(app && ['installed', 'stopped'].includes(app.state) && app.version !== stack.version);
  return {
    id: c.Id, name: bounded(c.Names?.[0]?.replace(/^\//, ''), 200), image: bounded(c.Image, 300),
    imageId: c.ImageID, state: bounded(c.State, 40), status: bounded(c.Status, 300), stack,
    ports: (c.Ports ?? []).filter(p => p.PublicPort).map(p => ({
      hostPort: p.PublicPort, containerPort: p.PrivatePort, protocol: p.Type, address: p.IP ?? '',
    })),
    stoppable: retired && stack.appId !== 'com.ictrek.v-harness' && ['running', 'restarting'].includes(c.State),
    cleanup: retired && c.State === 'exited',
  };
}

function candidates(images, containers) {
  const inUse = new Set(containers.map(c => c.ImageID));
  return images.filter(i => IMAGE_ID.test(i.Id) && !inUse.has(i.Id)
    && (i.RepoTags ?? []).every(t => t === '<none>:<none>')
    && (i.RepoDigests ?? []).every(t => t === '<none>@<none>'))
    .map(i => ({ id: i.Id, created: i.Created, bytes: i.Size }));
}

function logText(data) {
  // Non-TTY Docker streams prepend an eight-byte header to each frame.
  if (data.length < 8 || ![1, 2].includes(data[0]) || data[1] || data[2] || data[3]) {
    return data.toString('utf8');
  }
  const lines = [];
  for (let offset = 0; offset + 8 <= data.length;) {
    const end = offset + 8 + data.readUInt32BE(offset + 4);
    if (end > data.length || ![1, 2].includes(data[offset])) throw new OpsError(502, 'docker-unavailable');
    lines.push(data.subarray(offset + 8, end).toString('utf8'));
    offset = end;
  }
  return lines.join('');
}

export function createVosOps({ sessionFor, tokenFor, agentSessionAllowed = async () => false, userinfoUrl, readBody, respond, daemon = dockerJson,
  daemonCall = engine, platform = vos, now = Date.now, audit = console.info }) {
  const grants = new Map();
  const proposals = new Map();
  const grantTtl = 15 * 60 * 1000;

  async function inventory(token, base) {
    const listing = await platform(token, '/v1000/app/list', undefined, base);
    if (!Array.isArray(listing.data) || listing.total !== listing.data.length ||
        listing.data.some(a => !APP_ID.test(a?.app_id ?? '') || typeof a.installed_app_id !== 'string' ||
          typeof a.version !== 'string' || typeof a.state !== 'string')) {
      throw new OpsError(502, 'vos-request-failed');
    }
    return listing.data.map(a => ({
      appId: a.app_id, installationId: a.installed_app_id, version: a.version,
      state: a.state, lastError: bounded(a.last_error),
    }));
  }

  async function target(action, id, token, base) {
    if (action === 'restart' && APP_ID.test(id)) {
      const a = (await inventory(token, base)).find(a => a.appId === id);
      if (!a || a.state !== 'installed' || id === 'com.ictrek.v-harness') throw stale();
      return a;
    }
    if (['stop-container', 'remove-container'].includes(action) && CONTAINER_ID.test(id)) {
      const apps = await inventory(token, base);
      const containers = await daemon('/containers/json?all=1');
      const c = containers.find(c => c.Id === id);
      const item = c && summarizeContainer(c, apps);
      if (action === 'stop-container') {
        if (!item?.stoppable) throw stale();
        const app = apps.find(a => a.appId === item.stack.appId);
        return { id: item.id, name: item.name, image: item.image, imageId: item.imageId, stack: item.stack,
          ports: item.ports, installedVersion: app.version, installationId: app.installationId };
      }
      if (!item?.cleanup || item.stack.appId === 'com.ictrek.v-harness') throw stale();
      return item;
    }
    if (action === 'remove-image' && IMAGE_ID.test(id)) {
      const [containers, images] = await Promise.all([daemon('/containers/json?all=1'), daemon('/images/json?all=1')]);
      const item = candidates(images, containers).find(i => i.id === id);
      if (!item) throw stale();
      return item;
    }
    throw new OpsError(400, 'invalid-target');
  }

  async function execute(pending, token, base, session, stillAllowed, res) {
    const { action, id, item } = pending;
    const latestPermissions = await platform(token, '/v1000/rbac/permission/my', undefined, base);
    if (latestPermissions.is_super_admin !== true) throw denied();
    if (!await stillAllowed()) throw stale();
    const current = await target(action, id, token, base);
    if (JSON.stringify(current) !== JSON.stringify(item)) throw stale();
    audit('VOS ops attempt', JSON.stringify({ subject: session.subject, action, id }));
    let taskId = null;
    if (action === 'restart') {
      const task = await platform(token, '/v1000/app/restart_async', { app_id: id }, base);
      taskId = task.task_id;
    } else if (action === 'stop-container') {
      await daemonCall('POST', `/containers/${id}/stop?t=30`);
    } else if (action === 'remove-container') {
      await daemonCall('DELETE', `/containers/${id}?force=0&v=0`);
    } else {
      await daemonCall('DELETE', `/images/${id}?force=0&noprune=1`);
    }
    audit('VOS ops accepted', JSON.stringify({ subject: session.subject, action, id, taskId }));
    respond(res, 200, { action, id, taskId });
  }

  async function handle(req, res, url, agent) {
    const path = url.pathname.slice(OPS_PATH.length);
    try {
      // All requests carry a non-simple header. This route never enables CORS.
      if (!agent && (req.headers['x-vh-ops'] !== '1' ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))) throw denied();
      if (agent && !((req.method === 'GET' && ['/inventory', '/status', '/logs'].includes(path)) ||
          (req.method === 'POST' && path === '/proposal'))) throw denied();
      const session = agent?.session ?? sessionFor(req);
      if (!session) throw new OpsError(401, 'sign-in-required');
      const sessionScoped = agent || path === '/proposal' || path === '/confirm-proposal';
      const sessionId = agent?.sessionId ?? url.searchParams.get('sessionId');
      if (sessionScoped && (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId ?? '') ||
          !await agentSessionAllowed(session.subject, sessionId))) throw denied();
      const token = await tokenFor(session);
      if (!token) throw new OpsError(401, 'sign-in-required');
      const base = userinfoUrl();
      const permissions = await platform(token, '/v1000/rbac/permission/my', undefined, base);
      if (permissions.is_super_admin !== true) throw denied();
      const { sid } = session;
      const grantKey = req.headers['x-vh-ops-grant'];
      const grant = grants.get(grantKey);
      if (path === '/authorize' && req.method === 'POST') {
        for (const [key, value] of grants) if (value.expires <= now() || value.sid === sid) grants.delete(key);
        if (grants.size >= 128) throw new OpsError(429, 'too-many-grants');
        const key = randomBytes(32).toString('hex');
        grants.set(key, { sid, expires: now() + grantTtl });
        respond(res, 200, { grant: key, expiresIn: grantTtl / 1000 });
        return;
      }
      if (sessionScoped) {
        const key = JSON.stringify([session.subject, sessionId]);
        if (path === '/proposal' && agent) {
          const { action, id } = await readBody(req).catch(() => { throw new OpsError(400, 'invalid-body'); });
          if (!ACTIONS.has(action) || typeof id !== 'string') throw new OpsError(400, 'invalid-target');
          for (const [k, p] of proposals) if (p.expires <= now()) proposals.delete(k);
          if (proposals.has(key)) throw new OpsError(409, 'confirmation-pending');
          if (proposals.size >= 128) throw new OpsError(429, 'too-many-grants');
          const item = await target(action, id, token, base);
          if (proposals.has(key)) throw new OpsError(409, 'confirmation-pending');
          proposals.set(key, { action, id, item, confirmation: randomBytes(32).toString('hex'), expires: now() + 120000 });
          respond(res, 200, { action, id, pending: true, expiresIn: 120 });
          return;
        }
        if (!agent && path === '/proposal' && req.method === 'GET') {
          const p = proposals.get(key);
          respond(res, 200, { proposal: p && p.expires > now()
            ? { action: p.action, targetId: p.id, target: p.item, confirmation: p.confirmation } : null });
          return;
        }
        if (!agent && path === '/confirm-proposal' && req.method === 'POST') {
          const { confirmation, targetId, approved } = await readBody(req).catch(() => { throw new OpsError(400, 'invalid-body'); });
          const p = proposals.get(key);
          if (!p || p.confirmation !== confirmation || p.expires <= now()) throw stale();
          if (approved !== true && approved !== false) throw new OpsError(400, 'invalid-body');
          if (approved && targetId !== p.id) throw new OpsError(400, 'confirmation-mismatch');
          proposals.delete(key);
          if (!approved) { respond(res, 200, { cancelled: true }); return; }
          await execute(p, token, base, session, () => sessionFor(req)?.sid === sid &&
            agentSessionAllowed(session.subject, sessionId), res);
          return;
        }
        if (!agent) throw denied();
      } else if (!grant || grant.expires <= now() || grant.sid !== sid) throw denied();

      if (path === '/inventory' && req.method === 'GET') {
        const [apps, containers, images] = await Promise.all([
          inventory(token, base), daemon('/containers/json?all=1'), daemon('/images/json?all=1'),
        ]);
        const imageReferences = new Set(containers.map(c => c.ImageID));
        const rows = containers.map(c => summarizeContainer(c, apps));
        respond(res, 200, {
          apps, containers: rows.filter(c => c.stack && CONTAINER_ID.test(c.id)),
          publishedPorts: rows.flatMap(c => c.ports.map(p => ({ ...p, container: c.name, appId: c.stack?.appId ?? null }))),
          unusedImages: candidates(images, containers),
          unreferencedTaggedImages: images.filter(i => IMAGE_ID.test(i.Id) &&
            !imageReferences.has(i.Id) && (i.RepoTags ?? []).some(t => t !== '<none>:<none>'))
            .map(i => ({ id: i.Id, tags: i.RepoTags, bytes: i.Size })),

        });
        return;
      }
      if (path === '/close' && req.method === 'POST') {
        grants.delete(grantKey);
        respond(res, 200, { closed: true });
        return;
      }
      if (path === '/status' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!APP_ID.test(id ?? '')) throw new OpsError(400, 'invalid-target');
        const app = await platform(token, '/v1000/app/status?' + new URLSearchParams({ app_id: id }), undefined, base);
        const workflow = app.workflow;
        respond(res, 200, {
          appId: app.app_id, version: app.version, state: app.state, lastError: bounded(app.last_error),
          workflow: workflow ? { taskId: workflow.task_id, status: workflow.status,
            stage: workflow.current_stage ?? null, failure: bounded(workflow.failure?.message) } : null,
        });
        return;
      }
      if (path === '/logs' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!CONTAINER_ID.test(id ?? '')) throw new OpsError(400, 'invalid-target');
        const [containers, apps] = await Promise.all([daemon('/containers/json?all=1'), inventory(token, base)]);
        const c = containers.find(c => c.Id === id);
        const stack = c && mainStack(c);
        if (!stack || !apps.some(a => a.appId === stack.appId)) throw new OpsError(404, 'not-found');
        const data = await daemonCall('GET', `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=150`, 512 * 1024);
        respond(res, 200, { id, text: logText(data) });
        return;
      }
      if (path === '/preview' && req.method === 'POST') {
        const { action, id } = await readBody(req).catch(() => { throw new OpsError(400, 'invalid-body'); });
        if (!ACTIONS.has(action) || typeof id !== 'string') throw new OpsError(400, 'invalid-target');
        const item = await target(action, id, token, base);
        const confirmation = randomBytes(32).toString('hex');
        grant.pending = { action, id, item, confirmation, expires: now() + 60000 };
        respond(res, 200, { confirmation, expiresIn: 60, action, targetId: id, target: item });
        return;
      }
      if (path === '/execute' && req.method === 'POST') {
        const { confirmation, targetId } = await readBody(req).catch(() => { throw new OpsError(400, 'invalid-body'); });
        const pending = grant.pending;
        if (!pending || pending.confirmation !== confirmation || pending.expires <= now()) throw stale();
        if (targetId !== pending.id) throw new OpsError(400, 'confirmation-mismatch');
        delete grant.pending;
        await execute(pending, token, base, session, () => grants.get(grantKey) === grant &&
          grant.expires > now() && sessionFor(req)?.sid === sid, res);
        return;
      }
      respond(res, 404, { error: 'not-found' });
    } catch (error) {
      const status = error instanceof OpsError ? error.status : 502;
      respond(res, status, { error: error instanceof OpsError ? error.message : 'upstream-unavailable' });
    }
  }
  return handle;
}
