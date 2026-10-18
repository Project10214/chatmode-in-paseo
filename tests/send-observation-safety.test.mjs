import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';

for(const state of ['running','standby'])test('SEND-SAFE receipt failure after observed dispatch cannot override '+state,async t=>{
  const f=await fixture(t),s=await f.ready(),events=[];
  f.broker.subscribe(s.id,event=>events.push(event));
  await f.broker.prompt(s.id,'one-send','one actual attempt');
  const {command,claim,event}=await f.dispatchSend(s,{state});
  await f.broker.result(command.id,claim.lease,{error:'RECEIPT_UNCONFIRMED',
    diagnostic:{stage:'receipt',nativeClicked:true,guardCode:'PAGE_GONE'}});
  let current=f.broker.snapshot(s.id);
  assert.equal(current.observation.page.state,state);
  assert.equal(current.turn.outcome,state==='standby'?'completed':null);
  assert.equal(current.turn.receiptPending,true);
  assert.equal(current.status,state==='running'?'running':'idle');
  assert.equal(events.some(row=>row.state==='failed'),false,'receipt failure is not task failure');
  assert.ok(events.some(row=>row.state==='receipt-pending'));
  if(state==='running')await assert.rejects(f.broker.prompt(s.id,'must-wait','another'),/SESSION_BUSY/);
  const proof={...event,turnId:command.payload.turnId,lease:claim.lease,nativeMessageId:'native-real-receipt'};
  await assert.rejects(f.broker.recoverReceipt({...proof,lease:'wrong'}),/TURN_IDENTITY_MISMATCH/);
  await assert.rejects(f.broker.recoverReceipt({...proof,nativeMessageId:'fallback-turn-0:0:user'}),/NATIVE_MESSAGE_ID_UNPROVEN/);
  await f.broker.recoverReceipt(proof);
  current=f.broker.snapshot(s.id);
  assert.ok(current.turn.receivedAt);
  assert.equal(current.turn.receiptPending,false);
  assert.equal(current.observation.page.state,state);
  assert.equal(current.turn.outcome,state==='standby'?'completed':null);
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
});

test('SEND-SAFE an old document receipt cannot roll back a fresh binding; timeout keeps observing',async t=>{
  const f=await fixture(t),s=await f.ready();
  await f.broker.prompt(s.id,'one-send','one attempt');
  const {command,claim,event}=await f.dispatchSend(s,{state:'running'});
  const rebound=await f.broker.rebindObservation({...event,previousDocumentKey:s.documentKey,
    tabId:s.tabId+1,documentKey:'new-document'});
  const before=f.broker.snapshot(s.id);
  for(const result of [
    {receipt:true,config:command.payload.config,url:event.url,nativeMessageId:'old-document-user'},
    {error:'RECEIPT_UNCONFIRMED',diagnostic:{nativeClicked:true}}
  ])await assert.rejects(f.broker.result(command.id,claim.lease,result),/PAGE_IDENTITY_MISMATCH/);
  assert.deepEqual(f.broker.snapshot(s.id),before);
  await f.broker.tick(claim.deadline+1);
  const pending=f.broker.snapshot(s.id);
  assert.equal(pending.documentKey,'new-document');
  assert.equal(pending.observation.lease,rebound.observationLease);
  assert.equal(pending.turn.outcome,null);
  assert.equal(pending.status,'running');
  assert.equal(pending.turn.receiptPending,true);
  await assert.rejects(f.broker.recoverReceipt({...event,turnId:command.payload.turnId,
    lease:claim.lease,nativeMessageId:'old-document-user'}),/OBSERVATION_LEASE_MISMATCH/);
  await f.view(s,{state:'standby'});
  assert.equal(f.broker.snapshot(s.id).turn.outcome,'completed');
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
});
