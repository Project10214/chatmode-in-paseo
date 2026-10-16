import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.mjs';
import { nativeActivity, phaseLabel } from '../server/activity.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';

const step=(kind='search',done=false)=>({kind,label:'web.run',done});
const activity=(phase='search',steps=[step()])=>({phase,nativeStatus:'in_progress',steps});

test('NATIVE1 public native activity is bounded to status/tool names only',()=>{
  assert.deepEqual(nativeActivity(activity()),activity());
  for(const bad of [
    {...activity(),secret:'token'},
    {...activity(),steps:[{...step(),arguments:{authorization:'abc'}}]},
    {...activity(),steps:[{...step(),label:'https://example.com/?key=secret'}]},
    {...activity(),steps:Array(13).fill(step())},
    {...activity(),phase:'fabricated'},
    {...activity(),nativeStatus:'error'},
    {...activity(),steps:[{kind:'search',label:'query',done:'true'}]}
  ])assert.throws(()=>nativeActivity(bad),/ACTIVITY_INVALID/);
  assert.equal(phaseLabel('approval'),'正在等待网页授权');
});

test('NATIVE2 observed native tool state goes into one replayable timeline card',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  const first={...event,kind:'activity',activity:activity()};
  const seen=[];f.broker.subscribe(s.id,e=>seen.push(e));
  const result=await f.broker.observe(first);
  assert.equal(result.active,true);
  await f.broker.observe(first);
  assert.equal(seen.filter(e=>e.state==='activity').length,1);
  let rows=f.broker.snapshot(s.id).history.filter(x=>x.kind==='native-activity');
  assert.equal(rows.length,1);
  assert.equal(rows[0].data.turnId,event.turnId);
  assert.equal(rows[0].data.steps[0].done,false);
  assert.equal(f.broker.snapshot(s.id).status,'running','activity alone is not completion proof');
  await f.broker.observe({...first,activity:activity('search',[step('search',true)])});
  rows=f.broker.snapshot(s.id).history.filter(x=>x.kind==='native-activity');
  assert.equal(rows.length,1);assert.equal(rows[0].data.steps[0].done,true);
});

test('NATIVE3 status ownership cannot cross tabs, leases or native turns',async t=>{
  const f=await fixture(t),a=await f.ready(),b=await f.ready();
  const x=await f.sending(a,'a'),y=await f.sending(b,'b');
  const before=JSON.stringify(f.broker.snapshot(b.id).history);
  for(const change of [
    {sessionId:b.id},{tabId:y.event.tabId},{lease:y.event.lease},
    {nativeMessageId:y.event.nativeMessageId},
    {url:y.event.url}
  ])await assert.rejects(f.broker.observe({...x.event,...change,kind:'activity',activity:activity()}));
  assert.equal(JSON.stringify(f.broker.snapshot(b.id).history),before);
});

test('NATIVE4 completed terminal updates the same card and does not fabricate prose',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  const signals=[];f.broker.subscribe(s.id,e=>signals.push(e));
  await f.broker.observe({...event,kind:'activity',activity:activity('thinking',[])});
  await f.broker.observe({...event,kind:'snapshot',messageId:'native-final',text:'Done'});
  await f.broker.observe({...event,kind:'completed',finalConfirmed:true,messageId:'native-final'});
  const items=f.broker.snapshot(s.id).history.filter(x=>x.kind==='native-activity');
  assert.equal(items.length,1);assert.equal(items[0].data.phase,'completed');
  assert.equal(items[0].data.nativeStatus,'complete');
  assert.equal(signals.filter(x=>x.state==='completed').length,1);
  assert.equal(signals.filter(x=>x.state==='activity').length,1);
  assert.equal(signals.find(x=>x.state==='completed').activityItem.data.phase,'completed');
});

test('NATIVE5 failed turn marks activity card failed; no fake completion',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  await f.broker.observe({...event,kind:'activity',activity:activity('tool',[step('tool')])});
  await f.broker.observe({...event,kind:'failed',error:'NATIVE_ERROR'});
  const state=f.broker.snapshot(s.id);
  assert.equal(state.status,'idle');
  assert.equal(state.conversationId,'chat-'+s.tabId);
  assert.equal(state.turn.outcome,'failed');
  assert.equal(state.history.find(x=>x.kind==='native-activity').data.phase,'failed');
});

test('NATIVE6 Paseo Provider emits upserted timeline plugin item and final update',async t=>{
  const f=await fixture(t),events=[];
  const provider=await createProvider({...f,status:()=>({connected:true})}).connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>provider.close());provider.onEvent(e=>events.push(e));
  await provider.send({type:'session.open',requestId:'open',sessionId:'host',history:'skip',
    config:{cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,model:'m1',thinkingOption:'standard',providerOptions:{appIds:['asdk_app_a']}}});
  for(let i=0;i<120&&!events.some(e=>e.type==='session.ready');i++)await new Promise(r=>setTimeout(r,5));
  const opened=events.find(e=>e.type==='session.opened');
  assert.ok(opened);
  const sid=opened.persistence.data.id;
  await provider.send({type:'session.prompt',sessionId:'host',prompt:{clientMessageId:'one',delivery:'auto',input:{type:'message',content:[{type:'text',text:'Hello'}]}}});
  const open=await until(()=>f.broker.queued().find(c=>c.sessionId===sid&&c.kind==='open'));
  const c=await f.broker.claim(open.id,150,'document-150');
  await f.broker.result(open.id,c.lease,{config:open.payload.config,tabId:150,url:'https://chatgpt.com/'});
  const sending=await until(()=>f.broker.queued().find(c=>c.sessionId===sid&&c.kind==='send'));
  const claim=await f.broker.claim(sending.id,150,'document-150');
  await f.broker.authorize(sending.id,claim.lease);
  await f.broker.result(sending.id,claim.lease,{receipt:true,config:sending.payload.config,tabId:150,
    url:'https://chatgpt.com/c/chat-150',nativeMessageId:'native-user-1'});
  await until(()=>events.some(e=>e.type==='session.turn'&&e.state==='started'));
  const ev={sessionId:sid,turnId:sending.payload.turnId,lease:claim.lease,nativeMessageId:'native-user-1',
    tabId:150,documentKey:'document-150',url:'https://chatgpt.com/c/chat-150'};
  await f.broker.observe({...ev,kind:'activity',activity:activity('search',[step('search')])});
  await until(()=>events.some(e=>e.type==='timeline.item'&&e.item.kind==='native-activity'));
  assert.equal(events.filter(e=>e.type==='timeline.item'&&e.item.kind==='native-activity').length,1);
  await f.broker.observe({...ev,kind:'snapshot',messageId:'native-answer',text:'Result'});
  await f.broker.observe({...ev,kind:'completed',finalConfirmed:true,messageId:'native-answer'});
  assert.equal(events.filter(e=>e.type==='timeline.item'&&e.item.kind==='native-activity').length,2);
  assert.equal(events.filter(e=>e.type==='session.turn'&&e.state==='completed').length,1);
  assert.equal(events.some(e=>e.type==='session.runtime_failed'),false);
});
