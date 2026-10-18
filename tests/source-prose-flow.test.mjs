// Actual Store/Broker projection; original Provider/host/browser gate is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,sourceItem} from './helpers.mjs';
import {Store} from '../server/store.mjs';
const raw=(text,representation='markdown',extra={})=>sourceItem('formal','DOM rendered text',{
  nativeMessageId:'native-formal',prose:{status:'available',nativeMessageId:'native-formal',
  rawText:text,representation,observedAt:Date.now(),...extra}});
const body=f=>f.broker.snapshot(f.s.id).history.find(i=>i.messageId==='native-formal')?.text;
async function world(t){const f=await fixture(t),s=await f.ready();await f.sending(s);return {...f,s};}
test('PROSE-FLOW-1 raw Markdown persists separately and becomes native text without a completion gate',async t=>{
 const f=await world(t);await f.view(f.s,{items:[raw('**bold** 😀')]});
 assert.equal(body(f),'**bold** 😀');
 const saved=f.broker.snapshot(f.s.id).sources.find(x=>x.id==='formal');
 assert.equal(saved.text,'DOM rendered text');assert.equal(saved.prose.rawText,'**bold** 😀');
 const disk=await new Store(f.directory).open();
 assert.equal(disk.read().sessions[f.s.id].sourceProjections.find(x=>x.sourceId==='formal').proseState.mode,'markdown');
 assert.equal(f.broker.snapshot(f.s.id).status,'running');
});
test('PROSE-FLOW-2 DIL holds only ambiguous syntax, resumes persisted parser, accepts late tail after standby',async t=>{
 const f=await world(t);await f.view(f.s,{items:[raw('before a\\_b and \\(','dil')]});
 assert.equal(body(f),'before a_b and ');
 const disk=await new Store(f.directory).open();
 const state=disk.read().sessions[f.s.id].sourceProjections.find(x=>x.sourceId==='formal').proseState;
 assert.equal(state.mode,'dil');assert.ok(state.parser.cursor<state.input.length);
 await f.store.transaction(d=>{d.sessions[f.s.id]=structuredClone(disk.read().sessions[f.s.id]);});
 await f.view(f.s,{state:'standby',items:[raw('before a\\_b and \\(x\\) done','dil')]});
 assert.equal(body(f),'before a_b and \\(x\\) done');
 const events=[];f.broker.subscribe(f.s.id,e=>events.push(e));
 await f.view(f.s,{state:'standby',items:[raw('before a\\_b and \\(x\\) done','dil')]});
 assert.equal(events.filter(e=>e.state==='source').length,0);
 assert.equal(f.broker.snapshot(f.s.id).observation.page.state,'standby');
});
test('PROSE-FLOW-3 pending supplement holds only its formal projection, not DOM persistence or state',async t=>{
 const f=await world(t);
 const item=raw('ignored');item.prose={status:'pending'};
 await f.view(f.s,{state:'standby',items:[item,sourceItem('notice','still here',{role:'page',kind:'notice'})]});
 assert.equal(body(f),undefined);
 const saved=f.broker.snapshot(f.s.id);
 assert.equal(saved.sources.find(x=>x.id==='formal').text,'DOM rendered text');
 assert.equal(saved.observation.page.state,'standby');
 assert.ok(saved.history.some(x=>x.kind==='page-source'&&x.data.source.id==='notice'));
 await f.view(f.s,{state:'standby',items:[raw('# heading')]});
 assert.equal(body(f),'# heading');
});
test('PROSE-FLOW-4 current rewritten source reaches delivery authority instead of stale converter output',async t=>{
 const f=await world(t);await f.view(f.s,{items:[raw('old')]});
 await f.view(f.s,{items:[raw('new **answer**')]});
 assert.equal(body(f),'new **answer**','local projection is current source, NOT host delivery ACK');
 const saved=f.broker.snapshot(f.s.id).sources.find(x=>x.id==='formal');
 assert.equal(saved.prose.rawText,'new **answer**');
 assert.equal(saved.proseRewrites[0].rawText,'old');
});
test('PROSE-FLOW-5 unavailable raw is escaped literal DOM and a raw gap never changes state',async t=>{
 const f=await world(t),item=raw('ignored');
 item.text='*literal*';item.prose={status:'unavailable',code:'PUBLIC_MESSAGE_RAW_UNAVAILABLE'};
 await f.view(f.s,{items:[item]});
 assert.equal(body(f),'\\*literal\\*');
 await f.view(f.s,{items:[raw('**real**')]});
 assert.equal(body(f),'**real**','delivery layer, not converter, decides if a changed representation is publishable');
 assert.equal(f.broker.snapshot(f.s.id).status,'running');
});
test('PROSE-FLOW-6 UTF-16 split is retained in raw storage but never sent as a replacement character',async t=>{
 const f=await world(t);
 await f.view(f.s,{items:[raw('a'+String.fromCharCode(0xd83d))]});
 assert.equal(body(f),'a');
 const source=f.broker.snapshot(f.s.id).sources.find(x=>x.id==='formal');
 assert.equal(source.prose.rawText.charCodeAt(1),0xd83d);
 const disk=await new Store(f.directory).open();
 assert.equal(disk.read().sessions[f.s.id].sources.find(x=>x.id==='formal').prose.rawText,source.prose.rawText);
 await f.view(f.s,{items:[raw('a😀')]});
 assert.equal(body(f),'a😀');
});
test('PROSE-FLOW-7 long formula and independent message order survive the actual source ledger',async t=>{
 const f=await world(t);
 const formula='\\[\n'+Array.from({length:520},(_,i)=>'x_'+i).join('\n')+'\n\\]\n';
 const before='a\\_b\n';
 await f.view(f.s,{items:[raw(before+formula.slice(0,-3),'dil')]});
 assert.equal(body(f),'a_b\n');
 const sibling=raw('separate');sibling.id='sibling';sibling.nativeMessageId='native-sibling';
 sibling.prose.nativeMessageId='native-sibling';sibling.order=[-1];
 await f.view(f.s,{state:'standby',items:[raw(before+formula,'dil'),sibling]});
 assert.equal(body(f),'a_b\n'+formula);
 assert.deepEqual(f.broker.snapshot(f.s.id).sources.map(s=>s.id),['sibling','formal']);
 assert.equal(f.broker.snapshot(f.s.id).history.find(i=>i.messageId==='native-sibling').text,'separate');
 assert.equal(f.broker.snapshot(f.s.id).sources.find(i=>i.id==='formal').prose.rawText,before+formula);
});

