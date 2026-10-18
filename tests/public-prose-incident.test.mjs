/** Regressions from the 2026-10-17 investigation, migrated to the
 * user-authorized completed-message spec (whole native messages, not a
 * character stream). All inputs are synthetic. No live Chrome, account,
 * provider or stored user state. Production readers (transcript core, shell
 * public reader, picker) and the real Broker are exercised; the deleted
 * streaming adapter is used ONLY by the one test explicitly marked HISTORICAL.
 *
 * Goals kept from the incident: subordinate duplicates are excluded first; an
 * old bad message never blinds the next turn; many bad items never exhaust the
 * reader; private parents never leak; an observation failure is not proof the
 * native task stopped. A real revision of an already delivered body is now
 * refused at the Broker message entry as a local issue (no browser lock-in).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fixture as backendFixture} from './helpers.mjs';
import {decodePublicProse} from '../shared/public-prose.mjs';

const cid='12345678-1234-1234-1234-123456789abc';
const files=['upstream/cos-transcript-core.js','upstream/cos-shell-public.js','upstream/cos-picker-main.js'];
const sources=await Promise.all(files.map(file=>readFile(new URL('../extension/'+file,import.meta.url),'utf8')));
const historical=await readFile(new URL('./fixtures/historical-streaming-prose.js',import.meta.url),'utf8');
const assistant=(id,raw,completed=false,phase='final_answer')=>({type:'assistant-message',messageId:id,phase,completed,
  content:'::chatgpt-content-reference{fixture}',contentReferences:[{type:'dil',source_message_id:id,model_dil_v2:{fallbackMarkdown:raw}}]});
// Two own DIL bodies: the reader cannot prove which one the page shows.
const unreadable=(id,completed=true,phase='commentary')=>({...assistant(id,'A',completed,phase),
  contentReferences:[1,2].map(n=>({type:'dil',source_message_id:id,model_dil_v2:{fallbackMarkdown:'body '+n}}))});
const user=id=>({type:'user-message',messageId:id,message:'Synthetic input'});
function browserFixture(){
  const listeners=[],sections=[];let reply;
  const context=vm.createContext({URL,location:{pathname:'/c/'+cid,origin:'https://chatgpt.com'},
    getComputedStyle:()=>({display:'block'}),
    document:{querySelectorAll:()=>sections},
    addEventListener:(name,fn)=>{if(name==='message')listeners.push(fn)},
    postMessage:value=>{if(value.source==='cip-cos-transcript-reply-v2')reply=value.transcript}
  });
  context.window=context;
  for(const source of sources)vm.runInContext(source,context);
  const section=turn=>({parentElement:null,closest:()=>null,matches:()=>false,
    __reactFiber$synthetic:{memoizedProps:{conversationId:cid,turn},return:null}});
  const read=()=>{
    reply=null;
    for(const handler of listeners)handler({source:vm.runInContext('window',context),origin:'https://chatgpt.com',
      data:{source:'cip-cos-transcript-ask-v2',v:2,nonce:'incident-0000-0000-0000'}});
    assert(reply,'Production picker did not reply');return reply;
  };
  return {context,sections,section,read};
}
const shellRead=(f,turn,id='t')=>f.context.CIP_COS_SHELL_PUBLIC.sourceFor({memoizedProps:{entry:{id,turn}}},
  {matches:()=>false,closest:()=>null,querySelector:()=>null,getAttribute:k=>k==='data-turn-key'?id:null},{conversationId:cid,conflict:false});
const row=(reply,id)=>reply.messages.find(x=>x.id===id);
const asMessage=(event,r)=>({...event,kind:'message',messageId:r.id,text:r.text,format:r.format,messageState:r.messageState});

test('incident control: the full reader hands over raw DIL; pending stays pending, completion is whole',()=>{
  const f=browserFixture(),a=assistant('answer','标题\n\n');
  const turn={status:'in_progress',items:[user('user-one'),a]};
  f.sections.push(f.section(turn));
  let r=row(f.read(),'answer');
  assert.equal(r.messageState,'pending','an unfinished message is not a body to deliver');
  assert.equal(r.format,'dil');
  a.contentReferences[0].model_dil_v2.fallbackMarkdown+='第一段 a\\_b';
  a.completed=true;turn.status='complete';
  r=row(f.read(),'answer');
  assert.equal(r.messageState,'complete');assert.equal(r.final,true);
  assert.equal(r.text,'标题\n\n第一段 a\\_b','raw public string, decoded once on the receiver');
  assert.equal(decodePublicProse({text:r.text,format:r.format}),'标题\n\n第一段 a_b');
});

test('incident: an excluded reasoning duplicate is dropped before it can affect the canonical body',t=>{
  const f=browserFixture(),canonical=assistant('shared-answer','已发布标题\n\n');
  const turn={status:'in_progress',items:[user('user-one'),canonical]};
  assert.equal(shellRead(f,turn,'turn-one').messages.at(-1).content.parts[0],'已发布标题\n\n');
  canonical.contentReferences[0].model_dil_v2.fallbackMarkdown+='正常新增正文';
  turn.items.splice(1,0,{type:'chatgpt-reasoning-group',items:[assistant('shared-answer','一个本应跳过的旧副本')]});
  let result,error;try{result=shellRead(f,turn,'turn-one')}catch(e){error=e.message}
  t.diagnostic(JSON.stringify({canonicalOnlyGrew:true,excludedDuplicate:error??'ignored'}));
  assert.equal(error,undefined,'Duplicate filtering must run before any prose handling');
  assert.deepEqual(Array.from(result.messages.filter(x=>x.id==='shared-answer'),x=>x.content.parts[0]),['已发布标题\n\n正常新增正文']);
});

test('incident: a failed historical message must not fail a healthy next user turn',t=>{
  const f=browserFixture();
  const oldTurn={status:'complete',items:[user('old-user'),unreadable('old-answer',true,'final_answer')]};
  const oldSection=f.section(oldTurn);f.sections.push(oldSection);
  assert.equal(f.read().issues.find(x=>x.messageId==='old-answer')?.code,'ANSWER_CONTENT_UNAVAILABLE');
  const next={status:'in_progress',items:[user('new-user'),assistant('new-answer','新轮正常正文',true,'commentary')]};
  f.sections.push(f.section(next));
  const withHistory=f.read();
  f.sections.splice(0,1);
  const alone=f.read();
  f.sections.unshift(oldSection);
  const restored=f.read();
  t.diagnostic(JSON.stringify({withHistory:withHistory.error,newTurnAlone:alone.available,oldRowRestored:restored.error}));
  assert.equal(withHistory.error,undefined,'An old per-message failure must not poison the next-turn envelope');
  assert.equal(withHistory.issues.find(x=>x.messageId==='old-answer')?.code,'ANSWER_CONTENT_UNAVAILABLE','The old failure remains explicit');
  assert.equal(row(withHistory,'old-answer').readable,false,'unreadable is never an empty readable body');
  assert.equal(row(withHistory,'new-answer').text,'新轮正常正文');
  assert.equal(row(withHistory,'new-answer').messageState,'complete');
  assert.deepEqual(row(withHistory,'new-answer'),row(alone,'new-answer'));
});

test('incident: a completed excluded duplicate cannot prematurely complete the canonical message',()=>{
  const f=browserFixture(),canonical=assistant('shared','标题');
  const duplicate=assistant('shared','标题',true);
  const turn={status:'in_progress',items:[user('u'),{type:'chatgpt-reasoning-group',items:[duplicate]},canonical]};
  const read=()=>shellRead(f,turn).messages.find(x=>x.id==='shared');
  assert.equal(read().metadata.cipMessageState,'pending','the duplicate completion flag is not this message');
  canonical.contentReferences[0].model_dil_v2.fallbackMarkdown+='和后续';
  assert.equal(read().content.parts[0],'标题和后续');
  assert.equal(read().metadata.cipMessageState,'pending');
  canonical.completed=true;turn.status='complete';
  assert.equal(read().metadata.cipMessageState,'complete');
});

test('incident: forty failed items do not exhaust the reader or erase their own refusals',()=>{
  const f=browserFixture();
  const items=[user('u')];for(let i=0;i<40;i++)items.push(unreadable('failed-'+i));
  items.push(assistant('healthy','new answer',true));
  f.sections.push(f.section({status:'complete',items}));
  const r=f.read();
  assert.equal(r.error,undefined);
  assert.equal(r.issues.filter(x=>/^failed-/.test(x.messageId)&&x.code==='ANSWER_CONTENT_UNAVAILABLE').length,40);
  assert.equal(row(r,'healthy').text,'new answer');assert.equal(row(r,'healthy').final,true);
});

test('HISTORICAL oracle (not production): the deleted streaming adapter kept refusals beyond its parser capacity',()=>{
  // Research only: tests/fixtures/historical-streaming-prose.js is no longer
  // loaded by the manifest. This documents the old capacity behavior.
  const context=vm.createContext({location:{pathname:'/c/'+cid},addEventListener(){}});
  vm.runInContext(historical,context);const prose=context.CIP_PUBLIC_PROSE;
  for(let i=0;i<40;i++){
    prose.update({id:'failed-'+i,raw:'A'},x=>x);
    assert.throws(()=>prose.update({id:'failed-'+i,raw:'B'},x=>x),/ANSWER_RAW_DIVERGED/);
  }
  assert.equal(prose.update({id:'healthy',raw:'new answer'},x=>x),'new answer');
  assert.throws(()=>prose.update({id:'failed-0',raw:'A'},x=>x),/ANSWER_RAW_DIVERGED/);
});

/* Retired lane: broker.observe message revisions and observation 'failed'
 * events. Current equivalents:
 * - an unfinished representation is never locked in; a completed rewrite is
 *   retained as current source but refused for host replacement (PROSE-FLOW-1,
 *   PROSE-FLOW-2, CM-R4);
 * - a content/observation failure is an issue or gap, not a native stop or
 *   idle claim (CONTOBS-10, CM-R9).
 */

test('incident: a typed view retains public nested commentary but never private groups',()=>{
  const f=browserFixture();
  const turn={status:'in_progress',items:[user('u'),
    {type:'chatgpt-reasoning-group',items:[{...assistant('public-comment','Visible'),phase:'commentary'}]},
    {type:'chatgpt-reasoning-group',isVisuallyHidden:true,items:[{...assistant('private-comment','PRIVATE'),phase:'commentary'}]},
    {type:'chatgpt-reasoning-group',metadata:{is_visually_hidden:true},items:[{...assistant('private-meta','PRIVATE'),phase:'commentary'}]},
    {...assistant('private-recipient','PRIVATE'),phase:'commentary',recipient:'analysis'},
    assistant('final','Answer')]};
  f.sections.push(f.section(turn));
  const r=f.read();assert.deepEqual(Array.from(r.messages,x=>x.id),['u','public-comment','final']);
  assert.deepEqual(Array.from(r.messages.find(x=>x.id==='public-comment').position),[1,0]);
  assert.equal(JSON.stringify(r).includes('PRIVATE'),false);
});
