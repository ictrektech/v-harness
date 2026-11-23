// VOS operations. The Agent transport is read-only; writes require browser
// confirmation. No route accepts caller-supplied Docker API paths. Host
// management reaches only containers of VOS application stacks, never the
// database, model or unrelated containers that share the host. Log reads are
// windowed and filtered server-side; /diagnose answers inspect facts plus an
// error-line summary instead of raw logs.
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { hostname } from 'node:os';

export const OPS_PATH = '/__vh/vos-ops';
const APP_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const HOST_ACTIONS = new Map([
  ['host-start', ['created', 'exited']],
  ['host-stop', ['running', 'restarting']],
  ['host-restart', ['running', 'restarting']],
  ['host-remove', ['created', 'exited', 'dead']],
]);
const CLEANUP_ACTIONS = new Set(['remove-container', 'host-remove', 'remove-image']);
const MAX_CLEANUP_TARGETS = 20;
const ACTIONS = new Set(['restart', 'stop-container', 'remove-container', 'remove-image',
  'backend-start', 'backend-stop', 'node-rescan', 'node-drain', 'node-undrain', 'node-revoke']);
const LOG_QUERY = 'stdout=1&stderr=1&timestamps=1&tail=';
const LOG_DEFAULT_TAIL = 150;
const LOG_SCAN_TAIL = 1000;
const LOG_MAX_RECORDS = 300;
const LOG_MAX_CONTEXT = 50;
const LOG_BYTES = 1024 * 1024;
const LOG_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;
const LOG_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// Cursor values echo a Docker stamp, so only the Z form is accepted and padded
// comparisons stay valid across RFC3339Nano's trimmed trailing zeros.
const LOG_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const LOG_SPAN = /^(\d{1,8})(ms|s|m|h|d)$/;
const LOG_SPAN_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
const PATTERN_MAX = 200;
const DIAGNOSE_TAIL = 2000;
const DIAGNOSE_ERROR_GROUPS = 40;
const DIAGNOSE_ERROR_SAMPLE = 300;
const DIAGNOSE_HEALTH_OUTPUT = 500;
const ERROR_LINE = /\b(?:error|fatal|panic|exception|traceback|failed|failure)\b/i;
// V-Scheduler owns every cross-machine fact: the machines themselves, the VOS
// applications each one runs, and the compute backends it deploys onto them.
// This gateway reads those registers and never dials another machine itself.
const SCHEDULER_NODES = '/scheduler/api/v1/nodes';
const SCHEDULER_MANAGED_NODES = '/scheduler/api/v1/managed-nodes';
const SCHEDULER_BACKENDS = '/scheduler/api/v1/backend-deployments';
const SCHEDULER_ORIGIN = process.env.V_SCHEDULER_URL ?? 'http://v-scheduler:8080';
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const BACKEND_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LOCAL_NODE = 'local';
const NODE_APPS_LIMIT = 400;
const NODE_ACTIONS = new Set(['node-rescan', 'node-drain', 'node-undrain', 'node-revoke']);
// Scheduler treats a node without a heartbeat inside 12 seconds as offline and
// a telemetry report older than 30 seconds as stale (backend/src/controller.rs).
const NODE_HEARTBEAT_MS = 12_000;
const NODE_REPORT_MS = 30_000;
// `ApplicationBackendList` answers the newest 200 records and exposes no total,
// so a full page is the only truncation signal the scheduler gives.
const BACKEND_LIMIT = 200;
// `POST /backend-deployments/{id}/start` accepts a stopped or failed backend;
// stop also retries a cleanup that could not be confirmed, which is exactly the
// remote failure this panel exists to repair.
const BACKEND_STARTABLE = ['stopped', 'failed'];
const BACKEND_STOPPABLE = ['running', 'pending', 'cleanup_failed'];
// The last node list that succeeded, per VOS user; a failed read falls back to
// it instead of claiming every other machine disappeared.
const NODE_CACHE_LIMIT = 64;
const LOCAL_CAPABILITIES = ['inventory', 'status', 'logs', 'app-logs', 'diagnose', 'operations', 'apps', 'metrics'];

export class OpsError extends Error {
  constructor(status, code, detail = null) {
    super(code);
    this.status = status;
    this.detail = detail;
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

const HIDDEN_APP_IDS = new Set(['com.ictrek.v-harness']);

/**
 * A container host management may show and operate on: a VOS application stack
 * member that is not the harness itself. Database, model and unrelated host
 * containers carry no matching stack and stay invisible. A stack container left
 * behind by an uninstalled application keeps its labels, so cleanup still
 * reaches it without consulting the VOS application list.
 */
function visible(c) {
  const stack = mainStack(c);
  return stack !== null && !HIDDEN_APP_IDS.has(stack.appId);
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
    cleanup: retired && ['created', 'exited'].includes(c.State),
  };
}

function candidates(images, containers) {
  const inUse = new Set(containers.map(c => c.ImageID));
  return images.filter(i => IMAGE_ID.test(i.Id) && !inUse.has(i.Id)
    && (i.RepoTags ?? []).every(t => t === '<none>:<none>')
    && (i.RepoDigests ?? []).every(t => t === '<none>@<none>'))
    .map(i => ({ id: i.Id, created: i.Created, bytes: i.Size }));
}

function taggedImages(images, containers) {
  const inUse = new Set(containers.map(c => c.ImageID));
  return images.filter(i => IMAGE_ID.test(i.Id) && !inUse.has(i.Id))
    .map(i => ({ id: i.Id, tags: (i.RepoTags ?? []).filter(t => t !== '<none>:<none>').sort(),
      bytes: i.Size, digests: (i.RepoDigests ?? []).filter(d => d !== '<none>@<none>').sort() }))
    .filter(i => i.tags.length > 0);
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

/**
 * Docker timestamps mark log frames; a frame may carry several lines and only
 * its first line is stamped. Continuation lines fold into the previous record
 * so stack traces stay whole for filtering and context.
 */
function logRecords(data) {
  const records = [];
  let current = null;
  for (const line of logText(data).replace(/\n$/, '').split('\n')) {
    const match = LOG_TS.exec(line);
    if (match) {
      current = { ts: match[1], text: line.slice(match[1].length + 1) };
      records.push(current);
    } else if (current) current.text += '\n' + line;
    else if (line) {
      current = { ts: null, text: line };
      records.push(current);
    }
  }
  return records;
}

function logSince(value, nowMs, code) {
  if (value === null) return null;
  if (LOG_RFC3339.test(value) && !Number.isNaN(Date.parse(value))) {
    return { ms: Date.parse(value) };
  }
  const span = LOG_SPAN.exec(value);
  if (span) return { ms: nowMs - Number(span[1]) * LOG_SPAN_MS[span[2]] };
  throw new OpsError(400, code);
}

const logNano = ts => ts.replace(/(?:\.(\d+))?Z$/, (_, frac = '') => '.' + frac.padEnd(9, '0') + 'Z');

/**
 * Parses the shared log query: since/until (RFC 3339 or a span like 30m),
 * after (a Z-form RFC 3339 polling cursor), pattern (case-insensitive) and
 * context (records around each match). The time bounds go to Docker as unix
 * epoch seconds: this deployment's daemon parses logs since/until with
 * strconv.ParseInt and answers RFC 3339 with a 500. One second of slack on
 * each side over-fetches; the record-level filtering below stays exact. The
 * cursor is exclusive by stamp so polling resumes exactly after the last
 * record already seen. With any of them the Docker-side scan window widens
 * from the default tail.
 */
function logFilter(url, nowMs) {
  const since = logSince(url.searchParams.get('since'), nowMs, 'invalid-since');
  const until = logSince(url.searchParams.get('until'), nowMs, 'invalid-until');
  if (since && until && until.ms < since.ms) throw new OpsError(400, 'invalid-since');
  let after = null;
  const raw = url.searchParams.get('after');
  if (raw !== null) {
    if (raw.length > 40 || !LOG_CURSOR.test(raw) || Number.isNaN(Date.parse(raw))) {
      throw new OpsError(400, 'invalid-after');
    }
    after = raw;
  }
  if (after && since) throw new OpsError(400, 'invalid-after');
  if (after && until && until.ms < Date.parse(after)) throw new OpsError(400, 'invalid-after');
  let pattern = null;
  const patternRaw = url.searchParams.get('pattern');
  if (patternRaw !== null) {
    if (patternRaw.length < 1 || patternRaw.length > PATTERN_MAX) throw new OpsError(400, 'invalid-pattern');
    try { pattern = new RegExp(patternRaw, 'i'); } catch { throw new OpsError(400, 'invalid-pattern'); }
  }
  let context = 0;
  if (url.searchParams.has('context')) {
    context = Number(url.searchParams.get('context'));
    if (!Number.isInteger(context) || context < 0 || context > LOG_MAX_CONTEXT) throw new OpsError(400, 'invalid-context');
  }
  const epoch = (ms, slack) => String(Math.floor(ms / 1000) + slack);
  const lower = since ?? (after ? { ms: Date.parse(after) } : null);
  const query = LOG_QUERY + (lower || until || pattern ? LOG_SCAN_TAIL : LOG_DEFAULT_TAIL) +
    (lower ? '&since=' + epoch(lower.ms, -1) : '') +
    (until ? '&until=' + epoch(until.ms, 1) : '');
  return { since, until, after, cursor: after === null ? null : logNano(after), pattern, context, query };
}

/**
 * Applies the parsed filter to parsed records. Time filtering only drops
 * records with a parsable stamp, so unlabeled frames stay visible. The after
 * cursor is exclusive by padded stamp, so records at or before the cursor are
 * dropped even when Docker's since is inclusive at the boundary. Context
 * windows never cross the since/until boundary. Beyond LOG_MAX_RECORDS the
 * earliest records are returned and `truncated` reports the remainder.
 */
function filterRecords(records, filter) {
  const window = [];
  records.forEach((record, index) => {
    const ts = record.ts === null ? null : Date.parse(record.ts);
    if (filter.cursor !== null && record.ts !== null && logNano(record.ts) <= filter.cursor) return;
    if (ts !== null && !Number.isNaN(ts)) {
      if (filter.since && ts < filter.since.ms) return;
      if (filter.until && ts > filter.until.ms) return;
    }
    window.push(index);
  });
  const windowSet = new Set(window);
  const picked = new Set();
  for (const index of window) {
    if (filter.pattern === null || filter.pattern.test(records[index].text)) picked.add(index);
  }
  if (filter.pattern !== null && filter.context > 0) {
    for (const index of [...picked]) {
      for (let offset = index - filter.context; offset <= index + filter.context; offset++) {
        if (windowSet.has(offset)) picked.add(offset);
      }
    }
  }
  const selected = [...picked].sort((a, b) => a - b).map(index => records[index]);
  const truncated = selected.length > LOG_MAX_RECORDS;
  return { records: truncated ? selected.slice(0, LOG_MAX_RECORDS) : selected,
    truncated, scanned: records.length, window: window.length };
}

function logsPayload(id, result, filter) {
  const text = result.records.map(record => (record.ts ? record.ts + ' ' : '') + record.text).join('\n');
  const stamped = result.records.filter(record => record.ts !== null);
  // Polling resumes from the last returned stamp; without new records the
  // cursor stays where the caller left it so the next poll retries the gap.
  const next = stamped.at(-1)?.ts ?? filter.after ?? null;
  return { id, text, truncated: result.truncated, scanned: result.scanned,
    returned: result.records.length, first: stamped[0]?.ts ?? null, last: stamped.at(-1)?.ts ?? null, next };
}

/**
 * Merges every stack member's parsed records into one timeline ordered by
 * padded Docker stamps, tagging each record with its container name. Unstamped
 * leading records travel with the container's first stamp so they stay next to
 * the records they precede on their own stream.
 */
function appLogsPayload(appId, sources, filter) {
  const rows = [];
  for (const { name, records } of sources) {
    let anchor = '';
    for (const record of records) {
      if (record.ts !== null) anchor = logNano(record.ts);
      rows.push({ ts: record.ts, text: record.text, name, anchor });
    }
  }
  rows.sort((a, b) => a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0);
  const result = filterRecords(rows, filter);
  const text = result.records
    .map(row => (row.ts ? row.ts + ' ' : '') + `[${row.name}] ${row.text}`).join('\n');
  const stamped = result.records.filter(row => row.ts !== null);
  const next = stamped.at(-1)?.ts ?? filter.after ?? null;
  return { appId, containers: sources.map(source => source.name), text,
    truncated: result.truncated, scanned: result.scanned, returned: result.records.length,
    first: stamped[0]?.ts ?? null, last: stamped.at(-1)?.ts ?? null, next };
}

/**
 * Collapses repeated error lines into one entry with a count and span so a
 * recurring exception costs one row instead of hundreds.
 */
function errorGroups(records) {
  const groups = new Map();
  for (const record of records) {
    if (!ERROR_LINE.test(record.text)) continue;
    const key = record.text.replace(/\s+/g, ' ').trim().slice(0, 120);
    const entry = groups.get(key) ?? { count: 0, first: null, last: null, sample: '' };
    entry.count++;
    if (record.ts !== null) {
      if (entry.first === null || record.ts < entry.first) entry.first = record.ts;
      if (entry.last === null || record.ts > entry.last) entry.last = record.ts;
    }
    if (!entry.sample) entry.sample = bounded(record.text, DIAGNOSE_ERROR_SAMPLE);
    groups.set(key, entry);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, DIAGNOSE_ERROR_GROUPS);
}

/**
 * One authenticated call against V-Scheduler's v1 API.
 *
 * The scheduler answers `Envelope { code, data }`; anything else means the
 * caller is not the administrator those routes require, or the scheduler is
 * unavailable. The three refusals stay distinct so a caller can tell a missing
 * role from an unreachable scheduler and never reports one as the other.
 * Callers decide whether that degrades to this machine instead of failing.
 */
async function schedulerCall(token, path, body) {
  const response = await fetch(new URL(path, SCHEDULER_ORIGIN), {
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}) },
    method: body ? 'POST' : 'GET',
    body: body ? JSON.stringify(body) : undefined,
    // A start or stop waits for the scheduler's own reconcile step, so it gets
    // the longer bound; reads answer from its database.
    signal: AbortSignal.timeout(body ? 20000 : 8000),
  }).catch(error => {
    throw new OpsError(502, 'scheduler-unavailable', bounded(error?.cause?.code ?? error?.message, 120) || null);
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 401) throw new OpsError(401, 'sign-in-required');
  // A 403 is the scheduler saying this account is not its administrator. It is
  // not an expired VOS session, and must not read as one.
  if (response.status === 403) throw new OpsError(403, 'scheduler-forbidden');
  if (response.status === 404) throw new OpsError(404, 'not-found');
  if (!payload || typeof payload.code !== 'string') {
    throw new OpsError(502, 'scheduler-unavailable', bounded(payload?.msg, 120) || null);
  }
  if (payload.code !== 'OK') {
    // The scheduler refuses with its own business code (`BACKEND_DEPLOYMENT_FORBIDDEN`,
    // unconfirmed reservations and so on); carrying it through is what makes a
    // refusal actionable instead of a generic upstream failure.
    throw new OpsError(502, 'scheduler-rejected',
      bounded(payload.error?.code ?? payload.code, 80) || null);
  }
  return payload.data;
}

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Millisecond age of an upstream stamp; null when the stamp is unparsable. */
function age(iso, nowMs) {
  const at = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(at) ? null : nowMs - at;
}

const within = (iso, nowMs, windowMs) => {
  const ms = age(iso, nowMs);
  return ms !== null && ms >= -windowMs && ms < windowMs;
};

/** The public application projection a node observation carries. */
function appRows(observation) {
  const rows = Array.isArray(observation?.data) ? observation.data : [];
  return rows.slice(0, NODE_APPS_LIMIT).flatMap(row => {
    const appId = typeof row?.app_id === 'string' ? row.app_id : '';
    if (!APP_ID.test(appId)) return [];
    return [{ appId, installationId: bounded(row.installed_app_id, 128),
      version: bounded(row.version, 64), state: bounded(row.state, 40),
      error: bounded(row.last_error, 200) || null }];
  });
}

/** A node's VOS hardware/usage observation, or null when it was never read. */
function metricsRow(observation) {
  const data = observation?.data;
  if (!data || typeof data !== 'object') return null;
  return {
    hostname: bounded(data.hostname, 128), deviceName: bounded(data.device_name, 128),
    cpuLogicalCount: finite(data.cpu_logical_count), cpuUsedPercent: finite(data.cpu_used_percent),
    memoryTotalMib: finite(data.memory_total_mib), memoryUsedMib: finite(data.memory_used_mib),
    diskSizeBytes: finite(data.disk?.size_bytes), diskUsedBytes: finite(data.disk?.used_bytes),
    observedAt: observation.observed_at ?? null, fresh: observation.fresh === true,
    error: observation.error_code ?? null,
  };
}

/**
 * The first device name a machine reports.
 *
 * A schedulable node names its devices in its telemetry report and a ModelInfer
 * node in its inventory sample; names are the only stable identity the
 * scheduler keeps for them, so the first non-empty one represents the machine.
 */
function gpuName(view) {
  for (const list of [view?.report?.gpus, view?.modelinfer_source?.node?.host_resources?.gpus]) {
    if (!Array.isArray(list)) continue;
    const name = list.map(gpu => typeof gpu?.name === 'string' ? gpu.name.trim() : '')
      .find(value => value !== '');
    if (name !== undefined) return name;
  }
  return null;
}

/**
 * One row of the scheduler's merged node view.
 *
 * `health_state` is the scheduler's own verdict and passes through unchanged;
 * only `status` needs a local reading because the scheduler exposes it as a
 * heartbeat timestamp. A discovered node reports `observing`, which the panel
 * marks as observation-only.
 */
function schedulerNodeRow(view, nowMs) {
  const id = typeof view?.id === 'string' ? view.id : '';
  if (!NODE_ID.test(id)) return null;
  const local = id === LOCAL_NODE;
  const apps = appRows(view.vos_applications);
  const metrics = metricsRow(view.vos_metrics);
  const heartbeat = typeof view.heartbeat === 'string' ? view.heartbeat : null;
  // A failed collection still stores an observation (empty data plus an error
  // code), so presence of the observation decides reporting, not a non-empty list.
  const observed = view.vos_applications && typeof view.vos_applications === 'object'
    ? view.vos_applications : null;
  return {
    id, local,
    name: bounded(view.display_name ?? view.vos_node?.display_name ?? id, 200),
    kind: local ? 'local' : id.startsWith('vos:') ? 'cluster' : id.startsWith('modelinfer:') ? 'application' : 'scheduler',
    status: heartbeat === null ? 'unknown' : within(heartbeat, nowMs, NODE_HEARTBEAT_MS) ? 'online' : 'offline',
    health: bounded(view.health_state, 40) || null,
    managed: view.managed === true, managementEnabled: view.management_enabled === true,
    draining: view.draining === true, heartbeat,
    capacity: view.capacities ?? null,
    observedAt: observed?.observed_at ?? metrics?.observedAt ?? null,
    fresh: observed ? observed.fresh === true : metrics ? metrics.fresh : null,
    reportFresh: within(view.report?.observed_at, nowMs, NODE_REPORT_MS),
    apps: observed ? { count: observed.data?.length ?? apps.length, rows: apps,
      observedAt: observed.observed_at ?? null,
      fresh: observed.fresh === true, error: observed.error_code ?? null } : null,
    metrics,
    // A discovered machine reports architecture and device names through its
    // telemetry report, never a deployment profile: profiles belong to the SSH
    // register that chooses them.
    arch: bounded(view.report?.arch, 64) || null,
    gpuModel: bounded(gpuName(view), 128) || null,
    profile: null,
    capabilities: local ? [...LOCAL_CAPABILITIES] : metrics || observed ? ['apps', 'metrics'] : ['hardware'],
  };
}

/** One row of the scheduler's SSH-managed compute nodes (the other machines). */
function managedNodeRow(row) {
  const id = typeof row?.id === 'string' ? row.id : '';
  if (!NODE_ID.test(id)) return null;
  return {
    id, local: false, name: bounded(row.name ?? id, 200), kind: 'managed',
    status: row.status === 'online' ? 'online' : row.status === 'offline' ? 'offline' : 'unknown',
    health: null, managed: true, managementEnabled: true, draining: false,
    heartbeat: null, capacity: null,
    observedAt: typeof row.last_checked_at === 'string' ? row.last_checked_at : null,
    fresh: null, reportFresh: null, apps: null, metrics: null,
    arch: bounded(row.arch, 64) || null, gpuModel: bounded(row.gpu_model, 128) || null,
    profile: bounded(row.profile, 64) || null,
    detectedProfile: bounded(row.detected_profile, 64) || null,
    compatibleProfiles: Array.isArray(row.compatible_profiles)
      ? row.compatible_profiles.filter(value => typeof value === 'string').slice(0, 8) : [],
    capabilities: ['hardware', 'rescan'],
  };
}

/** The machine this gateway runs on, used whenever the scheduler has no answer. */
function localNodeRow() {
  return {
    id: LOCAL_NODE, local: true, name: bounded(hostname(), 200), kind: 'local',
    status: 'unknown', health: null, managed: false, managementEnabled: false, draining: false,
    heartbeat: null, capacity: null, observedAt: null, fresh: null,
    reportFresh: null, apps: null, metrics: null, arch: null, gpuModel: null, profile: null,
    capabilities: [...LOCAL_CAPABILITIES],
  };
}

/**
 * One backend the scheduler deployed onto a machine.
 *
 * `state` and `last_error` are the scheduler's reconcile verdicts, passed
 * through so a failure reads as a failure here.
 */
function backendRow(row) {
  const id = typeof row?.id === 'string' ? row.id : '';
  if (!BACKEND_ID.test(id)) return null;
  return {
    id, appId: bounded(row.app_id, 128), image: bounded(row.image, 300),
    targetKind: bounded(row.target_kind, 32), targetId: bounded(row.target_id, 128),
    profile: bounded(row.profile, 64) || null,
    host: bounded(row.host, 128) || null,
    port: Number.isInteger(row.host_port) ? row.host_port : null,
    endpoint: typeof row.endpoint === 'string' ? row.endpoint : null,
    state: bounded(row.state, 32), error: bounded(row.last_error, 200) || null,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  };
}

/**
 * The fields that must still match between confirmation and execution.
 *
 * Container and image targets are compared whole. Backend and node targets
 * carry volatile facts (endpoint, heartbeat, observation stamps), so only the
 * fields that decide eligibility are compared; comparing the rest would expire
 * every confirmation for a reason the caller cannot act on.
 */
function snapshotKey(action, row) {
  if (NODE_ACTIONS.has(action)) return JSON.stringify([row?.id, row?.managed, row?.draining]);
  if (action === 'backend-start' || action === 'backend-stop') return JSON.stringify([row?.id, row?.state]);
  return JSON.stringify(row);
}

export function createVosOps({ sessionFor, tokenFor, agentSessionAllowed = async () => false, sessionExists = async () => false, browserSessionActive = () => false,
  userinfoUrl, readBody, respond, daemon = dockerJson,
  daemonCall = engine, platform = vos, now = Date.now, audit = console.info,
  scheduler = schedulerCall }) {
  const grants = new Map();
  const hostModes = new Map();
  const proposals = new Map();
  const grantTtl = 15 * 60 * 1000;
  // The last node list each administrator successfully read. Only an
  // unreachable scheduler falls back to it, and only for the same user.
  const nodeCache = new Map();

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

  /** The scheduler's own merged node view, without the SSH-managed list. */
  async function nodeViews(token) {
    const data = await scheduler(token, SCHEDULER_NODES);
    const ms = now();
    return (Array.isArray(data) ? data : [])
      .map(view => schedulerNodeRow(view, ms)).filter(row => row !== null);
  }

  /** The SSH-managed compute machines, as rows the panel can render. */
  async function managedNodes(token) {
    const data = await scheduler(token, SCHEDULER_MANAGED_NODES);
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.map(managedNodeRow).filter(row => row !== null);
  }

  /**
   * Record one machine list as the fallback for this administrator.
   *
   * This machine's application list is dropped first: it is re-read live on
   * every answer, and a cached copy would show a deploy the scheduler has not
   * observed yet as the authoritative one.
   */
  function rememberNodes(subject, rows, ms) {
    if (typeof subject !== 'string' || subject === '') return;
    if (nodeCache.size >= NODE_CACHE_LIMIT && !nodeCache.has(subject)) {
      nodeCache.delete(nodeCache.keys().next().value);
    }
    nodeCache.set(subject, { at: ms, nodes: rows.map(row => row.local
      ? { ...row, apps: null, observedAt: null, fresh: null } : row) });
  }

  /**
   * Every machine this administrator may target.
   *
   * The scheduler merges its own nodes (this machine's agent, VOS cluster
   * members, application-discovered nodes) and separately lists SSH-managed
   * compute nodes; both are read so the selector matches what the platform says
   * exists. The two lists form one snapshot, so a failed half falls back to the
   * previous complete one instead of splicing a partial view together.
   *
   * A withdrawn session or role does not fall back: the last good list is for
   * an unreachable scheduler, not for an account that may no longer see it.
   * `source` and `error` tell the panel which of the three states it is reading.
   */
  async function catalog(token, base, subject) {
    const ms = now();
    let rows = null;
    let error = null;
    let cachedAt = null;
    try {
      // Both registers form one snapshot; reading them together keeps a slow
      // scheduler from doubling the wait and keeps the two lists in one epoch.
      const [views, managed] = await Promise.all([nodeViews(token), managedNodes(token)]);
      rows = [...views, ...managed];
      rememberNodes(subject, rows, ms);
    } catch (failure) {
      error = failure instanceof OpsError ? failure.message : 'scheduler-unavailable';
      const fallback = error === 'sign-in-required' || error === 'scheduler-forbidden'
        ? undefined : nodeCache.get(subject);
      if (fallback) {
        rows = fallback.nodes.map(row => ({ ...row, fresh: row.fresh === null ? null : false }));
        cachedAt = fallback.at;
      }
    }
    if (rows === null) rows = [localNodeRow()];
    if (!rows.some(row => row.local)) rows.unshift(localNodeRow());
    // This machine's own VOS answers for its application list; the scheduler's
    // cached observation can lag behind a deploy or have failed outright.
    const local = rows.find(row => row.local);
    const apps = await inventory(token, base).catch(() => null);
    if (local && apps) {
      const observedAt = new Date(ms).toISOString();
      local.apps = { count: apps.length, rows: apps.map(app => ({
        appId: app.appId, version: app.version, state: app.state,
        error: app.lastError || null })), observedAt, fresh: true, error: null };
      local.observedAt = observedAt;
      local.fresh = true;
    }
    return {
      source: error === null ? 'scheduler' : cachedAt === null ? 'local-fallback' : 'cache',
      error, stale: cachedAt !== null,
      observedAt: new Date(cachedAt ?? ms).toISOString(), nodes: rows,
    };
  }

  /**
   * The compute backends the scheduler deploys and reconciles on the machines.
   *
   * The ledger answers the newest 200 records with no total, so a full page is
   * reported as possibly truncated rather than silently presented as complete.
   * `node` narrows the answer to one machine's instances; the flag stays, since
   * a truncated ledger can hide that machine's rows too.
   */
  async function backends(token, nodeId = null) {
    const data = await scheduler(token, SCHEDULER_BACKENDS);
    const raw = Array.isArray(data?.items) ? data.items : [];
    const items = raw.slice(0, BACKEND_LIMIT).map(backendRow).filter(row => row !== null);
    const truncated = raw.length >= BACKEND_LIMIT;
    return { items: nodeId === null ? items : items.filter(row => row.targetId === nodeId),
      truncated, total: items.length };
  }

  /**
   * Apply one node management action.
   *
   * `rescan` refreshes an SSH machine's hardware profile from its saved
   * credentials; `drain`/`undrain` move a schedulable node out of and back into
   * placement; `revoke` withdraws an external node's credentials. The scheduler
   * applies each asynchronously, so the state it returns is what gets reported
   * rather than the request having been sent.
   */
  async function runNodeAction(action, id, token) {
    const node = `${SCHEDULER_NODES}/${encodeURIComponent(id)}`;
    if (action === 'node-drain' || action === 'node-undrain') {
      const data = await scheduler(token, `${node}/drain`, { draining: action === 'node-drain' });
      return { state: data?.draining === true ? 'draining' : 'ready' };
    }
    if (action === 'node-revoke') {
      const data = await scheduler(token, `${node}/revoke`, {});
      return { state: bounded(data?.state, 40) || 'revoked' };
    }
    const data = await scheduler(token,
      `${SCHEDULER_MANAGED_NODES}/${encodeURIComponent(id)}/rescan`, {});
    return { state: bounded(data?.status, 32) || null, profile: bounded(data?.profile, 64) || null };
  }

  /**
   * One machine's state, as register facts plus explicit findings.
   *
   * Everything here is data the scheduler already holds: its own verdicts, the
   * observation stamps that say how old they are, and the backend ledger rows
   * scoped to this machine. No container internals and no log bodies are
   * reachable through it, which is why the Agent tool may read it whole.
   */
  async function nodeDiagnose(id, token, base, subject) {
    if (!NODE_ID.test(id ?? '')) throw new OpsError(400, 'invalid-node');
    const list = await catalog(token, base, subject);
    const node = list.nodes.find(row => row.id === id);
    if (!node) throw new OpsError(404, 'not-found');
    const ledger = await backends(token, node.id).catch(() => null);
    const apps = node.apps;
    const counts = rows => rows.reduce((result, row) => {
      const state = row.state === '' ? 'unknown' : row.state;
      result[state] = (result[state] ?? 0) + 1;
      return result;
    }, {});
    const failingApps = (apps?.rows ?? []).filter(app => app.state === 'failed' || app.error !== null);
    const failingBackends = (ledger?.items ?? [])
      .filter(row => ['failed', 'cleanup_failed'].includes(row.state));
    const findings = [];
    if (node.status === 'offline') findings.push({ code: 'node-offline', level: 'error' });
    if (node.status === 'unknown') findings.push({ code: 'node-heartbeat-missing', level: 'warning' });
    if (!node.managed) findings.push({ code: 'node-observation-only', level: 'info' });
    if (node.draining) findings.push({ code: 'node-draining', level: 'info' });
    if (node.fresh === false) findings.push({ code: 'node-observation-stale', level: 'warning' });
    if (list.error !== null) findings.push({ code: 'catalog-degraded', level: 'warning', detail: list.error });
    if (!node.capabilities.includes('apps')) findings.push({ code: 'node-apps-unavailable', level: 'info' });
    if (ledger === null) findings.push({ code: 'backend-ledger-unavailable', level: 'warning' });
    for (const app of failingApps) {
      findings.push({ code: app.state === 'failed' ? 'app-failed' : 'app-error', level: 'error',
        subject: app.appId, detail: app.error ?? null });
    }
    for (const row of failingBackends) {
      findings.push({ code: row.state === 'failed' ? 'backend-failed' : 'backend-cleanup-failed',
        level: 'error', subject: row.id, detail: row.error ?? null });
    }
    return {
      node: { id: node.id, name: node.name, kind: node.kind, local: node.local,
        status: node.status, health: node.health, managed: node.managed,
        draining: node.draining, fresh: node.fresh, observedAt: node.observedAt,
        heartbeat: node.heartbeat, arch: node.arch, gpuModel: node.gpuModel,
        profile: node.profile, capacity: node.capacity, capabilities: node.capabilities },
      catalog: { source: list.source, error: list.error, stale: list.stale,
        observedAt: list.observedAt },
      apps: apps === null ? null : { total: apps.count, byState: counts(apps.rows),
        fresh: apps.fresh, observedAt: apps.observedAt, error: apps.error,
        failing: failingApps.map(app => ({ appId: app.appId, version: app.version,
          state: app.state, error: app.error })) },
      backends: ledger === null ? null : { total: ledger.total, scoped: ledger.items.length,
        truncated: ledger.truncated, byState: counts(ledger.items), failing: failingBackends },
      findings,
    };
  }

  async function target(action, id, token, base, snapshot) {
    if (action === 'backend-start' || action === 'backend-stop') {
      if (!BACKEND_ID.test(id)) throw new OpsError(400, 'invalid-target');
      const { items } = await backends(token);
      const row = items.find(item => item.id === id);
      if (!row) throw stale();
      // Start accepts a stopped or failed instance; stop also retries a cleanup
      // that could not be confirmed, which is the state a remote repair starts
      // from. Anything else means the confirmation is out of date.
      const eligible = action === 'backend-start' ? BACKEND_STARTABLE : BACKEND_STOPPABLE;
      if (!eligible.includes(row.state)) throw stale();
      return row;
    }
    if (NODE_ACTIONS.has(action)) {
      // This machine is not a managed node; its repairs go through the
      // container actions instead.
      if (!NODE_ID.test(id) || id === LOCAL_NODE) throw new OpsError(400, 'invalid-target');
      if (action === 'node-rescan') {
        const row = (await managedNodes(token)).find(item => item.id === id);
        if (!row) throw stale();
        return row;
      }
      const view = (await nodeViews(token)).find(item => item.id === id);
      // An observation-only node carries no schedulable budget, so the
      // scheduler has nothing to drain or revoke; refuse where it would.
      if (!view || view.local || view.managed !== true) throw stale();
      if (action === 'node-drain' && view.draining) throw stale();
      if (action === 'node-undrain' && !view.draining) throw stale();
      // One stable, readable snapshot for the confirmation dialog; the applied
      // changes are checked against the eligibility fields, not this copy.
      return { id: view.id, name: view.name, kind: view.kind, status: view.status,
        health: view.health, managed: view.managed, draining: view.draining,
        profile: view.profile, capacity: view.capacity };
    }
    if (HOST_ACTIONS.has(action)) {
      if (!CONTAINER_ID.test(id)) throw new OpsError(400, 'invalid-target');
      const container = (snapshot?.containers ?? await daemon('/containers/json?all=1')).find(c => c.Id === id);
      if (!container || !visible(container) || !HOST_ACTIONS.get(action).includes(container.State) ||
          (process.env.VH_SELF_CONTAINER || hostname()) === container.Id.slice(0, 12) ||
          process.env.VH_SELF_CONTAINER === container.Id) throw stale();
      const summary = summarizeContainer(container, []);
      if (action === 'host-remove') delete summary.status;
      return summary;
    }
    if (action === 'restart' && APP_ID.test(id) && !CONTAINER_ID.test(id)) {
      const a = (await inventory(token, base)).find(a => a.appId === id);
      if (!a || a.state !== 'installed' || id === 'com.ictrek.v-harness') throw stale();
      return a;
    }
    if (['stop-container', 'remove-container'].includes(action) && CONTAINER_ID.test(id)) {
      const apps = snapshot?.apps ?? await inventory(token, base);
      const containers = snapshot?.containers ?? await daemon('/containers/json?all=1');
      const c = containers.find(c => c.Id === id);
      const item = c && summarizeContainer(c, apps);
      if (action === 'stop-container') {
        if (!item?.stoppable) throw stale();
        const app = apps.find(a => a.appId === item.stack.appId);
        return { id: item.id, name: item.name, image: item.image, imageId: item.imageId, stack: item.stack,
          ports: item.ports, installedVersion: app.version, installationId: app.installationId };
      }
      if (!item?.cleanup || item.stack.appId === 'com.ictrek.v-harness') throw stale();
      delete item.status;
      return item;
    }
    if (action === 'remove-image' && IMAGE_ID.test(id)) {
      const [containers, images] = snapshot ? [snapshot.containers, snapshot.images] :
        await Promise.all([daemon('/containers/json?all=1'), daemon('/images/json?all=1')]);
      const item = candidates(images, containers).find(i => i.id === id) ??
        taggedImages(images, containers).find(i => i.id === id);
      if (!item) throw stale();
      return item;
    }
    throw new OpsError(400, 'invalid-target');
  }

  async function cleanupTargets(action, ids, token, base) {
    const [containers, apps, images] = await Promise.all([
      daemon('/containers/json?all=1'),
      action === 'remove-container' ? inventory(token, base) : [],
      action === 'remove-image' ? daemon('/images/json?all=1') : [],
    ]);
    return Promise.all(ids.map(id => target(action, id, token, base, { containers, apps, images })));
  }

  async function removeTarget(action, id) {
    if (action !== 'remove-image') {
      await daemonCall('DELETE', `/containers/${id}?force=0&v=0`);
      return;
    }
    try {
      await daemonCall('DELETE', `/images/${id}?force=0&noprune=1`);
    } catch (error) {
      if (error instanceof OpsError && error.status === 409) throw new OpsError(409, 'image-delete-conflict');
      throw error;
    }
  }

  /**
   * One-call diagnosis for a visible container: Docker-inspect facts that
   * never appear in application logs (exit code, OOM, restart count, health
   * checks) plus a collapsed error-line summary. No raw log body is returned.
   */
  async function diagnose(id) {
    if (!CONTAINER_ID.test(id ?? '')) throw new OpsError(400, 'invalid-target');
    const container = (await daemon('/containers/json?all=1')).find(c => c.Id === id);
    if (!container || !visible(container)) throw new OpsError(404, 'not-found');
    let inspect;
    try {
      inspect = JSON.parse(await daemonCall('GET', `/containers/${id}/json`));
    } catch (error) {
      if (error instanceof OpsError && error.status === 404) throw stale();
      throw error;
    }
    const state = inspect.State ?? {};
    const health = state.Health ?? null;
    const records = logRecords(await daemonCall('GET',
      `/containers/${id}/logs?${LOG_QUERY}${DIAGNOSE_TAIL}`, LOG_BYTES));
    const stamped = records.filter(record => record.ts !== null);
    return {
      id, name: bounded(container.Names?.[0]?.replace(/^\//, ''), 200),
      image: bounded(container.Image, 300), stack: mainStack(container),
      state: {
        status: bounded(state.Status, 40), running: state.Running === true,
        restarting: state.Restarting === true, oomKilled: state.OOMKilled === true,
        exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null,
        error: bounded(state.Error, 500), startedAt: state.StartedAt ?? null,
        finishedAt: state.FinishedAt ?? null,
        restartCount: typeof inspect.RestartCount === 'number' ? inspect.RestartCount : 0,
        health: health ? {
          status: bounded(health.Status, 40),
          failingStreak: typeof health.FailingStreak === 'number' ? health.FailingStreak : 0,
          recent: (health.Log ?? []).slice(-3).map(entry => ({
            start: entry.Start ?? null, end: entry.End ?? null,
            exitCode: typeof entry.ExitCode === 'number' ? entry.ExitCode : null,
            output: bounded(entry.Output, DIAGNOSE_HEALTH_OUTPUT).trim(),
          })),
        } : null,
      },
      logs: {
        scanned: records.length, first: stamped[0]?.ts ?? null, last: stamped.at(-1)?.ts ?? null,
        errors: errorGroups(records),
      },
    };
  }

  async function execute(pending, token, base, session, stillAllowed, res) {
    const { action, id, item, ids, items } = pending;
    const latestPermissions = await platform(token, '/v1000/rbac/permission/my', undefined, base);
    if (latestPermissions.is_super_admin !== true) throw denied();
    if (!await stillAllowed()) throw stale();
    if (ids) {
      const current = await cleanupTargets(action, ids, token, base);
      if (JSON.stringify(current) !== JSON.stringify(items) || !await stillAllowed()) throw stale();
      const results = await Promise.all(ids.map(async targetId => {
        audit('VOS ops attempt', JSON.stringify({ subject: session.subject, action, id: targetId }));
        try {
          await removeTarget(action, targetId);
          audit('VOS ops accepted', JSON.stringify({ subject: session.subject, action, id: targetId, taskId: null }));
          return { id: targetId, removed: true };
        } catch (error) {
          return { id: targetId, removed: false, error: error instanceof OpsError ? error.message : 'docker-unavailable' };
        }
      }));
      respond(res, 200, { action, results });
      return;
    }
    const current = await target(action, id, token, base);
    if (snapshotKey(action, current) !== snapshotKey(action, item)) throw stale();
    audit('VOS ops attempt', JSON.stringify({ subject: session.subject, action, id }));
    let taskId = null;
    let state = null;
    if (action === 'backend-start' || action === 'backend-stop') {
      // The scheduler reconciles asynchronously; the re-read below reports the
      // state it reached, so a request in flight is never reported as done.
      await scheduler(token, `${SCHEDULER_BACKENDS}/${encodeURIComponent(id)}/` +
        (action === 'backend-start' ? 'start' : 'stop'), {});
      state = (await backends(token)).items.find(row => row.id === id)?.state ?? null;
    } else if (NODE_ACTIONS.has(action)) {
      state = (await runNodeAction(action, id, token)).state;
    } else if (action === 'restart') {
      const task = await platform(token, '/v1000/app/restart_async', { app_id: id }, base);
      taskId = task.task_id;
    } else if (action === 'host-start') {
      await daemonCall('POST', `/containers/${id}/start`);
    } else if (action === 'host-restart') {
      await daemonCall('POST', `/containers/${id}/restart?t=30`);
    } else if (action === 'stop-container' || action === 'host-stop') {
      await daemonCall('POST', `/containers/${id}/stop?t=30`);
    } else {
      await removeTarget(action, id);
    }
    audit('VOS ops accepted', JSON.stringify({ subject: session.subject, action, id, taskId, state }));
    respond(res, 200, { action, id, taskId, ...(state === null ? {} : { state }) });
  }

  async function handle(req, res, url, agent) {
    const path = url.pathname.slice(OPS_PATH.length);
    try {
      // All requests carry a non-simple header. This route never enables CORS.
      if (!agent && (req.headers['x-vh-ops'] !== '1' ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))) throw denied();
      if (agent && !((req.method === 'GET' && ['/inventory', '/status', '/logs', '/app-logs', '/diagnose',
          '/nodes', '/nodes/apps', '/nodes/diagnose', '/backends',
          '/host-mode', '/host-containers', '/host-logs', '/host-diagnose'].includes(path)) ||
        (req.method === 'POST' && path === '/proposal'))) throw denied();
      const session = agent?.session ?? sessionFor(req);
      if (!session) throw new OpsError(401, 'sign-in-required');
      const sessionScoped = agent || path.startsWith('/host-') || path === '/proposal' ||
        path === '/confirm-proposal' || path === '/containers';
      const sessionId = agent?.sessionId ?? url.searchParams.get('sessionId');
      const key = JSON.stringify([session.subject, sessionId]);
      const mode = hostModes.get(key);
      const hostEnabled = () => Boolean(mode && hostModes.get(key) === mode && mode.expires > now() &&
        browserSessionActive(mode.sid, session.subject) && (agent || mode.sid === session.sid));
      const conversation = () => sessionExists(session.subject, sessionId);
      const vosEnabled = () => agentSessionAllowed(session.subject, sessionId);
      if (sessionScoped && !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId ?? '')) throw denied();
      if (sessionScoped && !path.startsWith('/host-') &&
          !(hostEnabled() ? await conversation() : await vosEnabled())) throw denied();
      if (agent && path.startsWith('/host-') && !hostEnabled()) throw denied();
      const token = await tokenFor(session);
      if (!token) throw new OpsError(401, 'sign-in-required');
      const base = userinfoUrl();
      const permissions = await platform(token, '/v1000/rbac/permission/my', undefined, base);
      if (permissions.is_super_admin !== true) throw denied();
      const { sid } = session;
      if (path === '/host-mode') {
        if (req.method === 'GET') {
          respond(res, 200, { available: true, enabled: hostEnabled() });
          return;
        }
        if (agent || req.method !== 'POST' || !await conversation()) throw denied();
        const { enabled } = await readBody(req).catch(() => { throw new OpsError(400, 'invalid-body'); });
        if (typeof enabled !== 'boolean') throw new OpsError(400, 'invalid-body');
        if (enabled) {
          for (const [k, active] of hostModes) if (active.expires <= now()) hostModes.delete(k);
          if (hostModes.size >= 128 && !hostModes.has(key)) throw new OpsError(429, 'too-many-grants');
          hostModes.set(key, { sid, expires: now() + 30 * 60 * 1000 });
        } else {
          hostModes.delete(key);
          if (HOST_ACTIONS.has(proposals.get(key)?.action)) proposals.delete(key);
        }
        respond(res, 200, { available: true, enabled });
        return;
      }
      if (path === '/host-containers' || path === '/host-logs' || path === '/host-diagnose') {
        if (!agent || req.method !== 'GET' || !hostEnabled() || !await conversation()) throw denied();
        if (path === '/host-containers') {
          const containers = await daemon('/containers/json?all=1');
          respond(res, 200, { containers: containers.filter(c => CONTAINER_ID.test(c.Id) && visible(c))
            .map(c => summarizeContainer(c, [])) });
        } else if (path === '/host-logs') {
          const id = url.searchParams.get('id');
          if (!CONTAINER_ID.test(id ?? '')) throw new OpsError(400, 'invalid-target');
          const container = (await daemon('/containers/json?all=1')).find(c => c.Id === id);
          if (!container || !visible(container)) throw new OpsError(404, 'not-found');
          const filter = logFilter(url, now());
          const result = filterRecords(logRecords(
            await daemonCall('GET', `/containers/${id}/logs?${filter.query}`, LOG_BYTES)), filter);
          respond(res, 200, logsPayload(id, result, filter));
        } else {
          respond(res, 200, await diagnose(url.searchParams.get('id')));
        }
        return;
      }
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
        if (path === '/proposal' && agent) {
          const { action, id, ids } = await readBody(req).catch(() => { throw new OpsError(400, 'invalid-body'); });
          if (!(ACTIONS.has(action) || HOST_ACTIONS.has(action)) ||
              (ids === undefined ? typeof id !== 'string' :
                id !== undefined || !CLEANUP_ACTIONS.has(action) || !Array.isArray(ids) ||
                ids.length < 1 || ids.length > MAX_CLEANUP_TARGETS ||
                new Set(ids).size !== ids.length || ids.some(value => typeof value !== 'string'))) {
            throw new OpsError(400, 'invalid-target');
          }
          if (HOST_ACTIONS.has(action) ? !hostEnabled() : !await vosEnabled()) throw denied();
          for (const [k, p] of proposals) if (p.expires <= now()) proposals.delete(k);
          const reportPending = () => {
            const pending = proposals.get(key);
            if (!pending || pending.expires <= now()) return false;
            respond(res, 409, { error: 'confirmation-pending', action: pending.action,
              ...(pending.ids ? { ids: pending.ids } : { id: pending.id }),
              expiresIn: Math.ceil((pending.expires - now()) / 1000) });
            return true;
          };
          if (reportPending()) return;
          if (proposals.size >= 128) throw new OpsError(429, 'too-many-grants');
          const targets = ids
            ? { ids, items: await cleanupTargets(action, ids, token, base) }
            : { id, item: await target(action, id, token, base) };
          if (reportPending()) return;
          if (HOST_ACTIONS.has(action) && !hostEnabled()) throw denied();
          proposals.set(key, { action, ...targets, confirmation: randomBytes(32).toString('hex'), expires: now() + 120000 });
          respond(res, 200, { action, ...(ids ? { ids } : { id }), pending: true, executed: false, expiresIn: 120 });
          return;
        }
        if (!agent && path === '/proposal' && req.method === 'GET') {
          const p = proposals.get(key);
          respond(res, 200, { proposal: p && p.expires > now() && (!HOST_ACTIONS.has(p.action) || hostEnabled())
            ? { action: p.action, ...(p.ids ? { targetIds: p.ids, targets: p.items } : { targetId: p.id, target: p.item }),
                confirmation: p.confirmation } : null });
          return;
        }
        if (!agent && path === '/confirm-proposal' && req.method === 'POST') {
          const { confirmation, targetId, targetIds, approved } = await readBody(req).catch(() => { throw new OpsError(400, 'invalid-body'); });
          const p = proposals.get(key);
          if (!p || p.confirmation !== confirmation || p.expires <= now()) {
            throw new OpsError(409, 'confirmation-unavailable');
          }
          if (HOST_ACTIONS.has(p.action) && !hostEnabled()) throw denied();
          if (approved !== true && approved !== false) throw new OpsError(400, 'invalid-body');
          if (approved && (p.ids
            ? targetId !== undefined || !Array.isArray(targetIds) || targetIds.length !== p.ids.length ||
              p.ids.some((id, index) => id !== targetIds[index])
            : targetIds !== undefined || targetId !== p.id)) throw new OpsError(400, 'confirmation-mismatch');
          proposals.delete(key);
          if (!approved) { respond(res, 200, { cancelled: true }); return; }
          await execute(p, token, base, session, async () => sessionFor(req)?.sid === sid &&
            (HOST_ACTIONS.has(p.action) ? hostEnabled() && await conversation() : await vosEnabled()), res);
          return;
        }
        if (!agent && path === '/containers' && req.method === 'GET') {
          // The composer's @ menu names a container before the Agent has a turn
          // to run, so this read answers the browser directly. It carries the
          // same narrowed set the in-session tool operates on and needs no
          // grant: the conversation's operations preset already authorized it.
          const containers = await daemon('/containers/json?all=1');
          respond(res, 200, { containers: containers.filter(c => CONTAINER_ID.test(c.Id) && visible(c))
            .map(c => {
              const stack = mainStack(c);
              return { id: c.Id, name: bounded(c.Names?.[0]?.replace(/^\//, ''), 200),
                appId: stack.appId, version: stack.version,
                state: bounded(c.State, 40), status: bounded(c.Status, 300) };
            }) });
          return;
        }
        if (!agent) throw denied();
      } else if (!grant || grant.expires <= now() || grant.sid !== sid) throw denied();

      if (path === '/nodes' && req.method === 'GET') {
        respond(res, 200, await catalog(token, base, session.subject));
        return;
      }
      if (path === '/nodes/apps' && req.method === 'GET') {
        const id = url.searchParams.get('node') ?? LOCAL_NODE;
        if (!NODE_ID.test(id)) throw new OpsError(400, 'invalid-node');
        if (id === LOCAL_NODE) {
          const apps = await inventory(token, base);
          respond(res, 200, { node: id, local: true, source: 'vos', fresh: true,
            observedAt: new Date(now()).toISOString(),
            apps: apps.map(app => ({ appId: app.appId, version: app.version, state: app.state,
              error: app.lastError || null })) });
          return;
        }
        const node = (await catalog(token, base, session.subject)).nodes.find(row => row.id === id);
        if (!node) throw new OpsError(404, 'not-found');
        respond(res, 200, {
          node: id, local: false, source: 'scheduler',
          observedAt: node.apps?.observedAt ?? node.observedAt ?? null,
          fresh: node.apps?.fresh === true,
          error: node.apps ? node.apps.error : 'source-unavailable',
          apps: node.apps?.rows ?? [],
        });
        return;
      }
      if (path === '/nodes/diagnose' && req.method === 'GET') {
        respond(res, 200, await nodeDiagnose(url.searchParams.get('node') ?? LOCAL_NODE,
          token, base, session.subject));
        return;
      }
      if (path === '/backends' && req.method === 'GET') {
        const nodeId = url.searchParams.get('node');
        if (nodeId !== null && !NODE_ID.test(nodeId)) throw new OpsError(400, 'invalid-node');
        let ledger = null;
        let failure = null;
        try {
          ledger = await backends(token, nodeId);
        } catch (error) {
          // A refused or unreachable scheduler is reported, not folded into an
          // empty register: "no backends" and "cannot read backends" differ.
          failure = error instanceof OpsError ? error.message : 'scheduler-unavailable';
        }
        respond(res, 200, {
          source: 'scheduler', available: ledger !== null, error: failure,
          node: nodeId, truncated: ledger?.truncated === true, total: ledger?.total ?? 0,
          backends: ledger?.items ?? [],
        });
        return;
      }
      if (path === '/inventory' && req.method === 'GET') {
        const [apps, containers, images] = await Promise.all([
          inventory(token, base), daemon('/containers/json?all=1'), daemon('/images/json?all=1'),
        ]);
        const rows = containers.map(c => summarizeContainer(c, apps));
        respond(res, 200, {
          apps, containers: rows.filter(c => c.stack && CONTAINER_ID.test(c.id)),
          publishedPorts: rows.flatMap(c => c.ports.map(p => ({ ...p, container: c.name, appId: c.stack?.appId ?? null }))),
          unusedImages: candidates(images, containers),
          unreferencedTaggedImages: taggedImages(images, containers),

        });
        return;
      }
      if (path === '/close' && req.method === 'POST') {
        grants.delete(grantKey);
        // Closing the session also drops the fallback list: the next open reads
        // the scheduler again instead of replaying what this session saw.
        nodeCache.delete(session.subject);
        respond(res, 200, { closed: true });
        return;
      }
      if (path === '/status' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (CONTAINER_ID.test(id ?? '') || IMAGE_ID.test(id ?? '')) throw new OpsError(400, 'app-id-required');
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
        const filter = logFilter(url, now());
        const [containers, apps] = await Promise.all([daemon('/containers/json?all=1'), inventory(token, base)]);
        const c = containers.find(c => c.Id === id);
        const stack = c && mainStack(c);
        if (!stack || !apps.some(a => a.appId === stack.appId)) throw new OpsError(404, 'not-found');
        const result = filterRecords(logRecords(
          await daemonCall('GET', `/containers/${id}/logs?${filter.query}`, LOG_BYTES)), filter);
        respond(res, 200, logsPayload(id, result, filter));
        return;
      }
      if (path === '/app-logs' && req.method === 'GET') {
        const appId = url.searchParams.get('appId');
        if (!APP_ID.test(appId ?? '')) throw new OpsError(400, 'invalid-target');
        const filter = logFilter(url, now());
        const [containers, apps] = await Promise.all([daemon('/containers/json?all=1'), inventory(token, base)]);
        if (!apps.some(a => a.appId === appId)) throw new OpsError(404, 'not-found');
        const members = containers
          .filter(c => CONTAINER_ID.test(c.Id) && mainStack(c)?.appId === appId)
          .map(c => ({ id: c.Id, name: bounded(c.Names?.[0]?.replace(/^\//, ''), 200) }));
        if (members.length === 0) throw new OpsError(404, 'not-found');
        const sources = await Promise.all(members.map(async member => ({
          name: member.name,
          records: logRecords(await daemonCall('GET', `/containers/${member.id}/logs?${filter.query}`, LOG_BYTES)),
        })));
        respond(res, 200, appLogsPayload(appId, sources, filter));
        return;
      }
      if (path === '/diagnose' && req.method === 'GET') {
        respond(res, 200, await diagnose(url.searchParams.get('id')));
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
      respond(res, status, { error: error instanceof OpsError ? error.message : 'upstream-unavailable',
        ...(error instanceof OpsError && error.detail ? { detail: error.detail } : {}) });
    }
  }
  return handle;
}
