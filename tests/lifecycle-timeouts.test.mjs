import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';

const url = s => `https://chatgpt.com/c/chat-${s.tabId}`;
async function unconfirmed(f, s, text='sent text') {
  const {claim,result,event}=await f.sending(s,'pending-message',text,false);
  await f.broker.bindConversation(claim.id,claim.lease,{
    tabId:s.tabId,documentKey:s.documentKey,url:url(s)
  });
  await f.broker.result(claim.id,claim.lease,{
    error:'RECEIPT_UNCONFIRMED',bindingUrl:url(s),
    diagnostic:{stage:'receipt',nativeClicked:true}
  });
  return {claim,result,event:{...event,nativeMessageId:null}};
}

test('LIVE-T01: a clicked bound Send expires into monitoring, not a failed turn or a second Send',async t=>{
  const f=await fixture(t),s=await f.ready(),notices=[];
  f.broker.subscribe(s.id,e=>notices.push(e));
  await unconfirmed(f,s);
  const current=f.broker.snapshot(s.id);
  assert.equal(current.status,'sending');
  assert.equal(current.turn.receiptPending,true);
  assert.equal(current.turn.outcome,null);
  assert.equal(current.turn.receivedAt,undefined);
  assert.equal(current.conversationId,'chat-'+s.tabId);
  assert.equal(f.broker.queued().length,0);
  assert.ok(notices.some(x=>x.state==='receipt-pending'));
  await assert.rejects(f.broker.prompt(s.id,'new-id','different'),/SESSION_BUSY/);
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
});

test('LIVE-T02: a verified live heartbeat lets a pending receipt survive arbitrary elapsed hours',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await unconfirmed(f,s);
  await f.store.transaction(d=>{d.sessions[s.id].turn.lastObservedAt=Date.now()-4*60*60*1000;});
  await f.broker.observe({...event,kind:'heartbeat'});
  await f.broker.tick(Date.now());
  assert.equal(f.broker.snapshot(s.id).status,'sending');
  assert.equal(f.broker.snapshot(s.id).turn.outcome,null);
  assert.equal(f.broker.queued().length,0);
});

test('LIVE-T03: exact recovered user UUID resumes native tool and final observation',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await unconfirmed(f,s);
  await f.broker.observe({...event,kind:'receipt_recovered',nativeMessageId:'native-actual-user'});
  const running=f.broker.snapshot(s.id);
  assert.equal(running.status,'running');
  assert.equal(running.turn.receiptPending,false);
  assert.equal(running.turn.nativeMessageId,'native-actual-user');
  assert.ok(running.turn.receivedAt);
  const settled={...event,nativeMessageId:'native-actual-user'};
  await f.broker.observe({...settled,kind:'snapshot',messageId:'native-final',text:'Finished after long MCP work'});
  await f.broker.observe({...settled,kind:'completed',messageId:'native-final',finalConfirmed:true});
  assert.equal(f.broker.snapshot(s.id).turn.outcome,'completed');
  assert.equal(f.broker.queued().length,0);
});

test('LIVE-T04: wrong lease, tab, route or layout identity cannot recover pending delivery',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await unconfirmed(f,s);
  for(const [patch,pattern] of [
    [{lease:'other'},/TURN_IDENTITY_MISMATCH/],
    [{tabId:777},/PAGE_IDENTITY_MISMATCH/],
    [{url:'https://chatgpt.com/c/foreign'},/PAGE_IDENTITY_MISMATCH/],
    [{documentKey:'other-document'},/PAGE_IDENTITY_MISMATCH/],
    [{nativeMessageId:'fallback-turn-0:0:user'},/NATIVE_MESSAGE_ID_UNPROVEN/]
  ])await assert.rejects(f.broker.observe({...event,kind:'receipt_recovered',
    nativeMessageId:'native-actual-user',...patch}),pattern);
  assert.equal(f.broker.snapshot(s.id).turn.receiptPending,true);
  assert.equal(f.broker.snapshot(s.id).turn.receivedAt,undefined);
});

test('LIVE-T05: a claimed or not-clicked command never becomes receipt-pending',async t=>{
  const f=await fixture(t),s=await f.ready(),{claim}=await f.sending(s,'not-clicked','text',false);
  await f.broker.result(claim.id,claim.lease,{
    error:'RECEIPT_UNCONFIRMED',notSent:true,bindingUrl:url(s),
    diagnostic:{stage:'receipt',nativeClicked:false}
  });
  assert.equal(f.broker.snapshot(s.id).turn.outcome,'failed');
  assert.equal(f.broker.snapshot(s.id).turn.receiptPending,undefined);
  assert.equal(f.broker.snapshot(s.id).conversationId,null);
});

test('LIVE-T06: expired authorized Send soft-handoffs only if its URL is already bound',async t=>{
  const f=await fixture(t),s=await f.ready(),{claim}=await f.sending(s,'slow','slow network',false);
  await f.broker.bindConversation(claim.id,claim.lease,{tabId:s.tabId,documentKey:s.documentKey,url:url(s)});
  await f.broker.tick(claim.deadline+1);
  assert.equal(f.broker.snapshot(s.id).turn.receiptPending,true);
  assert.equal(f.broker.snapshot(s.id).turn.outcome,null);
  assert.equal(f.store.read().commands[claim.id].phase,'done');
  assert.equal(f.broker.queued().length,0);
  // A late proof from the original, one-shot browser command is not discarded.
  await f.broker.result(claim.id,claim.lease,{receipt:true,config:s.config,
    nativeMessageId:'native-late',url:url(s)});
  assert.equal(f.broker.snapshot(s.id).status,'running');
  assert.equal(f.broker.snapshot(s.id).turn.nativeMessageId,'native-late');
});

test('LIVE-T07: a 90-second Send without an authorized click/route is still safely rejected',async t=>{
  const f=await fixture(t),s=await f.ready(),{claim}=await f.sending(s,'unknown','text',false);
  await f.broker.tick(claim.deadline+1);
  const state=f.broker.snapshot(s.id);
  assert.equal(state.turn.outcome,'failed');
  assert.equal(state.turn.receiptPending,undefined);
  assert.equal(state.conversationId,null);
});

test('LIVE-T08: restart preserves exact running and pending browser turn identities without replay',async t=>{
  const f=await fixture(t),a=await f.ready(),b=await f.ready();
  await f.sending(a,'known','known message',true);
  await unconfirmed(f,b);
  await f.broker.recover();
  assert.equal(f.broker.snapshot(a.id).status,'running');
  assert.equal(f.broker.snapshot(b.id).status,'sending');
  assert.equal(f.broker.snapshot(b.id).turn.receiptPending,true);
  assert.equal(f.broker.queued().length,0);
});

test('LIVE-T09: a stale observation gap never forges liveness or a completion',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await unconfirmed(f,s);
  const before=f.broker.snapshot(s.id).turn.lastObservedAt;
  await f.broker.observe({...event,kind:'observation_gap'});
  const after=f.broker.snapshot(s.id);
  assert.equal(after.turn.lastObservedAt,before);
  assert.equal(after.turn.outcome,null);
  assert.equal(after.status,'sending');
  await assert.rejects(f.broker.observe({...event,url:'https://chatgpt.com/c/other',kind:'observation_gap'}),/PAGE_IDENTITY_MISMATCH/);
});

test('LIVE-T10: genuine prolonged loss of all verified browser activity still triggers a local error',async t=>{
  const f=await fixture(t,{turnTimeout:1000}),s=await f.ready(),{event}=await unconfirmed(f,s);
  await f.store.transaction(d=>{d.sessions[s.id].turn.lastObservedAt=Date.now()-1001;});
  await f.broker.tick(Date.now());
  assert.equal(f.broker.snapshot(s.id).turn.outcome,'failed');
  assert.equal(f.broker.snapshot(s.id).error,'TURN_TIMEOUT');
  assert.equal(f.broker.snapshot(s.id).conversationId,'chat-'+s.tabId);
  await assert.rejects(f.broker.observe({...event,kind:'receipt_recovered',nativeMessageId:'late'}),/TURN_IDENTITY_MISMATCH/);
});

test('LIVE-T11: a queued prompt does not expire merely because another tab keeps working',async t=>{
  const f=await fixture(t,{maxConcurrent:1,turnTimeout:35}),a=await f.ready(),b=await f.ready();
  const {event}=await f.sending(a);
  let acquired=false;
  const waiting=f.broker.slots.acquire(b.id).then(lease=>{acquired=true;return lease;});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(acquired,false);
  await f.broker.observe({...event,kind:'snapshot',messageId:'out',text:'complete'});
  await f.broker.observe({...event,kind:'completed',messageId:'out',finalConfirmed:true});
  const lease=await waiting;
  assert.equal(acquired,true);
  lease.release();
});

test('LIVE-T12: Provider connection close/reopen does not Stop a verified native turn',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  const provider=createProvider({...f,status:()=>({connected:true})});
  const connect=()=>provider.connect({versions:[1],capabilities:CAPABILITIES});
  const config={cwd:'/fixture',systemPrompt:'',env:{},settings:{},mcpServers:{},persist:true,
    model:s.config.model,thinkingOption:s.config.thinkingOption,providerOptions:{appIds:s.config.appIds}};
  const open=async(connection,host)=>{
    const events=[];connection.onEvent(e=>events.push(e));
    await connection.send({type:'session.open',sessionId:host,requestId:'open-'+host,
      config,history:'replay',persistence:{version:1,data:{id:s.id}}});
    await until(()=>events.some(e=>e.type==='session.ready'||e.type==='request.failed'));
    assert.equal(events.find(e=>e.type==='request.failed')?.error?.code,undefined,JSON.stringify(events));
    return events;
  };
  const first=await connect(),events=await open(first,'host-first');
  assert.ok(events.some(e=>e.type==='session.turn'&&e.state==='started'));
  await first.close();
  assert.equal(f.broker.snapshot(s.id).turn.outcome,null);
  assert.equal(f.broker.snapshot(s.id).status,'running');
  const second=await connect(),next=await open(second,'host-second');
  assert.ok(next.some(e=>e.type==='session.turn'&&e.state==='started'));
  await f.broker.observe({...event,kind:'snapshot',messageId:'continuing',text:'still working'});
  assert.ok((await until(()=>next.find(e=>e.type==='timeline.item'&&e.item.id.includes('continuing')))));
  await second.close();
});

test('LIVE-T13: after claim, browser RPC timeout retains a bound authorized attempt instead of failing',async t=>{
  const f=await fixture(t),s=await f.ready(),{claim}=await f.sending(s,'timeout-message','slow response',false);
  await f.broker.bindConversation(claim.id,claim.lease,
    {tabId:s.tabId,documentKey:s.documentKey,url:url(s)});
  await f.broker.result(claim.id,claim.lease,{error:'CONTENT_TIMEOUT'});
  const state=f.broker.snapshot(s.id);
  assert.equal(state.status,'sending');
  assert.equal(state.turn.receiptPending,true);
  assert.equal(state.turn.outcome,null);
  assert.equal(state.turn.receivedAt,undefined);
  assert.equal(f.broker.queued().length,0);
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
  // The original browser still owes a strict native user receipt.
  await f.broker.observe({...{
    sessionId:s.id,turnId:state.turn.id,lease:claim.lease,
    nativeMessageId:'proven-late-user',tabId:s.tabId,documentKey:s.documentKey,
    url:url(s)
  },kind:'receipt_recovered'});
  assert.equal(f.broker.snapshot(s.id).status,'running');
});
test('LIVE-T14: timeout without a prior trustworthy route and explicit non-send evidence remain terminal',async t=>{
  const f=await fixture(t),s=await f.ready(),{claim}=await f.sending(s,'unbound-timeout','hello',false);
  await f.broker.result(claim.id,claim.lease,{error:'CONTENT_TIMEOUT'});
  assert.equal(f.broker.snapshot(s.id).turn.outcome,'failed');
  assert.equal(f.broker.snapshot(s.id).turn.receiptPending,undefined);
  const next=await f.ready(),pending=await f.sending(next,'explicit-no-click','second',false);
  await f.broker.bindConversation(pending.claim.id,pending.claim.lease,
    {tabId:next.tabId,documentKey:next.documentKey,url:url(next)});
  await f.broker.result(pending.claim.id,pending.claim.lease,
    {error:'CONTENT_TIMEOUT',notSent:true});
  assert.equal(f.broker.snapshot(next.id).turn.outcome,'failed');
  assert.equal(f.broker.snapshot(next.id).turn.receiptPending,undefined);
});

test('LIVE-T15: a stopping native turn may safely rebind after document replacement',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s,'stop-and-reload');
  await f.store.transaction(d=>{d.sessions[s.id].status='stopping';});
  const replacement=await f.broker.rebindObservation({...event,
    previousDocumentKey:s.documentKey,documentKey:'replacement-document'});
  assert.equal(replacement.nativeMessageId,event.nativeMessageId);
  assert.equal(f.broker.snapshot(s.id).status,'stopping');
  assert.equal(f.broker.snapshot(s.id).documentKey,'replacement-document');
  await assert.rejects(f.broker.rebindObservation({...event,
    previousDocumentKey:'replacement-document',documentKey:'another-document',
    nativeMessageId:'foreign-user'}),/TURN_IDENTITY_MISMATCH/);
});
