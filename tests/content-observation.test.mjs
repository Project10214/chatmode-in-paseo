/** Observer migrations for the continuous page-view contract.
 *
 * The old file drove content.js's removed `kind:'observation'` monitor
 * (snapshot / page_status / activity / completed) and asserted that an
 * unfinished message BLOCKED later rows. That gate is gone: the extension
 * reports every visible source and every visible button on each tick, and only
 * that source's original representation may wait for its raw supplement.
 * Collection/receipts never end a Paseo run; a visible standby page does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {clone,item,page} from './fixtures/content-page.mjs';

const tool=extra=>({id:'tool',userMessageId:null,role:'page',lane:'process',kind:'tool_call',
 text:'read running',format:'text',order:[2],callId:'call-1',name:'read',status:'running',...extra});
const observerOnly=f=>assert.ok(f.requests.every(request=>request.type==='page-view'),
 'the observer may only read pages and report page views');

test('observer reports every visible source in source order, never only the last answer',async t=>{
 const f=page(t);
 f.state.source.items=[item('comment','First',{order:[1]}),tool(),
  item('answer','Last',{order:[3],nativeMessageId:'native-answer'})];
 await f.monitor();
 const view=f.accepted[0].event.view;
 assert.deepEqual(view.items.map(value=>value.id),['comment','tool','answer']);
 assert.equal(view.items.find(value=>value.id==='comment').text,'First');
 assert.equal(view.items.find(value=>value.id==='answer').text,'Last');
 assert.equal(view.page.state,'running');
 assert.equal(f.state.sends,0);assert.equal(f.state.stops,0);assert.equal(f.state.approvals,0);
 observerOnly(f);
});

test('a pending original representation holds only itself; later rows and the status card stay live',async t=>{
 const f=page(t);
 // The supplement read is in flight: formal bodies carry prose status pending.
 f.rawReader(()=>new Promise(()=>{}));
 f.state.source.items=[item('answer','half',{order:[1],nativeMessageId:'native-answer'}),tool()];
 await f.monitor();
 const view=f.accepted[0].event.view;
 assert.deepEqual(view.items.map(value=>value.id),['answer','tool'],
  'an unfinished representation does not block later rows any more');
 assert.equal(view.items.find(value=>value.id==='answer').prose.status,'pending');
 assert.equal(view.items.find(value=>value.id==='tool').text,'read running');
 assert.equal(view.page.state,'running');
 assert.equal(view.page.controls.stop.visible,true);
 // One tick, both reads: status is not waiting for the body.
 assert.equal(f.state.sourceReads,1);assert.equal(f.state.controlReads,1);
 assert.equal(f.state.sends,0);assert.equal(f.state.stops,0);
 observerOnly(f);
});

test('a content read failure is an issue in the same frame as live controls, and the same observer recovers',async t=>{
 const f=page(t);
 f.state.readSource=()=>{throw new Error('unreadable content');};
 await f.monitor();
 const failed=f.accepted[0].event.view;
 assert.deepEqual(failed.items,[]);
 assert.equal(failed.page.state,'running','buttons are read independently of prose');
 assert.ok(failed.issues.some(issue=>issue.code==='CONTENT_READ_FAILED'));
 f.state.readSource=undefined;f.state.source.items=[item('answer','later visible answer')];
 await f.tick();
 assert.equal(f.accepted.at(-1).event.view.items[0].id,'answer');
 assert.equal(f.state.sends,0);assert.equal(f.state.stops,0);assert.equal(f.state.approvals,0);
 observerOnly(f);
});

test('an unreadable item is a visible issue, never an empty successful body',async t=>{
 const f=page(t);
 f.state.readSource=()=>({conversationId:'chat-a',items:[],
  approvals:[],closedApprovals:[],issues:[{code:'ANSWER_CONTENT_UNAVAILABLE',id:'answer'}]});
 await f.monitor();
 const view=f.accepted[0].event.view;
 assert.deepEqual(view.items,[],'nothing is fabricated for the unreadable item');
 assert.ok(view.issues.some(issue=>issue.code==='ANSWER_CONTENT_UNAVAILABLE'));
 assert.equal(view.page.state,'running','an unreadable body is not a terminal state');
 observerOnly(f);
});

test('content and local persistence never complete the run; only a visible standby page ends it',async t=>{
 const f=page(t);
 await f.monitor();
 assert.equal(f.accepted.length,1);
 assert.equal(f.accepted[0].event.view.page.state,'running');
 // Persistence accepted:true is a local write, not a host ACK or completion.
 await f.tick();
 assert.equal(f.state.sourceReads,2);
 assert.equal(f.requests.filter(request=>request.type!=='page-view').length,0);
 f.state.state='standby';
 await f.tick();
 assert.equal(f.accepted.at(-1).event.view.page.state,'standby');
 assert.equal(f.state.sends,0);assert.equal(f.state.stops,0);
 observerOnly(f);
});

test('a stale observation endpoint resumes under a fresh lease without replaying a command',async t=>{
 const f=page(t);
 await f.monitor();
 assert.equal(f.accepted[0].event.sequence,1);
 f.navigate('chat-b');f.navigate('chat-a');
 assert.equal((await f.monitor()).ok,false,'the old document/route cannot resume');
 assert.equal((await f.monitor(f.session({observationLease:'observation-new'}))).ok,true);
 f.state.source.items=[item('later','new epoch answer')];
 await f.tick();
 const fresh=f.attempts().filter(request=>request.event.observationLease==='observation-new');
 assert.deepEqual(fresh.map(request=>request.event.sequence),[1,2]);
 assert.equal(fresh.at(-1).event.view.items[0].text,'new epoch answer');
 assert.equal(f.state.sends,0);
 observerOnly(f);
});
