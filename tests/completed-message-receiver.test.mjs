/** Continuous receiver migrations. No completed-message compatibility API.
 * Raw capture -> ledger/prose -> actual Provider where delivery matters.
 * Provider worlds use a synthetic projected host; original-host/browser gates
 * are separate. Local acceptance/projected observation are NOT durable host ACK.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderEventSchema} from '@getpaseo/plugin/server/provider';
import {Store} from '../server/store.mjs';
import {Broker} from '../server/broker.mjs';
import {sourceRevision} from '../server/source-ledger.mjs';
import {decodePublicProse} from '../shared/public-prose.mjs';
import {fixture,until,sourceItem,pageView} from './helpers.mjs';
import {world} from './fixtures/provider-delivery-world.mjs';

const message=(id,rawText,extra={})=>sourceItem(id,'DOM '+id,{
 nativeMessageId:'native-'+id,prose:{status:'available',nativeMessageId:'native-'+id,
 rawText,representation:'markdown',observedAt:Date.now()},...extra});
const rowOf=(s,id)=>s.history.find(row=>row.type==='assistant_message'&&row.messageId==='native-'+id);
const assistants=s=>s.history.filter(row=>row.type==='assistant_message');
const commands=f=>Object.values(f.store.read().commands).filter(c=>['send','stop','configure','open','ensure'].includes(c.kind)).length;
const actual=(w,id)=>w.rows.filter(r=>r.item.type==='assistant_message'&&r.item.messageId==='native-'+id).map(r=>r.item.text).join('');
const confirmed=(w,id,text)=>w.broker.snapshot(w.s.id).nativeDelivery?.durable.deliveries.some(d=>
 d.sourceId===rowOf(w.broker.snapshot(w.s.id),id)?.id&&d.confirmedText===text&&!d.pending);
async function confirmedStop(f,s) {
 const stopping=f.broker.interrupt(s.id);stopping.catch(()=>{});
 const c=await until(()=>f.broker.queued().find(c=>c.kind==='stop'&&c.sessionId===s.id));
 const current=f.broker.snapshot(s.id),claim=await f.broker.claim(c.id,current.tabId,current.documentKey);
 await f.broker.result(c.id,claim.lease,{stopped:true});await stopping;
 assert.equal(f.broker.snapshot(s.id).observation.page.state,'running','click receipt alone cannot end the run');
 await f.view(s,{state:'standby'});
}

test('CM-R1 partial raw is durably captured once; local acceptance never claims host delivery or completion',async t=>{
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 const seen=[];f.broker.subscribe(s.id,e=>seen.push(e));
 const item=message('assistant-1','第一条发言\n',{order:[3,1]});
 const ack=await f.view(s,{items:[item]});
 assert.equal(ack.accepted,true);assert.equal(ack.receipt,undefined);
 const state=f.broker.snapshot(s.id),saved=state.sources.find(x=>x.id===item.id);
 assert.deepEqual(rowOf(state,item.id),{type:'assistant_message',id:'page:'+item.id,messageId:item.nativeMessageId,text:item.prose.rawText});
 assert.equal(saved.revision,sourceRevision(saved));assert.equal(saved.text,item.text);
 assert.equal(saved.prose.rawText,item.prose.rawText);assert.deepEqual(saved.order,[3,1]);
 assert.equal(state.status,'running');assert.equal(state.turn.outcome,null);assert.equal(state.nativeDelivery,undefined);
 assert.equal(seen.filter(e=>e.state==='source').length,1);
 const disk=await new Store(f.directory).open(),stored=disk.read().sessions[s.id];
 assert.deepEqual(rowOf(stored,item.id),rowOf(state,item.id));
 assert.equal(stored.sources[0].revision,saved.revision);
});

test('CM-R2 repeated frames and restarted/rebound observation preserve source identity without replaying Send',async t=>{
 let reopened;t.after(()=>reopened?.close());
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 const item=message('assistant-1','Answer'),frame=pageView(f.broker.snapshot(s.id),{items:[item]});
 await f.broker.observeView(frame);
 const seen=[];f.broker.subscribe(s.id,e=>seen.push(e));
 assert.equal((await f.broker.observeView(frame)).duplicate,true);
 await f.view(s,{items:[message('assistant-1','Answer')]});
 assert.equal(seen.filter(e=>e.state==='source').length,0);
 const original=f.broker.snapshot(s.id),before=commands(f);
 await f.broker.close();
 const store=await new Store(f.directory).open(),broker=reopened=new Broker(store);
 await broker.rebindObservation({sessionId:s.id,observationLease:original.observation.lease,
 previousDocumentKey:original.documentKey,documentKey:'document-reloaded',tabId:original.tabId,url:frame.url});
 await assert.rejects(broker.observeView(frame),/OBSERVATION_LEASE_MISMATCH/);
 const events=[];broker.subscribe(s.id,e=>events.push(e));
 await broker.observeView(pageView(broker.snapshot(s.id),{items:[item]}));
 const after=broker.snapshot(s.id);
 assert.equal(after.sources[0].revision,original.sources[0].revision);
 assert.deepEqual(rowOf(after,item.id),rowOf(original,item.id));
 assert.equal(assistants(after).length,1);assert.equal(events.filter(e=>e.state==='source').length,0);
 assert.equal(commands({store}),before);
});

test('CM-R3 raw DIL remains in the ledger while its decoded native projection is idempotent',async t=>{
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 const fence=String.fromCharCode(96).repeat(3);
 const raw='公式 \\(x\\) 与 a\\_b\n'+fence+'js\nconst a = "\\_";\n'+fence;
 const item=message('assistant-dil',raw);item.prose.representation='dil';item.prose.eof=true;
 await f.view(s,{items:[item]});
 const state=f.broker.snapshot(s.id),saved=state.sources[0],revision=saved.revision;
 assert.equal(saved.prose.rawText,raw);assert.equal(revision,sourceRevision(saved));
 assert.equal(rowOf(state,item.id).text,decodePublicProse({text:raw,format:'dil'}));
 const events=[];f.broker.subscribe(s.id,e=>events.push(e));
 await f.view(s,{items:[item]});
 assert.equal(f.broker.snapshot(s.id).sources[0].revision,revision);
 assert.equal(events.filter(e=>e.state==='source').length,0);
 assert.equal(f.broker.snapshot(s.id).turn.outcome,null,'EOF is not task completion');
});

test('CM-R4 published rewrite is retained as current source but cannot replace or concatenate native text',async t=>{
 const w=await world(t,{pageState:'running'});
 await w.view(w.s,{items:[message('a','原文')]});await until(()=>confirmed(w,'a','原文'));
 await w.view(w.s,{items:[message('a','改写后的原文')]});
 await until(()=>w.events.some(e=>e.notice?.id==='native-content-delivery'&&e.notice.dismissed===false));
 const state=w.broker.snapshot(w.s.id);
 assert.equal(actual(w,'a'),'原文');assert.equal(w.bodies().length,1);
 assert.equal(rowOf(state,'a').text,'改写后的原文','local projection is not host truth');
 assert.equal(state.sources[0].prose.rawText,'改写后的原文');
 assert.equal(state.sources[0].proseRewrites[0].rawText,'原文');
 assert.equal(state.turn.outcome,null);
 await w.view(w.s,{state:'standby'});
 assert.equal(w.broker.snapshot(w.s.id).observation.page.state,'standby');
 assert.equal(actual(w,'a'),'原文');
 assert.ok(w.broker.snapshot(w.s.id).nativeDelivery.durable.deliveries.some(d=>d.confirmedText==='原文'));
});

test('CM-R5 known native history identity survives raw adoption, prefix growth and conflicting revisions',async t=>{
 const history=['Hello','Partial','Old start'].map((text,i)=>({type:'assistant_message',id:'legacy-'+i,messageId:'native-'+['a','b','c'][i],text}));
 const w=await world(t,{history});
 await until(()=>w.text()==='HelloPartialOld start');
 const count=w.bodies().length;
 await w.view(w.s,{state:'standby',items:[message('a','Hello'),message('b','Partial and complete'),message('c','New start')]});
 await until(()=>actual(w,'b')==='Partial and complete');
 await until(()=>w.events.some(e=>e.notice?.id==='native-content-delivery'&&e.notice.dismissed===false));
 assert.equal(actual(w,'a'),'Hello');assert.equal(actual(w,'c'),'Old start');
 const state=w.broker.snapshot(w.s.id);
 assert.deepEqual(assistants(state).map(i=>i.id),history.map(i=>i.id));
 assert.equal(w.bodies().length,count+1);
 assert.deepEqual([...new Set(w.bodies().map(e=>e.item.messageId))].sort(),history.map(i=>i.messageId).sort());
 assert.equal(state.sources.find(i=>i.id==='c').prose.rawText,'New start');
});

test('CM-R6 continuous input validation isolates bad sources and rejects wrong observation identity', async t => {
  const f = await fixture(t), s = await f.ready(); await f.sending(s);
  const item = (id, text, extra = {}) => sourceItem(id, text, {nativeMessageId: id, ...extra});
  // The positive owner is initialized FIRST; negatives cannot pass at a dead API.
  await f.view(s, {items: [item('valid-first', '正常😀')]});
  assert.equal(assistants(f.broker.snapshot(s.id)).length, 1);
  const current = f.broker.snapshot(s.id);
  for (const patch of [{observationLease:'wrong'}, {documentKey:'wrong'}, {tabId:999},
    {url:'https://chatgpt.com/c/other'}]) {
    await assert.rejects(f.broker.observeView({...pageView(current), ...patch}));
  }
  const invalid = [
    item('', 'x'), item('bad-type', 7), item('bad-unicode', 'bad \ud800 surrogate'),
    item('bad-nul', 'nul\u0000byte'), item('bad-format', 'x', {format:'html'}),
    item('bad-order', 'x', {order:[NaN]}), item('bad-order-type', 'x', {order:'1'})
  ];
  const result = await f.view(s, {items: [...invalid, item('valid-sibling', '仍可采集')]});
  assert.equal(result.accepted, true);
  const state = f.broker.snapshot(s.id);
  assert.equal(state.sources.length, 2, 'invalid data never evicts valid siblings');
  assert.equal(assistants(state).length, 2);
  assert.equal(state.status, 'running');
  assert.equal(state.turn.outcome, null);
  // Original 256k / completed-only / fixed position-depth restrictions are not
  // the continuous source contract. UTF-16/NUL/types/ownership still ARE.
  const large = 'x'.repeat(256001);
  await f.view(s, {items:[item('large', large, {format:'markdown', order:Array(9).fill(1.5)}),
    item('empty-source', '   ')]});
  assert.equal(f.broker.snapshot(s.id).sources.find(x=>x.id==='large').text, large);
  assert.ok(!assistants(f.broker.snapshot(s.id)).some(x=>!x.text.trim()), 'no empty native answer');
  await f.view(s,{items:[item('layout-id','fake',{nativeMessageId:'fallback-turn-1'}),
    item('user-echo','not an assistant',{nativeMessageId:current.turn.nativeMessageId})]});
  assert.ok(!assistants(f.broker.snapshot(s.id)).some(x=>['fallback-turn-1',current.turn.nativeMessageId].includes(x.messageId)));
  const raw = item('raw-invalid', 'DOM survives', {prose:{status:'available',
    nativeMessageId:'someone-else', representation:'markdown',rawText:'foreign text',observedAt:Date.now()}});
  await f.view(s, {items:[raw]});
  const saved = f.broker.snapshot(s.id).sources.find(x=>x.id===raw.id);
  assert.equal(saved.text, raw.text);
  assert.equal(saved.prose.status, 'unavailable');
  assert.notEqual(saved.prose.rawText, 'foreign text');
});

test('CM-R7 final/EOF metadata and local receipts cannot select state or certify unobserved host delivery',async t=>{
 const w=await world(t,{barrier:false,pageState:'running'});
 const item=message('final','最终回答');item.prose.eof=true;
 await w.view(w.s,{items:[item],finalConfirmed:true,messageState:'complete'});
 assert.equal(w.broker.snapshot(w.s.id).turn.outcome,null);
 assert.equal(w.broker.snapshot(w.s.id).observation.page.state,'running');
 assert.equal(w.bodies().length,0);
 await w.view(w.s,{state:'standby',finalConfirmed:false});
 assert.equal(w.broker.snapshot(w.s.id).observation.run.active,false);
 assert.equal(w.bodies().length,0,'standby is not a content ACK');
 w.releaseBarrier();await until(()=>confirmed(w,'final','最终回答'));
 assert.equal(actual(w,'final'),'最终回答');
 assert.equal(w.broker.snapshot(w.s.id).observation.page.state,'standby');
});

test('CM-R8 confirmed button Stop ends the run, not late content capture or observation',async t=>{
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 await f.view(s,{items:[message('final','停止前')]});
 await confirmedStop(f,s);
 const before=commands(f),run=f.broker.snapshot(s.id).observation.run.id,events=[];
 f.broker.subscribe(s.id,e=>events.push(e));
 await f.view(s,{state:'standby',items:[message('final','停止前可见的半段')]});
 await f.view(s,{state:'standby',items:[message('final','停止前可见的半段')]});
 const state=f.broker.snapshot(s.id);
 assert.equal(rowOf(state,'final').text,'停止前可见的半段');
 assert.equal(state.observation.run.id,run);assert.equal(state.observation.run.active,false);
 assert.equal(state.status,'idle');assert.equal(commands(f),before);
 assert.equal(events.filter(e=>e.state==='source').length,1);
 assert.equal(events.filter(e=>e.state==='page-running'||e.state==='page-standby').length,0);
 assert.equal(state.sources[0].messageState,undefined,'do not invent native interrupted metadata');
});

test('CM-R9 Stop failure, observation gap and newer prompts never become content-loss gates',async t=>{
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 await f.view(s,{items:[message('old','半段')]});
 const old=f.broker.snapshot(s.id),stopping=f.broker.interrupt(s.id);stopping.catch(()=>{});
 const c=await until(()=>f.broker.queued().find(x=>x.kind==='stop'));
 const claim=await f.broker.claim(c.id,old.tabId,old.documentKey);
 await f.broker.result(c.id,claim.lease,{error:'STOP_UNCONFIRMED'});await assert.rejects(stopping);
 assert.equal(f.broker.snapshot(s.id).observation.page.state,'running');
 await f.broker.observeGap({...pageView(f.broker.snapshot(s.id)),reason:'SOURCE_TEMPORARILY_UNREADABLE'});
 assert.equal(f.broker.snapshot(s.id).observation.run.active,true);
 await f.view(s,{items:[message('old','半段仍在增长')]});
 await f.view(s,{state:'standby'});
 await f.view(s,{state:'standby',items:[message('late','迟到')]});
 const next=await f.sending(f.broker.snapshot(s.id),'second');
 const late=message('old','半段仍在增长，后补');late.userMessageId=old.turn.nativeMessageId;
 await f.view(s,{items:[late]});
 const state=f.broker.snapshot(s.id);
 assert.equal(state.turn.id,next.event.turnId);assert.equal(state.turn.outcome,null);
 assert.equal(rowOf(state,'old').text,late.prose.rawText);assert.equal(rowOf(state,'late').text,'迟到');
 assert.equal((await f.broker.observeView(pageView(old,{items:[message('old','stale')]}))).stale,true);
 for(const patch of [{observationLease:'old-lease'},{documentKey:'old-document'}])
 await assert.rejects(f.broker.observeView({...pageView(state,{items:[late]}),...patch}));
 assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,2,'two explicitly requested sends, no replay');
});

test('CM-R10 conversation source capacity has no per-turn 16-message cutoff or silent truncation', async t => {
  const f = await fixture(t), s = await f.ready(); await f.sending(s);
  const items = Array.from({length:40}, (_,i)=>sourceItem('m-'+i,'x'+i,{nativeMessageId:'native-m-'+i,order:[i]}));
  await f.view(s, {items});
  assert.equal(f.broker.snapshot(s.id).sources.length, 40);
  assert.deepEqual(assistants(f.broker.snapshot(s.id)).map(x=>x.text), items.map(x=>x.text));
  await f.view(s, {state:'standby',items:[sourceItem('late','late',{nativeMessageId:'native-late',order:[40]})]});
  assert.equal(f.broker.snapshot(s.id).sources.length, 41);
  assert.equal(assistants(f.broker.snapshot(s.id)).length, 41);
  assert.equal(f.broker.snapshot(s.id).observation.page.state, 'standby');
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length, 1);
  // Wire limit is UTF-8 frame bytes, not body count. The real content monitor
  // covers splitting and explicit PAGE_ENTRY_TOO_LARGE, never hidden clipping.
});

test('CM-P1 real Provider emits exact native raw projections; only matching host evidence confirms each source',async t=>{
 const w=await world(t,{pageState:'running'});
 const raw='结论：a\\_b 与 \\(x\\)',last=message('final',raw);
 last.prose.representation='dil';last.prose.eof=true;
 const first=message('commentary','先说明\n'),expected=decodePublicProse({text:raw,format:'dil'});
 await w.view(w.s,{items:[first,last]});
 await until(()=>confirmed(w,'commentary',first.prose.rawText)&&confirmed(w,'final',expected));
 const count=w.bodies().length;
 await w.view(w.s,{items:[first,last]});
 assert.equal(w.bodies().length,count);assert.equal(actual(w,'commentary'),first.prose.rawText);
 assert.equal(actual(w,'final'),expected);
 assert.ok(w.bodies().every(e=>e.item.type==='assistant_message'));
 await w.view(w.s,{state:'standby'});
 assert.equal(w.events.filter(e=>e.type==='session.turn'&&e.state==='completed').length,1);
 for(const e of w.events)ProviderEventSchema.parse(e);
 assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='send').length,1);
});

test('CM-P2 actual Provider accepts late Stop-tail without inventing a new turn lifecycle',async t=>{
 const w=await world(t,{pageState:'running'});
 await w.view(w.s,{items:[message('final','停止前')]});await until(()=>confirmed(w,'final','停止前'));
 await confirmedStop(w,w.s);
 const turns=w.events.filter(e=>e.type==='session.turn').length,before=commands(w);
 await w.view(w.s,{state:'standby',items:[message('final','停止前的半段')]});
 await until(()=>confirmed(w,'final','停止前的半段'));
 assert.equal(actual(w,'final'),'停止前的半段');
 assert.equal(w.events.filter(e=>e.type==='session.turn').length,turns);
 assert.equal(commands(w),before);
 for(const e of w.events)ProviderEventSchema.parse(e);
});

test('CM-R11 DOM refresh cannot overwrite proven raw; late raw growth uses the same native identity',async t=>{
 const w=await world(t);
 await w.view(w.s,{state:'standby',items:[message('final','完整回答')]});
 await until(()=>confirmed(w,'final','完整回答'));
 const count=w.bodies().length;
 const dom=sourceItem('final','DOM 后续渲染',{nativeMessageId:'native-final'});
 await w.view(w.s,{state:'standby',items:[dom]});
 assert.equal(rowOf(w.broker.snapshot(w.s.id),'final').text,'完整回答');
 assert.equal(w.broker.snapshot(w.s.id).sources[0].text,dom.text);
 assert.equal(w.bodies().length,count);
 await w.view(w.s,{state:'standby',items:[message('final','完整回答，后来又长出来的字')]});
 await until(()=>confirmed(w,'final','完整回答，后来又长出来的字'));
 assert.equal(actual(w,'final'),'完整回答，后来又长出来的字');
 assert.deepEqual([...new Set(w.bodies().map(e=>e.item.messageId))],['native-final']);
 assert.equal(w.broker.observe,undefined,'no legacy competing snapshot/message ingestion API');
});
