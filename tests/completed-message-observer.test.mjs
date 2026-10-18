/** Observer migrations for the continuous page-view contract.
 *
 * The old file drove `extension/content.js`'s removed monitor IPC
 * (`kind:'observation'` with snapshot/page_status/activity/completed and a
 * cached transcript). Those inputs no longer exist: the extension now reads
 * visible source items + visible Stop/Send/Voice on every tick
 * (`CIP_PAGE_CONTENT`, `CIP_PAGE_CONTROLS`) and the Broker records
 * `observeView`. Assertions that only the observer/IPC layer owned are
 * migrated here against the real Broker/Provider; assertions that the receiver
 * migration already covers are listed at the end instead of being duplicated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,sourceItem,until} from './helpers.mjs';
import {decodePublicProse} from '../shared/public-prose.mjs';
import {world} from './fixtures/provider-delivery-world.mjs';

const message=(id,rawText,extra={})=>sourceItem(id,'DOM '+id,{
 nativeMessageId:'native-'+id,prose:{status:'available',nativeMessageId:'native-'+id,
 rawText,representation:'markdown',observedAt:Date.now()},...extra});
const tool=extra=>({id:'tool-1',userMessageId:null,role:'page',lane:'process',kind:'tool_call',
 text:'running read',format:'text',order:[2],callId:'call-1',name:'read',status:'running',...extra});
const card={state:'open',key:'6f1c2d3e-0000-4000-8000-000000000001',app:'mymac',
 tool:'run_shell_command',input:JSON.stringify({args:{command:'node --version'}})};
const rowOf=(s,id)=>s.history.find(row=>row.type==='assistant_message'&&row.messageId==='native-'+id);
const sends=f=>Object.values(f.store.read().commands).filter(c=>c.kind==='send').length;
const approvals=f=>Object.values(f.store.read().commands).filter(c=>c.kind==='approval').length;
const actual=(w,id)=>w.rows.filter(r=>r.item.type==='assistant_message'&&r.item.messageId==='native-'+id)
 .map(r=>r.item.text).join('');
const confirmed=(w,id,text)=>w.broker.snapshot(w.s.id).nativeDelivery?.durable.deliveries
 .some(d=>d.sourceId===rowOf(w.broker.snapshot(w.s.id),id)?.id&&d.confirmedText===text&&!d.pending);

test('CM observer: an open approval does not hide a completed message, and is never granted by observation',async t=>{
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 const seen=[];f.broker.subscribe(s.id,event=>seen.push(event));
 // Waiting for the user is a standby page, not a running one: the run ends,
 // the captured message and the open card both remain.
 await f.view(s,{state:'standby',approvals:[card],items:[message('answer','需要用户批准后继续。')]});
 const state=f.broker.snapshot(s.id);
 assert.equal(rowOf(state,'answer').text,'需要用户批准后继续。');
 assert.equal(state.approvals[card.key].state,'open');
 assert.equal(state.approvals[card.key].answered,undefined,'observation cannot answer the card');
 assert.equal(state.observation.page.state,'standby');
 assert.equal(state.turn.outcome,'completed');
 assert.equal(seen.filter(event=>event.state==='approval').length,1);
 assert.equal(approvals(f),0,'no approval command without an explicit Paseo answer');
 assert.equal(sends(f),1);
});

test('CM observer: a pending raw supplement holds only that body; buttons and other sources stay live',async t=>{
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 // The supplement read is in flight. Its body is not published yet (the
 // current representation would otherwise be replaced later), but it is not
 // a page-state, approval or turn-completion gate and it is not a Send gate.
 const pending=sourceItem('answer','half',{nativeMessageId:'native-answer',
  prose:{status:'pending'}});
 const notice=sourceItem('notice','still visible',{role:'page',kind:'notice',order:[2]});
 await f.view(s,{state:'running',items:[pending,notice]});
 const state=f.broker.snapshot(s.id);
 assert.equal(rowOf(state,'answer'),undefined,'no half-committed representation is published');
 assert.equal(state.sources.find(x=>x.id==='answer').text,'half','the DOM source itself is durably captured');
 assert.ok(state.history.some(row=>row.type==='plugin'&&row.data?.source?.id==='notice'));
 assert.equal(state.observation.page.state,'running');
 assert.equal(state.turn.outcome,null);
 const status=state.history.find(row=>row.kind==='page-state');
 assert.equal(status.data.state,'running');
 assert.ok(status.data.issues.some(issue=>issue.code==='SOURCE_PROSE_READ_PENDING'));
 // The raw arrives while the page still runs: one body, same source identity,
 // and no turn/completion was required first.
 await f.view(s,{state:'running',items:[message('answer','half of the whole answer',{order:[1]}),notice]});
 const after=f.broker.snapshot(s.id);
 assert.equal(after.history.filter(row=>row.type==='assistant_message').length,1);
 assert.equal(rowOf(after,'answer').text,'half of the whole answer');
 assert.equal(after.sources[0].prose.rawText,'half of the whole answer');
 assert.equal(sends(f),1);
});

test('CM observer: a completed body is delivered while running, and standby reuses it without a second body',async t=>{
 const w=await world(t,{pageState:'running'});
 await w.view(w.s,{items:[message('answer','完整回答。')]});
 await until(()=>confirmed(w,'answer','完整回答。'));
 const count=w.bodies().length;
 assert.ok(count>=1,'the running page delivered the body before standby');
 assert.equal(actual(w,'answer'),'完整回答。');
 await w.view(w.s,{state:'standby',items:[message('answer','完整回答。')]});
 assert.equal(w.bodies().length,count,'task completion is not a second body');
 assert.equal(w.events.filter(e=>e.type==='session.turn'&&e.state==='completed').length,1);
 assert.equal(actual(w,'answer'),'完整回答。');
});

test('CM observer: raw DIL reaches the ledger unmodified and is decoded only for projection',async t=>{
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 const raw=String.raw`hello \!`;
 const item=message('answer',raw);item.prose.representation='dil';
 await f.view(s,{items:[item]});
 const state=f.broker.snapshot(s.id),saved=state.sources[0];
 assert.equal(saved.prose.rawText,raw,'the raw public string is stored once, unchanged');
 assert.equal(saved.prose.representation,'dil');
 assert.equal(rowOf(state,'answer').text,decodePublicProse({text:raw,format:'dil'}));
 assert.equal(state.turn.outcome,null);
});

test('CM observer: a receiver rejection is not a delivery confirmation or a successful turn',async t=>{
 const w=await world(t,{pageState:'running'});
 await w.view(w.s,{items:[message('answer','A')]});
 await until(()=>confirmed(w,'answer','A'));
 const count=w.bodies().length;
 await w.view(w.s,{items:[message('answer','B')]});
 await until(()=>w.events.some(e=>e.notice?.id==='native-content-delivery'&&e.notice.dismissed===false));
 assert.equal(w.bodies().length,count,'a refused revision is not re-published');
 assert.equal(actual(w,'answer'),'A');
 assert.equal(w.broker.snapshot(w.s.id).turn.outcome,null,'a rejected revision is not completion');
 assert.ok(!w.broker.snapshot(w.s.id).nativeDelivery.durable.deliveries
  .some(d=>d.confirmedText==='B'),'rejection is not a confirmed delivery');
});

test('CM observer: stored A after a rejected B is re-confirmed under the same identity, not a cleared cache',async t=>{
 const w=await world(t,{pageState:'running'});
 await w.view(w.s,{items:[message('answer','A')]});
 await until(()=>confirmed(w,'answer','A'));
 const count=w.bodies().length,deliveries=()=>w.broker.snapshot(w.s.id).nativeDelivery
  .durable.deliveries.filter(d=>d.sourceId===rowOf(w.broker.snapshot(w.s.id),'answer').id);
 const stored=deliveries().length;
 assert.ok(stored>=1&&deliveries().some(d=>d.confirmedText==='A'),'A was actually delivered first');
 await w.view(w.s,{items:[message('answer','B')]});
 await until(()=>w.events.some(e=>e.notice?.id==='native-content-delivery'&&e.notice.dismissed===false));
 await w.view(w.s,{items:[message('answer','A')]});
 // Re-reading the stored version needs no body traffic: the host already has
 // exactly this text, so the same source identity stays confirmed.
 await new Promise(resolve=>setTimeout(resolve,120));
 assert.equal(w.bodies().length,count);
 assert.equal(actual(w,'answer'),'A');
 assert.equal(deliveries().length,stored,'no second delivery record for the same version');
 assert.ok(deliveries().every(d=>d.confirmedText==='A'));
 assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='send').length,1);
});

test('CM observer: in-batch source order is kept, and a later tool row keeps its position',async t=>{
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 const rowsOf=state=>state.history.filter(row=>['assistant_message','tool_call'].includes(row.type));
 // Both visible in one frame: visible order decides history order, not which
 // item finishes or arrives first.
 await f.view(s,{items:[message('answer','half and the rest',{order:[1]}),tool()]});
 const first=rowsOf(f.broker.snapshot(s.id));
 assert.deepEqual(first.map(row=>row.type),['assistant_message','tool_call']);
 // The earlier source grows later; the later tool row must not move.
 await f.view(s,{items:[message('answer','half and the rest, then more',{order:[1]}),
  {...tool(),status:'completed',text:'completed read'}]});
 const after=rowsOf(f.broker.snapshot(s.id));
 assert.deepEqual(after.map(row=>row.type),['assistant_message','tool_call']);
 assert.equal(after[1].callId,first[1].callId);
 assert.equal(after[1].status,'completed');
 assert.equal(after[0].text,'half and the rest, then more');
 assert.equal(sends(f),1);
 // Known ordering boundary, reported instead of hidden: while a body's raw
 // supplement is still pending, a later projected row is published first (the
 // contract forbids holding it as a content gate). The withheld body is
 // appended when its representation is readable, and the page-state card
 // reports SOURCE_PROSE_READ_PENDING meanwhile.
 const g=await fixture(t),other=await g.ready();await g.sending(other);
 const pending=sourceItem('answer','half',{nativeMessageId:'native-answer',order:[1],
  prose:{status:'pending'}});
 await g.view(other,{items:[pending,tool()]});
 const boundary=rowsOf(g.broker.snapshot(other.id));
 assert.deepEqual(boundary.map(row=>row.type),['tool_call']);
 assert.ok(g.broker.snapshot(other.id).history.find(row=>row.kind==='page-state')
  .data.issues.some(issue=>issue.code==='SOURCE_PROSE_READ_PENDING'));
 await g.view(other,{items:[message('answer','half and the rest',{order:[1]}),tool()]});
 assert.deepEqual(rowsOf(g.broker.snapshot(other.id)).map(row=>row.type),
  ['tool_call','assistant_message']);
});
