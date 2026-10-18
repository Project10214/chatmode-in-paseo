// Real Provider/Broker/Store; a synthetic projected host consumes the events.
// Not a real daemon or UI. Original-class gates are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {until} from './helpers.mjs';
import {world} from './fixtures/provider-delivery-world.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('PD-1 production Provider persists attempts and emits native body through observed checkpoints',async t=>{
  const w=await world(t);await w.capture('A');
  await until(()=>w.text()==='A');
  await until(()=>w.markers().length>=2); // checkpoint follows the durable forwarded-attempt record
  assert.ok(w.markers().length>=2,'actual Provider must emit anchor then batch checkpoint');
  await until(()=>w.broker.snapshot(w.s.id).nativeDelivery?.durable.attempts.some(a=>a.status==='confirmed'));
  assert.equal(w.bodies()[0].item.messageId,'native-formal');
  assert.ok(w.broker.snapshot(w.s.id).history.some(i=>i.type==='assistant_message'&&i.text==='A'));
  await w.capture('AB');await until(()=>w.text()==='AB');
  await sleep(300);assert.equal(w.text(),'AB');
  assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='send').length,1);
});
test('PD-2 source storage and standby continue while subscription/marker observation is unavailable',async t=>{
  const w=await world(t,{barrier:false});await w.capture('pending');
  assert.equal(w.broker.snapshot(w.s.id).sources.find(i=>i.id==='formal').text,'pending');
  assert.equal(w.broker.snapshot(w.s.id).observation.page.state,'standby');
  assert.equal(w.bodies().length,0);
  w.holdMarker(true);w.releaseBarrier();await until(()=>w.markers().length>0);
  await sleep(300);assert.equal(w.bodies().length,0,'unobserved anchor is not an ACK');
  const pending=w.events.filter(e=>e.notice?.id==='native-content-delivery').at(-1).notice;
  assert.equal(pending.dismissed,false);assert.match(pending.description,/DELIVERY_PENDING/);
  w.holdMarker(false);await until(()=>w.text()==='pending');
});
test('PD-3 a dropped body is repaired only after its marker, with a fresh transport id',async t=>{
  const w=await world(t);w.drop(true);await w.capture('A');
  await until(()=>w.bodies().length>0);w.drop(false);
  await until(()=>w.text()==='A');
  assert.ok(w.bodies().length>=2);
  assert.notEqual(w.bodies()[0].item.id,w.bodies().at(-1).item.id);
  assert.ok(w.bodies().every(e=>e.item.messageId==='native-formal'));
  await sleep(300);assert.equal(w.text(),'A');
});
test('PD-4 closing a binding fences a late read without sending or persisting from that callback',async t=>{
  const w=await world(t);let release,entered=false;
  w.setRead(()=>{entered=true;return new Promise(r=>{release=r;});});
  await w.capture('late');await until(()=>entered);
  await w.connection.send({type:'session.close',sessionId:'host-one',requestId:'close'});
  await until(()=>w.events.some(e=>e.type==='session.closed'));
  const before=w.broker.snapshot(w.s.id).nativeDelivery;
  const count=w.events.length;release();await sleep(300);
  assert.equal(w.events.length,count);
  assert.deepEqual(w.broker.snapshot(w.s.id).nativeDelivery,before);
  assert.equal(w.bodies().length,0);
});
test('PD-5 a deferred new prompt never lets a checkpoint overtake held content',async t=>{
  const w=await world(t);let release,entered=false;
  w.runtime.chromeWake=async()=>{entered=true;await new Promise(r=>{release=r;});throw Error('TEST_PRE_SEND_FAILURE');};
  await w.connection.send({type:'session.prompt',sessionId:'host-one',prompt:{clientMessageId:'blocked',
    delivery:'auto',input:{type:'message',content:[{type:'text',text:'new request'}]}}});
  await until(()=>entered);await w.capture('held');await sleep(300);
  assert.equal(w.bodies().length,0);assert.equal(w.markers().length,0);
  release();await until(()=>w.text()==='held');
  const result=w.events.findIndex(e=>e.type==='session.prompt_result');
  const anchor=w.events.findIndex(e=>e.item?.kind==='source-checkpoint');
  assert.ok(result>=0&&anchor>result);
});

test('PD-6 warm reopen adopts observed prefix without replay, then sends only growth on fresh transport',async t=>{
  const w=await world(t);await w.capture('A');
  await until(()=>w.broker.snapshot(w.s.id).nativeDelivery?.durable.attempts.some(a=>a.status==='confirmed'));
  const generation=w.broker.snapshot(w.s.id).nativeDelivery.generation;
  await w.connection.send({type:'session.close',sessionId:'host-one',requestId:'close'});
  await until(()=>w.events.some(e=>e.type==='session.closed'));
  await w.open('host-two');
  await until(()=>w.broker.snapshot(w.s.id).nativeDelivery?.generation!==generation);
  await sleep(300);assert.equal(w.bodies().length,1);
  await w.capture('AB');await until(()=>w.text()==='AB');
  assert.equal(w.bodies().at(-1).item.text,'B');
  assert.notEqual(w.bodies()[0].item.id,w.bodies().at(-1).item.id);
  assert.equal(w.broker.snapshot(w.s.id).nativeDeliveryHistory.length,1);
});
test('PD-7 epoch change cannot cause a silent full-body replay',async t=>{
  const w=await world(t);await w.capture('A');
  await until(()=>w.broker.snapshot(w.s.id).nativeDelivery?.durable.attempts.some(a=>a.status==='confirmed'));
  const count=w.bodies().length;w.epoch('new-epoch');await w.capture('AB');
  await until(()=>w.events.some(e=>e.notice?.description?.includes('HOST_EPOCH_MISMATCH')));
  assert.equal(w.bodies().length,count);
  assert.equal(w.broker.snapshot(w.s.id).sources.find(s=>s.id==='formal').text,'AB');
});
test('PD-8 missing marker retries only marker, never the unconfirmed native body',async t=>{
  const w=await world(t);await w.capture('A');
  await until(()=>w.broker.snapshot(w.s.id).nativeDelivery?.durable.attempts.some(a=>a.status==='confirmed'));
  w.drop(true);w.holdMarker(true);await w.capture('AB');
  await until(()=>w.bodies().length===2);const markerCount=w.markers().length;
  await sleep(350);
  assert.equal(w.bodies().length,2);assert.ok(w.markers().length>markerCount);
  w.drop(false);w.holdMarker(false);await until(()=>w.text()==='AB');
  assert.equal(w.bodies().length,3);assert.equal(w.bodies().at(-1).item.text,'B');
});
test('PD-9 durable preparation failure prevents all native/checkpoint emission',async t=>{
  const w=await world(t),transaction=w.store.transaction.bind(w.store);let deny=true;
  w.store.transaction=(fn,options)=>transaction(data=>{
    const result=fn(data);
    if(deny&&data.sessions[w.s.id]?.nativeDelivery)throw Error('TEST_STORAGE_FAILURE');
    return result;
  },options);
  await w.capture('A');
  await until(()=>w.events.some(e=>e.notice?.description?.includes('DELIVERY_UNAVAILABLE')));
  assert.equal(w.bodies().length,0);assert.equal(w.markers().length,0);
  assert.equal(w.broker.snapshot(w.s.id).sources.find(s=>s.id==='formal').text,'A');
  deny=false;await w.capture('AB');await until(()=>w.text()==='AB');
});

test('PD-10 latest unpublished revision replaces a proven-missing attempt, never repairs stale source text',async t=>{
  const w=await world(t);w.drop(true);await w.capture('old source');
  await until(()=>w.bodies().length===1);
  await w.capture('rewritten source');w.drop(false);
  await until(()=>w.text()==='rewritten source');
  assert.equal(w.bodies().at(-1).item.text,'rewritten source');
  assert.equal(w.broker.snapshot(w.s.id).nativeDelivery.durable.sources[0].text,'rewritten source');
});

test('PD-11 a published non-prefix revision is retained but never concatenated to old native text',async t=>{
  const w=await world(t);await w.capture('published');
  await until(()=>w.broker.snapshot(w.s.id).nativeDelivery?.durable.attempts.some(a=>a.status==='confirmed'));
  await w.capture('replacement');
  await until(()=>w.events.some(e=>e.notice?.description?.includes('HOST_BODY_DIVERGED')));
  assert.equal(w.text(),'published');assert.equal(w.bodies().length,1);
  assert.equal(w.broker.snapshot(w.s.id).sources.find(s=>s.id==='formal').text,'replacement');
  assert.equal(w.broker.snapshot(w.s.id).nativeDelivery.durable.sources[0].text,'replacement');
});

test('PD-12 a new binding cannot relabel an ambiguous prior attempt as never sent',async t=>{
  const w=await world(t);w.fail(true);await w.capture('A');
  await until(()=>w.broker.snapshot(w.s.id).nativeDelivery?.durable.attempts.some(a=>a.status==='uncertain'));
  assert.equal(w.text(),'');
  await w.connection.send({type:'session.close',sessionId:'host-one',requestId:'close'});
  await until(()=>w.events.some(e=>e.type==='session.closed'));
  w.fail(false);const before=w.bodies().length;await w.open('host-two');
  await until(()=>w.events.some(e=>e.sessionId==='host-two'&&e.notice?.description?.includes('DELIVERY_PRIOR_UNCONFIRMED')));
  assert.equal(w.bodies().length,before);assert.equal(w.text(),'');
  assert.equal(w.broker.snapshot(w.s.id).sources.find(s=>s.id==='formal').text,'A');
});
test('PD-13 source freshness is rechecked after durable prepare, before any body forwarding',async t=>{
  const w=await world(t),transaction=w.store.transaction.bind(w.store);
  let entered=false,release;
  const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  w.store.transaction=async(fn,options)=>{
    const value=await transaction(fn,options);
    if(!entered&&w.broker.snapshot(w.s.id).nativeDelivery?.durable.attempts.some(a=>a.status==='prepared'&&a.target==='old')){
      entered=true;await gate;
    }
    return value;
  };
  await w.capture('old');await until(()=>entered);
  assert.equal(w.bodies().length,0);
  await w.capture('NEW current');release();
  await until(()=>w.text()==='NEW current');
  assert.ok(!w.bodies().some(event=>event.item.text==='old'));
  const attempts=w.broker.snapshot(w.s.id).nativeDelivery.durable.attempts;
  assert.ok(attempts.some(a=>a.target==='old'&&a.status==='retired'&&a.reason==='source-changed-before-send'));
});

