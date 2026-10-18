/** Public prose regressions under the user-authorized completed-message spec:
 * the production reader hands over the raw public string with its format and
 * native message state; the receiver decodes ONCE (shared/public-prose.mjs).
 * The same counterexample inputs as the streaming era are kept; what changed is
 * the interaction rule: no partial prose packets, so prefix-monotonic partial
 * output is no longer asserted. Exact final text still is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {decodePublicProse} from '../shared/public-prose.mjs';
import {fixture as backendFixture} from './helpers.mjs';

const core=await readFile(new URL('../extension/upstream/cos-transcript-core.js',import.meta.url),'utf8');
const shell=await readFile(new URL('../extension/upstream/cos-shell-public.js',import.meta.url),'utf8');
const decoderSource=(await readFile(new URL('../shared/public-prose.mjs',import.meta.url),'utf8')).replace(/^export /gm,'');
const decode=raw=>decodePublicProse({text:raw,format:'dil'});
function fixture() {
  const context=vm.createContext({location:{pathname:'/c/synthetic'},addEventListener:()=>{}});
  for(const source of [core,shell])vm.runInContext(source,context);
  const message=(id,raw,completed=false,phase='final_answer')=>({
    type:'assistant-message',messageId:id,phase,completed,
    content:'::chatgpt-content-reference{synthetic}',
    contentReferences:[{type:'dil',source_message_id:id,model_dil_v2:{fallbackMarkdown:raw}}]
  });
  const read=(items,status='in_progress')=>context.CIP_COS_SHELL_PUBLIC.sourceFor(
    {memoizedProps:{turn:{status,items:[
      {type:'user-message',messageId:'synthetic-user',message:'fixture'},...items
    ]}}}, {matches:()=>true,closest:()=>null}, {conversationId:'synthetic',conflict:false}
  ).messages;
  return {context,message,read};
}
const state=row=>row.metadata.cipMessageState;
// Pending prefixes are never bodies; the completed raw is handed over intact.
function deliverWhole(raw,expected){
  const f=fixture();
  for(let i=1;i<raw.length;i++){
    const row=f.read([f.message('answer',raw.slice(0,i))]).at(-1);
    assert.equal(state(row),'pending');
  }
  const done=f.read([f.message('answer',raw,true)],'complete').at(-1);
  assert.equal(state(done),'complete');assert.equal(done.metadata.cipProseFormat,'dil');
  assert.equal(done.content.parts[0],raw,'raw public string, not a browser projection');
  assert.equal(decode(done.content.parts[0]),expected);
}

test('prose: whole-line decoder context after a plain prefix is exact on the completed message',()=>{
  deliverWhole('前言 ```code\\!\n结束。','前言 ```code!\n结束。');
  deliverWhole('前言 ~~~code\\!\n结束。','前言 ~~~code!\n结束。');
  deliverWhole('```js\nconst a = "\\_";\n```\n后记 \\_','```js\nconst a = "\\_";\n```\n后记 _');
});

test('prose: every whitespace recognized by the decoder can indent a display formula',()=>{
  for(const indent of ['\u00a0','\u2003','\ufeff',' \t\u00a0']) {
    const raw='前言\n'+indent+'\\[\nx+y\n'+indent+'\\]\n结束';
    deliverWhole(raw,raw);
  }
});

test('prose: a completed commentary is a whole message before the turn completes',()=>{
  const f=fixture();
  const first=f.read([f.message('comment','说明 \\!',false,'commentary')]);
  assert.equal(state(first.at(-1)),'pending','no body for an unfinished commentary');
  const settled=f.read([f.message('comment','说明 \\!',true,'commentary')]);
  assert.equal(state(settled.at(-1)),'complete');
  assert.equal(decode(settled.at(-1).content.parts[0]),'说明 !');
  assert.equal(settled.at(-1).end_turn,false,'Message completion must not finish the user turn');
});

test('prose: a final-answer flag alone must not seal an unfinished native turn',()=>{
  const f=fixture();
  const completeMessage=f.read([f.message('answer','正文',true)]).at(-1);
  assert.equal(state(completeMessage),'complete','message completion does not wait for the task');
  assert.equal(completeMessage.end_turn,false,'the native task is still unfinished');
  const growing=f.read([f.message('answer','正文继续增长',false)]);
  assert.equal(growing.at(-1).content.parts[0],'正文继续增长');
  assert.equal(growing.at(-1).end_turn,false);
  assert.equal(state(growing.at(-1)),'pending','new uncompleted source content is not sealed by an older flag');
  const done=f.read([f.message('answer','正文继续增长',true)],'complete').at(-1);
  assert.equal(done.end_turn,true);assert.equal(state(done),'complete');
});

test('prose: finished commentary history does not exhaust the reader',()=>{
  const f=fixture();
  for(let i=0;i<40;i++) {
    const rows=f.read([f.message('comment-'+i,'已完成的说明',true,'commentary')]);
    assert.equal(rows.at(-1).content.parts[0],'已完成的说明');
    assert.equal(state(rows.at(-1)),'complete');
  }
  assert.equal(f.read([f.message('new-answer','新答案')]).at(-1).content.parts[0],'新答案');
});

test('prose: non-text reference-only final messages do not fail an image-only turn',()=>{
  const f=fixture();
  const image=f.message('image-answer','',true);
  image.contentReferences=[{type:'image',source_message_id:'image-answer'}];
  const rows=f.read([image],'complete');
  assert(!rows.some(row=>row.content?.parts?.some(part=>typeof part==='string'&&part.includes('chatgpt-content-reference'))));
});

test('prose: a large plain message is read and decoded in linear work',()=>{
  const f=fixture(),raw='普通正文'.repeat(5000);
  const count=`globalThis.testedUnits=0;
    const originalTest=RegExp.prototype.test,originalExec=RegExp.prototype.exec;
    RegExp.prototype.test=function(text){testedUnits+=String(text).length;return originalTest.call(this,text);};
    RegExp.prototype.exec=function(text){testedUnits+=String(text).length;return originalExec.call(this,text);};`;
  vm.runInContext(count,f.context);
  const row=f.read([f.message('answer',raw,true)],'complete').at(-1);
  assert.equal(row.content.parts[0],raw);
  assert(f.context.testedUnits<raw.length*25,'reader work must be linear in the message');
  const d=vm.createContext({});vm.runInContext(decoderSource+'\n'+count,d);
  assert.equal(vm.runInContext('decodePublicProse',d)({text:raw,format:'dil'}),raw);
  assert(d.testedUnits<raw.length*25,'one-shot decode must be linear, not quadratic in a long line');
});
