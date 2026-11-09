/**
 * v-harness gateway: VOS SSO front door and per-user dsh reverse proxy.
 *
 * Request flow:
 *   1. An unauthenticated document request receives a bootstrap page that runs
 *      the VOS Fastpath exchange and posts the access token to `/__vh/auth`.
 *   2. `/__vh/auth` verifies the token through VOS userinfo, ensures the user's
 *      instance exists, and mints a signed `vh_session` cookie.
 *   3. Every later request is forwarded to that user's instance over the
 *      address its network namespace is published on, with the browser Cookie
 *      replaced by the instance's own dsh cookie and Host rewritten to
 *      `127.0.0.1:<port>` (the authority dsh signed that cookie for).
 *
 * @module v-harness/gateway/server
 */

import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';

import {
  WorkspaceError,
  listWorkspace,
  openWorkspaceFile,
  statWorkspace,
  uploadWorkspaceFile,
} from './files.mjs';
import {
  ensureInstance,
  instanceBoot,
  launchFailure,
  liveInstance,
  migrateInstanceStateKeys,
  stopAll,
  stopInstance,
  userPaths,
} from './instances.mjs';
import { instanceAddress, tenantLoopback } from './addressing.mjs';
import {
  accessTokenFor,
  closeOfficeCapabilities,
  editorUrlFor,
  ensureOfficeCapability,
  expiryFromToken,
  hasUsableTokens,
  listDocuments,
  rememberOrigin,
  rememberTokens,
} from './office.mjs';
import { closeAlbumCapabilities, ensureAlbumCapability } from './album.mjs';
import { closeImageStudioCapabilities, ensureImageStudioCapability } from './image-studio.mjs';
import {
  handleAgent as handleMcphubAgent,
  mcphubRouting,
  mcphubSelection,
  mcphubServices,
  mcphubTools,
  saveMcphubSelection,
} from './mcphub.mjs';
import { closePhotocraftCapabilities, ensurePhotocraftCapability } from './photocraft.mjs';
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
import { findUser, upsertUser } from './users.mjs';
import { VosAuthError, verifyVosToken } from './vos-auth.mjs';
import {
  closeWeknoraCapabilities,
  ensureWeknoraCapability,
  handleWeknoraControl,
} from './weknora.mjs';
import {
  closeServicesCapabilities,
  ensureServicesCapability,
  initServices,
  listServices,
  restartService,
  resolveService,
  stopService,
} from './services.mjs';
import { closeDockerCapabilities, ensureDockerCapability, resolveContainerPort } from './docker-proxy.mjs';
import { handleScheduler } from './scheduler.mjs';

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

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

const sessions = await openSessionStore(SESSION_DB_FILE, { ttlMs: SESSION_TTL_MS });
// One boot finishes the persistent-state key migration (namespace → subject);
// later boots find nothing to move and leave the file alone.
await migrateInstanceStateKeys(STATE_FILE, USERS_FILE);
// Tenant service registrations survive a gateway restart; a stopped service
// stays listed so the UI can offer restart.
await initServices({ stateRoot: STATE_ROOT });

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
  // The cookie is what the proxied UI relies on; the header is the fallback for
  // the bootstrap page, which cannot count on a cookie having been stored.
  return sessions.loadSession(cookies[SESSION_COOKIE] || header, String(req.headers['user-agent'] ?? ''));
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
 * @param {import('./session.mjs').Session} session
 * @param {import('./users.mjs').UserRecord} record
 * @returns {Promise<boolean>} whether the request may proceed.
 */
async function subjectRecheck(session, record) {
  const now = Date.now();
  const cached = subChecks.get(session.sid);
  if (cached && cached.subject === session.subject && now - cached.checkedAt < SUB_RECHECK_MS) {
    return true;
  }
  subChecks.set(session.sid, { subject: session.subject, checkedAt: now });
  if (AUTH_DISABLED) return true;
  const token = await accessTokenFor(record.namespace);
  if (token === undefined) return true;
  try {
    const identity = await verifyVosToken(token);
    if (identity.subject !== session.subject) {
      sessions.revokeSession(session.sid);
      console.warn(`sub recheck: session drift for ${record.account ?? record.linuxName}, revoked`);
      return false;
    }
    return true;
  } catch (error) {
    // VOS answered and refused this identity (rejected token, 401/403 from
    // userinfo): the session's subject is gone. Fail closed for this session
    // only — the other tenants keep theirs.
    if (error instanceof VosAuthError
      && (error.code === 'vos-token-rejected'
        || (error.code === 'vos-userinfo-status' && (error.status === 401 || error.status === 403)))) {
      sessions.revokeSession(session.sid);
      console.warn(`sub recheck: token refused for ${record.account ?? record.linuxName} (${error.code}), session revoked`);
      return false;
    }
    // Everything else — unreachable endpoint, 5xx, malformed payload — is a
    // VOS outage, not an identity verdict. A hiccup must not sign every
    // tenant out, so fail open; the recheck window throttles the retry.
    console.warn(`sub recheck unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return true;
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
async function bridge(){
  const direct=window.vos_platform?.api?.v1000?.oauth2;
  if(direct)return direct;
  if(window.parent===window)return null;
  const t0=Date.now();
  while(Date.now()-t0<4000){
    await new Promise(r=>setTimeout(r,50));
    const found=window.vos_platform?.api?.v1000?.oauth2;
    if(found)return found;
  }
  return null;
}
function fail(m){
  document.getElementById('m').textContent='无法进入 v-harness';
  document.getElementById('e').textContent=m;
}
async function authorize(cfg){
  const oauth2=await bridge();
  if(!oauth2)throw new Error('当前 VOS 未提供 OIDC Fastpath，无法验证用户身份');
  const verifier=rand(),state=rand();
  const digest=await sha256Bytes(new TextEncoder().encode(verifier));
  const authorized=await oauth2.authorize({
    client_id:cfg.clientId,response_type:'code',scope:cfg.scope,
    state,nonce:rand(),code_challenge:b64(digest),code_challenge_method:'S256'});
  if(authorized.state!==state)throw new Error('VOS OIDC state mismatch');
  const tokens=await oauth2.token({
    grant_type:'authorization_code',code:authorized.code,
    code_verifier:verifier,client_id:cfg.clientId});
  if(!tokens.access_token)throw new Error('VOS OIDC 未返回 access token');
  const res=await fetch('/__vh/auth',{
    method:'POST',credentials:'include',
    headers:{'content-type':'application/json','x-vh-csrf':cfg.csrf||''},
    body:JSON.stringify({access_token:tokens.access_token,
      refresh_token:tokens.refresh_token,expires_in:tokens.expires_in})});
  const body=await res.json().catch(()=>({})).then(v=>v||{});
  if(!res.ok)throw new Error(body.error||'VOS 登录失败');
  // Keep the session here as well: when the browser refuses the cookie this is
  // the only way the next request can still identify itself.
  if(body.session)try{sessionStorage.setItem('vh_session',body.session);}catch{}
}
function showRenew(error){
  document.getElementById('m').textContent='登录状态已恢复，但能力授权已失效';
  const detail=document.getElementById('e');
  detail.textContent=(error?.message||String(error))+'。';
  const renew=document.createElement('button');
  renew.textContent='重新登录';
  renew.onclick=async()=>{await fetch('/__vh/logout',{method:'POST'});location.reload();};
  const skip=document.createElement('button');
  skip.textContent='仍然进入（部分能力不可用）';
  skip.onclick=()=>location.replace('./');
  detail.append(document.createElement('br'),renew,skip);
}
async function boot(){
  let saved='';
  try{saved=sessionStorage.getItem('vh_session')||'';}catch{}
  const cfg=await(await fetch('/__vh/session',{
    credentials:'include',cache:'no-store',
    headers:saved?{'x-vh-session':saved}:{}})).json();
  if(cfg.session)try{sessionStorage.setItem('vh_session',cfg.session);}catch{}
  // Re-prove the signed-in VOS account on every load. The cookie only names
  // the tenant served last, so trusting it here is how two accounts in one
  // browser ended up sharing an instance. VOS silent auth answers "who is
  // signed in now", and /__vh/auth re-issues the cookie for that account.
  if(cfg.authenticated){
    try{await authorize(cfg);}
    catch(error){showRenew(error);return;}
    location.replace('./');
    return;
  }
  await authorize(cfg);
  location.replace('./');
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
const STARTING = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>v-harness</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0d10;color:#c8ccd4;font:14px/1.7 system-ui,sans-serif}
#w{text-align:center}
#m{opacity:.85;display:flex;gap:.6rem;align-items:center;justify-content:center}
#s{width:14px;height:14px;border:2px solid #2a2f38;border-top-color:#7aa2f7;border-radius:50%;animation:r .8s linear infinite}
#h{margin-top:1rem;color:#7d8492;font-size:12px;line-height:1.6}
@keyframes r{to{transform:rotate(360deg)}}</style>
</head><body><div id="w"><div id="m"><span id="s"></span><span>正在启动工作区…</span></div><div id="h"></div></div>
<script>
var tries = 0;
var hint = document.getElementById('h');
var failed = '';
function poll() {
  tries += 1;
  // A launch that keeps failing would otherwise spin here forever with no
  // explanation; say how long it has been, and what to do about it.
  if (tries === 80 && !failed) hint.textContent = '启动时间较长，仍在重试…';
  if (tries === 200 && !failed) hint.textContent = '仍在自动重试：若长时间无响应，请联系管理员查看工作区日志。';
  fetch('./__vh/boot', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (d && typeof d.boot === 'number' && d.boot > 0) { location.replace('./'); return; }
      if (d && typeof d.error === 'string' && d.error !== '') {
        failed = d.error;
        hint.textContent = '启动失败：' + d.error;
      }
      setTimeout(poll, tries < 120 ? 700 : 3000);
    })
    .catch(function () { setTimeout(poll, 1000); });
}
setTimeout(poll, 500);
</script></body></html>`;

/**
 * @param {import('node:http').ServerResponse} res
 */
function sendStarting(res) {
  const body = Buffer.from(STARTING, 'utf8');
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
  if (!(await subjectRecheck(session, record))) {
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
    // knowing.
    const boot = instanceBoot(session.subject);
    const failure = launchFailure(session.subject);
    json(res, 200, failure === undefined ? { boot } : { boot, error: failure });
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

  // Short editor link. The storage service's own URL embeds the WOPI source and
  // a signed token, which runs to hundreds of characters; a chat client that
  // wraps or truncates it drops the signature and the editor answers
  // "unauthorized WOPI host". This path carries only the name and mints a fresh
  // token on every click, so it stays short and never expires.
  if (url.pathname === '/__vh/office/open' && req.method === 'GET') {
    const record = await requireUser(req, res);
    if (!record) return;
    const name = (url.searchParams.get('name') ?? '').trim();
    if (name === '') {
      json(res, 400, { error: 'name-required' });
      return;
    }
    try {
      const link = await editorUrlFor(record.namespace, {
        name,
        edit: url.searchParams.get('readonly') !== '1',
      });
      res.writeHead(302, { location: link.editorUrl, 'cache-control': 'no-store' });
      res.end();
    } catch (error) {
      console.error(`editor link failed (${record.namespace}):`, error?.message ?? error);
      json(res, 502, { error: 'editor-unavailable', message: '编辑器地址暂时取不到，请稍后重试' });
    }
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
    try {
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
      await ensureInstance({
        record,
        stateRoot: STATE_ROOT,
        dshBin: DSH_BIN,
        nodeBin: NODE_BIN,
        statePath: STATE_FILE,
        userHelper: USER_HELPER,
      });
      await startCapabilities(record);
    } catch (error) {
      console.error(
        `instance start failed user=${record.username} account=${record.account ?? record.linuxName}:`,
        error instanceof Error ? error.message : String(error),
      );
      json(res, 503, { authenticated: false, error: '实例启动失败，请稍后重试' });
      return;
    }

    const sid = sessions.createSession({
      subject: record.subject,
      account: record.account ?? record.linuxName,
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
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

  if (url.pathname === '/__vh/logout' && req.method === 'POST') {
    const session = authenticate(req);
    if (session) {
      // Revoking alone leaves the dsh process (and its VOS capabilities)
      // running for whoever holds the instance cookie next; stopping the
      // instance closes the tenant's whole world, not just the browser door.
      sessions.revokeSession(session.sid);
      stopInstance(session.subject);
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
 * @param {import('./users.mjs').UserRecord} record
 * @returns {Promise<void>}
 */
async function startCapabilities(record) {
  const options = {
    namespace: record.namespace,
    subject: record.subject,
    account: record.account ?? record.linuxName,
    uid: record.uid,
    linuxName: record.linuxName,
    home: userPaths(STATE_ROOT, record.account ?? record.linuxName).home,
    userHelper: USER_HELPER,
  };
  const settled = await Promise.allSettled([
    ensureOfficeCapability(options),
    ensureWeknoraCapability(options),
    ensureAlbumCapability(options),
    ensureImageStudioCapability(options),
    ensurePhotocraftCapability(options),
    ensureServicesCapability(options),
    ensureDockerCapability(options),
  ]);
  for (const result of settled) {
    if (result.status === 'rejected') {
      console.error(`capability for ${record.namespace} failed:`, result.reason);
    }
  }
}

/**
 * Resolve the instance for one authenticated request, starting it if needed.
 * @param {import('./session.mjs').SessionPayload} session
 * @returns {Promise<{ port: number, cookie: string | undefined } | undefined>}
 */
async function instanceFor(session) {
  const cached = liveInstance(session.subject);
  if (cached?.cookie) return cached;
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
  await startCapabilities(record);
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
  const previous = liveInstance(key);
  // Let what was already forwarded finish on the process that owns it. Without
  // this the signal lands under in-flight asset requests, the gateway reports
  // the hang-up as 502, and the tab that asked for the restart gets a shell
  // whose modules never load.
  await drainRequests(key);
  stopInstance(key);
  // The port has to be free before the next bind. Waiting for the exit here is
  // cheaper than letting the launch discover a draining process and reclaim
  // the port from it, which is where most of a restart's wall time went: a
  // second click used to start a second launch that fought the first one.
  if (previous?.child) {
    await new Promise((resolve) => {
      if (previous.child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 3000);
      previous.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
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
  if (!(await subjectRecheck(session, record))) {
    // The VOS subject drifted (account kicked / switched): send the browser
    // back through bootstrap, which re-proves identity and re-issues a session.
    if (isDocumentRequest(req)) {
      sendBootstrap(res);
      return;
    }
    json(res, 401, { error: 'session revoked' });
    return;
  }

  // The cookie outlives the gateway's in-memory VOS token, so a reload after a
  // restart would otherwise enter the app with every capability endpoint
  // unauthorized and no way back. A navigation goes through the bootstrap page
  // instead, which replays the VOS login and then returns here. Resolving the
  // token here — not just checking for one — also covers a refresh token VOS no
  // longer accepts: the page then re-authorizes instead of entering dead.
  if (!AUTH_DISABLED && isDocumentRequest(req) && await accessTokenFor(record.namespace) === undefined) {
    sendBootstrap(res);
    return;
  }

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
        const html = injectShell(source.toString('utf8'), { locale, basePath: APP_BASE_PATH });
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

    upstream.on('error', (error) => {
      console.error(`upstream ${String(instance.port)} failed:`, error.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('实例不可用');
      resolve();
    });
    res.on('close', () => { upstream.destroy(); resolve(); });
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
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/__vh/')) {
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
