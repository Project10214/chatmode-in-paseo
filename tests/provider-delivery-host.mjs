// Opt-in: ACTUAL production Provider + original beta.2 SDK/Session/AgentManager.
// Only browser dispatch, agent metadata/transport and pre-Provider failures are fixtures.
// No daemon, websocket/IPC connection, live browser/account or host code modification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {world,until,agentId} from './fixtures/provider-host-world.mjs';
import {sourceItem,pageView} from './helpers.mjs';
test('PD-HOST-1 real Provider reaches actual native projection through public SDK reads after standby',async t=>{
  const w=await world(t);
  await w.capture('A');await until(()=>w.confirmed('A'));
  await w.capture('AB');await until(()=>w.confirmed('AB'));
  assert.equal(w.text(),'AB');
  const bodies=w.wire.filter(e=>e.item?.type==='assistant_message');
  assert.equal(bodies.length,2);assert.ok(bodies.every(e=>e.item.messageId==='native-final'));
  assert.ok(w.wire.some(e=>e.item?.kind==='source-checkpoint'));
  assert.equal(w.manager.getAgent(agentId).lifecycle,'idle');
  assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='send').length,1);
});
test('PD-HOST-2 pre-Provider pending loss repairs ONLY missing suffix through real Provider',async t=>{
  const w=await world(t);await w.capture('prefix');await until(()=>w.confirmed('prefix'));
  let entered=false,release;
  const gate=new Promise(r=>{release=r;});
  const original=w.session.startTurn;
  w.session.startTurn=async()=>{entered=true;await gate;throw Error('TEST_PRE_PROVIDER_FAILURE');};
  const attempt=(async()=>{for await(const event of w.manager.streamAgent(agentId,'fixture host pending',{clientMessageId:'never-dispatched'}))void event;})()
    .then(()=>null,error=>error);
  t.after(async()=>{release();await attempt;w.session.startTurn=original;});
  await until(()=>entered);
  await w.capture('prefix suffix');
  await until(()=>{
    const staged=w.manager.runs.getPendingRun(agentId)?.stagedEvents??[];
    return staged.some(event=>event.type==='timeline'&&event.item.type==='assistant_message'&&
      event.item.messageId==='native-final'&&event.item.text===' suffix') &&
      staged.some(event=>event.type==='timeline'&&event.item.kind==='source-checkpoint'&&
        event.item.data.phase==='after-body'&&event.item.data.through==='prefix suffix'.length);
  });
  assert.equal(w.text(),'prefix','the exact suffix/checkpoint are still staged, not already committed');
  release();assert.match((await attempt).message,/TEST_PRE_PROVIDER_FAILURE/);w.session.startTurn=original;
  await until(()=>w.confirmed('prefix suffix'));
  assert.equal(w.text(),'prefix suffix');
  const bodies=w.wire.filter(e=>e.item?.type==='assistant_message');
  assert.equal(bodies.at(-1).item.text,' suffix');
  assert.notEqual(bodies.at(-1).item.id,bodies.at(-2).item.id);
  assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='send').length,1);
});

test('PD-HOST-3 raw revision during durable preparation cannot forward stale unpublished text',async t=>{
  const w=await world(t),transaction=w.store.transaction.bind(w.store);
  let entered=false,release;
  const gate=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  w.store.transaction=async(fn,options)=>{
    const result=await transaction(fn,options);
    if(!entered&&w.broker.snapshot(w.s.id).nativeDelivery?.durable.attempts.some(a=>a.status==='prepared'&&a.target==='old')){
      entered=true;await gate; // durable write finished, Provider forward has NOT begun
    }
    return result;
  };
  const capture=rawText=>w.view(w.s,{state:'standby',items:[sourceItem('formal','DOM',{
    nativeMessageId:'native-final',prose:{status:'available',nativeMessageId:'native-final',
      rawText,representation:'markdown',observedAt:Date.now()}})]});
  await capture('old');await until(()=>entered);
  assert.equal(w.text(),'');
  await capture('NEW **current**');
  release();await until(()=>w.confirmed('NEW **current**'));
  assert.equal(w.text(),'NEW **current**');
  assert.ok(!w.wire.some(e=>e.item?.type==='assistant_message'&&e.item.text==='old'));
  assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='send').length,1);
});

test('PD-HOST-4 raw parser survives rebind and confirmed Stop; late tail reaches native host without replay',async t=>{
 const w=await world(t);
 const item=rawText=>sourceItem('formal','DOM final',{nativeMessageId:'native-final',
  prose:{status:'available',nativeMessageId:'native-final',rawText,representation:'dil',observedAt:Date.now()}});
 const prefix='a\\_b \\(';
 await w.view(w.s,{items:[item(prefix)]});await until(()=>w.confirmed('a_b '));
 const old=w.broker.snapshot(w.s.id),frame=pageView(old,{items:[item(prefix)]});
 await w.broker.rebindObservation({sessionId:w.s.id,observationLease:old.observation.lease,
  previousDocumentKey:old.documentKey,documentKey:'source-rebound',tabId:old.tabId,url:frame.url});
 await assert.rejects(w.broker.observeView(frame),/OBSERVATION_LEASE_MISMATCH/);
 await w.view(w.s,{items:[item(prefix)]});
 const stop=w.broker.interrupt(w.s.id);stop.catch(()=>{});
 const command=await until(()=>w.broker.queued().find(c=>c.kind==='stop'));
 const current=w.broker.snapshot(w.s.id),claim=await w.broker.claim(command.id,current.tabId,current.documentKey);
 await w.broker.result(command.id,claim.lease,{stopped:true});await stop;
 assert.equal(w.broker.snapshot(w.s.id).observation.page.state,'running');
 await w.view(w.s,{state:'standby'});
 const lifecycle=w.wire.filter(e=>e.type==='session.turn').length;
 await w.view(w.s,{state:'standby',items:[item('a\\_b \\(x\\) done')]});
 await until(()=>w.confirmed('a_b \\(x\\) done'));
 assert.equal(w.text(),'a_b \\(x\\) done');
 assert.equal(w.wire.filter(e=>e.type==='session.turn').length,lifecycle);
 assert.equal(w.wire.filter(e=>e.item?.type==='assistant_message').length,2);
 assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='send').length,1);
});
test('PD-HOST-5 known native legacy row adopts raw source without duplicate identity or prefix replay',async t=>{
 const w=await world(t,{history:[{type:'assistant_message',id:'legacy-formal',messageId:'native-final',text:'**bo'}]});
 await until(()=>w.confirmed('**bo'));
 await w.view(w.s,{state:'standby',items:[sourceItem('formal','bold',{nativeMessageId:'native-final',
  prose:{status:'available',nativeMessageId:'native-final',rawText:'**bold**',representation:'markdown',observedAt:Date.now()}})]});
 await until(()=>w.confirmed('**bold**'));
 assert.equal(w.text(),'**bold**');
 const rows=w.broker.snapshot(w.s.id).history.filter(i=>i.type==='assistant_message');
 assert.equal(rows.length,1);assert.equal(rows[0].id,'legacy-formal');
 assert.ok(w.wire.filter(e=>e.item?.type==='assistant_message').every(e=>e.item.messageId==='native-final'));
 assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='send').length,1);
});


