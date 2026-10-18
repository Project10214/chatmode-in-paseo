import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const files=['cos-transcript-core.js','cos-shell-public.js','cos-picker-main.js'];
const sources=await Promise.all(files.map(f=>readFile(new URL('../extension/upstream/'+f,import.meta.url),'utf8')));
function fixture(){
 const cid='12345678-1234-1234-1234-123456789abc',sections=[],handlers=[];let reply;
 const c=vm.createContext({URL,location:{pathname:'/c/'+cid,origin:'https://chatgpt.com'},
  document:{querySelectorAll:()=>sections},getComputedStyle:()=>({display:'block'}),
  addEventListener:(name,cb)=>{if(name==='message')handlers.push(cb)},
  postMessage:message=>{if(message.source==='cip-cos-transcript-reply-v2')reply=message.transcript}});
 c.window=c;for(const source of sources)vm.runInContext(source,c);
 const section=turn=>({parentElement:null,closest:()=>null,matches:()=>false,
  __reactFiber$fixture:{memoizedProps:{conversationId:cid,turn},return:null}});
 const read=()=>{reply=null;for(const cb of handlers)cb({source:vm.runInContext('window',c),origin:'https://chatgpt.com',data:{source:'cip-cos-transcript-ask-v2',v:2,nonce:'completed-0000-0000'}});assert(reply);return reply;};
 return {c,sections,section,read};
}
const user=id=>({type:'user-message',messageId:id,message:'fixture'});
const plain=(id,completed=false,phase='commentary')=>({type:'assistant-message',messageId:id,content:'visible text',completed,phase});
const dil=(id,raw,completed=true)=>({...plain(id,completed),content:'::chatgpt-content-reference{fixture}',contentReferences:[{type:'dil',source_message_id:id,model_dil_v2:{fallbackMarkdown:raw}}]});
test('CM source: a completed intermediate message is ready before the whole native turn ends',()=>{
 const f=fixture(),a=plain('answer'),turn={status:'in_progress',items:[user('user'),a]};f.sections.push(f.section(turn));
 assert.equal(f.read().messages.at(-1).messageState,'pending');
 a.completed=true;const row=f.read().messages.at(-1);
 assert.equal(row.messageState,'complete');assert.equal(row.final,false);assert.equal(row.readable,true);
});
test('CM source: a completed final-channel message is ready, but task completion still requires the native turn',()=>{
 const f=fixture(),turn={status:'in_progress',items:[user('user'),plain('final',true,'final_answer')]};f.sections.push(f.section(turn));
 const early=f.read().messages.at(-1);assert.equal(early.messageState,'complete');assert.equal(early.final,false);
 turn.status='complete';const row=f.read().messages.at(-1);assert.equal(row.messageState,'complete');assert.equal(row.final,true);
});
test('CM source: Chrome forwards exact DIL representation without a prose state machine',()=>{
 const f=fixture(),a=dil('a',String.raw`说明 \!`),turn={status:'in_progress',items:[user('u'),a]};f.sections.push(f.section(turn));
 const row=f.read().messages.at(-1);assert.equal(row.text,String.raw`说明 \!`);assert.equal(row.format,'dil');assert.equal(row.messageState,'complete');
 assert.equal(f.c.CIP_PUBLIC_PROSE,undefined);
 a.contentReferences[0].model_dil_v2.fallbackMarkdown='new version';assert.equal(f.read().messages.at(-1).text,'new version');
});
test('CM source: unavailable completed content is not an empty successful message, and is not permanently poisoned',()=>{
 const f=fixture(),a=dil('a',null),turn={status:'in_progress',items:[user('u'),a]};f.sections.push(f.section(turn));
 let row=f.read().messages.at(-1);assert.equal(row.readable,false);assert.equal(row.error,'ANSWER_CONTENT_UNAVAILABLE');
 a.contentReferences[0].model_dil_v2.fallbackMarkdown='recovered';row=f.read().messages.at(-1);
 assert.equal(row.readable,true);assert.equal(row.error,undefined);assert.equal(row.messageState,'complete');
});
test('CM source: old malformed content is scoped and a newer complete message survives',()=>{
 const f=fixture();f.sections.push(f.section({status:'complete',items:[user('u1'),dil('bad',null)]}),f.section({status:'in_progress',items:[user('u2'),plain('good',true)]}));
 const r=f.read();assert.equal(r.error,undefined);assert.equal(r.messages.at(-1).messageState,'complete');assert.equal(r.issues[0].messageId,'bad');assert.equal(r.issues[0].userMessageId,'u1');
});
