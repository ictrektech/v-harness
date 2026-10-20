/**
 * v-harness gateway: VOS SSO front door and per-user dsh reverse proxy.
 *
 * Request flow:
 *   1. An unauthenticated document request receives a bootstrap page that runs
 *      the VOS Fastpath exchange and posts the access token to `/__vh/auth`.
 *   2. `/__vh/auth` verifies the token through VOS userinfo, ensures the user's
 *      instance exists, and mints a signed `vh_session` cookie.
 *   3. Every later request is forwarded to that user's loopback instance with
 *      the browser Cookie replaced by the instance's own dsh cookie and Host
 *      rewritten to `127.0.0.1:<port>`.
 *
 * @module v-harness/gateway/server
 */

import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';

import {
  WorkspaceError,
  listWorkspace,
  openWorkspaceFile,
  statWorkspace,
  uploadWorkspaceFile,
} from './files.mjs';
import { ensureInstance, liveInstance, stopAll, userPaths } from './instances.mjs';
import {
  closeOfficeCapabilities,
  ensureOfficeCapability,
  expiryFromToken,
  rememberTokens,
} from './office.mjs';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  cookie,
  csrfMatches,
  loadSecret,
  newCsrfToken,
  parseCookies,
  signSession,
  verifySession,
} from './session.mjs';
import { findUser, upsertUser } from './users.mjs';
import { VosAuthError, verifyVosToken } from './vos-auth.mjs';
import { closeWeknoraCapabilities, ensureWeknoraCapability, handleWeknoraControl } from './weknora.mjs';

const DATA_ROOT = process.env.DATA_ROOT ?? '/data';
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const USERS_FILE = process.env.USERS_FILE ?? join(DATA_ROOT, 'users.json');
const STATE_FILE = process.env.STATE_FILE ?? join(DATA_ROOT, 'state-instances.json');
const SECRET_FILE = process.env.SECRET_FILE ?? join(DATA_ROOT, 'session-secret');
const DSH_BIN = process.env.DSH_BIN ?? '/opt/v-harness/dsh/apps/cli/lib/bin.js';
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

const secret = await loadSecret(SECRET_FILE);

/**
 * Whether the browser reached us over HTTPS (terminated by the VOS ingress).
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isSecure(req) {
  const forwarded = req.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(',')[0]?.trim().toLowerCase() === 'https';
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {import('./session.mjs').SessionPayload | undefined}
 */
function authenticate(req) {
  return verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE], secret);
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
try{
  const cfg=await(await fetch('/__vh/session',{credentials:'same-origin',cache:'no-store'})).json();
  if(cfg.authenticated){location.replace('./');}
  else{
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
      method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json','x-vh-csrf':cfg.csrf||''},
      body:JSON.stringify({access_token:tokens.access_token,
        refresh_token:tokens.refresh_token,expires_in:tokens.expires_in})});
    const body=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(body.error||'VOS 登录失败');
    location.replace('./');
  }
}catch(error){fail(error?.message||String(error));}
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
 * Control endpoints owned by the gateway itself.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<void>}
 */
async function handleControl(req, res, url) {
  if (url.pathname.startsWith('/__vh/files')) {
    await handleFiles(req, res, url);
    return;
  }

  if (url.pathname.startsWith('/__vh/weknora/')) {
    const record = await requireUser(req, res);
    if (!record) return;
    await handleWeknoraControl(record.namespace, req, res, url.pathname.slice('/__vh/weknora'.length));
    return;
  }

  if (url.pathname === '/__vh/health') {
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/__vh/session' && req.method === 'GET') {
    const session = authenticate(req);
    if (session) {
      json(res, 200, {
        authenticated: true,
        user: { username: session.username, namespace: session.namespace },
      });
      return;
    }
    if (AUTH_DISABLED) {
      // Local debugging: mint a session for one fixed user so the UI can be
      // exercised without VOS. The instance starts on the first proxied request.
      const { record } = await upsertUser(USERS_FILE, {
        subject: DEV_SUBJECT,
        namespace: DEV_NAMESPACE,
        username: 'dev',
      });
      const value = signSession({
        subject: record.subject,
        namespace: record.namespace,
        username: record.username,
        expiresAt: Date.now() + SESSION_TTL_MS,
      }, secret);
      console.warn('VH_AUTH_DISABLED is set: signing in as the local dev user');
      json(res, 200, {
        authenticated: true,
        user: { username: record.username, namespace: record.namespace },
      }, {
        'set-cookie': cookie(SESSION_COOKIE, value, {
          maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1_000),
          secure: isSecure(req),
        }),
      });
      return;
    }
    const csrf = newCsrfToken();
    // The double-submit token must also reach the page: the cookie is
    // HttpOnly, so the client cannot read it back to set the header.
    json(res, 200, { authenticated: false, clientId: CLIENT_ID, scope: SCOPE, csrf }, {
      'set-cookie': cookie(CSRF_COOKIE, csrf, { maxAgeSeconds: 600, secure: isSecure(req) }),
    });
    return;
  }

  if (url.pathname === '/__vh/auth' && req.method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    const presented = req.headers['x-vh-csrf'];
    if (!csrfMatches(String(presented ?? ''), cookies[CSRF_COOKIE] ?? '')) {
      json(res, 403, { authenticated: false, error: 'CSRF 校验失败' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const identity = await verifyVosToken(body.access_token);
      const { record, created } = await upsertUser(USERS_FILE, identity);
      if (created) {
        console.log(`user created namespace=${record.namespace} port=${String(record.port)}`);
      }
      const accessToken = String(body.access_token);
      rememberTokens(record.namespace, {
        access: accessToken,
        ...typeof body.refresh_token === 'string' && body.refresh_token ? { refresh: body.refresh_token } : {},
        expiresAt: expiryFromToken(accessToken, Number(body.expires_in)),
      });
      await ensureInstance({
        record,
        dataRoot: DATA_ROOT,
        dshBin: DSH_BIN,
        nodeBin: NODE_BIN,
        statePath: STATE_FILE,
        userHelper: USER_HELPER,
      });
      await startCapabilities(record);
      const value = signSession({
        subject: record.subject,
        namespace: record.namespace,
        username: record.username,
        expiresAt: Date.now() + SESSION_TTL_MS,
      }, secret);
      json(res, 200, {
        authenticated: true,
        user: { username: record.username, namespace: record.namespace },
      }, {
        'set-cookie': cookie(SESSION_COOKIE, value, {
          maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1_000),
          secure: isSecure(req),
        }),
      });
    } catch (error) {
      const code = error instanceof VosAuthError ? error.code : 'auth-failed';
      const status = code === 'vos-userinfo-unreachable' ? 502 : 401;
      console.warn(`auth rejected: ${code} ${error instanceof Error ? error.message : String(error)}`);
      json(res, status, { authenticated: false, error: '身份验证失败' });
    }
    return;
  }

  if (url.pathname === '/__vh/logout' && req.method === 'POST') {
    json(res, 200, { authenticated: false }, {
      'set-cookie': cookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: isSecure(req) }),
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
    linuxName: record.linuxName,
    home: userPaths(DATA_ROOT, record.namespace).home,
    userHelper: USER_HELPER,
  };
  const settled = await Promise.allSettled([
    ensureOfficeCapability(options),
    ensureWeknoraCapability(options),
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
  const cached = liveInstance(session.namespace);
  if (cached?.cookie) return cached;
  const record = await findUser(USERS_FILE, session.subject);
  if (!record) return undefined;
  const instance = await ensureInstance({
    record,
    dataRoot: DATA_ROOT,
    dshBin: DSH_BIN,
    nodeBin: NODE_BIN,
    statePath: STATE_FILE,
    userHelper: USER_HELPER,
  });
  await startCapabilities(record);
  return instance;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function proxyRequest(req, res) {
  const session = authenticate(req);
  if (!session) {
    if (isDocumentRequest(req)) {
      sendBootstrap(res);
      return;
    }
    json(res, 401, { error: 'unauthenticated' });
    return;
  }

  const instance = await instanceFor(session);
  if (!instance?.cookie) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('实例尚未就绪，请稍后重试');
    return;
  }

  const path = stripPrefix(req.url ?? '/');
  const headers = upstreamHeaders(req, instance.port, instance.cookie);

  await new Promise((resolve) => {
    const upstream = httpRequest({
      host: '127.0.0.1',
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
      // dsh regenerates its SPA boot manifest on restart; a cached shell pins
      // the browser to stale plugin bundles.
      if (String(upstreamRes.headers['content-type'] ?? '').startsWith('text/html')) {
        responseHeaders['cache-control'] = 'no-store';
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('end', resolve);
      upstreamRes.on('error', resolve);
    });

    upstream.on('error', (error) => {
      console.error(`upstream ${String(instance.port)} failed:`, error.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('实例不可用');
      resolve();
    });
    res.on('close', () => { upstream.destroy(); resolve(); });
    req.pipe(upstream);
  });
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

  const upstream = connect(instance.port, '127.0.0.1', () => {
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
  void proxyRequest(req, res).catch((error) => {
    console.error('proxy failed:', error);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('网关错误');
  });
});

server.on('upgrade', (req, socket, head) => {
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
  void Promise.allSettled([stopAll(), closeOfficeCapabilities(), closeWeknoraCapabilities()]).finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
