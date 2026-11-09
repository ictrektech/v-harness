/**
 * MCPHub discovery, tool preview and per-tenant selection for the panel.
 *
 * MCPHub runs as a sibling VOS application on the same `vos_default` network,
 * so the gateway reaches it by its compose alias (`mcphub:3000`) with the
 * MCPHub `BASE_PATH` kept intact — the upstream does not strip it, and the
 * address carries no host of its own: moving the platform to another server
 * never changes it.
 *
 * Same trust model as `office.mjs` and `weknora.mjs`: the browser holds only
 * its v-harness cookie and the tenant process holds nothing at all. The VOS
 * access token stays in this process and is attached here. MCPHub authorizes
 * the request itself — its own `auth` middleware accepts a VOS user token and
 * derives the role from the platform userinfo answer — so nothing here
 * re-implements visibility or ownership.
 *
 * Every upstream answer is rebuilt field by field, so an upstream that grows a
 * `url`, a `command` or an `env` cannot leak it into the page.
 *
 * @module v-harness/gateway/mcphub
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';

import { GATEWAY_IP } from './addressing.mjs';
import { accessTokenFor } from './office.mjs';

/**
 * Where MCPHub listens inside the container network.
 *
 * A compose alias, not a private address: `docker-compose.yml` sets the same
 * value through `MCPHUB_URL`, and this fallback only keeps a deployment that
 * predates that variable working.
 */
const DEFAULT_BASE = 'http://mcphub:3000/app/com.ictrek.mcphub';

/** Per-attempt budget for the health probe. */
const PROBE_TIMEOUT_MS = 1_200;
/** Attempts per probe: a sibling container may still be starting. */
const PROBE_ATTEMPTS = 2;
/** Wait between probe attempts. */
const PROBE_GAP_MS = 300;
/** Discovery budget; the MCPHub query is a single indexed read. */
const DISCOVERY_TIMEOUT_MS = 8_000;
/** How long a failed probe stays a failure, so launches do not each pay for it. */
const NEGATIVE_TTL_MS = 60_000;
/** Consecutive upstream failures before the resolved base is probed again. */
const RETRY_AFTER_FAILURES = 3;
/** Methods an MCP transport uses; anything else is refused locally. */
const MCP_METHODS = new Set(['POST', 'GET', 'DELETE']);
/** The upstream MCP surface: `/mcp`, `/mcp/<server>`, `/mcp/$smart`. */
const MCP_PATH = /^\/mcp(?:\/[\w.$~%-]+)*$/;
/** A service name is an MCPHub path segment and a YAML scalar. */
const SERVER_NAME = /^[\w.$~%-]{1,128}$/u;
/** Tools listed per service: the preview is for a reader, not a directory. */
const MAX_TOOLS = 200;
/** Characters of a tool description worth showing in one row. */
const MAX_TOOL_DESCRIPTION = 200;
/** A selection larger than this is a mistake, not a plan. */
const MAX_SELECTION = 64;
/** Budget for the dashboard read the tool preview needs. */
const TOOLS_TIMEOUT_MS = 8_000;
/** Where the per-service patch is written, relative to the tenant home. */
const PATCH_RELATIVE = join('.dsh', 'profiles', 'web', 'mcphub.patch.yml');

/** Resolved base, cached after the first successful probe. */
let base;
/** The configured value `base` was resolved for. */
let baseFor;
/** In-flight probe, shared so a burst of calls probes once. */
let probing;
/** Consecutive upstream failures since the last success. */
let failures = 0;
/** When the last probe finished, at epoch milliseconds. */
let checkedAt = 0;
// Capability keys: one per tenant, and the reverse lookup that turns a tenant
// request back into the namespace whose token signs it.
/** @type {Map<string, string>} */
const keys = new Map();
/** @type {Map<string, string>} */
const tenants = new Map();

/**
 * The one address this deployment configured, without a trailing slash.
 * @returns {string} the MCPHub base URL, including its `BASE_PATH`.
 */
function configured() {
  const fromEnv = process.env.MCPHUB_URL;
  const value = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : DEFAULT_BASE;
  return value.replace(/\/+$/, '');
}

/**
 * Whether the sibling MCPHub answers, retried once to ride out its startup.
 * @param {string} candidate - the configured base.
 * @returns {Promise<boolean>} whether `/health` answered.
 */
async function probe(candidate) {
  // `/health` is registered at the server root upstream and never carries the
  // app path, so it is resolved against the origin rather than the base.
  const health = new URL('/health', candidate).href;
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => { setTimeout(resolve, PROBE_GAP_MS); });
    const reachable = await fetch(health, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      .then((response) => response.ok)
      .catch(() => false);
    if (reachable) return true;
  }
  return false;
}

/**
 * The upstream base, re-probed once an MCPHub that answered stops answering.
 *
 * `fresh` skips the negative cache: the panel asks for the live answer, while
 * an instance launch may reuse the miss a previous launch just paid for.
 * @param {boolean} [fresh] - probe even inside the negative window.
 * @returns {Promise<string | undefined>} the base, or undefined when absent.
 */
async function upstream(fresh = false) {
  const candidate = configured();
  if (baseFor !== candidate) {
    baseFor = candidate;
    base = undefined;
    failures = 0;
    checkedAt = 0;
  }
  if (!fresh) {
    if (base !== undefined && failures < RETRY_AFTER_FAILURES) return base;
    if (base === undefined && Date.now() - checkedAt < NEGATIVE_TTL_MS) return undefined;
  }
  probing ??= probe(candidate).then((reachable) => (reachable ? candidate : undefined));
  const found = await probing;
  probing = undefined;
  checkedAt = Date.now();
  base = found;
  failures = 0;
  return base;
}

/** Record one failed attempt; enough of them forget the cached base. */
function upstreamFailed() {
  failures += 1;
  if (failures >= RETRY_AFTER_FAILURES) base = undefined;
}

/**
 * One discovery entry, rebuilt from the fields the panel shows.
 * @param {unknown} entry - a raw entry from the upstream response.
 * @returns {{ name: string, description: string, visibility: string, status: string } | undefined}
 *   the displayable entry, or undefined when it has no usable name.
 */
function displayEntry(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  const record = /** @type {Record<string, unknown>} */ (entry);
  if (typeof record.name !== 'string' || record.name === '') return undefined;
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    name: record.name,
    description: text(record.description),
    visibility: text(record.visibility) || 'private',
    status: text(record.status) || 'unknown',
  };
}

/**
 * The services this tenant may use, as `GET /__vh/mcphub/services` answers.
 *
 * `available: false` means the sibling application is not there; the panel is
 * normally not even mounted in that case, and the answer exists so a probe can
 * be inspected without guessing.
 * @param {string} namespace - the tenant's namespace.
 * @returns {Promise<{
 *   available: boolean,
 *   authorized: boolean,
 *   servers: { name: string, description: string, visibility: string, status: string }[],
 *   error?: string,
 * }>} the discovery answer.
 */
export async function mcphubServices(namespace) {
  const target = await upstream(true);
  if (target === undefined) return { available: false, authorized: false, servers: [] };

  const token = await accessTokenFor(namespace);
  // A signed-out tenant is not a failure: the page says so instead of showing
  // an empty list, which would read as "you have no services".
  if (token === undefined || token === '') return { available: true, authorized: false, servers: [] };

  /** @type {Response} */
  let response;
  try {
    response = await fetch(`${target}/api/integration/discovery`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`mcphub discovery unreachable (${namespace}):`, error?.message ?? error);
    upstreamFailed();
    return { available: true, authorized: true, servers: [], error: 'unreachable' };
  }

  if (response.status === 401 || response.status === 403) {
    return { available: true, authorized: false, servers: [] };
  }
  if (!response.ok) {
    console.error(`mcphub discovery failed (${namespace}): HTTP ${String(response.status)}`);
    upstreamFailed();
    return { available: true, authorized: true, servers: [], error: `http-${String(response.status)}` };
  }

  const body = await response.json().catch(() => undefined);
  const raw = body?.data?.servers;
  const servers = Array.isArray(raw)
    ? raw.map(displayEntry).filter((entry) => entry !== undefined)
    : [];
  return { available: true, authorized: true, servers };
}

/**
 * One tool of a service, rebuilt from the fields the preview shows.
 * @param {unknown} entry - a raw tool from the upstream answer.
 * @returns {{ name: string, description: string, enabled: boolean } | undefined}
 *   the tool, or undefined when it has no usable name.
 */
function displayTool(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  const record = /** @type {Record<string, unknown>} */ (entry);
  if (typeof record.name !== 'string' || record.name === '') return undefined;
  return {
    name: record.name,
    description: typeof record.description === 'string'
      ? record.description.slice(0, MAX_TOOL_DESCRIPTION)
      : '',
    enabled: record.enabled !== false,
  };
}

/**
 * One service and its tools, rebuilt from the fields the preview shows.
 * @param {unknown} entry - a raw server from the dashboard answer.
 * @returns {{ name: string, tools: { name: string, description: string, enabled: boolean }[] } | undefined}
 *   the service, or undefined when it has no usable name.
 */
function displayToolEntry(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  const record = /** @type {Record<string, unknown>} */ (entry);
  if (typeof record.name !== 'string' || record.name === '') return undefined;
  const raw = Array.isArray(record.tools) ? record.tools.slice(0, MAX_TOOLS) : [];
  return { name: record.name, tools: raw.map(displayTool).filter((tool) => tool !== undefined) };
}

/**
 * The tools behind this tenant's services, as `GET /__vh/mcphub/tools` answers.
 *
 * Read from MCPHub's own dashboard answer rather than by speaking MCP from
 * here: the runtime already holds the tool list, and looking at a preview must
 * not open sessions or wake a stdio service as a side effect.
 * @param {string} namespace - the tenant's namespace.
 * @returns {Promise<{
 *   available: boolean,
 *   authorized: boolean,
 *   servers: { name: string, tools: { name: string, description: string, enabled: boolean }[] }[],
 *   error?: string,
 * }>} the preview answer.
 */
export async function mcphubTools(namespace) {
  const target = await upstream(true);
  if (target === undefined) return { available: false, authorized: false, servers: [] };

  const token = await accessTokenFor(namespace);
  if (token === undefined || token === '') return { available: true, authorized: false, servers: [] };

  /** @type {Response} */
  let response;
  try {
    response = await fetch(`${target}/api/servers`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TOOLS_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`mcphub tool preview unreachable (${namespace}):`, error?.message ?? error);
    upstreamFailed();
    return { available: true, authorized: true, servers: [], error: 'unreachable' };
  }

  // MCPHub answers the same 401 for an expired platform session and for an
  // application token, and both mean "refresh the page", not "read failed".
  if (response.status === 401 || response.status === 403) {
    return { available: true, authorized: false, servers: [] };
  }
  if (!response.ok) {
    console.error(`mcphub tool preview failed (${namespace}): HTTP ${String(response.status)}`);
    upstreamFailed();
    return { available: true, authorized: true, servers: [], error: `http-${String(response.status)}` };
  }

  const body = await response.json().catch(() => undefined);
  const raw = body?.data;
  const servers = Array.isArray(raw)
    ? raw.map(displayToolEntry).filter((entry) => entry !== undefined)
    : [];
  return { available: true, authorized: true, servers };
}

/**
 * The file holding each tenant's service selection.
 * @returns {string} the JSON path; a deployment may relocate it for tests.
 */
function selectionFile() {
  return process.env.MCPHUB_SELECTION_FILE ?? join(process.env.STATE_ROOT ?? '/data/.vh', 'mcphub-selection.json');
}

/**
 * The selection map on disk, dropping entries that cannot be a service name.
 * @returns {Promise<Record<string, string[]>>} one list per tenant, possibly empty.
 */
async function readSelection() {
  const text = await readFile(selectionFile(), 'utf8').catch(() => undefined);
  if (text === undefined) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    /** @type {Record<string, string[]>} */
    const map = {};
    for (const [namespace, names] of Object.entries(parsed)) {
      if (!Array.isArray(names)) continue;
      map[namespace] = names.filter((name) => typeof name === 'string' && SERVER_NAME.test(name));
    }
    return map;
  } catch (error) {
    // A record this process cannot read is treated as "nothing chosen"; the
    // alternative is refusing to launch the tenant over a stale file.
    console.error('mcphub selection unreadable, following the aggregate endpoint:', error?.message ?? error);
    return {};
  }
}

/**
 * Replace the selection map atomically, so a crash never leaves half a file.
 * @param {Record<string, string[]>} map - the whole map to record.
 * @returns {Promise<void>}
 */
async function writeSelection(map) {
  const path = selectionFile();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(map, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * The services this tenant chose to mount, if they chose at all.
 * @param {string} namespace - the tenant's namespace.
 * @returns {Promise<string[] | undefined>} the chosen names, or undefined when
 *   the tenant follows the aggregate endpoint.
 */
export async function mcphubSelection(namespace) {
  const map = await readSelection();
  const value = map[namespace];
  return Array.isArray(value) ? value : undefined;
}

/**
 * Record which services the Agent mounts for one tenant.
 * @param {string} namespace - the tenant's namespace.
 * @param {readonly string[] | undefined} names - the chosen services, or
 *   undefined to fall back to the aggregate endpoint.
 * @returns {Promise<string[] | undefined>} what was recorded.
 */
export async function saveMcphubSelection(namespace, names) {
  const map = await readSelection();
  if (names === undefined) {
    delete map[namespace];
    await writeSelection(map);
    return undefined;
  }
  const chosen = [...new Set(names)]
    .filter((name) => SERVER_NAME.test(name))
    .slice(0, MAX_SELECTION);
  map[namespace] = chosen;
  await writeSelection(map);
  return chosen;
}

/**
 * Write this tenant's per-service patch, so the Agent mounts exactly the chosen
 * services instead of the aggregate endpoint.
 *
 * The file names this gateway's capability, never MCPHub: both the URL and the
 * key stay `!!js` expressions the loader evaluates from the instance's own
 * environment, so the key is never written to disk and a key rotated at the
 * next launch needs no rewrite beyond the file this launch already wrote.
 * @param {{
 *   namespace: string,
 *   home: string,
 *   linuxName: string,
 *   jailHome: string,
 *   uid: number,
 * }} options - the tenant, in both the host's and the jail's view of its home.
 * @returns {Promise<{ patch?: string, env?: Record<string, string> }>} the
 *   `--patch` argument plus the variable that retires the aggregate row, or
 *   nothing when the tenant follows the aggregate endpoint.
 */
export async function mcphubLaunchPatch(options) {
  const { namespace, home, linuxName, jailHome, uid } = options;
  const path = join(home, PATCH_RELATIVE);
  const selected = await mcphubSelection(namespace);
  if (selected === undefined) {
    await rm(path, { force: true });
    return {};
  }
  // An overlay is a loader patch list, not a plugin tree: rows arrive inside an
  // `insert` op, and a list with nothing to add is the empty array. Getting
  // this shape wrong is not a small mistake — the launcher refuses the file and
  // the workspace never boots, so it is asserted by a test.
  const body = selected.length === 0
    ? `${PATCH_HEADER}\n[]\n`
    : `${PATCH_HEADER}\n- insert:\n${selected.map(insertRow).join('')}`;
  if (!isLaunchPatch(body)) {
    // Refusing to hand over a document the launcher would reject is the only
    // way this module can be sure it never keeps a workspace down.
    console.error(`mcphub selection patch refused for ${linuxName}: not a loader patch list`);
    return {};
  }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, body, { mode: 0o600 });
  } catch (error) {
    // A workspace that cannot boot is worse than one that lost a preference:
    // an unwritable overlay leaves the tenant on the aggregate endpoint.
    console.error(`mcphub selection patch not written for ${linuxName}:`, error?.message ?? error);
    return {};
  }
  await handOver(path, uid, linuxName);
  return { patch: `${jailHome}/.dsh/profiles/web/mcphub.patch.yml`, env: { VH_MCPHUB_SELECT: '1' } };
}

/** The comment header every generated overlay carries. */
const PATCH_HEADER = `# Generated by the v-harness gateway from this tenant's MCP service choice.
# Removed again, by the next launch, when the tenant follows the aggregate endpoint.`;

/**
 * One `insert` list item mounting a service through the gateway capability.
 * @param {string} name - the MCPHub service name, already checked.
 * @returns {string} the YAML lines, each ending in a newline.
 */
function insertRow(name) {
  return [
    `    - id: mcp-mcphub-${name}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        transport: streamable-http',
    `        serverName: '${name}'`,
    `        url: !!js "process.env.VH_MCPHUB_ENDPOINT + '/mcp/${name}'"`,
    `        headers: !!js "({ authorization: 'Bearer ' + process.env.VH_MCPHUB_KEY })"`,
    '        toolCallTimeoutMs: 120000',
    '',
  ].join('\n');
}

/**
 * Whether a generated overlay is the document the launcher accepts.
 *
 * Checked against the shape the launcher requires — a top-level list of patch
 * entries — because that is the failure that takes a workspace down: the file
 * is refused before a single row is read, and nothing else in this module can
 * notice. The generator's output is verified here rather than trusted.
 * @param {string} text - the document about to be written.
 * @returns {boolean} whether it may be handed to `--patch`.
 */
export function isLaunchPatch(text) {
  const lines = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
  if (lines.length === 1 && lines[0] === '[]') return true;
  if (lines[0] !== '- insert:') return false;
  const rest = lines.slice(1);
  if (!rest.some((line) => /^ {4}- id: /u.test(line))) return false;
  return rest.every((line) => /^ {4}- id: [\w.$~%-]+$/u.test(line) || /^ {6,}\S/u.test(line));
}

/**
 * Remove the overlay, so the next launch runs without a service choice.
 * @param {{ home: string }} options - the tenant home the overlay lives in.
 * @returns {Promise<void>}
 */
export async function dropMcphubLaunchPatch(options) {
  await rm(join(options.home, PATCH_RELATIVE), { force: true });
}

/**
 * Give one written file to the tenant, best effort.
 *
 * The landlord created it inside the tenant's own home, so a platform whose
 * gateway cannot chown still leaves a readable file; failing the launch over a
 * cosmetic owner would be worse than the owner being wrong.
 * @param {string} path - the file just written.
 * @param {number} uid - the tenant's uid.
 * @param {string} group - the tenant's group name.
 * @returns {Promise<void>}
 */
function handOver(path, uid, group) {
  return new Promise((resolve) => {
    execFile('chown', [`${String(uid)}:${group}`, path], (error) => {
      if (error) console.error(`mcphub selection patch ownership unchanged (${path}):`, error.message);
      resolve();
    });
  });
}

/**
 * The env that mounts the panel and the Agent's MCP connection.
 *
 * The panel is hidden by not being mounted at all: `cordis.patch.yml` disables
 * its row unless `VH_MCPHUB` is set, so an environment without MCPHub serves no
 * bundle and registers no Sidebar entry. Installing MCPHub later is picked up
 * by the instance's next restart.
 *
 * The Agent gets a capability URL that names this gateway, never MCPHub: the
 * key it carries resolves to one tenant here, and only this process ever holds
 * that tenant's VOS token.
 * @param {string} namespace - the tenant the capability belongs to.
 * @returns {Promise<{
 *   VH_MCPHUB?: string,
 *   VH_MCPHUB_ENDPOINT?: string,
 *   VH_MCPHUB_KEY?: string,
 *   VH_MCPHUB_ROUTING?: string,
 * }>} the variables, or nothing when MCPHub is absent.
 */
export async function mcphubEnvironment(namespace) {
  const target = await upstream(false);
  if (target === undefined) return {};
  return {
    VH_MCPHUB: '1',
    VH_MCPHUB_ENDPOINT: `http://${GATEWAY_IP}:${String(process.env.PORT ?? 8080)}/__vh/mcphub/agent`,
    VH_MCPHUB_KEY: issueKey(namespace),
    VH_MCPHUB_ROUTING: mcphubRouting(),
  };
}

/**
 * The routing mode this deployment chose for the Agent's connection.
 *
 * `smart` asks MCPHub's vector router for a per-request tool subset, which only
 * answers when MCPHub runs in database mode with an embedding provider. It is a
 * deployment decision, never a per-tenant one: a tenant able to flip it would
 * silently lose every tool on a JSON-mode MCPHub.
 * @returns {'all' | 'smart'} the mode the Agent connects with.
 */
export function mcphubRouting() {
  return process.env.MCPHUB_ROUTING === 'smart' ? 'smart' : 'all';
}

/**
 * Mint this tenant's capability key, retiring the previous one.
 * @param {string} namespace - the tenant the key belongs to.
 * @returns {string} the new key.
 */
function issueKey(namespace) {
  const previous = keys.get(namespace);
  if (previous !== undefined) tenants.delete(previous);
  const key = randomBytes(32).toString('hex');
  keys.set(namespace, key);
  tenants.set(key, namespace);
  return key;
}

/**
 * Whether a response header is one the MCP transport needs back.
 * @param {string} name - the upstream header name.
 * @returns {boolean} whether to copy it to the browser-facing response.
 */
function isForwardedResponseHeader(name) {
  return name === 'mcp-session-id' || name === 'mcp-protocol-version';
}

/**
 * Proxy one MCP request to MCPHub under the tenant's own token.
 *
 * The Streamable HTTP transport keeps one `mcp-session-id` per connection and
 * streams replies, so the session header is echoed back, the body is piped
 * without buffering, and the socket gets no idle timeout.
 * @param {string} namespace - the tenant the capability belongs to.
 * @param {import('node:http').IncomingMessage} req - the tenant's request.
 * @param {import('node:http').ServerResponse} res - the tenant's response.
 * @param {string} rest - the path after `/__vh/mcphub/agent`, e.g. `/mcp`.
 * @returns {Promise<void>}
 */
async function forward(namespace, req, res, rest) {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  // The route test runs on the path alone; the query string is carried over to
  // the upstream separately.
  const path = rest.split('?')[0];
  if (!MCP_METHODS.has(method)) {
    refuse(req, res, 405, { error: 'method-not-allowed', message: 'MCP 只接受 POST、GET、DELETE' });
    return;
  }
  // Only the MCP surface passes: `/api/*` on MCPHub is a dashboard API with
  // different authorization, and must never be reachable through a capability.
  if (!MCP_PATH.test(path)) {
    refuse(req, res, 403, { error: 'route-not-allowed', message: '该路径不在 MCP 能力范围内' });
    return;
  }

  const target = await upstream(false);
  if (target === undefined) {
    refuse(req, res, 503, { error: 'mcphub-unreachable', message: 'MCPHub 不可达' });
    return;
  }
  const token = await accessTokenFor(namespace);
  if (token === undefined || token === '') {
    refuse(req, res, 401, {
      error: 'vos-token-unavailable',
      message: 'VOS 登录令牌缺失或已过期，请在 v-harness 页面刷新后重试',
    });
    return;
  }

  /** @type {Record<string, string>} */
  const headers = {};
  const accept = String(req.headers.accept ?? '');
  headers.accept = accept.includes('text/event-stream')
    ? accept
    : `${accept === '' ? '' : `${accept}, `}application/json, text/event-stream`;
  for (const name of ['content-type', 'content-length', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  headers.authorization = `Bearer ${token}`;

  await new Promise((resolve) => {
    const outgoing = httpRequest(
      new URL(`${target}${path}${url.search}`),
      { method, headers },
      (incoming) => {
        /** @type {Record<string, string>} */
        const reply = {
          'content-type': incoming.headers['content-type'] ?? 'application/json',
          'cache-control': 'no-store',
        };
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string' && isForwardedResponseHeader(name)) reply[name] = value;
        }
        res.writeHead(incoming.statusCode ?? 502, reply);
        incoming.pipe(res);
        incoming.on('end', () => { failures = 0; resolve(); });
        incoming.on('error', resolve);
      },
    );
    // A tool call stays open while the upstream works; the transport's own
    // stream is what keeps the connection alive, so the socket takes no
    // timeout of its own.
    outgoing.setTimeout(0);
    outgoing.on('error', (error) => {
      console.error(`mcphub upstream failed (${namespace} ${method} ${path}):`, error?.message ?? error);
      upstreamFailed();
      if (!res.headersSent) json(res, 502, { error: 'mcphub-unreachable' });
      else res.destroy();
      resolve();
    });
    res.on('close', () => { outgoing.destroy(); resolve(); });
    req.pipe(outgoing);
  });
}

/**
 * Serve one `/__vh/mcphub/agent/<rest>` tenant request.
 *
 * The caller is a dsh instance, so the credential is the capability key the
 * gateway minted for that instance — never a cookie, and never a VOS token.
 * @param {import('node:http').IncomingMessage} req - the tenant's request.
 * @param {import('node:http').ServerResponse} res - the tenant's response.
 * @param {string} rest - the path after `/__vh/mcphub/agent`.
 * @returns {Promise<void>}
 */
export async function handleAgent(req, res, rest) {
  const key = String(req.headers.authorization ?? '').replace(/^Bearer /u, '').trim();
  const namespace = tenants.get(key);
  if (namespace === undefined) {
    refuse(req, res, 401, { error: 'capability-key-required', message: 'MCP 能力键无效' });
    return;
  }
  await forward(namespace, req, res, rest === '' ? '/mcp' : rest);
}

/**
 * Refuse a request without leaving its body unread on the socket.
 * @param {import('node:http').IncomingMessage} req - the request being refused.
 * @param {import('node:http').ServerResponse} res - the response to write.
 * @param {number} status - the HTTP status.
 * @param {Record<string, unknown>} payload - the body.
 */
function refuse(req, res, status, payload) {
  // A refusal that never reads the body makes Node tear the connection down
  // mid-request, which the transport reports as a transport error rather than
  // the fault it actually is.
  req.resume();
  json(res, status, payload);
}

/**
 * Write a JSON refusal or read fault.
 * @param {import('node:http').ServerResponse} res - the response to write.
 * @param {number} status - the HTTP status.
 * @param {Record<string, unknown>} payload - the body.
 */
function json(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength) });
  res.end(body);
}
