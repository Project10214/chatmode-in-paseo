import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, selection, until } from './helpers.mjs';

test('two sessions send concurrently without sharing conversation identities', async t => {
  const f = await fixture(t); const a = await f.ready(), b = await f.ready({ model: 'm2', appIds: ['asdk_app_b'] });
  const x = await f.sending(a), y = await f.sending(b);
  assert.notEqual(x.result.turnId, y.result.turnId); assert.notEqual(f.broker.snapshot(a.id).conversationId, f.broker.snapshot(b.id).conversationId);
  await assert.rejects(f.broker.observe({ ...x.event, sessionId: b.id, kind: 'snapshot', messageId: 'a1', text: 'wrong owner' }), /TURN_IDENTITY_MISMATCH/);
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
test('stop without a proven native anchor is unconfirmed, not canceled', async t => {
  const f = await fixture(t); const s = await f.ready(); await f.sending(s, 'a', 'a', false);
  await assert.rejects(f.broker.interrupt(s.id), /STOP_UNCONFIRMED/); assert.equal(f.broker.snapshot(s.id).status, 'blocked');
});
test('wrong document, wrong turn and wrong native anchor cannot inject observations', async t => {
  const f = await fixture(t); const s = await f.ready(); const { event } = await f.sending(s);
  for (const patch of [{ documentKey: 'other' }, { tabId: 999 }, { nativeMessageId: 'other' }, { url: 'https://chatgpt.com/c/other' }, { lease: 'other' }]) {
    await assert.rejects(f.broker.observe({ ...event, ...patch, kind: 'snapshot', messageId: 'a', text: 'bad' }));
  }
  assert.equal(f.broker.snapshot(s.id).history.filter(x => x.type === 'assistant_message').length, 0);
});
test('only proven final after a matching snapshot completes a turn', async t => {
  const f = await fixture(t); const s = await f.ready(); const { event } = await f.sending(s); const events = []; f.broker.subscribe(s.id, e => events.push(e));
  await assert.rejects(f.broker.observe({ ...event, kind: 'completed', finalConfirmed: true, messageId: 'answer' }), /FINAL_UNCONFIRMED/);
  await f.broker.observe({ ...event, kind: 'snapshot', messageId: 'answer', text: 'Hello' });
  await f.broker.observe({ ...event, kind: 'snapshot', messageId: 'answer', text: 'Hello there' });
  await f.broker.observe({ ...event, kind: 'completed', finalConfirmed: true, messageId: 'answer' });
  await f.broker.observe({ ...event, kind: 'completed', finalConfirmed: true, messageId: 'answer' });
  assert.equal(events.filter(x => x.state === 'completed').length, 1);
  const state = f.broker.snapshot(s.id); assert.equal(state.history.filter(x => x.type === 'assistant_message').length, 1); assert.equal(state.prompts['message-1'].outcome, 'completed');
});
test('native errors end only this turn, preserve verified link, and never auto-send', async t => {
  const f = await fixture(t); const s = await f.ready(); const { event } = await f.sending(s);
  await f.broker.observe({ ...event, kind: 'failed', error: 'NATIVE_ERROR' });
  const state=f.broker.snapshot(s.id);
  assert.equal(state.status,'idle');
  assert.equal(state.conversationId,'chat-'+s.tabId);
  assert.equal(state.turn.outcome,'failed');
  assert.equal(f.broker.queued().length,0,'failure must not queue another model, message, or account');
});
test('waiting for permission remains active and never auto-approves', async t => {
  const f = await fixture(t); const s = await f.ready(); const { event } = await f.sending(s);
  await f.broker.observe({ ...event, kind: 'waiting' }); assert.equal(f.broker.snapshot(s.id).status, 'running'); assert.equal(f.broker.queued().length, 0);
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
