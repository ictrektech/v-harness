/** Verify a disposable VOS image: shared RPC artifacts, tenant startup, authentication, and the proxied page. */
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readdir,readFile} from 'node:fs/promises';
assert.ok((await readFile('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js','utf8')).includes('selectDefaultModel'), 'browser Remote assembly must include default-model selection');
const webRoot='/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist';
assert.equal(JSON.parse(await readFile(webRoot+'/manifest.webmanifest','utf8')).name,'v-harness','installed web manifest must use the fork identity');
assert.match(await readFile(webRoot+'/favicon.svg','utf8'),/viewBox="0 0 1196 813"/,'installed favicon must carry the interwoven mark');
assert.ok((await readFile('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js','utf8')).includes('v-harness'),'installed chat bundle must contain the fork copy');
const upstream=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.includes('userinfo')?{sub:'startup-smoke',preferred_username:'startup-smoke'}:{models:[]}));});
upstream.listen(18090,'127.0.0.1'); await once(upstream,'listening');
const gateway=spawn('/opt/v-harness/bin/entrypoint',[],{env:{...process.env,VOS_OIDC_USERINFO_URL:'http://127.0.0.1:18090/userinfo',V_SCHEDULER_URL:'http://127.0.0.1:18090'},stdio:['ignore','inherit','inherit']});
try {
 const base='http://127.0.0.1:8080';
 for(let i=0;i<100;i++){try{const r=await fetch(base+'/__vh/health');if(r.ok)break;}catch{} await new Promise(r=>setTimeout(r,300));}
 const session=await fetch(base+'/__vh/session');const {csrf}=await session.json();assert.ok(csrf);
 const auth=await fetch(base+'/__vh/auth',{method:'POST',headers:{'content-type':'application/json','x-vh-csrf':csrf,cookie:'vh_csrf='+csrf},body:JSON.stringify({access_token:'isolated-fixture-token',expires_in:3600})});
 const body=await auth.json();console.log('AUTH RESULT',auth.status,body.authenticated);assert.equal(auth.status,200);assert.equal(body.authenticated,true);
 const cookie=auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 const page=await fetch(base+'/',{headers:{cookie}});const html=await page.text();assert.equal(page.status,200);assert.ok(html.includes('<html'));assert.ok(html.includes('<title>v-harness</title>'),'proxied page must use the fork title');assert.ok(!html.includes('网关错误'));console.log('FULL STARTUP AND AUTHENTICATED PAGE: PASS');
}catch(error){for(const file of await readdir('/data/logs').catch(()=>[])) console.log('INSTANCE LOG',await readFile('/data/logs/'+file,'utf8'));throw error;}finally{gateway.kill('SIGTERM');upstream.close();}
