/** Verify a disposable VOS image: shared RPC artifacts, tenant startup, authentication, and the proxied page. */
import {createServer} from 'node:http';
import {execFileSync,spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {cp,mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
const upgrade = process.env.VH_UPGRADE_FIXTURE;
const bundled = JSON.parse(await readFile('/opt/v-harness/gateway/agent-plugins/registry-plugins.json', 'utf8')
  .catch(error => {
    if (upgrade === 'prepare' && error.code === 'ENOENT') return 'null';
    throw error;
  }));
const optionalBundles = bundled ? JSON.parse(await readFile(
  '/opt/v-harness/gateway/agent-plugins/optional-bundles.json', 'utf8',
)) : [];
const profile = '/data/startup-smoke/.dsh/profiles/web';
const fixtureFile = '/data/.vh/release-session-fixture.json';
const runtimeModules = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules';

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
const personalModel = 'personal-fixture';
const personalReply = 'Personal model fixture completed';
const personalKey = 'isolated-personal-model-test';
let personalRequests = 0;
let schedulerAvailable = true;
const upstream = createServer((req, res) => {
 const key = req.headers.authorization?.replace(/^Bearer /, '');
 const subject = tokens.get(key);
 res.setHeader('content-type', 'application/json');
 if (!subject && !(key === personalKey && req.url === '/v1/chat/completions')) {
   res.writeHead(401);
   res.end(JSON.stringify({ code: 10001 }));
   return;
 }
 if (req.url === '/userinfo') {
   res.end(JSON.stringify({ sub: subject, preferred_username: subject, locale: 'en' }));
 } else if (req.url === '/api/v1/models') {
   if (!schedulerAvailable) {
     res.writeHead(503);
     res.end('{}');
     return;
   }
   res.end(JSON.stringify({ models: [{ id: model, endpoints: ['chat/completions'] }] }));
 } else if (req.url === '/v1/chat/completions') {
   req.resume();
   const personal = key === personalKey;
   if (personal) personalRequests++;
   const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: personal ? personalModel : model };
   res.setHeader('content-type', 'text/event-stream');
   res.end([
     { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: personal ? personalReply : replyText }, finish_reason: null }] },
     { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
   ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n');
 } else {
   res.writeHead(404);
   res.end('{}');
 }
});
upstream.listen(18090,'127.0.0.1'); await once(upstream,'listening');
const gateway=spawn('/opt/v-harness/bin/entrypoint',[],{env:{...process.env,VOS_OIDC_USERINFO_URL:'http://127.0.0.1:18090/userinfo',V_SCHEDULER_URL:'http://127.0.0.1:18090',VH_NET_ALLOW_CIDRS:'127.0.0.1/32'},stdio:['ignore','inherit','inherit']});
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
 if (bundled) {
   assert.ok(!html.includes('ds-bot:surface'));
   const graph = JSON.parse(html.match(/globalThis\["__DSH_BOOT__"\] = ([^<]+)<\/script>/u)[1]);
   const inventory = await rpc('pluginManager/listPlugins', {});
   const bundles = await rpc('pluginManager/listBundles', {});
   for (const [name, version] of Object.entries(bundled)) {
     const entry = bundles.find(item => item.name === name);
     assert.equal(entry?.version, version, name);
     const optional = optionalBundles.includes(name);
     assert.equal(entry?.enabled, !optional, name);
     assert.equal(entry?.error, undefined, JSON.stringify(entry?.error));
     if (optional) {
       assert.ok(!inventory.some(item => item.moduleName === name && item.fiberPhase === 'active'), name);
       continue;
     }
     const host = inventory.find(item => item.moduleName === name);
     assert.equal(host?.fiberPhase, 'active', JSON.stringify(host ?? { name }));
     const client = graph.entries.find(item => item.id === name);
     assert.ok(client?.url, `missing browser component for ${name}`);
     const response = await fetch(new URL(client.url, base + '/'), { headers: { cookie } });
     assert.equal(response.status, 200, name);
     assert.match(response.headers.get('content-type') ?? '', /javascript/, name);
     await response.arrayBuffer();
   }
   for (const name of ['dsh-mnemon-source-runtime', 'dsh-mnemon-source-documents',
     'dsh-mnemon-source-memory-spaces', 'dsh-mnemon-source-skills', 'dsh-mnemon-strategy-default-three-tier']) {
     const entry = inventory.find(item => item.moduleName === name);
     assert.equal(entry?.fiberPhase, 'active', JSON.stringify(entry ?? { name }));
   }
   assert.ok(!bundles.some(item => item.name === 'ds-bot'));
   assert.ok(!inventory.some(item => item.moduleName.startsWith('ds-bot')));
   assert.ok(inventory.some(item => item.moduleName === '@deepseek-ai/dsh-client-ui-settings-general' && item.enabled));
   const teamBase = base + '/app/com.ictrek.v-harness/plugins/dsh-agent-teams/';
   const teamState = await fetch(teamBase + 'state', { headers: { cookie } });
   assert.equal(teamState.status, 200, 'Agent Teams state under VOS prefix');
   assert.deepEqual((await teamState.json()).teams, []);
   const teamArtwork = await fetch(teamBase + 'assets/member-qa-v2.png', { headers: { cookie } });
   assert.equal(teamArtwork.status, 200, 'Agent Teams artwork under VOS prefix');
   assert.match(teamArtwork.headers.get('content-type') ?? '', /image\/png/);
   await teamArtwork.arrayBuffer();
   console.log('AGENT TEAMS AUTHENTICATED STATE AND ARTWORK THROUGH VOS PREFIX: PASS');
   console.log('PINNED PLUGINS, ACTIVE HOST FIBERS, BROWSER BUNDLES AND CORE SETTINGS: PASS');
 }
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
 if (upgrade === 'check') {
   const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
   const prior = await api('/sessions/' + fixture.sessionId + '/events');
   assert.equal(prior.status, 200, await prior.clone().text());
   const previousEvents = (await prior.json()).events;
   assert.ok(previousEvents.some(event => event.type === 'assistant-text' && event.text === replyText));
   assert.ok(previousEvents.some(event => event.type === 'turn-ended' && event.outcome === 'completed'));
   const legacyStorage = JSON.parse(await readFile(fixture.shadow + '/package.json', 'utf8'));
   assert.equal(legacyStorage.version, fixture.storageVersion, 'retain the plugin-owned copy in the tenant profile');
   const manifest = JSON.parse(await readFile(profile + '/package.json', 'utf8'));
   assert.ok(!Object.hasOwn(manifest.dependencies, 'ds-bot'));
   assert.ok(!manifest.dsh.profile.bundles.includes('ds-bot'));
   assert.equal(await readFile('/data/startup-smoke/.dsh/ds-bot-upgrade-fixture', 'utf8'), 'preserved');
   console.log('PRIOR IMAGE SESSION REOPENED WITH OLD STORAGE STILL INSTALLED: PASS');
 }
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
 if (bundled) {
   const providerId = 'personal-fixture';
   const ref = 'PERSONAL_FIXTURE_API_KEY';
   await rpc('credentials/set', { ref, value: personalKey });
   await rpc('settings/update', {
     ns: 'llm-pi-ai',
     patch: { providers: { [providerId]: {
       api: 'openai-completions', baseURL: 'http://127.0.0.1:18090/v1', apiKeyEnv: ref, models: [{ id: personalModel }],
     } } },
   });
   let models;
   for (let n = 0; n < 20; n++) {
     models = await rpc('session/modelCatalog', {});
     if (models.groups.some(group => group.id === providerId)) break;
     await new Promise(resolve => setTimeout(resolve, 500));
   }
   assert.ok(models.groups.some(group => group.id === providerId && group.models.some(row => row.id === personalModel)), 'personal provider unavailable');
   assert.ok(models.groups.some(group => group.id === provider.id), 'V-Scheduler remains available');
   await rpc('session/selectDefaultModel', { selection: { provider: providerId, model: personalModel } });
   const selected = await rpc('session/modelCatalog', {});
   assert.equal(selected.default.provider, providerId);
   schedulerAvailable = false;
   const personalOnly = await rpc('session/modelCatalog', {});
   assert.ok(personalOnly.groups.some(group => group.id === providerId));
   assert.ok(!personalOnly.groups.some(group => group.id === provider.id));
   const response = await api('/sessions', { body: { workspaceId: workspace.workspace.workspaceId } });
   assert.equal(response.status, 201, await response.clone().text());
   const personalPath = '/sessions/' + (await response.json()).sessionId;
   const accepted = await api(personalPath + '/prompts', { body: { requestId: randomUUID(), text: 'Run the personal model fixture.' } });
   assert.equal(accepted.status, 202, await accepted.text());
   let completed = false;
   for (let n = 0; n < 45; n++) {
     const observed = await api(personalPath + '/events').then(result => result.json());
     assert.ok(Array.isArray(observed.events));
     if (observed.events.some(event => event.type === 'turn-ended')) {
       assert.ok(observed.events.some(event => event.type === 'turn-ended' && event.outcome === 'completed'), JSON.stringify(observed.events));
       assert.ok(observed.events.some(event => event.type === 'assistant-text' && event.text === personalReply), JSON.stringify(observed.events));
       completed = true;
       break;
     }
     await new Promise(resolve => setTimeout(resolve, 1000));
   }
   assert.equal(completed, true, 'personal model request timed out');
   assert.ok(personalRequests > 0, 'the endpoint received the tenant credential');
   console.log('PERSONAL DEFAULT AND DIRECT INFERENCE WITHOUT V-SCHEDULER: PASS');
 }

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
 for (const name of Object.keys(bundled ?? { dshmarket: true, 'ds-bot': true })) {
   assert.ok(Object.hasOwn(plugins.installed, name), `Missing bundled plugin ${name}`);
 }
 const logs = '/data/.vh/logs';
 for (const file of await readdir(logs)) {
   assert.doesNotMatch(await readFile(logs + '/' + file, 'utf8'), /prompt section .* is already registered/);
 }
 console.log('GLOBAL MARKET DEFAULT AND BUNDLED PLUGINS: PASS');
 if (optionalBundles.length) {
   for (const name of optionalBundles) {
     const change = await rpc('pluginManager/setBundleEnabled', { name, enabled: true });
     assert.equal(change.changed, true, JSON.stringify(change));
     assert.notEqual(change.application, 'failed', JSON.stringify(change));
   }
   const previousBoot = await fetch(base + '/__vh/boot', { headers: { cookie } }).then(r => r.json());
   const restart = await fetch(base + '/__vh/restart', { method: 'POST', headers: { cookie } });
   assert.equal(restart.status, 202);
   let ready = false;
   for (let n = 0; n < 180; n++) {
     const boot = await fetch(base + '/__vh/boot', { headers: { cookie } }).then(r => r.json());
     if (boot.error) throw new Error(JSON.stringify(boot));
     if (boot.boot > 0 && boot.boot !== previousBoot.boot) {
       ready = true;
       break;
     }
     await new Promise(resolve => setTimeout(resolve, 1000));
   }
   assert.ok(ready, 'optional bundles did not boot');
   const inventory = await rpc('pluginManager/listPlugins', {});
   for (const name of ['@liustack/modsearch', 'billion-context', 'billion-context/dsh-compaction-gate']) {
     assert.ok(inventory.some(item => item.moduleName === name && item.fiberPhase === 'active'), name);
   }
   const config = await fetch(base + '/modsearch/config', { headers: { cookie } });
   assert.equal(config.status, 200, await config.clone().text());
   assert.match(config.headers.get('content-type') ?? '', /json/);
   for (const [headers, status] of [
     [{ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, 403],
     [{ 'content-type': 'text/plain' }, 415],
     [{ 'content-type': 'application/json' }, 200],
   ]) {
     const saved = await fetch(base + '/modsearch/config', {
       method: 'POST', headers: { cookie, ...headers }, body: JSON.stringify({ engine: '' }),
     });
     assert.equal(saved.status, status, await saved.text());
   }
   let proxyOrigin;
   for (let n = 0; n < 30; n++) {
     const response = await fetch(base + '/bili/origin', { headers: { cookie } });
     assert.equal(response.status, 200, await response.clone().text());
     proxyOrigin = (await response.json()).origin;
     if (proxyOrigin) break;
     await new Promise(resolve => setTimeout(resolve, 1000));
   }
   assert.match(proxyOrigin ?? '', /^http:\/\/127\.\d+\.\d+\.1:\d+$/);
   assert.notEqual(new URL(proxyOrigin).hostname, '127.0.0.1');

   const response = await api('/sessions', { body: { workspaceId: workspace.workspace.workspaceId } });
   assert.equal(response.status, 201, await response.clone().text());
   const path = '/sessions/' + (await response.json()).sessionId;
   const accepted = await api(path + '/prompts', { body: { requestId: randomUUID(), text: 'Run the optional bundles fixture.' } });
   assert.equal(accepted.status, 202, await accepted.text());
   let completed = false;
   for (let n = 0; n < 45; n++) {
     const { events } = await api(path + '/events').then(result => result.json());
     if (events.some(event => event.type === 'turn-ended')) {
       assert.ok(events.some(event => event.type === 'turn-ended' && event.outcome === 'completed'), JSON.stringify(events));
       completed = true;
       break;
     }
     await new Promise(resolve => setTimeout(resolve, 1000));
   }
   assert.ok(completed, 'model request with the optional bundles timed out');
   console.log('OPTIONAL BUNDLES, TENANT-LOCAL PROXY AND MODEL SESSION: PASS');
 }
 if (upgrade === 'prepare') {
   const manifestPath = profile + '/package.json';
   const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
   assert.ok(manifest.dependencies['ds-bot'], 'prepare the upgrade fixture with the prior DS Bot image');
   if (!manifest.dsh.profile.bundles.includes('ds-bot')) manifest.dsh.profile.bundles.push('ds-bot');
   await writeFile(manifestPath, JSON.stringify(manifest));
   await writeFile('/data/startup-smoke/.dsh/ds-bot-upgrade-fixture', 'preserved');
   const shadow = profile + '/node_modules/@deepseek-ai/dsh-storage-domain';
   await mkdir(profile + '/node_modules/@deepseek-ai', { recursive: true });
   await cp(runtimeModules + '/@deepseek-ai/dsh-storage-domain', shadow, {recursive:true});
   await writeFile(fixtureFile, JSON.stringify({sessionId: createdBody.sessionId, shadow, storageVersion: JSON.parse(await readFile(shadow + '/package.json', 'utf8')).version}), {mode:0o600});
   console.log('PRIOR IMAGE SESSION AND STORAGE FIXTURE SAVED');
 }

}catch(error){for(const file of await readdir('/data/.vh/logs').catch(()=>[])) console.log('INSTANCE LOG',(await readFile('/data/.vh/logs/'+file,'utf8')).replace(/token=[^\s&]+/g, 'token=<redacted>'));throw error;}finally{gateway.kill('SIGTERM');upstream.close();}
