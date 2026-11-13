/** VOS-authenticated access to a tenant's DSH session controller. */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

export const AGENT_API_PREFIX = '/__vh/api/v1/';
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ROUTE = /^sessions\/([A-Za-z0-9_-]{1,128})\/(prompts|events)$/;

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function invalid() {
  throw new ApiError(400, 'invalid-request');
}

async function objectBody(req, keys, readBody) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'json-required');
  }
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    if (error?.code === 'body-too-large') throw new ApiError(413, 'body-too-large');
    invalid();
  }
  if (Object.keys(body).some(key => !keys.includes(key))) invalid();
  return body;
}

function cursor(query, name, minimum) {
  if (!query.has(name)) return undefined;
  const value = query.get(name);
  if (query.getAll(name).length !== 1 || !/^-?\d+$/.test(value)) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) invalid();
  return number;
}

function publicEvent({ event }) {
  const { seq, time, type, data } = event;
  if (type === 'assistant/message') {
    const text = data.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
    return text ? { seq, time, type: 'assistant-text', turn: data.turn, text } : undefined;
  }
  if (type === 'turn/end') {
    const kind = data.reason.kind;
    const outcome = ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked'].includes(kind)
      ? kind : 'other';
    return { seq, time, type: 'turn-ended', turn: data.turn, outcome };
  }
  if (type === 'user/message' && typeof data.source?.rpcId === 'string') {
    return { seq, time, type: 'prompt-recorded', requestId: data.source.rpcId };
  }
  return undefined;
}

export async function handleAgentApi(req, res, url, { authenticate, readBody, call, json }) {
  try {
    const path = url.pathname.slice(AGENT_API_PREFIX.length);
    const create = path === 'sessions';
    const match = SESSION_ROUTE.exec(path);
    if (!create && !match) throw new ApiError(404, 'route-not-found');
    const events = match?.[2] === 'events';
    const method = events ? 'GET' : 'POST';
    if (req.method !== method) {
      json(res, 405, { error: 'method-not-allowed' }, { allow: method });
      return;
    }
    const tenant = await authenticate(req);
    if (!tenant) throw new ApiError(401, 'invalid-token');
    if (!events && url.search) invalid();
    if (create) {
      const { workspaceId } = await objectBody(req, ['workspaceId'], readBody);
      if (workspaceId !== undefined && (typeof workspaceId !== 'string' || !IDENTIFIER.test(workspaceId))) invalid();
      const { sessionId } = await call(tenant, 'session/create', workspaceId === undefined ? {} : { workspaceId });
      json(res, 201, { sessionId });
      return;
    }
    const sessionId = match[1];
    if (!events) {
      const { text, requestId } = await objectBody(req, ['text', 'requestId'], readBody);
      if (typeof text !== 'string' || !text.trim() || typeof requestId !== 'string' || !IDENTIFIER.test(requestId)) invalid();
      await call(tenant, 'session/prompt', { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] });
      json(res, 202, { requestId, accepted: true });
      return;
    }
    if ([...url.searchParams.keys()].some(key => key !== 'beforeSeq' && key !== 'throughSeq')) invalid();
    const beforeSeq = cursor(url.searchParams, 'beforeSeq', 0);
    const throughSeq = cursor(url.searchParams, 'throughSeq', -1);
    const page = await call(tenant, 'session/events', {
      address: { kind: 'session', sessionId },
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      ...(throughSeq === undefined ? {} : { throughSeq }),
    });
    json(res, 200, {
      cursor: page.cursor,
      beforeSeq: page.hasMore ? page.records[0].event.seq : null,
      events: page.records.map(publicEvent).filter(event => event !== undefined),
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    json(res, error.status, { error: error.code });
  }
}

export async function callSessionController(origin, cookie, endpoint, request) {
  const rpcId = randomUUID();
  const target = new URL('/api/' + endpoint, origin);
  const signal = AbortSignal.timeout(30_000);
  const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: { request } } });
  let envelope;
  try {
    const response = await new Promise((resolve, reject) => {
      // The tenant binds its auth cookie to this authority, as in the UI proxy.
      const upstream = httpRequest(target, {
        method: 'POST', signal,
        headers: { host: `127.0.0.1:${target.port}`, cookie, 'content-type': 'application/json' },
      }, resolve);
      upstream.on('error', reject);
      upstream.end(body);
    });
    if (response.statusCode !== 200) {
      response.resume();
      throw new ApiError(502, 'controller-unavailable');
    }
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (signal.aborted) throw new ApiError(504, 'controller-timeout');
    console.warn('Agent API controller transport failed:', endpoint, error?.code ?? error?.name);
    throw new ApiError(502, 'controller-unavailable');
  }
  if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) {
    throw new ApiError(502, 'controller-unavailable');
  }
  if (envelope.result?.ok === true) return envelope.result.value;
  switch (envelope.result?.error?.code) {
    case 'session/not-found':
    case 'workspace/not-found':
    case 'remote-access/denied':
      throw new ApiError(404, 'resource-not-found');
    case 'gateway/bad-request':
    case 'gateway/input-invalid':
      throw new ApiError(400, 'invalid-request');
    case 'session/agent-busy':
    case 'session/writer-held':
      throw new ApiError(409, 'session-busy');
    case 'gateway/service-unavailable':
    case 'gateway/internal':
    case undefined:
      throw new ApiError(502, 'controller-unavailable');
    default:
      throw new ApiError(422, 'operation-rejected');
  }
}

export function unavailableIdentity() {
  return new ApiError(502, 'identity-unavailable');
}

export function unavailableInstance() {
  return new ApiError(503, 'instance-unavailable');
}
