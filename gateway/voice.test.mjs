import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {apply} from './voice/index.mjs';

test('voice uses the tenant proxy, migrates the local selection, transcribes and disposes',{timeout:10000},async t=>{
 const requests=[];
 const server=createServer(async(req,res)=>{
  requests.push(req.url);assert.equal(req.headers.authorization,'Bearer fixture-key');
  res.setHeader('content-type','application/json');
  if(req.url==='/v1/audio/models')res.end(JSON.stringify({data:[{id:'app-v-voice/sensevoice-int8'}]}));
  else {const chunks=[];for await(const chunk of req)chunks.push(chunk);assert.ok(Buffer.concat(chunks).includes(Buffer.from('app-v-voice/sensevoice-int8')));res.end('{"text":"fixture speech"}');}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const previous={base:process.env.VH_SCHEDULER_URL,key:process.env.VH_SCHEDULER_KEY};
 t.after(()=>{for(const [key,value] of [['VH_SCHEDULER_URL',previous.base],['VH_SCHEDULER_KEY',previous.key]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 process.env.VH_SCHEDULER_URL='http://127.0.0.1:'+server.address().port;process.env.VH_SCHEDULER_KEY='fixture-key';
 let provider,removals=0,cleanup;const selections=[];
 apply({speechToText:{register:p=>{provider=p;return async()=>{removals++;};},snapshot:()=>({selection:{providerId:'sensevoice-local'}}),configure:async value=>selections.push(value)},effect:fn=>{cleanup=Promise.resolve(fn());}});
 const rawDispose=await cleanup;let disposed;const dispose=()=>disposed??=rawDispose();t.after(dispose);
 await new Promise(resolve=>{if(provider.preparation.snapshot().phase==='ready')resolve();else{const remove=provider.preparation.subscribe(()=>{if(provider.preparation.snapshot().phase==='ready'){remove();resolve();}});}});
 assert.deepEqual(selections,[{providerId:'v-scheduler-voice'}]);
 const audio=Buffer.alloc(32044);audio.writeUInt32LE(32000,28);
 const result=await provider.transcribe({audio,language:'zh'},new AbortController().signal);
 assert.equal(result.text,'fixture speech');assert.equal(result.audioSeconds,1);
 assert.deepEqual(requests,['/v1/audio/models','/v1/audio/models','/v1/audio/transcriptions']);
 await dispose();assert.equal(removals,1);
});
