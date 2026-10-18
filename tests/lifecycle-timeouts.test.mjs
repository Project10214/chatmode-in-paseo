/** Lifecycle/timeout behaviour under the continuous observation contract.
 *
 * A bound, authorized Send whose receipt is uncertain is kept as ONE pending
 * receipt and its observation run stays active (`running`), not `sending`.
 * Timeouts never replay a Send and never turn a lost observer into a webpage
 * failure. The removed heartbeat/watchdog/receipt_recovered observation events
 * are listed at the end with their current equivalents.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, pageView, until } from './helpers.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';

const url = s => `https://chatgpt.com/c/chat-${s.tabId}`;
const sends = f => Object.values(f.store.read().commands).filter(c => c.kind === 'send').length;
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

test('LIVE-T01: a clicked bound Send becomes one pending receipt and an active observation, not a second Send',async t=>{
  const f=await fixture(t),s=await f.ready(),notices=[];
  f.broker.subscribe(s.id,e=>notices.push(e));
  await unconfirmed(f,s);
  const current=f.broker.snapshot(s.id);
  assert.equal(current.status,'running','a pending receipt is an observation run, not a failed Send');
  assert.equal(current.turn.receiptPending,true);
  assert.equal(current.turn.outcome,null);
  assert.equal(current.turn.receivedAt,undefined);
  assert.equal(current.conversationId,'chat-'+s.tabId);
  assert.equal(current.observation.run.active,true);
  assert.equal(f.broker.queued().length,0);
  assert.ok(notices.some(x=>x.state==='receipt-pending'));
  await assert.rejects(f.broker.prompt(s.id,'new-id','different'),/SESSION_BUSY/);
  assert.equal(sends(f),1);
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
  assert.equal(f.broker.snapshot(b.id).status,'running');
  assert.equal(f.broker.snapshot(b.id).turn.receiptPending,true);
  assert.equal(f.broker.snapshot(b.id).conversationId,'chat-'+b.tabId);
  assert.equal(f.broker.queued().length,0);
  assert.equal(sends(f),2,'one explicitly requested Send per session, no replay');
});

test('LIVE-T11: a queued prompt is released by the active run ending, not by another tab working',async t=>{
  const f=await fixture(t,{maxConcurrent:1,turnTimeout:35}),a=await f.ready(),b=await f.ready();
  await f.sending(a);
  let acquired=false;
  const waiting=f.broker.slots.acquire(b.id).then(lease=>{acquired=true;return lease;});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(acquired,false,'the slot is still owned by the active run');
  await f.view(f.broker.snapshot(a.id),{state:'standby'});
  const lease=await waiting;
  assert.equal(acquired,true);
  lease.release();
});

test('LIVE-T12: Provider connection close/reopen does not Stop a verified native turn',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
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
  assert.equal(f.broker.snapshot(s.id).turn.outcome,null,'closing the provider is not a Stop');
  assert.equal(f.broker.snapshot(s.id).status,'running');
  const second=await connect(),next=await open(second,'host-second');
  assert.ok(next.some(e=>e.type==='session.turn'&&e.state==='started'));
  await f.view(s,{state:'running',items:[{id:'continuing',userMessageId:null,role:'assistant',
    lane:'output',kind:'message',text:'still working',format:'text',order:[1],
    nativeMessageId:'native-continuing'}]});
  await until(()=>next.some(e=>e.type==='timeline.item'&&e.item.id==='page:continuing'&&
    e.item.text==='still working'));
  await second.close();
  assert.equal(Object.values(f.store.read().commands).some(c=>c.kind==='stop'),false);
});

test('LIVE-T13: after claim, a browser RPC timeout keeps the authorized attempt and its late receipt is used',async t=>{
  const f=await fixture(t),s=await f.ready(),{claim}=await f.sending(s,'timeout-message','slow response',false);
  await f.broker.bindConversation(claim.id,claim.lease,
    {tabId:s.tabId,documentKey:s.documentKey,url:url(s)});
  await f.broker.result(claim.id,claim.lease,{error:'CONTENT_TIMEOUT'});
  let state=f.broker.snapshot(s.id);
  assert.equal(state.status,'running');
  assert.equal(state.turn.receiptPending,true);
  assert.equal(state.turn.outcome,null);
  assert.equal(state.turn.receivedAt,undefined);
  assert.equal(f.broker.queued().length,0);
  assert.equal(sends(f),1);
  // The original browser still owes a strict native user receipt; it clears
  // the pending flag without a second Send or a new turn.
  await f.broker.result(claim.id,claim.lease,{receipt:true,config:s.config,
    nativeMessageId:'proven-late-user',url:url(s)});
  state=f.broker.snapshot(s.id);
  assert.equal(state.turn.receiptPending,false);
  assert.equal(state.turn.nativeMessageId,'proven-late-user');
  assert.equal(state.status,'running');
  assert.equal(sends(f),1);
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

test('LIVE-T15: a native run may safely rebind after document replacement',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s,'reload');
  const before=f.broker.snapshot(s.id);
  const replacement=await f.broker.rebindObservation({sessionId:s.id,
    observationLease:before.observation.lease,previousDocumentKey:before.documentKey,
    documentKey:'replacement-document',tabId:before.tabId,
    url:`https://chatgpt.com/c/${before.conversationId}`});
  const after=f.broker.snapshot(s.id);
  assert.equal(after.documentKey,'replacement-document');
  assert.equal(after.turn.id,before.turn.id,'the Paseo turn identity is unchanged');
  assert.notEqual(replacement.observationLease,before.observation.lease);
  await assert.rejects(f.broker.observeView({...pageView(after),observationLease:before.observation.lease}),
    /OBSERVATION_LEASE_MISMATCH/);
  // A frame under the fresh lease is accepted; no Stop is invented and no
  // second Send appears.
  await f.broker.observeView(pageView(after,{state:'running'}));
  assert.equal(f.broker.snapshot(s.id).observation.page.state,'running');
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='stop').length,0);
  assert.equal(sends(f),1);
});

/* Retired assertions (mechanism removed):
 * LIVE-T02 heartbeat kept a pending receipt alive for hours -> there is no
 *   heartbeat lane. A pending receipt has no expiry; only the observed
 *   conversation or an explicit user action changes it (T01/T06/T13 above,
 *   CONTOBS-01/02 for identity).
 * LIVE-T03 receipt_recovered resumed tool/final observation -> the late strict
 *   receipt is now accepted by the original command result (T06/T13) and
 *   content arrives as continuous sources, not a snapshot/completed lane.
 * LIVE-T04 wrong lease/tab/route could not recover a pending delivery -> the
 *   same fence now lives on observation frames and rebinds (CONTOBS-01,
 *   CM-R2, MON-11/17, LATE-3/4).
 * LIVE-T09 observation_gap -> recordObservationGap keeps a gap reason and an
 *   unknown page state; it never forges liveness or completion (CM-R9,
 *   CONTOBS-10).
 * LIVE-T10 the watchdog failed a turn after prolonged loss -> a lost observer
 *   is not a failed native turn any more (CM-R9, CONTOBS-10). Command deadlines
 *   still expire their own command (T06/T07/T14).
 * LIVE-T15's old 'stopping' status no longer exists: Stop is a queued command and
 *   the reported page state always comes from the visible controls. The
 *   rebind/no-replay guarantees are asserted in T15 above.
 */
