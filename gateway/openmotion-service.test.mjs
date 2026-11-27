import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openMotionHeaders} from './openmotion-service.mjs';
import {editorBytes} from './agent-plugins/openmotion/vos-editor.mjs';
import {exposePreview} from './agent-plugins/openmotion/vos-preview.mjs';

test('OpenMotion proxy preserves same-origin admission while using local upstream origin',()=>{
 const headers={host:'127.0.0.1:4173'};
 assert.equal(openMotionHeaders({headers:{host:'vos.example:1180',origin:'https://vos.example:1180',referer:'https://vos.example:1180/app/','sec-fetch-site':'same-origin'}},headers),true);
 assert.equal(headers.origin,'http://127.0.0.1:4173');
 assert.equal(headers.referer,'http://127.0.0.1:4173/');
 for(const origin of ['https://other.example','https://vos.example:9999','invalid'])assert.equal(openMotionHeaders({headers:{host:'vos.example:1180',origin}},{}),false);
 assert.equal(openMotionHeaders({headers:{host:'vos.example:1180','sec-fetch-site':'cross-site'}},{}),false);
});

test('OpenMotion directs the preview handoff to the authenticated VOS user browser',async()=>{
 const result=await exposePreview({result:{serverInfo:{name:'openmotion'},instructions:'OpenMotion tools',nextAction:'Use the host built-in browser to open previewUrl in this conversation.'}});
 assert.ok(result.result.instructions.includes('authenticated VOS browser'));
 assert.ok(result.result.nextAction.includes('mapped VOS previewUrl'));
 assert.ok(!result.result.nextAction.includes('Use the host built-in browser'));
});

test('Studio assets stay under the service prefix without changing external URLs or binary responses',()=>{
 const input=Buffer.from('<script src="/editor-assets/index.js"></script> fetch("/motion-api/templates"); url(/design-system/font.woff2); const external="https://example.com/api/test"; const file="/home/workspace";');
 const output=editorBytes(input,'text/javascript',4173).toString();
 assert.ok(output.includes('"/__vh/svc/4173/editor-assets/index.js"'));
 assert.ok(output.includes('"/__vh/svc/4173/motion-api/templates"'));
 assert.ok(output.includes('url(/__vh/svc/4173/design-system/font.woff2)'));
 assert.ok(output.includes('https://example.com/api/test'));
 assert.ok(output.includes('"/home/workspace"'));
 assert.equal(editorBytes(input,'image/png',4173),input);
 assert.equal(editorBytes(input,'text/javascript',undefined),input);
});
