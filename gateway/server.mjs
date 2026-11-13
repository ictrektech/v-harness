/**
 * v-harness gateway: VOS SSO front door and per-user dsh reverse proxy.
 *
 * Request flow:
 *   1. A request with no session at all receives the bootstrap page, which runs
 *      the VOS Fastpath exchange and posts the access token to `/__vh/session`.
 *   2. `/__vh/session` verifies that token through VOS userinfo, ensures the
 *      user's instance exists, and mints a signed `vh_session` cookie.
 *   3. Every later request is forwarded to that user's instance over the
 *      address its network namespace is published on, with the browser Cookie
 *      replaced by the instance's own dsh cookie and Host rewritten to
 *      `127.0.0.1:<port>` (the authority dsh signed that cookie for).
 *   4. A shell navigation is served first and asks the platform second: it arms
 *      `identityGate`, the injected `/__vh/verify.js` fetches the answer in the
 *      background, and the navigation's data requests wait for it rather than
 *      being served from an answer nobody has confirmed. A different account is
 *      terminal — the page reloads into the tenant it now belongs to.
 *
 * @module v-harness/gateway/server
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';

import { IdentityGate, mayServe } from './identity-gate.mjs';
import {
  CAPABILITY_ENV,
  capabilityContractFor,
  readAuthoritativeContract,
  rememberCapabilityContract,
  removeCapabilityContract,
} from './capability-registry.mjs';
import { startOwnedCapabilities } from './capability-ownership.mjs';
import { capabilitiesPluginShipped } from './plugins.mjs';
import { EGRESS_PREFIX, egressRefusal, handleEgress } from './egress.mjs';

import {
  WorkspaceError,
  listWorkspace,
  openWorkspaceFile,
  statWorkspace,
  uploadWorkspaceFile,
} from './files.mjs';
import {
  ensureInstance,
  instanceAnswers,
  invalidateInstance,
  launchFailure,
  readyBoot,
  liveInstance,
  migrateInstanceStateKeys,
  primeInstanceBoots,
  stopAll,
  stopInstance,
  userPaths,
  waitForFreePort,
} from './instances.mjs';
import { instanceAddress, tenantLoopback } from './addressing.mjs';
import {
  closeOfficeCapabilities,
  editorUrlFor,
  ensureOfficeCapability,
  forgetOfficeCapability,
  handleOfficeEgress,
  listDocuments,
  rememberOrigin,
} from './office.mjs';
import {
  accessTokenFor,
  expiryFromToken,
  forgetTokens,
  hasUsableTokens,
  initTokenStore,
  rememberTokens,
  rememberApiAccessToken,
} from './vos-token-store.mjs';
import {
  closeAlbumCapabilities,
  ensureAlbumCapability,
  forgetAlbumCapability,
  handleAlbumEgress,
} from './album.mjs';
import {
  closeImageStudioCapabilities,
  ensureImageStudioCapability,
  forgetImageStudioCapability,
  handleImageStudioEgress,
} from './image-studio.mjs';
import {
  handleAgent as handleMcphubAgent,
  mcphubRouting,
  mcphubSelection,
  mcphubServerAction,
  mcphubServices,
  mcphubTools,
  restoreMcphubKey,
  saveMcphubSelection,
} from './mcphub.mjs';
import {
  closePhotocraftCapabilities,
  ensurePhotocraftCapability,
  forgetPhotocraftCapability,
  handlePhotocraft,
} from './photocraft.mjs';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  cookie,
  csrfMatches,
  newCsrfToken,
  openSessionStore,
  parseCookies,
} from './session.mjs';
import { DECODABLE_ENCODINGS, injectShell } from './shell-inject.mjs';
import { findUser, listUsers, upsertUser } from './users.mjs';
import { VosAuthError, userinfoUrl, verifyVosToken } from './vos-auth.mjs';
import { createVosOps, OPS_PATH } from './vos-ops.mjs';
import { AGENT_API_PREFIX, callSessionController, handleAgentApi, unavailableIdentity, unavailableInstance } from './agent-api.mjs';
import {
  closeWeknoraCapabilities,
  ensureWeknoraCapability,
  forgetWeknoraCapability,
  handleWeknoraControl,
  handleWeknoraEgress,
} from './weknora.mjs';
import {
  closeServicesCapabilities,
  ensureServicesCapability,
  forgetServicesCapability,
  handleServicesEgress,
  initServices,
  listServices,
  restartService,
  resolveService,
  stopService,
} from './services.mjs';
import { closeDockerCapabilities, ensureDockerCapability, resolveContainerPort } from './docker-proxy.mjs';
import { handleScheduler, restoreSchedulerKey } from './scheduler.mjs';
import { readRegistry } from './instance-state.mjs';

// Tenant homes live in <DATA_ROOT>/<account>, and nothing else does: the gateway's
// own state (user table, instance cookies, logs, capability sockets) sits in
// one hidden sibling that no tenant can reach.
const DATA_ROOT = process.env.DATA_ROOT ?? '/data';
const STATE_ROOT = process.env.STATE_ROOT ?? join(DATA_ROOT, '.vh');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const USERS_FILE = process.env.USERS_FILE ?? join(STATE_ROOT, 'users.json');
const STATE_FILE = process.env.STATE_FILE ?? join(STATE_ROOT, 'state-instances.json');
const SESSION_DB_FILE = process.env.SESSION_DB_FILE ?? join(STATE_ROOT, 'sessions.db');
// VOS credentials live beside the session DB in the root-only state directory,
// never in a tenant home; the store itself enforces 0600.
const VOS_TOKENS_FILE = process.env.VOS_TOKENS_FILE ?? join(STATE_ROOT, 'vos-tokens.json');
const DSH_BIN = process.env.DSH_BIN ?? '/opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
const NODE_BIN = process.env.NODE_BIN ?? process.execPath;
const USER_HELPER = process.env.USER_HELPER ?? '/opt/v-harness/bin/vh-userctl';
const CLIENT_ID = process.env.VOS_OIDC_CLIENT_ID ?? 'com.ictrek.v-harness';
const SCOPE = process.env.VOS_OIDC_SCOPE ?? 'openid profile email';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 12 * 60 * 60 * 1_000);
const APP_BASE_PATH = process.env.APP_BASE_PATH ?? '/app/com.ictrek.v-harness';
const MAX_AUTH_BODY = 8 * 1024;
// Standalone debugging escape hatch, mirroring V_OFFICE_AUTH_DISABLED: skip
// VOS entirely and sign in as one local user. Never enable it on VOS.
const AUTH_DISABLED = /^(1|true|yes)$/i.test(process.env.VH_AUTH_DISABLED ?? '');
const DEV_SUBJECT = 'local-dev';
const DEV_NAMESPACE = createHash('sha256').update(`vos-oidc\0${DEV_SUBJECT}`).digest('hex').slice(0, 40);

/**
 * How long one navigation's data requests wait for the background identity
 * answer. The answer is two platform round trips when it arrives at all; past
 * this the request proceeds on the session it already has, because a platform
 * that cannot answer must not cost the user their workspace.
 */
const IDENTITY_WAIT_MS = Number(process.env.IDENTITY_WAIT_MS ?? 1_500);

/** How long a navigation stays armed with no answer at all. */
const IDENTITY_ARM_MS = Number(process.env.IDENTITY_ARM_MS ?? 6_000);

/** The background check every proxied HTML document loads. */
const VERIFY_SCRIPT_PATH = '/__vh/verify.js';

/**
 * One navigation, one background answer about who is signed in. The shell is
 * served without asking; the page settles this gate afterwards, and data
 * requests wait here rather than being served from an unconfirmed answer.
 */
const identityGate = new IdentityGate({ waitMs: IDENTITY_WAIT_MS, armMs: IDENTITY_ARM_MS });

/**
 * The check itself, read once. A deployment missing the file degrades to the
 * previous behaviour — no answer, and the gate times out — instead of failing
 * every navigation.
 */
const VERIFY_SCRIPT = await readFile(new URL('./pages/verify.js', import.meta.url), 'utf8')
  .catch((error) => {
    console.error('identity check script unavailable:', error instanceof Error ? error.message : String(error));
    return '';
  });

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

/**
 * Tenant identity as the services registry needs it, recovered from the
 * contract that authorized the request.
 * @param {import('./capability-registry.mjs').CapabilityContractRecord} contract
 * @returns {{ subject: string, account: string, uid: number } | undefined}
 */
function egressTenant(contract) {
  const { subject, account, uid } = contract;
  if (typeof subject !== 'string' || typeof account !== 'string' || !Number.isInteger(uid)) return undefined;
  return { subject, account, uid };
}

/**
 * Capability name → the gateway-side handler `/__vh/egress/*` dispatches to.
 *
 * Each module owns its route table and upstream; this table only decides which
 * module a delegated capability reaches. A name without a handler is refused
 * by the egress transport instead of guessed.
 */
const EGRESS_HANDLERS = {
  voffice: handleOfficeEgress,
  album: handleAlbumEgress,
  photocraft: handlePhotocraft,
  'image-studio': handleImageStudioEgress,
  weknora: handleWeknoraEgress,
  'vh-services': (_namespace, req, res, contract) => handleServicesEgress(egressTenant(contract), req, res),
};

const sessions = await openSessionStore(SESSION_DB_FILE, { ttlMs: SESSION_TTL_MS });
// Recover the VOS credentials a previous gateway left. Without this the
// capability endpoints answer 401 until every browser replays its own PKCE.
initTokenStore(VOS_TOKENS_FILE);
// One boot finishes the persistent-state key migration (namespace → subject);
// later boots find nothing to move and leave the file alone.
await migrateInstanceStateKeys(STATE_FILE, USERS_FILE);
// Tenant service registrations survive a gateway restart; a stopped service
// stays listed so the UI can offer restart.
await initServices({ stateRoot: STATE_ROOT });
// A previous gateway may have left healthy tenant processes behind. Recover
// their boot identities and the capability keys already baked into their env
// before the first request can ask for either.
const instanceRegistry = await readRegistry(STATE_FILE);
primeInstanceBoots(instanceRegistry);
// Whether this image mounts the tenant capability transport at all. A payload
// without it must neither honour a contract nor leave one behind: the gateway
// owns the sockets, and a stale contract would keep a future plugin listening
// on paths this gateway is bound to.
const CAPABILITIES_SHIPPED = await capabilitiesPluginShipped();
for (const record of await listUsers(USERS_FILE)) {
  const entry = instanceRegistry[record.subject];
  if (entry?.schedulerKey) restoreSchedulerKey(record.namespace, entry.schedulerKey);
  if (entry?.mcphubKey) restoreMcphubKey(record.namespace, entry.mcphubKey);
  // A tenant whose dsh owns a capability socket proves it with the
  // authoritative contract the previous gateway wrote under STATE_ROOT. The
  // delivery copy in the tenant home carries no authority: rebuilding this
  // index from it would let a tenant mint its own key.
  const home = userPaths(STATE_ROOT, record.account ?? record.linuxName).home;
  if (!CAPABILITIES_SHIPPED) {
    await removeCapabilityContract({ stateRoot: STATE_ROOT, home, subject: record.subject })
      .catch((error) => { console.error(`capability contract cleanup failed for ${record.namespace}:`, error); });
  } else {
    const contract = await readAuthoritativeContract(STATE_ROOT, record.subject);
    if (contract !== undefined) {
      rememberCapabilityContract(record.subject, {
        home,
        namespace: record.namespace,
        subject: record.subject,
        account: record.account ?? record.linuxName,
        uid: record.uid,
        ...contract,
      });
      console.log(
        `capabilities delegated to the tenant plugin (${record.namespace}): ${contract.capabilities.join(', ')}`,
      );
    }
  }
  // Rebuild capability sockets now, not on the first request: a dsh that
  // survived the previous gateway may already be running an agent turn, and
  // its skill CLI would otherwise hit a stale socket during the restart. A
  // delegated socket is only taken back when the tenant is proven running:
  // a tenant that never signed in since this boot cannot call it either, and
  // taking it would fight the plugin its next launch starts.
  void startCapabilities(record, { requireRunning: true }).catch((error) => {
    console.error(`capability warm-up failed for ${record.namespace}:`, error);
  });
}

/**
 * Whether the browser reached us over HTTPS (terminated by the VOS ingress).
 *
 * The ingress does not always forward `x-forwarded-proto`, and guessing wrong
 * towards HTTPS is expensive: `SameSite=None` without `Secure` is discarded by
 * the browser, so every request then arrives with an empty Cookie header. When
 * the proxy header is absent, fall back to what a browser always sends on its
 * own fetches — `Origin` on POST, `Referer` on GET.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isSecure(req) {
  const forced = process.env.VH_PUBLIC_HTTPS;
  if (forced === '1') return true;
  if (forced === '0') return false;
  const forwarded = req.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const proto = value?.split(',')[0]?.trim().toLowerCase();
  if (proto) return proto === 'https';
  if (req.socket?.encrypted) return true;
  for (const name of ['origin', 'referer']) {
    const header = req.headers[name];
    if (typeof header === 'string' && header.startsWith('https://')) return true;
  }
  // Nothing told us the scheme. The VOS ingress terminates TLS for every route
  // it proxies, and the frame it renders in may strip Referer, so assume HTTPS.
  // A deployment served over plain HTTP must set VH_PUBLIC_HTTPS=0; otherwise
  // the Secure cookie below is dropped and every request arrives sessionless.
  return true;
}

/**
 * Cookie attributes for every Set-Cookie this gateway emits.
 *
 * Inside the platform iframe a `Lax` cookie is not attached at all when the
 * frame is cross-site — that is the `cookie=` empty log, not a browser that
 * refuses to store it. `None` is required in that context, `Secure` is
 * mandatory alongside it, and `Partitioned` keeps the pair stored where
 * third-party cookies are blocked. Plain HTTP stays on `Lax`, because `None`
 * without `Secure` is the combination browsers throw away.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ secure?: boolean, partitioned?: boolean, sameSite?: 'Lax' | 'None' }}
 */
function cookiePolicy(req) {
  if (!isSecure(req)) return { sameSite: 'Lax' };
  return { secure: true, partitioned: true, sameSite: 'None' };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {import('./session.mjs').Session | undefined}
 */
function authenticate(req) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = req.headers['x-vh-session'];
  const header = typeof raw === 'string' && raw !== '' ? raw : undefined;
  const userAgent = String(req.headers['user-agent'] ?? '');
  // The cookie is what the proxied UI relies on; the header is the fallback for
  // the bootstrap page, which cannot count on a cookie having been stored. A
  // cookie naming a ticket already retired (the account that signed in before)
  // must not shadow that fallback, or sign-in would loop on a browser that
  // refused the new cookie.
  const fromCookie = sessions.loadSession(cookies[SESSION_COOKIE], userAgent);
  if (fromCookie) return fromCookie;
  return header === undefined ? undefined : sessions.loadSession(header, userAgent);
}

/** Per-session VOS subject re-check results: sid → { subject, checkedAt }. */
const SUB_RECHECK_MS = Number(process.env.SUB_RECHECK_MS ?? 5 * 60 * 1_000);
const subChecks = new Map();

/**
 * Re-prove that the stored VOS token still belongs to the session's subject.
 *
 * The cookie outlives the VOS token in memory, and an account kicked on the
 * VOS side must not keep routing. Throttled: one userinfo round trip per
 * session per window. A down endpoint fails open (throttled by the same
 * window); a subject mismatch revokes the session and fails closed.
 *
 * `no-token` is deliberately *not* a refusal any more. It is the state of every
 * process that has just started, and answering it as "unauthenticated" is what
 * turned a restart into a sign-in wall for every tenant. The session still names
 * a tenant, the shell carries no data, and the background check repopulates the
 * token on the very navigation that would have been refused.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./users.mjs').UserRecord} record
 * @returns {Promise<'ok' | 'no-token' | 'drift'>} how far the check got.
 */
async function subjectRecheck(session, record) {
  const now = Date.now();
  const cached = subChecks.get(session.sid);
  if (cached && cached.subject === session.subject && now - cached.checkedAt < SUB_RECHECK_MS) {
    return 'ok';
  }
  subChecks.set(session.sid, { subject: session.subject, checkedAt: now });
  if (AUTH_DISABLED) return 'ok';
  const token = await accessTokenFor(record.namespace);
  // This process holds no token for the tenant: after a restart, or once VOS
  // refused a refresh. It cannot prove the session wrong, so it does not.
  if (token === undefined) return 'no-token';
  try {
    const identity = await verifyVosToken(token);
    if (identity.subject !== session.subject) {
      sessions.revokeSession(session.sid);
      console.warn(`sub recheck: session drift for ${record.account ?? record.linuxName}, revoked`);
      return 'drift';
    }
    return 'ok';
  } catch (error) {
    // VOS answered and refused this identity (rejected token, 401/403 from
    // userinfo): the session's subject is gone. Fail closed for this session
    // only — the other tenants keep theirs.
    if (error instanceof VosAuthError
      && (error.code === 'vos-token-rejected'
        || (error.code === 'vos-userinfo-status' && (error.status === 401 || error.status === 403)))) {
      sessions.revokeSession(session.sid);
      console.warn(`sub recheck: token refused for ${record.account ?? record.linuxName} (${error.code}), session revoked`);
      return 'drift';
    }
    // Everything else — unreachable endpoint, 5xx, malformed payload — is a
    // VOS outage, not an identity verdict. A hiccup must not sign every
    // tenant out, so fail open; the recheck window throttles the retry.
    console.warn(`sub recheck unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return 'ok';
  }
}

/**
 * Strip the VOS application prefix so the same routes work behind either a
 * prefix-preserving or a prefix-stripping ingress.
 * @param {string} url
 * @returns {string}
 */
function stripPrefix(url) {
  if (!APP_BASE_PATH) return url;
  if (url === APP_BASE_PATH) return '/';
  if (url.startsWith(`${APP_BASE_PATH}/`) || url.startsWith(`${APP_BASE_PATH}?`)) {
    const rest = url.slice(APP_BASE_PATH.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return url;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function json(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_AUTH_BODY) throw new VosAuthError('body-too-large', 'auth body exceeds limit');
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VosAuthError('invalid-body', 'auth body must be a JSON object');
  }
  return parsed;
}

/** Bootstrap page that performs the Fastpath exchange inside the VOS iframe. */
const BOOTSTRAP = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>v-harness</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0d10;color:#c8ccd4;font:14px/1.7 system-ui,sans-serif}
#m{opacity:.8}#e{color:#e06c75;max-width:34rem;text-align:center;white-space:pre-wrap}</style>
</head><body><div id="m">正在接入平台身份…</div><div id="e"></div>
<script type="module">
const b64=(b)=>btoa(String.fromCharCode(...b)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const rand=(n=32)=>b64(crypto.getRandomValues(new Uint8Array(n)));
// crypto.subtle only exists in a secure context, and an internal VOS portal is
// often plain HTTP. PKCE still needs SHA-256 there, so carry a small one.
const K256=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
function sha256(data){
  const len=data.length, bits=len*8;
  const padded=new Uint8Array(((len+9+63)>>6)<<6);
  padded.set(data); padded[len]=0x80;
  const dv=new DataView(padded.buffer);
  dv.setUint32(padded.length-8,Math.floor(bits/0x100000000));
  dv.setUint32(padded.length-4,bits>>>0);
  const H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const w=new Uint32Array(64);
  for(let i=0;i<padded.length;i+=64){
    for(let t=0;t<16;t++) w[t]=dv.getUint32(i+t*4);
    for(let t=16;t<64;t++){
      const a=w[t-15],b=w[t-2];
      const s0=(rotr(a,7)^rotr(a,18)^(a>>>3));
      const s1=(rotr(b,17)^rotr(b,19)^(b>>>10));
      w[t]=(w[t-16]+s0+w[t-7]+s1)>>>0;
    }
    let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for(let t=0;t<64;t++){
      const S1=(rotr(e,6)^rotr(e,11)^rotr(e,25))>>>0;
      const ch=((e&f)^(~e&g))>>>0;
      const t1=(h+S1+ch+K256[t]+w[t])>>>0;
      const S0=(rotr(a,2)^rotr(a,13)^rotr(a,22))>>>0;
      const maj=((a&b)^(a&c)^(b&c))>>>0;
      const t2=(S0+maj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  const out=new Uint8Array(32);
  const odv=new DataView(out.buffer);
  for(let i=0;i<8;i++) odv.setUint32(i*4,H[i]);
  return out;
}
async function sha256Bytes(data){
  if(crypto.subtle) return new Uint8Array(await crypto.subtle.digest('SHA-256',data));
  return sha256(data);
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
// The portal injects the identity bridge into this iframe from the outside, so
// on a cold or busy portal it can lag well behind our own load. Waiting a few
// seconds used to fail the whole sign-in; the wait is now the length of a slow
// portal, with a message instead of a dead end.
async function bridge(waitMs){
  const direct=window.vos_platform?.api?.v1000?.oauth2;
  if(direct)return direct;
  if(window.parent===window)return null;
  const t0=Date.now();
  let announced=false;
  while(Date.now()-t0<waitMs){
    await sleep(100);
    const found=window.vos_platform?.api?.v1000?.oauth2;
    if(found)return found;
    if(!announced&&Date.now()-t0>1500){
      document.getElementById('m').textContent='正在等待平台注入身份组件…';
      announced=true;
    }
  }
  return null;
}
function fail(m){
  document.getElementById('m').textContent='无法进入 v-harness';
  document.getElementById('e').textContent=m;
}
// The platform SDK's fetches carry no timeout of their own; a portal that
// answers slowly or not at all used to hold the page on its first line for
// minutes. Every leg of the exchange now races a clock instead.
function withTimeout(promise,ms,tag){
  return Promise.race([
    promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error(tag+'超时，平台未响应')),ms)),
  ]);
}
async function authorize(cfg,waitMs){
  const oauth2=await bridge(waitMs===undefined?25000:waitMs);
  if(!oauth2)throw new Error('当前 VOS 未提供 OIDC Fastpath，无法验证用户身份');
  const verifier=rand(),state=rand();
  const digest=await sha256Bytes(new TextEncoder().encode(verifier));
  const authorized=await withTimeout(oauth2.authorize({
    client_id:cfg.clientId,response_type:'code',scope:cfg.scope,
    state,nonce:rand(),code_challenge:b64(digest),code_challenge_method:'S256'}),12000,'平台授权');
  if(authorized.state!==state)throw new Error('VOS OIDC state mismatch');
  const tokens=await withTimeout(oauth2.token({
    grant_type:'authorization_code',code:authorized.code,
    code_verifier:verifier,client_id:cfg.clientId}),12000,'平台令牌交换');
  if(!tokens.access_token)throw new Error('VOS OIDC 未返回 access token');
  const res=await fetch('/__vh/auth',{
    method:'POST',credentials:'include',signal:AbortSignal.timeout(15000),
    headers:{'content-type':'application/json','x-vh-csrf':cfg.csrf||''},
    body:JSON.stringify({access_token:tokens.access_token,
      refresh_token:tokens.refresh_token,expires_in:tokens.expires_in})});
  const body=await res.json().catch(()=>({})).then(v=>v||{});
  if(!res.ok)throw new Error(body.error||'VOS 登录失败');
  // Keep the session here as well: when the browser refuses the cookie this is
  // the only way the next request can still identify itself.
  if(body.session)try{sessionStorage.setItem('vh_session',body.session);}catch{}
}
function showRenew(error,cfg){
  const expired=isPortalExpired(error);
  document.getElementById('m').textContent=expired?'平台登录状态已过期':'登录状态已恢复，但能力授权已失效';
  const detail=document.getElementById('e');
  detail.textContent=(error?.message||String(error))+'。';
  detail.append(document.createElement('br'));
  if(expired){
    // The exchange is refused by the portal itself (无效的授权): waiting cannot
    // fix it, only a portal sign-in can. The button refreshes the portal page —
    // same origin, so the top reload is ours to make — and the background
    // watcher below still self-heals the moment the user signs in elsewhere.
    const hint=document.createElement('span');
    hint.textContent='需要在门户重新登录；登录后本页会自动恢复，无需手动刷新。';
    detail.append(hint,document.createElement('br'));
    const top=document.createElement('button');
    top.textContent='刷新门户并重试';
    top.onclick=()=>window.top.location.reload();
    detail.append(top);
  }else{
    const renew=document.createElement('button');
    renew.textContent='重新登录';
    renew.onclick=async()=>{await fetch('/__vh/logout',{method:'POST'});location.reload();};
    const skip=document.createElement('button');
    skip.textContent='仍然进入（部分能力不可用）';
    skip.onclick=()=>location.replace('/__vh/enter?to='+encodeURIComponent(location.pathname+location.search));
    detail.append(renew,skip);
  }
  recoverInBackground(cfg);
}
// The portal answers authorize/confirm with 无效的授权 (code 10001) when its
// own sign-in has lapsed. No amount of retrying fixes that here, so those
// failures skip the retry loop and get their own message and action. Plain
// substring checks, not a regex literal: this script lives inside a template
// literal, where an escape like \/ loses its backslash and a lone / would
// end the pattern early — a SyntaxError that killed the whole page.
function isPortalExpired(error){
  const message=error?.message||String(error);
  return message.includes('无效的授权')||message.includes('10001')||message.includes('/confirm');
}
function showFresh(error){
  const expired=isPortalExpired(error);
  document.getElementById('m').textContent=expired?'平台登录状态已过期':'无法完成平台登录';
  const detail=document.getElementById('e');
  detail.textContent=(error?.message||String(error))+'。';
  detail.append(document.createElement('br'));
  if(expired){
    const top=document.createElement('button');
    top.textContent='刷新门户并重试';
    top.onclick=()=>window.top.location.reload();
    detail.append(top);
  }
  const retry=document.createElement('button');
  retry.textContent='手动重试';
  retry.onclick=()=>location.reload();
  detail.append(retry);
}
// Shared by every dead end this page can reach, whatever the tenant asked for
// next: while the prompt is up, the page keeps watching for the portal bridge
// in the background; the moment the bridge appears the sign-in is retried and
// the original navigation resumes on its own. Five minutes of watching, ten
// seconds of backoff after each failed exchange, so a genuinely refusing VOS
// is not hammered.
function recoverInBackground(cfg){
  const t0=Date.now();
  const recover=async()=>{
    while(Date.now()-t0<300000){
      await sleep(3000);
      const oauth2=await bridge(0);
      if(!oauth2)continue;
      try{await authorize(cfg,1000);}
      catch(error){
        // The bridge is there and the exchange still failed, which is VOS
        // refusing rather than a slow portal: keep watching on a backoff
        // instead of spending an exchange on every tick.
        console.warn('vh bootstrap: background sign-in failed', error);
        await sleep(10000);
        continue;
      }
      location.reload();
      return;
    }
  };
  void recover();
}
// One failed exchange should not be the end: a busy portal recovers within
// seconds, so the sign-in is retried before the renew prompt is shown. A
// standalone tab (no portal around) can never gain the bridge, so it skips
// the retries instead of making the user wait for nothing.
async function authorizeWithRetry(cfg){
  const attempts=window.parent===window?1:3;
  const t0=Date.now();
  let last;
  for(let attempt=0;attempt<attempts;attempt++){
    try{return await authorize(cfg,25000);}catch(error){last=error;}
    // An expired portal sign-in survives every retry until the user signs in
    // again; fail fast into the prompt that says so instead of spinning.
    if(isPortalExpired(last))break;
    // A whole-exchange budget: with every leg clocked, the worst case still
    // lands on the actionable prompt inside a minute instead of spinning.
    if(attempt<attempts-1&&Date.now()-t0<60000){
      document.getElementById('m').textContent='平台身份验证失败，正在自动重试…';
      await sleep(1500*(attempt+1));
    }
  }
  throw last;
}
async function boot(){
  let saved='';
  try{saved=sessionStorage.getItem('vh_session')||'';}catch{}
  // A gateway hiccup (its own restart, a blip between containers) must not
  // dead-end the page either: the session read is retried before giving up.
  let cfg;
  for(let attempt=0;;attempt++){
    try{
      cfg=await(await fetch('/__vh/session',{
        credentials:'include',cache:'no-store',signal:AbortSignal.timeout(8000),
        headers:saved?{'x-vh-session':saved}:{}})).json();
      break;
    }catch(error){
      if(attempt>=4){fail('无法连接 v-harness 网关，自动重试未恢复，请稍后手动刷新');return;}
      document.getElementById('m').textContent='网关暂时不可达，正在自动重试…';
      await sleep(2000);
    }
  }
  if(cfg.session)try{sessionStorage.setItem('vh_session',cfg.session);}catch{}
  // Re-prove the signed-in VOS account on every load. The cookie only names
  // the tenant served last, so trusting it here is how two accounts in one
  // browser ended up sharing an instance. VOS silent auth answers "who is
  // signed in now", and /__vh/auth re-issues the cookie for that account.
  if(cfg.authenticated){
    try{await authorizeWithRetry(cfg);}
    catch(error){showRenew(error,cfg);return;}
    // Reload the page that asked, not the directory above it: the proof just
    // issued covers this navigation, and a deep link must survive the trip.
    // reload() keeps the whole URL (hash included) where replace(same url) can
    // collapse into a fragment change that never reaches the server.
    location.reload();
    return;
  }
  try{await authorizeWithRetry(cfg);}
  catch(error){showFresh(error);recoverInBackground(cfg);return;}
  location.reload();
}
boot().catch(error=>fail(error?.message||String(error)));
</script></body></html>`;

/**
 * @param {import('node:http').ServerResponse} res
 */
function sendBootstrap(res) {
  const body = Buffer.from(BOOTSTRAP, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
    'x-frame-options': 'SAMEORIGIN',
  });
  res.end(body);
}

/**
 * The page a navigation gets while its instance is still coming up.
 *
 * A replacing process answers nothing, and the browser is left holding whatever
 * the last byte was — a tab that reads as a white screen with no way back. This
 * page waits for the boot identity to appear and then loads the shell, so the
 * end of a restart is the app rather than a blank tab.
 */
/**
 * The waiting page must work when the app is mounted under a portal prefix.
 *
 * An absolute `/__vh/*` URL lands on the portal root there, not on the gateway,
 * so the boot probe can 404 while a cold launch is still running. The page
 * polls the prefixed probe and, when that is unavailable, fetches the document
 * in the background: both drive the launch, and neither reloads the tab until
 * the instance can actually serve the app (no flashing on a cold boot).
 * @returns {string}
 */
function startingPage() {
  const bootUrl = APP_BASE_PATH ? `${APP_BASE_PATH}/__vh/boot` : '/__vh/boot';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>v-harness</title>
<style>html{background:#0b0d10}body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0d10;color:#c8ccd4;font:14px/1.7 system-ui,sans-serif}
#w{text-align:center}
#m{opacity:.85;display:flex;gap:.6rem;align-items:center;justify-content:center}
#s{width:14px;height:14px;border:2px solid #2a2f38;border-top-color:#7aa2f7;border-radius:50%;animation:r .8s linear infinite}
#h{margin-top:1rem;color:#7d8492;font-size:12px;line-height:1.6}
@keyframes r{to{transform:rotate(360deg)}}</style>
</head><body><div id="w"><div id="m"><span id="s"></span><span>正在启动工作区…</span></div><div id="h"></div></div>
<script>
var BOOT_URL = ${JSON.stringify(bootUrl)};
var hint = document.getElementById('h');
var failed = '';
var handedOff = false;
var startedAt = Date.now();
try {
  var since = Number(sessionStorage.getItem('vh-starting-since') || 0);
  if (since && Date.now() - since < 300000) startedAt = since;
  else sessionStorage.setItem('vh-starting-since', String(startedAt));
} catch (e) { /* storage unavailable: count only this page load */ }
function waited() { return Math.round((Date.now() - startedAt) / 1000); }
var lastRetry = 0;
// One tab, one handoff. A broken arm boot used to answer the background
// document probe with an error page, and every probe reloaded the whole tab:
// the waiting page flashed for as long as the launch kept failing. Drive the
// launch in the background, but never reload while a failure is reported, and
// hand off to the workspace at most once.
function handoff() {
  if (handedOff) return;
  handedOff = true;
  location.reload();
}
function pokeDocument() {
  var now = Date.now();
  if (now - lastRetry < 10000) return;
  lastRetry = now;
  fetch(location.href.split('#')[0], {
    credentials: 'same-origin', cache: 'no-store', headers: { accept: 'text/html' }
  })
    .then(function (r) { return r.ok ? r.text() : ''; })
    .then(function (html) {
      if (!failed && html && html.indexOf('正在启动工作区') === -1) handoff();
    })
    .catch(function () {});
}
function poll() {
  if (handedOff) return;
  var w = waited();
  if (!failed) {
    if (w >= 60) hint.textContent = '启动时间较长（' + w + ' 秒），仍在自动重试…';
    else if (w >= 10) hint.textContent = '正在启动，已等待 ' + w + ' 秒…';
  }
  fetch(BOOT_URL, { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) { pokeDocument(); return; }
      if (typeof d.error === 'string' && d.error !== '') {
        failed = d.error;
        hint.textContent = '启动失败：' + d.error + '，仍在自动重试…';
        pokeDocument();
        return;
      }
      if (failed) { failed = ''; hint.textContent = ''; }
      if (typeof d.boot === 'number' && d.boot > 0) { handoff(); return; }
    })
    .catch(function () { pokeDocument(); });
  setTimeout(poll, 2000);
}
setTimeout(poll, 500);
</script></body></html>`;
}

/**
 * @param {import('node:http').ServerResponse} res
 */
function sendStarting(res) {
  const body = Buffer.from(startingPage(), 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
    'x-frame-options': 'SAMEORIGIN',
  });
  res.end(body);
}

/**
 * Whether the request is a browser navigation that should receive the
 * bootstrap page rather than a 401.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isDocumentRequest(req) {
  if (req.method !== 'GET') return false;
  const destination = req.headers['sec-fetch-dest'];
  if (destination === 'document' || destination === 'iframe' || destination === 'frame') return true;
  return String(req.headers.accept ?? '').includes('text/html');
}

/**
 * Whether the request is the workspace shell itself — the document at the app
 * root — rather than a document the tenant's dsh or one of its plugins serves.
 *
 * Only the shell carries the identity re-proof: it is the one document whose
 * answer decides which tenant the browser is inside. A plugin's own panel
 * (`/mcp-connector/ui/`) is rendered *inside* a tenant the session already
 * named, so sending it through the bootstrap page would replace the panel with
 * a login screen for no gain — and it is the reason a plugin panel used to
 * break every five minutes.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isShellDocument(req) {
  if (!isDocumentRequest(req)) return false;
  const path = stripPrefix(String(req.url ?? '/')).split('?')[0];
  return path === '/' || path === '/index.html';
}


/**
 * Resolve the caller's user record, or reply and return undefined.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<import('./users.mjs').UserRecord | undefined>}
 */
async function requireUser(req, res) {
  const session = authenticate(req);
  if (!session) {
    json(res, 401, { error: 'unauthenticated' });
    return undefined;
  }
  const record = await findUser(USERS_FILE, session.subject);
  if (!record) {
    json(res, 401, { error: 'unknown user' });
    return undefined;
  }
  // A missing token is not a verdict: the control endpoints answer with what the
  // tenant already has, and refusing them after a restart would take the
  // workspace down with the process.
  if (await subjectRecheck(session, record) === 'drift') {
    json(res, 401, { error: 'session revoked' });
    return undefined;
  }
  // Handed-out links must be absolute on the domain this tenant is browsing,
  // and only this tenant's requests may say what that domain is.
  rememberOrigin(req.headers, record.namespace);
  return record;
}

/**
 * Drawer endpoints: list, download, upload. All confined to `workspace/`.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<void>}
 */
async function handleFiles(req, res, url) {
  const record = await requireUser(req, res);
  if (!record) return;

  if (url.pathname === '/__vh/files' && req.method === 'GET') {
    try {
      const listing = await listWorkspace(record, url.searchParams.get('dir') ?? '');
      json(res, 200, listing);
    } catch (error) {
      json(res, 404, { error: error instanceof WorkspaceError ? error.message : 'cannot list directory' });
    }
    return;
  }

  if (url.pathname === '/__vh/files/raw' && req.method === 'GET') {
    const path = url.searchParams.get('path') ?? '';
    if (!path) {
      json(res, 400, { error: 'path is required' });
      return;
    }
    try {
      // Stat first: a missing file must answer 404 before any body byte is sent.
      const info = await statWorkspace(record, path);
      if (info.type !== 'file') {
        json(res, 400, { error: 'not a file' });
        return;
      }
      const name = path.split('/').pop() ?? 'download';
      const child = openWorkspaceFile(record, path);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(info.size),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'no-store',
      });
      child.stdout.pipe(res);
      child.stdout.on('error', () => res.destroy());
      child.on('close', (code) => { if (code !== 0) res.destroy(); });
    } catch (error) {
      json(res, 404, { error: error instanceof WorkspaceError ? error.message : 'not found' });
    }
    return;
  }

  if (url.pathname === '/__vh/files/upload' && req.method === 'POST') {
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site') {
      json(res, 403, { error: 'cross-site upload rejected' });
      return;
    }
    const dir = url.searchParams.get('dir') ?? '';
    const name = url.searchParams.get('name') ?? '';
    if (!name) {
      json(res, 400, { error: 'name is required' });
      return;
    }
    const child = uploadWorkspaceFile(record, dir, name);
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      json(res, 500, { error: error.message });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        json(res, 400, { error: stderr.trim() || 'upload rejected' });
        return;
      }
      try {
        json(res, 200, JSON.parse(output.trim()));
      } catch {
        json(res, 200, { ok: true });
      }
    });
    req.pipe(child.stdin);
    req.on('aborted', () => child.kill('SIGTERM'));
    return;
  }

  json(res, 404, { error: 'not found' });
}

/**
 * The tenant services list, for the browser panel: `GET /__vh/services`.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<void>}
 */
async function handleServices(req, res, url) {
  const record = await requireUser(req, res);
  if (!record) return;
  if (url.pathname === '/__vh/services' && req.method === 'GET') {
    json(res, 200, { services: listServices(record.subject) });
    return;
  }
  json(res, 404, { error: 'not found' });
}

/**
 * One state change on the tenant's own service: `POST /__vh/services/<port>/restart|stop`.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<void>}
 */
async function handleServiceAction(req, res, url) {
  const record = await requireUser(req, res);
  if (!record) return;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') {
    json(res, 403, { error: 'cross-site request rejected' });
    return;
  }
  const match = /^\/__vh\/services\/(\d+)\/(restart|stop)$/.exec(url.pathname);
  if (match === null || req.method !== 'POST') {
    json(res, 404, { error: 'not found' });
    return;
  }
  const port = Number(match[1]);
  const result = match[2] === 'restart'
    ? await restartService(record.subject, port)
    : stopService(record.subject, port);
  console.log(`service ${match[2]}: ${record.account ?? record.linuxName} port=${String(port)} -> ${String(result.status)}`);
  json(res, result.status, result.status === 200 ? { ok: true } : { error: result.error, message: result.message });
}

/**
 * Build upstream headers for one tenant-service request.
 *
 * The browser Cookie is dropped: the service belongs to the same tenant, but a
 * portal session cookie has no business being handed to whatever the tenant
 * happened to run.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} port
 * @returns {Record<string, string | string[]>}
 */
function serviceHeaders(req, port) {
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name)) continue;
    if (name === 'host' || name === 'cookie') continue;
    headers[name] = value;
  }
  headers.host = `127.0.0.1:${String(port)}`;
  const forwarded = req.socket.remoteAddress;
  if (forwarded) headers['x-forwarded-for'] = forwarded;
  headers['x-forwarded-proto'] = isSecure(req) ? 'https' : 'http';
  return headers;
}

/**
 * Resolve `/__vh/svc/<port>` to the address the gateway dials.
 *
 * A registered service comes first: registering is the tenant's explicit
 * statement about that port, and it listens on the container loopback the
 * gateway dials. Everything else is a container the tenant started: those
 * publish on the host's loopback instead (the create filter pins `HostIp`
 * there), because the host daemon runs them.
 * @param {string} subject
 * @param {number} port
 * @returns {Promise<{ host: string, port: number } | undefined>}
 */
async function serviceTarget(subject, port) {
  const record = resolveService(subject, port);
  if (record) return { host: tenantLoopback(record.uid), port };
  const user = await findUser(USERS_FILE, subject);
  if (!user) return undefined;
  return resolveContainerPort(user.account ?? user.linuxName, port);
}

/**
 * Proxy one request to a service the session's subject registered, or to a
 * container port the tenant published.
 * `/__vh/svc/<port>/<rest>` forwards to `<target>:<port>/<rest>`; a port that
 * is neither registered nor published answers 404 here — that table, not the
 * network, decides what is reachable.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<void>}
 */
async function proxyServiceRequest(req, res, url) {
  const session = authenticate(req);
  if (!session) {
    if (isDocumentRequest(req)) {
      sendBootstrap(res);
      return;
    }
    json(res, 401, { error: 'unauthenticated' });
    return;
  }
  const match = /^\/__vh\/svc\/(\d+)(\/.*)?$/.exec(url.pathname);
  if (match === null) {
    json(res, 404, { error: 'not found' });
    return;
  }
  const port = Number(match[1]);
  const target = await serviceTarget(session.subject, port);
  if (!target) {
    json(res, 404, { error: 'unknown-service', message: '该端口没有登记为你自己的服务，也没有容器发布它' });
    return;
  }
  const path = `${match[2] ?? '/'}${url.search}`;
  await new Promise((resolve) => {
    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      method: req.method,
      path,
      headers: serviceHeaders(req, target.port),
    }, (upstreamRes) => {
      /** @type {Record<string, string | string[]>} */
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        if (HOP_BY_HOP.has(name) && name !== 'upgrade') continue;
        responseHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('end', resolve);
      upstreamRes.on('error', resolve);
    });
    upstream.setTimeout(0);
    upstream.on('error', () => {
      if (!res.headersSent) json(res, 502, { error: 'service-unreachable', message: '服务没有在运行' });
      else res.destroy();
      resolve();
    });
    res.on('close', () => { upstream.destroy(); resolve(); });
    req.pipe(upstream);
  });
}

/**
 * Tunnel one WebSocket upgrade aimed at a registered tenant service.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @returns {Promise<void>}
 */
async function proxyServiceUpgrade(req, socket, head) {
  const session = authenticate(req);
  const match = session === undefined
    ? undefined
    : /^\/__vh\/svc\/(\d+)(?:\/|$)/.exec(stripPrefix(req.url ?? '/'));
  if (session === undefined || match === null || match === undefined) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const port = Number(match[1]);
  const target = await serviceTarget(session.subject, port);
  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const headers = serviceHeaders(req, target.port);
  headers.connection = 'Upgrade';
  headers.upgrade = String(req.headers.upgrade ?? 'websocket');

  const lines = [`${req.method ?? 'GET'} ${stripPrefix(req.url ?? '/').slice(`/__vh/svc/${String(port)}`.length) || '/'} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
    else lines.push(`${name}: ${value}`);
  }
  lines.push('', '');
  const upstream = connect(target.port, target.host, () => {
    upstream.write(lines.join('\r\n'));
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}

/** The market's own restart control; the gateway owns the instance it replaces. */
const MARKET_RESTART_PATH = '/dsh-market/restart';

/** One market-triggered restart at a time; the market retries a 409 itself. */
let marketRestartInFlight = false;

/**
 * Answer the market's restart control with the gateway's own restart.
 *
 * The market ships its own replacement helper, which spawns a second dsh the
 * gateway never registered: the old launch cookie goes stale and the next
 * request reclaims the port the helper just took. Reporting 202 and replacing
 * the instance here keeps one restart path — the same one `/__vh/restart`
 * drives. The market then polls its status until the new boot answers.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function handleMarketRestart(req, res) {
  const record = await requireUser(req, res);
  if (!record) return;
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    json(res, 403, { ok: false, error: 'cross-site request rejected' });
    return;
  }
  if (marketRestartInFlight) {
    json(res, 409, { ok: false, error: 'restart-in-progress' });
    return;
  }
  marketRestartInFlight = true;
  // Answer before the drain: exactly the process that would answer this request
  // is the one being replaced, and the market's next poll reaches the new boot.
  json(res, 202, { ok: true });
  void restartInstance(record)
    .catch((error) => {
      console.error(`market restart failed for ${record.account ?? record.linuxName}:`, error?.message ?? error);
    })
    .finally(() => {
      marketRestartInFlight = false;
    });
}

/**
 * Control endpoints owned by the gateway itself.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<void>}
 */
async function handleControl(req, res, url) {
  // The tenant-owned capability transport. A local dsh plugin authenticates
  // with its capability key, not with the browser session: the request never
  // came from a browser, and the public `/__vh` prefix must not turn into a
  // session-free proxy. Egress refuses browser-shaped requests itself.
  if (url.pathname.startsWith(EGRESS_PREFIX)) {
    await handleEgress(req, res, url, EGRESS_HANDLERS, CAPABILITY_ENV);
    return;
  }

  // The background identity check, served as its own file so it is written as
  // JavaScript rather than as an escaped template string, and so a deployment
  // can be reasoned about without re-reading the page that embeds it.
  if (url.pathname === VERIFY_SCRIPT_PATH && req.method === 'GET') {
    const body = Buffer.from(VERIFY_SCRIPT, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(body.byteLength),
      // The check speaks the gateway's own protocol; a cached copy would keep
      // calling endpoints the next release changed.
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }

  // The answer for one navigation: the same account, a different account, or
  // "the platform could not say". Every data request of that navigation is
  // waiting on this line, so every path settles it — including the failures.
  if (url.pathname === '/__vh/verify' && req.method === 'POST') {
    const session = authenticate(req);
    if (!session) {
      json(res, 401, { error: 'unauthenticated' });
      return;
    }
    const sid = session.sid;
    // Local debugging has no platform to ask; the check is not part of it.
    if (AUTH_DISABLED) {
      identityGate.settle(sid, 'skipped');
      json(res, 200, { same: true, verified: false, reason: 'auth-disabled' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      identityGate.settle(sid, 'skipped');
      json(res, 400, { same: true, verified: false, reason: 'invalid-body' });
      return;
    }
    // Same double-submit guard as the sign-in endpoint: this request can hand
    // out a session for an arbitrary account, so it must come from our page.
    const cookies = parseCookies(req.headers.cookie);
    if (!csrfMatches(String(req.headers['x-vh-csrf'] ?? ''), cookies[CSRF_COOKIE] ?? '')) {
      identityGate.settle(sid, 'skipped');
      json(res, 403, { same: true, verified: false, reason: 'csrf' });
      return;
    }
    if (body.skipped === true) {
      identityGate.settle(sid, 'skipped');
      console.warn(`identity check skipped (${String(body.reason ?? 'unknown')}) for ${session.account}`);
      json(res, 200, { same: true, verified: false, reason: String(body.reason ?? 'skipped') });
      return;
    }

    let identity;
    try {
      identity = await verifyVosToken(body.access_token, {
        acceptLanguage: String(req.headers['accept-language'] ?? ''),
      });
    } catch (error) {
      // The platform refused or could not answer. That is not a verdict about
      // the account in front of the browser, so the navigation keeps the session
      // it already had — visibly, in the log, so the degradation is not silent.
      const code = error instanceof VosAuthError ? error.code : 'auth-failed';
      console.warn(`identity check unavailable for ${session.account}: ${code}`);
      identityGate.settle(sid, 'skipped');
      json(res, 200, { same: true, verified: false, reason: code });
      return;
    }

    const tokenSet = {
      access: String(body.access_token),
      ...typeof body.refresh_token === 'string' && body.refresh_token ? { refresh: body.refresh_token } : {},
      expiresAt: expiryFromToken(String(body.access_token), Number(body.expires_in)),
    };

    if (identity.subject === session.subject) {
      const record = await findUser(USERS_FILE, session.subject);
      if (record) {
        rememberTokens(record.namespace, tokenSet);
        sessions.prove(sid);
        void ensureInstance({
          record,
          stateRoot: STATE_ROOT,
          dshBin: DSH_BIN,
          nodeBin: NODE_BIN,
          statePath: STATE_FILE,
          userHelper: USER_HELPER,
        })
          .then(() => startCapabilities(record))
          .catch((error) => {
            console.error(`identity recheck could not start ${record.account ?? record.linuxName}:`, error?.message ?? error);
          });
      }
      identityGate.settle(sid, 'same');
      json(res, 200, { same: true, verified: true });
      return;
    }

    // A different account is signed in on this browser. The old session cannot
    // route anywhere any more, and the page that asked is holding the previous
    // tenant's document — the client reloads on `same: false`.
    const upserted = await upsertUser(USERS_FILE, identity);
    const next = upserted.record;
    // The old account no longer owns this browser, so its durable credential
    // must not outlive the switch on disk.
    const previous = await findUser(USERS_FILE, session.subject);
    if (previous) {
      forgetTokens(previous.namespace);
      // The capability key authorises session-free upstream calls. Dropping it
      // with the browser session is what makes the sign-out complete rather
      // than only hiding the door.
      await removeCapabilityContract({
        stateRoot: STATE_ROOT,
        home: userPaths(STATE_ROOT, previous.account ?? previous.linuxName).home,
        subject: previous.subject,
      });
      // The signature the plugin read at boot is now dead, and a running dsh
      // cannot pick up a new one. Stop it here, as sign-out does: the next
      // visit relaunches it, and the launch writes the contract the new plugin
      // reads. Leaving it alive would restore the tenant with no key, no
      // gateway socket, and no listener that could ever answer.
      await stopInstance(previous.subject).catch((error) => {
        console.error(
          `could not stop ${previous.account ?? previous.linuxName} after the account switch:`,
          error,
        );
      });
      // The old tenant's sockets may have been the plugin's, and the stopped
      // process will not bind again. Rebuild the gateway's own listeners now so
      // the capability path is answered without waiting for the next sign-in or
      // gateway restart; `stopInstance` having found nothing is not a reason to
      // skip it, because the registry can outlive this process's instance map.
      await startCapabilities(previous).catch((error) => {
        console.error(
          `could not rebuild capability sockets for ${previous.account ?? previous.linuxName} after the account switch:`,
          error,
        );
      });
    }
    rememberTokens(next.namespace, tokenSet);
    sessions.revokeSession(sid);
    identityGate.settle(sid, 'switched');
    const nextSid = sessions.createSession({
      subject: next.subject,
      account: next.account ?? next.linuxName,
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
    sessions.prove(nextSid);
    console.log(`identity switched: ${session.account} -> ${next.account ?? next.linuxName}`);
    json(res, 200, {
      same: false,
      user: { username: next.username, namespace: next.namespace },
    }, {
      'set-cookie': cookie(SESSION_COOKIE, nextSid, {
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1_000),
        ...cookiePolicy(req),
      }),
    });
    return;
  }

  // The document a tab holds belongs to the process that served it. After a
  // restart that process is gone, and every bundle URL in the document carries
  // a revision the new one never had — the tab dies on the first plugin it has
  // left to mount. The injected script polls this to notice the swap itself.
  if (url.pathname === '/__vh/boot') {
    // Session cookie only: this is polled every couple of seconds from every
    // open tab, and the full check would put an identity recheck on that path.
    // The answer is a launch timestamp, which is nothing a caller can act on.
    const session = authenticate(req);
    if (!session) {
      json(res, 401, { error: 'unauthenticated' });
      return;
    }
    // A launch that failed says why: the starting page shows the reason while
    // it keeps retrying, which is the difference between waiting and not
    // knowing. The durable boot identity alone is not a readiness signal —
    // `readyBoot` answers 0 until an instance can actually forward a request.
    const boot = readyBoot(session.subject);
    const failure = launchFailure(session.subject);
    // A durable boot identity is not readiness when the last launch failed:
    // publishing it made the waiting page reload into a workspace that still
    // cannot serve a document, once per poll, for as long as the failure lasted.
    json(res, 200, failure === undefined ? { boot } : { boot: 0, error: failure });
    return;
  }

  // A plugin bundle patch that carries configuration is applied by the bundle
  // layer at startup only, and the surface only reports that a restart is owed.
  // This is the control that pays the debt, from the button the shell injects.
  if (url.pathname === '/__vh/restart') {
    const record = await requireUser(req, res);
    if (!record) return;
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method-not-allowed' });
      return;
    }
    // The control rewrites the tenant's process, so it is refused where a
    // browser would not attach the session on its own.
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 403, { error: 'cross-site request rejected' });
      return;
    }
    // Answer before the drain: the process that would answer this request is
    // the one being replaced. A restart is a restart — the page reloads into the
    // starting page and waits, so the request never becomes a failure dialog.
    json(res, 202, { ok: true });
    void restartUntilUp(record);
    return;
  }

  if (url.pathname.startsWith('/__vh/scheduler/')) {
    await handleScheduler(req, res, url.pathname.slice('/__vh/scheduler'.length) + url.search);
    return;
  }
  if (url.pathname.startsWith('/__vh/files')) {
    await handleFiles(req, res, url);
    return;
  }

  if (url.pathname === '/__vh/services') {
    await handleServices(req, res, url);
    return;
  }
  if (url.pathname.startsWith('/__vh/services/')) {
    await handleServiceAction(req, res, url);
    return;
  }
  // Tenant-run web services: forward to a port the subject registered.
  if (url.pathname.startsWith('/__vh/svc/')) {
    await proxyServiceRequest(req, res, url);
    return;
  }
  if (url.pathname.startsWith('/__vh/weknora/')) {
    const record = await requireUser(req, res);
    if (!record) return;
    await handleWeknoraControl(record.namespace, req, res, url.pathname.slice('/__vh/weknora'.length));
    return;
  }

  // The Agent's MCP transport to MCPHub. A dsh instance authenticates with the
  // capability key the gateway minted for it, so the tenant's VOS token stays
  // here; the MCPHub session id and stream are passed through untouched.
  if (url.pathname.startsWith('/__vh/mcphub/agent/')) {
    await handleMcphubAgent(req, res, url.pathname.slice('/__vh/mcphub/agent'.length));
    return;
  }

  // The MCPHub service list for the left-Sidebar panel. The page holds no VOS
  // token, so the gateway resolves the tenant from its session and forwards
  // with that tenant's token; the answer is rebuilt field by field upstream.
  if (url.pathname === '/__vh/mcphub/services') {
    const record = await requireUser(req, res);
    if (!record) return;
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method-not-allowed' });
      return;
    }
    const routing = mcphubRouting();
    json(res, 200, { ...(await mcphubServices(record.namespace)), routing });
    return;
  }

  // The tools behind those services, for the panel's preview. Same read-only
  // trust boundary as the list: the tenant's token travels upstream, and the
  // answer keeps tool names and descriptions only.
  if (url.pathname === '/__vh/mcphub/tools') {
    const record = await requireUser(req, res);
    if (!record) return;
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method-not-allowed' });
      return;
    }
    json(res, 200, await mcphubTools(record.namespace));
    return;
  }

  // Which services the Agent mounts. A choice is a plan for the next launch,
  // so the answer says a restart applies it rather than pretending otherwise.
  if (url.pathname === '/__vh/mcphub/selection') {
    const record = await requireUser(req, res);
    if (!record) return;
    if (req.method === 'GET') {
      json(res, 200, { selected: (await mcphubSelection(record.namespace)) ?? null, restartRequired: true });
      return;
    }
    if (req.method !== 'PUT') {
      json(res, 405, { error: 'method-not-allowed' });
      return;
    }
    // The choice rewrites what the Agent can call, so it is refused where a
    // browser would not attach the session on its own.
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 403, { error: 'cross-site request rejected' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      console.error('mcphub selection body rejected:', error?.message ?? error);
      json(res, 400, { error: 'invalid-body', message: '请求体不是合法的 JSON 对象' });
      return;
    }
    const names = body.names;
    const valid = names === null || names === undefined
      || (Array.isArray(names) && names.every((name) => typeof name === 'string'));
    if (!valid) {
      json(res, 400, { error: 'invalid-selection', message: 'names 必须是字符串数组或 null' });
      return;
    }
    const selected = await saveMcphubSelection(
      record.namespace,
      names === null || names === undefined ? undefined : /** @type {string[]} */ (names),
    );
    json(res, 200, { ok: true, selected: selected ?? null, restartRequired: true });
    return;
  }

  // One management action on one service: start/stop it, or reload its
  // connection. The page holds no VOS token, so the gateway signs the upstream
  // call with the session user's own; MCPHub decides whether that user may act
  // on the service at all, and its verdict (404 included) is relayed as is.
  if (url.pathname.startsWith('/__vh/mcphub/servers/')) {
    const record = await requireUser(req, res);
    if (!record) return;
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method-not-allowed' });
      return;
    }
    // A stop is a write to shared state, so it is refused where a browser
    // would not attach the session on its own.
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 403, { error: 'cross-site request rejected' });
      return;
    }
    const match = /^\/__vh\/mcphub\/servers\/([^/]+)\/(toggle|reload)$/u.exec(url.pathname);
    if (match === null) {
      json(res, 404, { error: 'route-not-allowed' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      console.error('mcphub server action body rejected:', error?.message ?? error);
      json(res, 400, { error: 'invalid-body', message: '请求体不是合法的 JSON 对象' });
      return;
    }
    // The raw segment travels to the module: it owns the decoding, so a
    // malformed escape comes back as its own 400 instead of a thrown
    // URIError this handler would answer with a misleading 500.
    const result = await mcphubServerAction(
      record.namespace,
      match[1],
      /** @type {'toggle' | 'reload'} */ (match[2]),
      body,
    );
    if (!result.ok) {
      json(res, result.status, { error: result.error, ...(result.message !== undefined ? { message: result.message } : {}) });
      return;
    }
    json(res, 200, { ok: true, ...(result.message !== undefined ? { message: result.message } : {}) });
    return;
  }

  // V-Office document listing for the composer's `@` menu. The page holds
  // neither the tenant socket nor a VOS token, so the gateway answers the
  // listing itself and never trusts a caller-supplied identity.
  if (url.pathname === '/__vh/office/list' && req.method === 'GET') {
    const record = await requireUser(req, res);
    if (!record) return;
    try {
      const files = await listDocuments(record.namespace);
      json(res, 200, { ok: true, total: files.length, files });
    } catch (error) {
      json(res, error?.status ?? 502, {
        error: error?.code ?? 'office-failed',
        message: error instanceof Error ? error.message : '读取文档列表失败',
      });
    }
    return;
  }

  // V-Office editor entry: `/session` answers the JSON a surface renders,
  // `/open` is the same thing as a redirect so a plain link works.
  if (url.pathname === '/__vh/office/session' || url.pathname === '/__vh/office/open') {
    const record = await requireUser(req, res);
    if (!record) return;
    const name = (url.searchParams.get('name') ?? '').trim();
    // The storage service owns its own path checks; this only keeps the shape
    // honest so a nested path can never reach it by accident.
    if (name === '' || name.includes('/') || name.includes('\\')) {
      json(res, 400, { error: 'invalid-name', message: '文档名不能为空，也不能带路径分隔符' });
      return;
    }
    let opened;
    try {
      opened = await editorUrlFor(record.namespace, {
        name,
        edit: url.searchParams.get('edit') !== '0',
        lang: url.searchParams.get('lang') ?? '',
        // `v` forces a fresh Collabora session (new docKey) after the file was
        // replaced behind an open editor. Default 0 keeps collaborators in one
        // session, which is what multi-user editing depends on.
        version: Number(url.searchParams.get('v') ?? 0) || 0,
      });
    } catch (error) {
      json(res, error?.status ?? 502, {
        error: error?.code ?? 'office-failed',
        message: error instanceof Error ? error.message : '打开文档失败',
      });
      return;
    }
    if (url.pathname === '/__vh/office/open') {
      res.writeHead(302, { location: opened.editorUrl, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    json(res, 200, { ok: true, ...opened });
    return;
  }

  if (url.pathname === '/__vh/health') {
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/__vh/session' && req.method === 'GET') {
    const session = authenticate(req);
    if (session) {
      const record = await findUser(USERS_FILE, session.subject);
      if (record) {
        const locale = record.locale ?? '';
        // The page calls this on every load, which makes it the one place that
        // reliably sees each tenant's real domain; recording it only on
        // capability routes left the map empty until the user opened a file.
        rememberOrigin(req.headers, record.namespace);
        console.log(`session ${record.username}: tokenReady=${String(hasUsableTokens(record.namespace))}`);
        // The page re-proves who is signed in on every load, so this endpoint
        // always hands back the CSRF token and client identity that replay
        // needs. The cookie names the tenant we served last; it is not evidence
        // of the account that is signed in now.
        const csrf = newCsrfToken();
        json(res, 200, {
          authenticated: true,
          // Whether this navigation still owes the gateway an answer about who
          // is signed in. The injected check reads it and does nothing at all
          // when the answer is already in hand, so a page load costs one cheap
          // request instead of a platform round trip.
          check: identityGate.armed(session.sid),
          // Handed back so the bootstrap page can keep the session even when
          // the browser refuses to store the cookie (cross-site iframe).
          session: session.sid,
          user: { username: record.username, namespace: record.namespace, locale },
          tokenReady: hasUsableTokens(record.namespace),
          clientId: CLIENT_ID,
          scope: SCOPE,
          csrf,
        }, {
          'set-cookie': cookie(CSRF_COOKIE, csrf, { maxAgeSeconds: 600, ...cookiePolicy(req) }),
        });
        return;
      }
      // The user table no longer knows this subject: the session cannot route
      // anywhere, so retire it and fall through to the bootstrap flow.
      sessions.revokeSubject(session.subject);
    }
    if (AUTH_DISABLED) {
      // Local debugging: mint a session for one fixed user so the UI can be
      // exercised without VOS. The instance starts on the first proxied request.
      const { record } = await upsertUser(USERS_FILE, {
        subject: DEV_SUBJECT,
        namespace: DEV_NAMESPACE,
        username: 'dev',
      });
      const sid = sessions.createSession({
        subject: record.subject,
        account: record.account ?? record.linuxName,
        userAgent: String(req.headers['user-agent'] ?? ''),
      });
      sessions.prove(sid);
      console.warn('VH_AUTH_DISABLED is set: signing in as the local dev user');
      json(res, 200, {
        authenticated: true,
        tokenReady: true,
        user: { username: record.username, namespace: record.namespace },
      }, {
        'set-cookie': cookie(SESSION_COOKIE, sid, {
          maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1_000),
          ...cookiePolicy(req),
        }),
      });
      return;
    }
    const csrf = newCsrfToken();
    // The double-submit token must also reach the page: the cookie is
    // HttpOnly, so the client cannot read it back to set the header.
    json(res, 200, { authenticated: false, clientId: CLIENT_ID, scope: SCOPE, csrf }, {
      'set-cookie': cookie(CSRF_COOKIE, csrf, { maxAgeSeconds: 600, ...cookiePolicy(req) }),
    });
    return;
  }

  // Session creation. `/__vh/session` is the documented endpoint; `/__vh/auth`
  // stays accepted so a bootstrap page from an older deployment still signs in.
  if ((url.pathname === '/__vh/session' || url.pathname === '/__vh/auth') && req.method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    const presented = req.headers['x-vh-csrf'];
    if (!csrfMatches(String(presented ?? ''), cookies[CSRF_COOKIE] ?? '')) {
      json(res, 403, { authenticated: false, error: 'CSRF 校验失败' });
      return;
    }
    let body;
    let record;
    try {
      body = await readJsonBody(req);
      const identity = await verifyVosToken(body.access_token, {
        acceptLanguage: String(req.headers['accept-language'] ?? ''),
      });
      const upserted = await upsertUser(USERS_FILE, identity);
      record = upserted.record;
      console.log(`identity user=${record.account ?? record.linuxName} sub=${record.subject} created=${String(upserted.created)}`);
      if (upserted.created) {
        console.log(`user created namespace=${record.namespace} port=${String(record.port)}`);
      }
    } catch (error) {
      const code = error instanceof VosAuthError ? error.code : 'auth-failed';
      const status = code === 'vos-userinfo-unreachable' ? 502 : 401;
      console.warn(`auth rejected: ${code} ${error instanceof Error ? error.message : String(error)}`);
      json(res, status, { authenticated: false, error: '身份验证失败' });
      return;
    }

    // From here on the identity is proven and the tenant is known. A failure is
    // the instance's, not the login's: reporting it as 401 is what made a dead
    // dsh surface as "身份验证失败" on the bootstrap page, where the message is
    // relayed verbatim and no amount of retrying can fix the real cause.
    // The answer language is baked into the tenant's dsh process at launch.
    // It is deliberately NOT restarted here: dsh closes gracefully over
    // several seconds, and a relaunch racing that shutdown dies on the
    // instance's own port (EADDRINUSE), which reads as a total sign-in
    // failure. The stored language lands on the next natural start.
    const accessToken = String(body.access_token);
    console.log(`auth ${record.username}: refresh=${body.refresh_token ? 'yes' : 'no'}`);
    rememberTokens(record.namespace, {
      access: accessToken,
      ...typeof body.refresh_token === 'string' && body.refresh_token ? { refresh: body.refresh_token } : {},
      expiresAt: expiryFromToken(accessToken, Number(body.expires_in)),
    });
    // Sign-in never waits for a cold start. `ensureInstance` needs 15–20 seconds
    // on a fresh container, while the page gives this request 15 and then shows
    // "平台身份验证失败，正在自动重试…" — three times, for every user, after every
    // restart, when nothing was actually wrong. The session is returned now and
    // the navigation that follows lands on the starting page (a document request
    // with no instance yet), which polls `/__vh/boot` and reloads the moment the
    // process answers. A launch that genuinely fails is reported there with its
    // reason, instead of masquerading as a sign-in error.
    void (async () => {
      await ensureInstance({
        record,
        stateRoot: STATE_ROOT,
        dshBin: DSH_BIN,
        nodeBin: NODE_BIN,
        statePath: STATE_FILE,
        userHelper: USER_HELPER,
      });
      await startCapabilities(record);
    })().catch((error) => {
      console.error(
        `instance start failed user=${record.username} account=${record.account ?? record.linuxName}:`,
        error instanceof Error ? error.message : String(error),
      );
    });

    // Whoever proved themselves here owns this browser from now on: the ticket
    // it arrived with is retired, so the previous account cannot ride along in
    // another tab that never navigates again.
    const priorSid = cookies[SESSION_COOKIE]
      ?? (typeof req.headers['x-vh-session'] === 'string' ? req.headers['x-vh-session'] : undefined);
    if (priorSid !== undefined) sessions.revokeSession(priorSid);

    const sid = sessions.createSession({
      subject: record.subject,
      account: record.account ?? record.linuxName,
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
    sessions.prove(sid);
    json(res, 200, {
      authenticated: true,
      session: sid,
      user: { username: record.username, namespace: record.namespace },
    }, {
      'set-cookie': cookie(SESSION_COOKIE, sid, {
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1_000),
        ...cookiePolicy(req),
      }),
    });
    return;
  }

  // The renew prompt offers "仍然进入（部分能力不可用）": VOS refused the silent
  // authorization, so the account behind the ticket is known but cannot be
  // re-proved. Marking it proven here is what makes that choice usable —
  // without it the document would bounce straight back to the page that just
  // failed, forever.
  if (url.pathname === '/__vh/enter' && req.method === 'GET') {
    const session = authenticate(req);
    if (!session) {
      json(res, 401, { error: 'unauthenticated' });
      return;
    }
    sessions.prove(session.sid);
    const to = url.searchParams.get('to') ?? './';
    // Only a same-origin path is a redirect target; a bare `//host` would hand
    // the browser to another origin.
    const target = /^\/(?!\/)[\x20-\x7e]*$/.test(to) ? to : './';
    res.writeHead(302, { location: target, 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (url.pathname === '/__vh/logout' && req.method === 'POST') {
    const session = authenticate(req);
    if (session) {
      // Revoking alone leaves the dsh process (and its VOS capabilities)
      // running for whoever holds the instance cookie next; stopping the
      // instance closes the tenant's whole world, not just the browser door.
      sessions.revokeSession(session.sid);
      await stopInstance(session.subject);
      const record = await findUser(USERS_FILE, session.subject);
      if (record) {
        forgetTokens(record.namespace);
        // Stopping the instance closes the tenant's world; the contract and
        // its key go with it so a surviving process cannot keep signing
        // upstream calls for an account that signed out.
        await removeCapabilityContract({
          stateRoot: STATE_ROOT,
          home: userPaths(STATE_ROOT, record.account ?? record.linuxName).home,
          subject: record.subject,
        }).catch((error) => { console.error(`capability contract cleanup failed on logout:`, error); });
        // The tenant may have been delegated, and the stopped plugin will not
        // bind again. Bind the gateway's own listeners now: the contract is gone,
        // so ownership recomputes to the gateway and the skill path keeps an
        // answer without waiting for the next launch or gateway restart.
        await startCapabilities(record).catch((error) => {
          console.error(`could not rebuild capability sockets on logout:`, error);
        });
      }
    }
    json(res, 200, { authenticated: false }, {
      'set-cookie': cookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, ...cookiePolicy(req) }),
    });
    return;
  }

  if (url.pathname === '/__vh/whoami' && req.method === 'GET') {
    const record = await requireUser(req, res);
    if (!record) return;
    json(res, 200, {
      subject: record.subject,
      account: record.account ?? record.linuxName,
      username: record.username,
      locale: record.locale ?? '',
    });
    return;
  }

  json(res, 404, { error: 'not found' });
}

/**
 * Build upstream headers for one forwarded request.
 *
 * The browser Cookie is dropped: dsh binds its cookie to the request authority,
 * so only the instance's own `dsh-auth-*` cookie can authenticate it.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} port
 * @param {string} instanceCookie
 * @returns {Record<string, string | string[]>}
 */
function upstreamHeaders(req, port, instanceCookie) {
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name)) continue;
    if (name === 'host' || name === 'cookie' || name === 'origin' || name === 'referer') continue;
    if (name.startsWith('sec-fetch-')) continue;
    headers[name] = value;
  }
  headers.host = `127.0.0.1:${String(port)}`;
  headers.cookie = instanceCookie;
  const forwarded = req.socket.remoteAddress;
  if (forwarded) headers['x-forwarded-for'] = forwarded;
  headers['x-forwarded-proto'] = isSecure(req) ? 'https' : 'http';
  return headers;
}

/**
 * Give one tenant its capability sockets. Idempotent; failures are logged
 * rather than fatal so a broken upstream never blocks sign-in.
 *
 * A socket the tenant's plugin owns must not be unlinked and rebound while the
 * plugin lives: it would keep listening on a deleted inode, silently. But the
 * contract only records an intention, so a delegated socket that does not
 * answer is taken back — contract and key deleted, gateway listener bound —
 * because a skill that dials a dead path has no recovery left.
 * @param {import('./users.mjs').UserRecord} record
 * @param {{ requireRunning?: boolean }} [control] - whether a missing listener
 *   only counts when the tenant's dsh is running; boot uses this so an offline
 *   tenant keeps its contract instead of being taken over until the next boot.
 * @returns {Promise<void>}
 */
async function startCapabilities(record, control = {}) {
  const options = {
    namespace: record.namespace,
    subject: record.subject,
    account: record.account ?? record.linuxName,
    uid: record.uid,
    linuxName: record.linuxName,
    home: userPaths(STATE_ROOT, record.account ?? record.linuxName).home,
    userHelper: USER_HELPER,
  };
  await startOwnedCapabilities({
    stateRoot: STATE_ROOT,
    shipped: CAPABILITIES_SHIPPED,
    env: CAPABILITY_ENV,
    options,
    bind: {
      voffice: ensureOfficeCapability,
      weknora: ensureWeknoraCapability,
      album: ensureAlbumCapability,
      'image-studio': ensureImageStudioCapability,
      photocraft: ensurePhotocraftCapability,
      // Kept here for symmetry; `vh-services` is not delegable, so this entry
      // always binds and its egress path never honours a delegated key.
      'vh-services': ensureServicesCapability,
    },
    bindDocker: ensureDockerCapability,
    forget: {
      voffice: forgetOfficeCapability,
      weknora: forgetWeknoraCapability,
      album: forgetAlbumCapability,
      'image-studio': forgetImageStudioCapability,
      photocraft: forgetPhotocraftCapability,
      'vh-services': forgetServicesCapability,
    },
    tenantRunning: control.requireRunning === true
      ? () => instanceAnswers(record, STATE_FILE)
      : undefined,
  });
}

/**
 * Resolve the instance for one authenticated request, starting it if needed.
 * @param {{ subject: string }} session
 * @returns {Promise<{ port: number, cookie: string | undefined } | undefined>}
 */
async function instanceFor(session) {
  const cached = liveInstance(session.subject);
  // A child we spawned is alive as long as its handle says so. An adopted
  // process has no handle: let ensureInstance re-prove it on its cadence.
  if (cached?.cookie && !cached.adopted) return cached;
  const record = await findUser(USERS_FILE, session.subject);
  if (!record) return undefined;
  const instance = await ensureInstance({
    record,
    stateRoot: STATE_ROOT,
    dshBin: DSH_BIN,
    nodeBin: NODE_BIN,
    statePath: STATE_FILE,
    userHelper: USER_HELPER,
  });
  if (!cached?.cookie) await startCapabilities(record);
  return instance;
}

/**
 * Requests currently forwarded to one tenant's instance, keyed by subject.
 *
 * A restart replaces the process those requests are riding on. Signalling it
 * first turns every one of them into a hang-up, which the browser reported as a
 * burst of 502s and a blank page: the shell had already been served, so the tab
 * kept a document whose modules never arrived. Waiting for them to land is what
 * removes that window.
 */
const inFlight = new Map();

/** How long a restart waits for forwarded requests before it signals anyway. */
const DRAIN_TIMEOUT_MS = 2_000;

/**
 * Count one forwarded request; the returned release is idempotent because the
 * proxy resolves from several places.
 * @param {string} subject
 * @returns {() => void}
 */
function trackRequest(subject) {
  inFlight.set(subject, (inFlight.get(subject) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inFlight.get(subject) ?? 1) - 1;
    if (left > 0) inFlight.set(subject, left);
    else inFlight.delete(subject);
  };
}

/**
 * Wait for a tenant's forwarded requests to finish, bounded.
 *
 * The bound is what keeps one long download from holding a restart hostage; a
 * request that outlives it loses to the signal, exactly as before.
 * @param {string} subject
 * @returns {Promise<void>}
 */
async function drainRequests(subject) {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while ((inFlight.get(subject) ?? 0) > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Restarts in flight, keyed by subject: a second click joins the first. */
const restarts = new Map();

/**
 * Replace the tenant's dsh process with a fresh one.
 *
 * The jail is signalled first so dsh drains its own session state; a process
 * that outlives the signal still holds its port, and `ensureInstance` answers
 * that by reclaiming the port before it listens, which is what keeps a slow
 * drain from turning a restart into EADDRINUSE.
 * @param {Awaited<ReturnType<typeof findUser>>} record - the tenant to restart.
 * @returns {Promise<{ port: number, cookie: string | undefined }>} the instance
 *   that replaced it.
 */
async function restartInstance(record) {
  const order = record.account ?? record.linuxName;
  const key = record.subject;
  const inflight = restarts.get(key);
  if (inflight !== undefined) return inflight;
  const run = (async () => {
  console.log(`restart requested: ${order}`);
  // Let what was already forwarded finish on the process that owns it. Without
  // this the signal lands under in-flight asset requests, the gateway reports
  // the hang-up as 502, and the tab that asked for the restart gets a shell
  // whose modules never load.
  await drainRequests(key);
  await stopInstance(key);
  // The port has to be free before the next bind. An adopted process has no
  // child handle to wait on, and a stale one may still be draining; checking
  // the port itself covers both and keeps a second click from starting a
  // second launch that fights the first one.
  await waitForFreePort(record.port, 30);
  const instance = await ensureInstance({
    record,
    stateRoot: STATE_ROOT,
    dshBin: DSH_BIN,
    nodeBin: NODE_BIN,
    statePath: STATE_FILE,
    userHelper: USER_HELPER,
  });
  await startCapabilities(record);
  console.log(`restarted: ${order} port=${String(instance.port)}`);
  return instance;
  })();
  restarts.set(key, run);
  try {
    return await run;
  } finally {
    restarts.delete(key);
  }
}

/** Wait before each launch attempt; the last value repeats for ever. */
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * Restart a tenant until it answers.
 *
 * A restart is a restart: the owner asked for a new process, and a launch that
 * fails is the gateway's problem to keep solving, not a dialog to hand back.
 * Every attempt is logged with its reason, and the loop settles on a slow retry
 * so a tenant whose configuration cannot start costs one launch every half
 * minute rather than a busy spin.
 * @param {Awaited<ReturnType<typeof findUser>>} record - the tenant to restart.
 * @returns {Promise<void>} resolves once a launch succeeded.
 */
async function restartUntilUp(record) {
  const order = record.account ?? record.linuxName;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await restartInstance(record);
      return;
    } catch (error) {
      const wait = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
      console.error(
        `restart attempt ${String(attempt + 1)} failed for ${order}, retrying in ${String(wait)}ms:`,
        error instanceof Error ? error.message : error,
      );
      await new Promise((resolve) => { setTimeout(resolve, wait); });
    }
  }
}

/**
 * Decode a shell document that arrived compressed.
 *
 * The proxy strips `accept-encoding` from document requests, so dsh answers
 * plain; a hop that compresses on its own would otherwise cost the document its
 * injected scripts, which is exactly the silent failure this guards.
 * @param {Buffer} body - the upstream body.
 * @param {string} encoding - the `content-encoding` value, lowercased.
 * @returns {Buffer | undefined} the decoded body, or undefined when the
 *   encoding is not one this gateway can read.
 */
function decodeDocument(body, encoding) {
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(body);
    if (encoding === 'deflate') {
      try {
        return inflateSync(body);
      } catch {
        return inflateRawSync(body);
      }
    }
    if (encoding === 'br') return brotliDecompressSync(body);
  } catch (error) {
    console.warn(`shell decode failed (${encoding}):`, error?.message ?? error);
  }
  return undefined;
}

// The `rev` in a bundle URL is a pointer into one client graph. dsh composes a
// single graph at a time and answers 404 to every other stamp ("versioned code
// is immutable"), while the stamp moves on each install, uninstall, toggle and
// post-boot reconcile. A tab opened minutes earlier therefore asks for a stamp
// the instance no longer serves: the bundle never executes and the shell dies
// on "HTML did not preload @deepseek-ai/dsh-client-modules/client.js". The same
// package set is still served under the current stamp, so look it up in the
// live shell and replay — the tab keeps running instead of blanking out. A
// package that is genuinely gone has no counterpart and still gets the reload.
const CURRENT_GRAPH_TTL_MS = 3_000;
/** @type {Map<string, { at: number, urls: string[] }>} */
const currentGraphCache = new Map();

/**
 * The package set a bundle URL names, stripped of its stamp.
 * @param {string} url - bundle URL, with or without a leading slash.
 * @returns {string | undefined} the identity shared by every stamp of it.
 */
function bundleIdentity(url) {
  const cut = url.indexOf('&rev=');
  if (cut < 0) return undefined;
  return url.slice(0, cut).replace(/^\.?\//, '');
}

/**
 * Read one instance's shell and collect the bundle URLs it advertises now.
 * @param {{ uid: number, port: number, cookie: string }} instance
 * @param {Record<string, string>} headers - headers already accepted by the
 *   instance; dsh pins its cookie to `127.0.0.1:<port>`, so the host and cookie
 *   have to be the ones the proxy uses or the read comes back 401.
 * @returns {Promise<string[]>} advertised paths, still carrying their stamps.
 */
function fetchAdvertisedBundles(instance, headers) {
  return new Promise((resolve) => {
    const upstream = httpRequest({
      host: instanceAddress(instance.uid),
      port: instance.port,
      method: 'GET',
      path: '/',
      headers: {
        ...headers,
        host: `127.0.0.1:${String(instance.port)}`,
        cookie: instance.cookie,
        accept: 'text/html',
        'accept-encoding': 'identity',
      },
    }, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', (chunk) => { chunks.push(chunk); });
      upstreamRes.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        resolve([...new Set(html.match(/plugins\/\?\?[^"'\s]+/g) ?? [])]);
      });
      upstreamRes.on('error', () => resolve([]));
    });
    upstream.on('error', () => resolve([]));
    upstream.end();
  });
}

/**
 * Find the live URL for a bundle request whose stamp has moved on.
 * @param {{ uid: number, port: number, cookie: string }} instance
 * @param {string} stalePath - the request path dsh refused.
 * @param {Record<string, string>} headers - headers the instance accepts.
 * @returns {Promise<string | undefined>} the live path, or undefined when the
 *   package set left the graph altogether.
 */
async function currentBundlePath(instance, stalePath, headers) {
  const identity = bundleIdentity(stalePath);
  if (identity === undefined) return undefined;
  const cacheKey = `${String(instance.uid)}\u0000${identity}`;
  const now = Date.now();
  const hit = currentGraphCache.get(cacheKey);
  let advertised = hit !== undefined && now - hit.at < CURRENT_GRAPH_TTL_MS ? hit.urls : undefined;
  if (advertised === undefined) {
    advertised = await fetchAdvertisedBundles(instance, headers);
    currentGraphCache.set(cacheKey, { at: now, urls: advertised });
  }
  const live = advertised
    .map((url) => url.replaceAll('&amp;', '&').replace(/[,)]+$/, ''))
    .find((url) => bundleIdentity(url) === identity);
  if (live === undefined) return undefined;
  return live.startsWith('/') ? live : `/${live}`;
}

/**
 * Replay a bundle request against its live URL and stream the answer back.
 * @param {{ uid: number, port: number, cookie: string }} instance
 * @param {string} livePath - the URL the current graph advertises.
 * @param {Record<string, string>} headers - the browser's upstream headers.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<boolean>} whether a body was served.
 */
function replayBundle(instance, livePath, headers, req, res) {
  return new Promise((resolve) => {
    const replay = httpRequest({
      host: instanceAddress(instance.uid),
      port: instance.port,
      method: 'GET',
      path: livePath,
      headers,
    }, (upstreamRes) => {
      if ((upstreamRes.statusCode ?? 0) !== 200) {
        upstreamRes.resume();
        upstreamRes.on('end', () => resolve(false));
        upstreamRes.on('error', () => resolve(false));
        return;
      }
      /** @type {Record<string, string | string[]>} */
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        responseHeaders[name] = value;
      }
      // The stamp was swapped under the browser's feet, so nothing may cache it.
      responseHeaders['cache-control'] = 'no-store';
      res.writeHead(200, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => resolve(true));
      upstreamRes.on('error', () => resolve(true));
    });
    replay.on('error', () => resolve(false));
    req.on('close', () => replay.destroy());
    replay.end();
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function proxyRequest(req, res) {
  const url0 = String(req.url ?? '');
  if (!url0.includes('dsh-pet') && !url0.includes('/assets/')) {
    console.log(`[req] ${String(req.method)} ${url0.slice(0, 70)} accept=${String(req.headers.accept ?? '').slice(0, 24)} cookie=${req.headers.cookie === undefined ? 'no' : 'yes'} host=${String(req.headers.host ?? '')}`);
  }
  const session = authenticate(req);
  if (!session) {
    if (isDocumentRequest(req)) {
      sendBootstrap(res);
      return;
    }
    json(res, 401, { error: 'unauthenticated' });
    return;
  }

  const record = await findUser(USERS_FILE, session.subject);
  if (!record) {
    // The session names a subject the user table dropped: it can never route,
    // so retire it wholesale instead of 401-ing every request forever.
    sessions.revokeSubject(session.subject);
    if (isDocumentRequest(req)) {
      sendBootstrap(res);
      return;
    }
    json(res, 401, { error: 'unknown user' });
    return;
  }
  // Identity is answered *after* the document is on screen, never before it.
  // The shell is generic code with no tenant data in it, and blocking a
  // navigation on a six-leg asynchronous chain is what made every entry cost a
  // platform round trip plus a full reload. Arming the gate here is the whole
  // hand-off: the page answers it in the background, and data waits below.
  if (!AUTH_DISABLED && isShellDocument(req)) identityGate.arm(session.sid);

  // Data never rides on an unanswered navigation. While this session's gate is
  // armed the request waits — bounded — for the answer; a switched account is
  // terminal, because the document in the tab belongs to whoever was signed in
  // before and no amount of proxying turns it into the new tenant's page.
  // This runs before the token recheck so that a check which just landed has
  // already repopulated the tenant's token for it to look at.
  if (!isDocumentRequest(req) && identityGate.armed(session.sid)) {
    const outcome = await identityGate.wait(session.sid);
    if (!mayServe(outcome)) {
      json(res, 401, { error: 'identity-changed', same: false });
      return;
    }
  }

  const verdict = await subjectRecheck(session, record);
  if (verdict === 'drift') {
    // The VOS subject drifted (account kicked / switched): send the browser
    // back through bootstrap, which re-proves identity and re-issues a session.
    if (isDocumentRequest(req)) {
      sendBootstrap(res);
      return;
    }
    json(res, 401, { error: 'session revoked' });
    return;
  }
  // `no-token` falls through: nothing in this process can say the session is
  // wrong, the shell carries no data, and the background check refills the token
  // on this very navigation. Refusing here is what turned every restart into a
  // sign-in wall.

  // This is the browser itself, not the instance behind it: its headers carry
  // the domain this tenant is actually on.
  rememberOrigin(req.headers, record.namespace);

  // A navigation never waits for a launch: what it would receive meanwhile is
  // the blank answer of a process being replaced. The waiting page holds the
  // tab while the launch finishes behind it.
  if (isDocumentRequest(req) && !liveInstance(record.subject)?.cookie) {
    void instanceFor(session).catch((error) => {
      console.error(`instance start failed for ${record.account ?? record.linuxName}:`, error?.message ?? error);
    });
    sendStarting(res);
    return;
  }

  const instance = await instanceFor(session);
  if (!instance?.cookie) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('实例尚未就绪，请稍后重试');
    return;
  }

  const path = stripPrefix(req.url ?? '/').replace(/^\/__vh-ui-v2\/assets\//, '/assets/');
  const headers = upstreamHeaders(req, instance.port, instance.cookie);
  // Media Desk checks Fetch Metadata before processing write requests.
  if (path.startsWith('/media-desk/') && req.headers['sec-fetch-site'] !== undefined) {
    headers['sec-fetch-site'] = req.headers['sec-fetch-site'];
  }
  // Only the document carries the shell injection; assets and RPC answers are
  // streamed untouched. The shell is rewritten as text, so this one request
  // must not come back compressed.
  const documentRequest = isDocumentRequest(req);
  if (documentRequest) delete headers['accept-encoding'];
  const locale = documentRequest ? record.locale : undefined;

  // A long-lived event stream never drains and is expected to die with the
  // process; counting it would only spend the whole bound on every restart.
  const release = String(req.headers.accept ?? '').includes('text/event-stream')
    ? () => {}
    : trackRequest(instance.subject);
  await new Promise((resolve) => {
    const upstream = httpRequest({
      // The instance listens on the tenant's own loopback address.
      host: instanceAddress(instance.uid),
      port: instance.port,
      method: req.method,
      path,
      headers,
    }, (upstreamRes) => {
      /** @type {Record<string, string | string[]>} */
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        if (HOP_BY_HOP.has(name) && name !== 'upgrade') continue;
        responseHeaders[name] = value;
      }
      // A stale `rev` used to end here. Serve the same package set under the
      // stamp the instance composes now instead: the tab never notices the
      // graph moved. Only a package that left the graph falls through to the
      // reload answer, and the document is `no-store`, so that retry does pick
      // up the current manifest. The window (3 reloads / 5 min) keeps a truly
      // missing plugin from spinning the browser; a storage-less context
      // reloads nothing, because it cannot count.
      if (upstreamRes.statusCode === 404 && path.startsWith('/plugins/??')) {
        upstreamRes.resume();
        void (async () => {
          const livePath = await currentBundlePath(instance, path, headers);
          if (livePath !== undefined && await replayBundle(instance, livePath, headers, req, res)) {
            resolve();
            return;
          }
          const retry = Buffer.from(
            'try{var k="vh-stale-bundle",t=Date.now(),v=null,r=[],i;'
            + 'try{v=JSON.parse(sessionStorage.getItem(k)||"[]");}catch(e2){v=[];}'
            + 'if(Object.prototype.toString.call(v)!=="[object Array]")v=[];'
            + 'for(i=0;i<v.length;i++)if(typeof v[i]==="number"&&t-v[i]<300000)r.push(v[i]);'
            + 'if(r.length<3){r.push(t);sessionStorage.setItem(k,JSON.stringify(r));location.reload();}'
            + '}catch(e){}',
            'utf8',
          );
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': String(retry.byteLength),
          });
          res.end(retry);
          resolve();
        })();
        return;
      }
      // dsh regenerates its SPA boot manifest on restart; a cached shell pins
      // the browser to stale plugin bundles.
      const encoding = String(upstreamRes.headers['content-encoding'] ?? '').toLowerCase();
      // Only a navigation is the shell. An HTML body fetched as data belongs to
      // whoever asked for it, and the bridge in it would rewrite their requests.
      const injectable = documentRequest
        && String(upstreamRes.headers['content-type'] ?? '').startsWith('text/html')
        && (encoding === '' || DECODABLE_ENCODINGS.has(encoding));
      if (!injectable) {
        // Bundle URLs carry the graph revision they were built for (`&rev=`),
        // and dsh answers 404 to every stamp but the current one — same rev,
        // same bytes. Assets are content-hashed filenames. The upstream sends
        // no cache headers of its own, so every portal round-trip re-downloaded
        // the whole client graph, which read as a full reload on each entry.
        // A new graph moves the rev and misses the cache by itself, so these
        // answers may be kept forever; documents stay no-store above.
        if ((upstreamRes.statusCode ?? 0) === 200
          && (path.includes('&rev=') || /^\/assets\/[\w.-]+-[A-Za-z0-9_-]{6,}\.\w{2,4}$/.test(path))) {
          responseHeaders['cache-control'] = 'public, max-age=31536000, immutable';
        }
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on('end', resolve);
        upstreamRes.on('error', resolve);
        return;
      }
      responseHeaders['cache-control'] = 'no-store';
      // The shell is small and has to be rewritten before it is sent, so this
      // one response is buffered instead of piped.
      const chunks = [];
      upstreamRes.on('data', (chunk) => { chunks.push(chunk); });
      upstreamRes.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('实例不可用');
        resolve();
      });
      upstreamRes.on('end', () => {
        const raw = Buffer.concat(chunks);
        const source = encoding === '' ? raw : decodeDocument(raw, encoding);
        if (source === undefined) {
          // An encoding this gateway cannot read: the document ships as dsh
          // wrote it, injection and all, rather than not at all.
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          res.end(raw);
          resolve();
          return;
        }
        const html = injectShell(source.toString('utf8'), {
          locale,
          basePath: APP_BASE_PATH,
          // Only the workspace shell is ours to decorate. A plugin's own panel
          // document gets the URL bridge and nothing else.
          shell: isShellDocument(req),
        });
        // Give the entire module graph a fresh URL after older gateways served
        // incompatible responses at the shared asset URLs. Relative imports
        // stay in this directory, so the entry and vendor modules move together.
        const body = Buffer.from(html.replaceAll('./assets/', './__vh-ui-v2/assets/'), 'utf8');
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
        responseHeaders['content-length'] = String(body.byteLength);
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        res.end(body);
        resolve();
      });
    });

    let clientGone = false;
    upstream.on('error', (error) => {
      console.error(`upstream ${String(instance.port)} failed:`, error.message);
      // A tab closing its own request destroys the upstream and can surface as
      // the same error. Only a failure the client did not cause retires the
      // record, or every navigation would look like an unreachable instance.
      if (!clientGone) invalidateInstance(record.subject);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('实例不可用');
      resolve();
    });
    res.on('close', () => { clientGone = true; upstream.destroy(); resolve(); });
    req.pipe(upstream);
  }).finally(release);
}

/**
 * Proxy one WebSocket upgrade (`/api/remote.mux`) to the user's instance.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @returns {Promise<void>}
 */
async function proxyUpgrade(req, socket, head) {
  const session = authenticate(req);
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  // An upgrade carries the same session a navigation just armed. A browser
  // cannot set a header on this handshake, so the cookie is the whole credential
  // — and it must not become a way around the answer the page is fetching.
  if (!AUTH_DISABLED && identityGate.armed(session.sid)) {
    const outcome = await identityGate.wait(session.sid);
    if (!mayServe(outcome)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  const instance = await instanceFor(session);
  if (!instance?.cookie) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  const headers = upstreamHeaders(req, instance.port, instance.cookie);
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';

  const lines = [`${req.method ?? 'GET'} ${stripPrefix(req.url ?? '/')} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
    else lines.push(`${name}: ${value}`);
  }
  lines.push('', '');
  const raw = lines.join('\r\n');

  const upstream = connect(instance.port, instanceAddress(instance.uid), () => {
    upstream.write(raw);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  let clientGone = false;
  upstream.on('error', () => {
    if (!clientGone) invalidateInstance(session.subject);
    socket.destroy();
  });
  socket.on('error', () => { clientGone = true; upstream.destroy(); });
  socket.on('close', () => { clientGone = true; upstream.destroy(); });
}

const agentApiDependencies = {
  json,
  readBody: readJsonBody,
  async authenticate(req) {
    const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return undefined;
    let identity;
    try {
      identity = await verifyVosToken(token, { acceptLanguage: req.headers['accept-language'] });
    } catch (error) {
      if (!(error instanceof VosAuthError)) throw error;
      if (error.code === 'vos-userinfo-unreachable' || error.code === 'vos-invalid-userinfo' || (error.status ?? 0) >= 500) {
        throw unavailableIdentity();
      }
      return undefined;
    }
    const { record } = await upsertUser(USERS_FILE, identity);
    rememberApiAccessToken(record.namespace, token);
    return record;
  },
  async call(record, endpoint, request) {
    let instance;
    try {
      instance = await instanceFor({ subject: record.subject });
    } catch {
      throw unavailableInstance();
    }
    if (!instance?.cookie) throw unavailableInstance();
    return callSessionController(`http://${instanceAddress(instance.uid)}:${instance.port}`, instance.cookie, endpoint, request);
  },
};

const handleVosOps = createVosOps({
  sessionFor: req => AUTH_DISABLED ? undefined : authenticate(req),
  async tokenFor(session) {
    const record = await findUser(USERS_FILE, session.subject);
    return record ? accessTokenFor(record.namespace) : undefined;
  },
  async agentSessionAllowed(subject, sessionId) {
    const instance = liveInstance(subject);
    if (!instance?.cookie) return false;
    const projection = await callSessionController(
      `http://${instanceAddress(instance.uid)}:${instance.port}`, instance.cookie, 'session/projections', { sessionId },
    ).catch(() => undefined);
    return projection?.kind === 'sequenced' && projection.values?.permissions?.currentValue === 'vos-full-access';
  },
  userinfoUrl,
  readBody: readJsonBody,
  respond: json,
});

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = stripPrefix(url.pathname);
  if (req.method === 'GET' && (path === '/__vh/api-docs/zh' || path === '/__vh/api-docs/en')) {
    const language = path.endsWith('/zh') ? 'zh' : 'en';
    void readFile(new URL('./pages/api-' + language + '.md', import.meta.url), 'utf8').then(text => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
      res.end(text);
    }).catch(() => json(res, 500, { error: 'internal' }));
    return;
  }
  if (path.startsWith(OPS_PATH + '/agent/')) {
    // Node fetch sends Sec-Fetch-Mode: cors even on loopback. Browsers also
    // send site metadata; retain those checks, the loopback fence and the key.
    const { 'sec-fetch-mode': mode, ...headers } = req.headers;
    const contract = !AUTH_DISABLED && (mode === undefined || mode === 'cors') && !egressRefusal({
      headers, remoteAddress: req.socket.remoteAddress, capability: 'vos-ops',
    }) ? capabilityContractFor(req.headers['x-vh-capability-key']) : undefined;
    const sessionId = req.headers['x-vh-ops-session'];
    if (!contract || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    url.pathname = OPS_PATH + path.slice((OPS_PATH + '/agent').length);
    void handleVosOps(req, res, url, {
      session: { subject: contract.subject }, sessionId,
      browserAlive: (sid, userAgent) => sessions.loadSession(sid, userAgent)?.subject === contract.subject,
    });
    return;
  }
  if (path.startsWith(OPS_PATH + '/')) {
    url.pathname = path;
    void handleVosOps(req, res, url);
    return;
  }
  if (path.startsWith(AGENT_API_PREFIX)) {
    url.pathname = path;
    void handleAgentApi(req, res, url, agentApiDependencies).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.destroy();
    });
    return;
  }
  if (path.startsWith('/__vh/')) {
    url.pathname = path;
    void handleControl(req, res, url).catch((error) => {
      console.error('control handler failed:', error);
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.destroy();
    });
    return;
  }
  if (stripPrefix(url.pathname) === MARKET_RESTART_PATH) {
    void handleMarketRestart(req, res).catch((error) => {
      console.error('market restart failed:', error);
      if (!res.headersSent) json(res, 502, { ok: false, error: 'restart-failed' });
      else res.destroy();
    });
    return;
  }
  void proxyRequest(req, res).catch((error) => {
    console.error('proxy failed:', error);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('网关错误');
  });
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(new RegExp(`^${APP_BASE_PATH}`), '');
  if (pathname.startsWith('/__vh/svc/')) {
    void proxyServiceUpgrade(req, socket, head).catch((error) => {
      console.error('service upgrade failed:', error);
      socket.destroy();
    });
    return;
  }
  void proxyUpgrade(req, socket, head).catch((error) => {
    console.error('upgrade failed:', error);
    socket.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`v-harness gateway listening on ${HOST}:${String(PORT)}`);
});

/**
 * Drain open instances before exiting: dsh aborts a running turn on SIGTERM,
 * so give it the same bounded window a direct shutdown would.
 */
function shutdown(signal) {
  console.log(`received ${signal}, stopping instances`);
  server.close();
  const deadline = setTimeout(() => process.exit(1), 8_000);
  void Promise.allSettled([stopAll(), closeOfficeCapabilities(), closeWeknoraCapabilities(), closeAlbumCapabilities(), closeImageStudioCapabilities(), closePhotocraftCapabilities(), closeServicesCapabilities(), closeDockerCapabilities()]).finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
