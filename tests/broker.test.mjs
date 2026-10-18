import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, selection, until, pageView, sourceItem } from './helpers.mjs';

test('two sessions send concurrently without sharing conversation identities', async t => {
  const f = await fixture(t); const a = await f.ready(), b = await f.ready({ model: 'm2', appIds: ['asdk_app_b'] });
  const x = await f.sending(a), y = await f.sending(b);
  assert.notEqual(x.result.turnId, y.result.turnId); assert.notEqual(f.broker.snapshot(a.id).conversationId, f.broker.snapshot(b.id).conversationId);
  const injected=pageView(f.broker.snapshot(a.id),{items:[sourceItem('a1','wrong owner')]});
  await assert.rejects(f.broker.observeView({...injected,sessionId:b.id}),/OBSERVATION_LEASE_MISMATCH/);
  await assert.rejects(f.broker.observeView({...injected,sessionId:b.id,
    observationLease:f.broker.snapshot(b.id).observation.lease}),/PAGE_IDENTITY_MISMATCH/);
  assert.equal(f.broker.snapshot(b.id).history.some(item=>item.id==='page:a1'),false);
});
test('stable client ID deduplicates sending and rejects changed contents', async t => {
  const f = await fixture(t); const s = await f.ready(); const a = await f.broker.prompt(s.id, 'same', 'hello'), b = await f.broker.prompt(s.id, 'same', 'hello');
  assert.equal(a.turnId, b.turnId); assert.equal(b.replay, true); assert.equal(f.broker.queued().filter(c => c.kind === 'send').length, 1);
  await assert.rejects(f.broker.prompt(s.id, 'same', 'changed'), /MESSAGE_ID_CONFLICT/);
});
test('busy session and global concurrency cap refuse additional sends', async t => {
  const f = await fixture(t, { maxConcurrent: 2 }); const a = await f.ready(), b = await f.ready(), c = await f.ready();
  await f.broker.prompt(a.id, 'a', 'a'); await f.broker.prompt(b.id, 'b', 'b');
  await assert.rejects(f.broker.prompt(a.id, 'a2', 'a2'), /SESSION_BUSY/);
  await assert.rejects(f.broker.prompt(c.id, 'c', 'c'), /CONCURRENCY_LIMIT/);
});
test('claim and Send authorization are one-shot durable gates', async t => {
  const f = await fixture(t); const s = await f.ready(); await f.broker.prompt(s.id, 'a', 'hello'); const c = f.broker.queued()[0];
  const lease = await f.broker.claim(c.id, s.tabId, s.documentKey);
  await assert.rejects(f.broker.claim(c.id, s.tabId, s.documentKey), /COMMAND_NOT_CLAIMABLE/);
  await assert.rejects(f.broker.authorize(c.id, 'wrong'), /SEND_NOT_AUTHORIZED/);
  await f.broker.authorize(c.id, lease.lease);
  await assert.rejects(f.broker.authorize(c.id, lease.lease), /SEND_NOT_AUTHORIZED/);
});
test('native receipt cannot be recorded without authorization', async t => {
  const f = await fixture(t); const s = await f.ready(); await f.broker.prompt(s.id, 'a', 'hello'); const c = f.broker.queued()[0]; const lease = await f.broker.claim(c.id, s.tabId, s.documentKey);
  await assert.rejects(f.broker.result(c.id, lease.lease, { receipt: true, config: s.config, url: 'https://chatgpt.com/c/a', nativeMessageId: 'u' }), /SEND_NOT_AUTHORIZED/);
});
test('unconfirmed send is never requeued, and the session becomes blocked', async t => {
  const f = await fixture(t); const s = await f.ready(); const { claim } = await f.sending(s, 'a', 'a', false);
  await f.broker.tick(claim.deadline + 1);
  assert.equal(f.broker.snapshot(s.id).status, 'blocked'); assert.equal(f.broker.queued().length, 0);
  await assert.rejects(f.broker.prompt(s.id, 'retry-as-new', 'a'), /DELIVERY_UNCONFIRMED/);
});
test('an unclaimed timeout is not misreported as delivered', async t => {
  const f = await fixture(t); const s = await f.ready(); await f.broker.prompt(s.id, 'a', 'a');
  await f.broker.tick(f.broker.queued()[0].deadline + 1);
  assert.equal(f.broker.snapshot(s.id).status, 'idle'); assert.equal(f.broker.snapshot(s.id).turn.outcome, 'failed');
});
test('restart does not replay either claimed or authorized messages', async t => {
  const f = await fixture(t); const s = await f.ready(); await f.sending(s, 'a', 'a', false); await f.broker.recover();
  assert.equal(f.broker.snapshot(s.id).status, 'blocked'); assert.equal(f.broker.queued().length, 0);
});
test('cancel before authorization sends nothing and produces one terminal outcome', async t => {
  const f = await fixture(t); const s = await f.ready(); const events = []; f.broker.subscribe(s.id, x => events.push(x));
  await f.broker.prompt(s.id, 'a', 'hello'); await f.broker.interrupt(s.id); await f.broker.interrupt(s.id);
  assert.equal(f.broker.queued().length, 0); assert.equal(events.filter(e => e.state === 'canceled').length, 1);
});
test('without a visible Stop an uncertain Send is not falsely canceled or converted into Deny', async t => {
  const f=await fixture(t),s=await f.ready();
  const {claim}=await f.sending(s,'a','a',false);
  await assert.rejects(f.broker.interrupt(s.id),/STOP_NOT_AVAILABLE/);
  assert.equal(f.broker.snapshot(s.id).turn.outcome,null);
  assert.equal(f.store.read().commands[claim.id].phase,'authorized');
  assert.equal(Object.values(f.store.read().commands).some(c=>['stop','approval'].includes(c.kind)),false);
});
test('wrong document, tab, conversation and observation lease cannot inject observations', async t => {
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const current=f.broker.snapshot(s.id),view=pageView(current,{items:[sourceItem('a','bad')]});
  for(const patch of [{documentKey:'other'},{tabId:999},{url:'https://chatgpt.com/c/other'},{observationLease:'other'}])
    await assert.rejects(f.broker.observeView({...view,...patch}));
  assert.equal(f.broker.snapshot(s.id).history.filter(x=>x.type==='assistant_message').length,0);
});
test('standby ends once without waiting for a final body, and later content still updates', async t => {
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const events=[];f.broker.subscribe(s.id,event=>events.push(event));
  const ending=pageView(f.broker.snapshot(s.id),{state:'standby'});
  await f.broker.observeView(ending);await f.broker.observeView(ending);
  assert.equal(events.filter(event=>event.state==='page-standby').length,1);
  assert.equal(f.broker.snapshot(s.id).prompts['message-1'].outcome,'completed');
  await f.view(s,{state:'standby',items:[sourceItem('answer','Hello')]});
  await f.view(s,{state:'standby',items:[sourceItem('answer','Hello there')]});
  const answers=f.broker.snapshot(s.id).history.filter(item=>item.type==='assistant_message');
  assert.equal(answers.length,1);assert.equal(answers[0].text,'Hello there');
  assert.equal(events.filter(event=>event.state==='page-running').length,0);
  assert.equal(f.broker.queued().length,0);
});
test('page errors preserve original text and binding without inventing a task failure or sending again', async t => {
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  await f.view(s,{state:'running'});
  await f.view(s,{state:'abnormal',items:[sourceItem('page-error','错误请点击重试',{role:'page',kind:'notice'})]});
  const state=f.broker.snapshot(s.id);
  assert.equal(state.conversationId,'chat-'+s.tabId);
  assert.equal(state.observation.page.state,'abnormal');
  assert.equal(state.turn.outcome,null);
  assert.equal(state.history.find(item=>item.id==='page:page-error').data.source.text,'错误请点击重试');
  assert.equal(f.broker.queued().length,0);
});
test('authorization with Voice and no Stop is standby, retains the request and never auto-approves', async t => {
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const approval={key:'approval-broker-test',app:'mymac',tool:null,input:null,clickable:true};
  await f.view(s,{page:{observedAt:Date.now(),readable:true,controls:{
    stop:{visible:false,enabled:false},send:{visible:false,enabled:false},voice:{visible:true,enabled:true}}},
    approvals:[approval]});
  const state=f.broker.snapshot(s.id);
  assert.equal(state.observation.page.state,'standby');
  assert.equal(state.turn.outcome,'completed');
  assert.equal(state.approvals[approval.key].state,'open');
  assert.equal(f.broker.queued().length,0);
});
test('configuration must be read back; echoing another model cannot commit', async t => {
  const f = await fixture(t); const s = await f.broker.create(selection); const p = f.broker.configure(s.id, selection); p.catch(() => {});
  const c = await until(() => f.broker.queued()[0]); const lease = await f.broker.claim(c.id, 999, 'doc');
  await assert.rejects(f.broker.result(c.id, lease.lease, { config: { model: 'wrong', thinkingOption: null, appIds: [] }, tabId: 999, url: 'https://chatgpt.com/' }), /CONFIG_NOT_CONFIRMED/);
  assert.equal(f.broker.snapshot(s.id).tabId, null);
});

test('restarted first-page app selection refusal is retryable before any Send', async t => {
  const f = await fixture(t);
  const s = await f.broker.create(selection);
  const pending = f.broker.configure(s.id, selection); pending.catch(() => {});
  const open = await until(() => f.broker.queued().find(c => c.kind === 'open' && c.sessionId === s.id));
  const claim = await f.broker.claim(open.id, 901, 'doc-orphan');
  await f.broker.result(open.id, claim.lease, {error:'APP_SELECTION_CHANGED'});
  await assert.rejects(pending,/APP_SELECTION_CHANGED/);
  assert.equal(f.broker.snapshot(s.id).status,'idle');
  assert.equal(f.broker.snapshot(s.id).tabId,null);
  assert.equal(f.broker.queued().filter(c=>c.kind==='send').length,0);
  const retry=f.broker.configure(s.id,selection); retry.catch(()=>{});
  const next=await until(()=>f.broker.queued().find(c=>c.kind==='open'&&c.id!==open.id));
  const nextClaim=await f.broker.claim(next.id,902,'doc-clean');
  await f.broker.result(next.id,nextClaim.lease,{config:selection,tabId:902,url:'https://chatgpt.com/'});
  await retry;
  assert.equal(f.broker.snapshot(s.id).status,'idle');
  assert.equal(f.broker.snapshot(s.id).tabId,902);
});
test('legacy blocked unbound control reopens only if no turn or Send ever existed',async t=>{
  const f=await fixture(t),s=await f.broker.create(selection);
  const pending=f.broker.configure(s.id,selection);pending.catch(()=>{});
  const c=await until(()=>f.broker.queued().find(x=>x.kind==='open'&&x.sessionId===s.id));
  const claim=await f.broker.claim(c.id,903,'doc-uncertain');
  await f.broker.result(c.id,claim.lease,{error:'CONTENT_UNAVAILABLE'});
  await assert.rejects(pending,/CONTENT_UNAVAILABLE/);
  assert.equal(f.broker.snapshot(s.id).status,'blocked');
  assert.equal(f.broker.snapshot(s.id).error,'CONTROL_UNCONFIRMED');
  await f.broker.recoverUnboundControl(s.id);
  assert.equal(f.broker.snapshot(s.id).status,'idle');
  assert.equal(f.broker.queued().filter(x=>x.kind==='send').length,0);
  await assert.rejects(f.broker.recoverUnboundControl(s.id),/SESSION_REQUIRES_INSPECTION/);
  const issued=await f.ready();
  const uncertain=await f.sending(issued,'unconfirmed','must not replay',false);
  await f.broker.tick(uncertain.claim.deadline+1);
  await assert.rejects(f.broker.recoverUnboundControl(issued.id),/SESSION_REQUIRES_INSPECTION/);
});
test('real POST app evidence is stored separately from message receipt; omitted app never causes another Send',async t=>{
  const f=await fixture(t);
  const s=await f.ready(); const events=[]; f.broker.subscribe(s.id,event=>events.push(event));
  const res=await f.broker.prompt(s.id,'app-evidence','test message');
  const cmd=f.broker.queued().find(c=>c.kind==='send'&&c.sessionId===s.id);
  const claim=await f.broker.claim(cmd.id,s.tabId,s.documentKey);
  await f.broker.authorize(cmd.id,claim.lease);
  await f.broker.result(cmd.id,claim.lease,{
    receipt:true,config:s.config,url:'https://chatgpt.com/c/chat-'+s.tabId,
    nativeMessageId:'native-app-evidence',appNetworkEvidence:'omitted'
  });
  const stored=f.store.read().commands[cmd.id];
  assert.equal(stored.result.appNetworkEvidence,'omitted');
  assert.equal(stored.result.receipt,true);
  assert.equal(f.broker.snapshot(s.id).status,'running');
  assert.equal(events.filter(e=>e.state==='receipt').at(-1).appNetworkEvidence,'omitted');
  assert.equal(f.broker.queued().filter(c=>c.kind==='send').length,0);
});
test('app evidence unknown and no-app cases cannot fabricate proof',async t=>{
  const f=await fixture(t);
  const first=await f.ready();
  await f.sending(first,'legacy','test legacy');
  const firstSend=Object.values(f.store.read().commands).find(c=>c.kind==='send'&&c.sessionId===first.id);
  assert.equal(firstSend.result.appNetworkEvidence,'unverified');

  const noApp=await f.ready({model:'m1',thinkingOption:'standard',appIds:[]});
  await f.sending(noApp,'no-app','plain text');
  const plainSend=Object.values(f.store.read().commands).find(c=>c.kind==='send'&&c.sessionId===noApp.id);
  assert.equal(plainSend.result.appNetworkEvidence,'none');
});
test('an old local cancellation does not suppress Stop for a later actual webpage run',async t=>{
  const f=await fixture(t),s=await f.ready();
  await f.sending(s);await f.view(s,{state:'standby'});
  await f.broker.prompt(s.id,'cancel-local','not sent');
  await f.broker.interrupt(s.id);
  await f.view(s,{state:'running'});
  const stopped=f.broker.interrupt(s.id);stopped.catch(()=>{});
  const command=await until(()=>f.broker.queued().find(c=>c.kind==='stop'));
  const current=f.broker.snapshot(s.id);
  assert.equal(command.payload.observationLease,current.observation.lease);
  const claim=await f.broker.claim(command.id,current.tabId,current.documentKey);
  await f.broker.result(command.id,claim.lease,{stopped:true});
  await stopped;
  assert.equal(f.broker.snapshot(s.id).observation.run.active,true,'click receipt is not standby');
  await f.view(s,{state:'standby'});
  assert.equal(f.broker.snapshot(s.id).observation.run.active,false);
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='stop').length,1);
});
