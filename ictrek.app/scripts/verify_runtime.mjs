/** Verify a disposable VOS image: shared RPC artifacts, tenant startup, authentication, and the proxied page. */
import {createServer} from 'node:http';
import {execFileSync,spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
assert.ok((await readFile('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js','utf8')).includes('selectDefaultModel'), 'browser Remote assembly must include default-model selection');
assert.equal(execFileSync('npm', ['config', 'get', 'registry'], { encoding: 'utf8' }).trim(), 'https://registry.npmjs.org/');
const webRoot='/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist';
assert.equal(JSON.parse(await readFile(webRoot+'/manifest.webmanifest','utf8')).name,'v-harness','installed web manifest must use the fork identity');
assert.match(await readFile(webRoot+'/favicon.svg','utf8'),/viewBox="0 0 1196 813"/,'installed favicon must carry the interwoven mark');
assert.ok((await readFile('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js','utf8')).includes('v-harness'),'installed chat bundle must contain the fork copy');
assert.ok((await readFile('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js','utf8')).includes('v-harness'),'installed layout bundle must retain the fork title after boot');
for(const name of ['locale','ui-knowledge','ui-tool-cards','ui-user-questions','ui-voffice']) {
 const bundle=await readFile('/opt/v-harness/plugins/dsh-client-'+name+'/lib/client.js','utf8');
 assert.ok(!/require\(["']@deepseek-ai\/(?:cosmokit|schemastery)["']\)/.test(bundle),name+' must inline its vendor utilities before staging');
}
assert.ok((await readFile('/opt/v-harness/plugins/dsh-api-session-controller/lib/client.js','utf8')).includes('@deepseek-ai/dsh-api-session-controller'),'session controller browser artifact must be staged with its Host artifact');
const tokens = new Map([
 ['isolated-fixture-token', 'startup-smoke'],
 ['isolated-other-token', 'startup-other'],
]);
const model = 'fixture/chat';
const replyText = 'API fixture completed';
const upstream = createServer((req, res) => {
 const subject = tokens.get(req.headers.authorization?.replace(/^Bearer /, ''));
 res.setHeader('content-type', 'application/json');
 if (!subject) {
   res.writeHead(401);
   res.end(JSON.stringify({ code: 10001 }));
   return;
 }
 if (req.url === '/userinfo') {
   res.end(JSON.stringify({ sub: subject, preferred_username: subject, locale: 'en' }));
 } else if (req.url === '/api/v1/models') {
   res.end(JSON.stringify({ models: [{ id: model, endpoints: ['chat/completions'] }] }));
 } else if (req.url === '/v1/chat/completions') {
   req.resume();
   const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model };
   res.setHeader('content-type', 'text/event-stream');
   res.end([
     { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: replyText }, finish_reason: null }] },
     { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
   ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n');
 } else {
   res.writeHead(404);
   res.end('{}');
 }
});
upstream.listen(18090,'127.0.0.1'); await once(upstream,'listening');
const gateway=spawn('/opt/v-harness/bin/entrypoint',[],{env:{...process.env,VOS_OIDC_USERINFO_URL:'http://127.0.0.1:18090/userinfo',V_SCHEDULER_URL:'http://127.0.0.1:18090'},stdio:['ignore','inherit','inherit']});
try {
 const base='http://127.0.0.1:8080';
 for(let i=0;i<100;i++){try{const r=await fetch(base+'/__vh/health');if(r.ok)break;}catch{} await new Promise(r=>setTimeout(r,300));}
 const session=await fetch(base+'/__vh/session');const {csrf}=await session.json();assert.ok(csrf);
 const auth=await fetch(base+'/__vh/auth',{method:'POST',headers:{'content-type':'application/json','x-vh-csrf':csrf,cookie:'vh_csrf='+csrf},body:JSON.stringify({access_token:'isolated-fixture-token',expires_in:3600})});
 const body=await auth.json();console.log('AUTH RESULT',auth.status,body.authenticated);assert.equal(auth.status,200);assert.equal(body.authenticated,true);
 const cookie=auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 for (let attempt = 0; attempt < 300; attempt++) {
   const boot = await fetch(base + '/__vh/boot', { headers: { cookie } }).then(r => r.json());
   if (boot.boot > 0) break;
   if (boot.error) throw new Error(JSON.stringify(boot));
   await new Promise(resolve => setTimeout(resolve, 1000));
 }
 const page=await fetch(base+'/',{headers:{cookie}});const html=await page.text();assert.equal(page.status,200);assert.ok(html.includes('<html'));assert.ok(html.includes('<title>v-harness</title>'),'proxied page must use the fork title');assert.ok(!html.includes('网关错误'));console.log('FULL STARTUP AND AUTHENTICATED PAGE: PASS');
 const rpc = async (method, args) => {
   const response = await fetch(base + '/api/' + method, {
     method: 'POST', headers: { cookie, 'content-type': 'application/json' },
     body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
   });
   const result = (await response.json()).result;
   assert.equal(result?.ok, true, JSON.stringify(result?.error));
   return result.value;
 };
 const workspace = await rpc('workspace/create', { request: { path: '/home/startup-smoke/workspace' } });
 assert.ok(workspace.workspace.workspaceId);
 console.log('WORKSPACE CONTROLLER CREATE: PASS');
 const catalog = await rpc('session/modelCatalog', {});
 const provider = catalog.groups.find(item => item.models.some(row => row.id === model));
 assert.ok(provider, 'fixture model missing from V-Scheduler catalog');
 await rpc('session/selectDefaultModel', { selection: { provider: provider.id, model } });
 const apiBase = base + '/app/com.ictrek.v-harness/__vh/api/v1';
 const api = (path, { token = 'isolated-fixture-token', body, method = body === undefined ? 'GET' : 'POST' } = {}) =>
   fetch(apiBase + path, {
     method,
     headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
     ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   });
 for (const token of ['', 'invalid-fixture-token']) {
   const denied = await api('/sessions', { token, body: {} });
   assert.equal(denied.status, 401);
 }
 assert.equal((await api('/sessions', { body: { workspaceId: null } })).status, 400);
 const created = await api('/sessions', { body: { workspaceId: workspace.workspace.workspaceId } });
 const createdBody = await created.json();
 assert.equal(created.status, 201, JSON.stringify(createdBody));
 const sessionPath = '/sessions/' + createdBody.sessionId;
 const requestId = randomUUID();
 const prompt = { requestId, text: 'Say API fixture completed.' };
 for (let n = 0; n < 2; n++) {
   const accepted = await api(sessionPath + '/prompts', { body: prompt });
   assert.equal(accepted.status, 202, await accepted.text());
 }
 let events;
 for (let n = 0; n < 45; n++) {
   const response = await api(sessionPath + '/events');
   const body = await response.json();
   assert.equal(response.status, 200, JSON.stringify(body));
   events = body.events;
   if (events.some(event => event.type === 'turn-ended')) break;
   await new Promise(resolve => setTimeout(resolve, 1000));
 }
 assert.equal(events.filter(event => event.type === 'prompt-recorded' && event.requestId === requestId).length, 1);
 assert.ok(events.some(event => event.type === 'assistant-text' && event.text === replyText));
 assert.ok(events.some(event => event.type === 'turn-ended' && event.outcome === 'completed'), JSON.stringify(events));
 const isolated = await api(sessionPath + '/events', { token: 'isolated-other-token' });
 assert.equal(isolated.status, 404, await isolated.text());
 for (const language of ['zh', 'en']) {
   const docs = await fetch(base + '/__vh/api-docs/' + language);
   assert.equal(docs.status, 200);
   assert.match(await docs.text(), /POST \/sessions/);
 }
 console.log('VOS BEARER API, TASK COMPLETION AND TENANT ISOLATION: PASS');
 const state = await fetch(base + '/media-desk/state', { headers: { cookie, 'x-media-desk-lang': 'en' } });
 assert.equal(state.status, 200);
 assert.ok(Array.isArray((await state.json()).state.items));
 const unknown = await fetch(base + '/media-desk/nonexistent', { headers: { cookie } });
 assert.equal(unknown.status, 404);
 const crossSiteWrite = await fetch(base + '/media-desk/ops', {
   method: 'POST',
   headers: { cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
   body: JSON.stringify({ ops: [] }),
 });
 assert.equal(crossSiteWrite.status, 403);
 console.log('AUTHENTICATED MEDIA DESK AND CROSS-SITE WRITE REJECTION: PASS');
 const market = await fetch(base + '/dsh-market/status', { headers: { cookie } });
 assert.equal(market.status, 200);
 const plugins = await market.json();
 assert.equal(plugins.region, 'global');
 assert.equal(plugins.githubProxy, null);
 for (const name of ['dshmarket', 'ds-bot', '@xmanrui/dsh-im', 'dsh-mcp-connector', 'dsh-media-desk']) {
   assert.ok(Object.hasOwn(plugins.installed, name), `Missing bundled plugin ${name}`);
 }
 const logs = '/data/.vh/logs';
 for (const file of await readdir(logs)) {
   assert.doesNotMatch(await readFile(logs + '/' + file, 'utf8'), /prompt section .* is already registered/);
 }
 console.log('GLOBAL MARKET DEFAULT AND BUNDLED PLUGINS: PASS');
}catch(error){for(const file of await readdir('/data/.vh/logs').catch(()=>[])) console.log('INSTANCE LOG',(await readFile('/data/.vh/logs/'+file,'utf8')).replace(/token=[^\s&]+/g, 'token=<redacted>'));throw error;}finally{gateway.kill('SIGTERM');upstream.close();}
