import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaseoApi} from '@getpaseo/client';
import {createHostTimelineReader} from '../server/host-timeline.mjs';
const entry=(n,text='A')=>({seqStart:n,seqEnd:n,sourceSeqRanges:[{startSeq:n,endSeq:n}],
  item:{type:'assistant_message',messageId:'native-message',text}});
const page=(extra={})=>({agentId:'host-agent',agent:null,direction:'tail',projection:'projected',
  epoch:'epoch',reset:false,staleCursor:false,gap:false,hasOlder:false,hasNewer:false,
  window:{minSeq:1,maxSeq:1,nextSeq:2},startCursor:{epoch:'epoch',seq:1},
  endCursor:{epoch:'epoch',seq:1},entries:[entry(1)],error:null,...extra});
function fixture(response=page()){
  const calls=[];let current=true;
  const api=createPaseoApi({fetchAgentTimeline:async(id,options)=>{
    calls.push({id,options});return typeof response==='function'?response():structuredClone(response);
  }});
  const read=createHostTimelineReader({agent:api.agents.ref('host-agent'),sessionId:'cip-session',
    bindingGeneration:'binding',isCurrent:()=>current});
  return {read,calls,revoke:()=>{current=false;}};
}
test('HT-1 public SDK handle requests a whole projected window and preserves original ranges',async()=>{
  const f=fixture(),view=await f.read();
  assert.deepEqual(f.calls,[{id:'host-agent',options:{direction:'tail',limit:0,projection:'projected'}}]);
  assert.equal(view.fullCoverage,true);assert.equal(view.sessionId,'cip-session');
  assert.deepEqual(view.rows[0],entry(1));
});
test('HT-2 genuinely empty new timeline is distinct from a cold empty retained window',async()=>{
  const empty={entries:[],startCursor:null,endCursor:null};
  assert.equal((await fixture(page({...empty,window:{minSeq:0,maxSeq:0,nextSeq:1}})).read()).fullCoverage,true);
  assert.equal((await fixture(page({...empty,window:{minSeq:9,maxSeq:8,nextSeq:9}})).read()).fullCoverage,false);
});
for(const field of ['gap','reset','staleCursor','hasOlder','hasNewer'])
  test('HT-3 '+field+' cannot prove absent content',async()=>{
    assert.equal((await fixture(page({[field]:true})).read()).coverage.complete,false);
  });
test('HT-4 filtering a row cannot turn a sequence hole into full coverage',async()=>{
  const p=page({window:{minSeq:1,maxSeq:3,nextSeq:4},endCursor:{epoch:'epoch',seq:3},entries:[entry(1),entry(3)]});
  assert.equal((await fixture(p).read()).fullCoverage,false);
});
for(const [name,patch,code] of [
  ['wrong agent',{agentId:'other'},'HOST_AGENT_MISMATCH'],
  ['wrong snapshot',{agent:{id:'other'}},'HOST_AGENT_MISMATCH'],
  ['error',{error:'offline'},'HOST_READ_FAILED'],
  ['canonical not projected',{projection:'canonical'},'HOST_VIEW_INVALID'],
  ['wrong cursor epoch',{endCursor:{epoch:'old',seq:1}},'HOST_CURSOR_INVALID'],
  ['missing cursor',{startCursor:undefined},'HOST_CURSOR_INVALID'],
  ['missing flags',{gap:undefined},'HOST_COVERAGE_UNAVAILABLE'],
  ['missing window',{window:undefined},'HOST_COVERAGE_UNAVAILABLE'],
  ['invalid next seq',{window:{minSeq:1,maxSeq:1,nextSeq:3}},'HOST_COVERAGE_UNAVAILABLE'],
  ['missing source ranges',{entries:[{...entry(1),sourceSeqRanges:undefined}]},'HOST_RANGES_UNAVAILABLE']
])test('HT-5 refuses '+name,async()=>{
  await assert.rejects(fixture(page(patch)).read(),{code});
});
test('HT-6 revoked binding rejects an in-flight read and does not issue a subsequent read',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>{resolve=r;}));
  const pending=f.read();f.revoke();resolve(page());
  await assert.rejects(pending,{code:'HOST_BINDING_EXPIRED'});
  await assert.rejects(f.read(),{code:'HOST_BINDING_EXPIRED'});assert.equal(f.calls.length,1);
});
