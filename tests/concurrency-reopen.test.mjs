import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, selection, until, sourceItem } from './helpers.mjs';
import { Broker } from '../server/broker.mjs';
import { Store } from '../server/store.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';
import { settingsSnapshot } from '../server/diagnostics.mjs';

async function completed(f,s){
 await f.sending(s,'first','hello');
 await f.view(s,{state:'standby',items:[sourceItem('native-reply','reply')]});
 return f.broker.snapshot(s.id);
}
async function reopenCommand(f,s){
 const ready=f.broker.ensurePage(s.id);void ready.catch(()=>{});
 const c=await until(()=>f.broker.queued().find(x=>x.kind==='ensure'&&x.sessionId===s.id));
 const proof={reopened:true,url:`https://chatgpt.com/c/${s.conversationId}`,nativeMessageId:s.lastNativeMessageId};
 return {ready,c,proof};
}
test('CFG1 persists 1..8, rejects invalid values and survives reopening old state',async t=>{
 const f=await fixture(t);assert.equal(f.broker.maxConcurrent,2);
 for(const n of [0,9,1.5,NaN,'4',null])await assert.rejects(f.broker.setConcurrency(n),/INVALID_CONCURRENCY/);
 await f.broker.setConcurrency(4);const other=new Broker(await new Store(f.directory).open());
 assert.equal(other.maxConcurrent,4);assert.equal(f.broker.maxConcurrent,4);
 const before=f.store.read();await assert.rejects(f.broker.setConcurrency(99));assert.deepEqual(f.store.read(),before);
});
test('CFG2 FIFO reserves before opening tabs and cancellation frees no phantom Send',async t=>{
 const f=await fixture(t,{maxConcurrent:1});const a=await f.broker.create(selection),b=await f.broker.create(selection),c=await f.broker.create(selection);
 const first=await f.broker.slots.acquire(a.id);const positions=[];const cancel=new AbortController();
 const second=f.broker.slots.acquire(b.id,{signal:cancel.signal,onPosition:n=>positions.push(n)});const rejected=assert.rejects(second,/SEND_CANCELLED/);
 const third=f.broker.slots.acquire(c.id);assert.equal(f.broker.queued().length,0);assert.deepEqual(f.broker.slots.snapshot(),{limit:1,active:1,waiting:2});
 cancel.abort();await rejected;assert.equal(f.broker.slots.snapshot().waiting,1);first.release();const next=await third;
 assert.equal(next.id,c.id);assert.deepEqual(positions,[1]);next.release();assert.equal(f.broker.slots.snapshot().active,0);
});
test('CFG3 raise limit releases waiters; lowering never cancels granted work',async t=>{
 const f=await fixture(t,{maxConcurrent:1});const s=await Promise.all([1,2,3].map(()=>f.broker.create(selection)));
 const a=await f.broker.slots.acquire(s[0].id);const b=f.broker.slots.acquire(s[1].id);let gotC=false;
 const c=f.broker.slots.acquire(s[2].id).then(x=>{gotC=true;return x});await f.broker.setConcurrency(2);const rb=await b;
 await f.broker.setConcurrency(1);assert.equal(f.broker.slots.snapshot().active,2);assert.equal(gotC,false);a.release();await new Promise(r=>setImmediate(r));assert.equal(gotC,false);
 rb.release();const rc=await c;assert.equal(gotC,true);rc.release();
});
test('CFG4 runtime close rejects waiting requests without creating browser commands',async t=>{
 const f=await fixture(t,{maxConcurrent:1});const a=await f.broker.create(selection),b=await f.broker.create(selection);
 await f.broker.slots.acquire(a.id);const rejected=assert.rejects(f.broker.slots.acquire(b.id),/CONNECTION_CLOSED/);await f.broker.close();await rejected;
 assert.equal(Object.keys(f.store.read().commands).length,0);
});
test('CFG5 an executing turn holds its slot until terminal; after finish queued work proceeds',async t=>{
 const f=await fixture(t,{maxConcurrent:1});const a=await f.ready(),b=await f.broker.create(selection);
 const held=await f.broker.slots.acquire(a.id),sent=await f.sending(a);held.release();let acquired=false;
 const queued=f.broker.slots.acquire(b.id).then(x=>{acquired=true;return x});await new Promise(r=>setImmediate(r));assert.equal(acquired,false);
 await f.view(a,{state:'running',items:[sourceItem('finish-id','done')]});
 assert.equal(acquired,false,'a body does not release capacity while Stop remains visible');
 await f.view(a,{state:'standby'});const lease=await queued;lease.release();
});
test('CFG6 blocked uncertain delivery reports DELIVERY_UNCONFIRMED, never generic SESSION_BUSY or a retry',async t=>{
 const f=await fixture(t);
 const s=await f.ready();await f.sending(s,'sent-once','hello',false);
 await f.broker.failTurn(s.id,'RECEIPT_UNCONFIRMED',true);
 assert.throws(()=>f.broker.slots.acquire(s.id),e=>e.code==='DELIVERY_UNCONFIRMED');
 assert.equal(f.broker.slots.snapshot().waiting,0);
 assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
});
test('REOPEN1 bound Conversation reopens with newer/missing native user ID and never replays Send',async t=>{
 const f=await fixture(t);const s=await completed(f,await f.ready());const {ready,c,proof}=await reopenCommand(f,s);
 await assert.rejects(f.broker.claim(c.id,900,'new-doc',{...proof,url:'https://chatgpt.com/c/other'}),/WRONG_CONVERSATION/);
 // A newer webpage message is not a reason to block opening the same /c/ URL.
 const claim=await f.broker.claim(c.id,900,'new-doc',{...proof,nativeMessageId:'newer-browser-message'});
 await f.broker.result(c.id,claim.lease,{config:s.config,tabId:900,url:proof.url,nativeMessageId:'newer-browser-message'});await ready;
 const recovered=f.broker.snapshot(s.id);
 assert.equal(recovered.conversationId,s.conversationId);assert.equal(recovered.tabId,900);
 assert.equal(recovered.lastNativeMessageId,s.lastNativeMessageId,'an unseen browser turn is not silently claimed as synced');
 assert.deepEqual(recovered.history,s.history,'reopening preserves the entire source and state history');
 assert.equal(recovered.history.filter(item=>item.type==='assistant_message').length,1);
 assert.equal(recovered.history.find(item=>item.type==='assistant_message').text,'reply');
 assert.equal(Object.values(f.store.read().commands).filter(x=>x.kind==='send').length,1);
});
test('REOPEN2 pending/uncertain turn is never restored as idle or replayed',async t=>{
 const f=await fixture(t);const s=await f.ready();await f.sending(s,'uncertain','hi',false);
 await assert.rejects(f.broker.ensurePage(s.id),/SESSION_BUSY/);await f.broker.failTurn(s.id,'RECEIPT_UNCONFIRMED',true);
 await assert.rejects(f.broker.ensurePage(s.id),/SESSION_BUSY/);assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='ensure').length,0);
});
test('REOPEN3 known unsent failure preserves last successful native anchor for a NEW request',async t=>{
 const f=await fixture(t);const s=await completed(f,await f.ready());await f.broker.prompt(s.id,'unsent','new');
 const pending=f.broker.queued().find(c=>c.kind==='send');await f.broker.failUnclaimed(pending.id,'TAB_NOT_OWNED');
 assert.equal(f.broker.snapshot(s.id).status,'idle');const {ready,c}=await reopenCommand(f,f.broker.snapshot(s.id));
 assert.equal(c.payload.previousNativeMessageId,s.lastNativeMessageId);await f.broker.failUnclaimed(c.id,'PAGE_CLOSED');await assert.rejects(ready,/PAGE_CLOSED/);
 assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,2);
});
test('REOPEN4 failure reporting cannot rewrite a claimed or authorized Send',async t=>{
 const f=await fixture(t);const s=await f.ready();const sent=await f.sending(s,'now','hi',false);
 await assert.rejects(f.broker.failUnclaimed(sent.claim.id,'PAGE_CLOSED'),/COMMAND_NOT_CLAIMABLE/);
 assert.equal(f.store.read().commands[sent.claim.id].phase,'authorized');
});
test('REOPEN5 a canceled page preparation cannot publish late tab binding',async t=>{
 const f=await fixture(t);const s=await completed(f,await f.ready());const {ready,c,proof}=await reopenCommand(f,s);
 const claim=await f.broker.claim(c.id,900,'new-doc',proof);await f.broker.cancelControl(c.id);await assert.rejects(ready,/CONTROL_UNCONFIRMED/);
 await f.broker.result(c.id,claim.lease,{config:s.config,tabId:900,url:proof.url,nativeMessageId:proof.nativeMessageId});
 assert.equal(f.broker.snapshot(s.id).tabId,s.tabId);assert.equal(f.broker.snapshot(s.id).status,'blocked');
});
test('REOPEN6 existing other session cannot lose its tab to restoration',async t=>{
 const f=await fixture(t);const s=await completed(f,await f.ready()),other=await f.ready();const {ready,c,proof}=await reopenCommand(f,s);
 await assert.rejects(f.broker.claim(c.id,other.tabId,'stolen-doc',proof),/TAB_ALREADY_OWNED/);await f.broker.failUnclaimed(c.id,'BROWSER_PREPARE_FAILED');await assert.rejects(ready);
 assert.equal(f.broker.snapshot(other.id).documentKey,other.documentKey);
});
