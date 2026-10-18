/** Monitor continuity under the continuous page-view contract.
 *
 * The old monitor needed a native user anchor plus heartbeat evidence to keep
 * running, and emitted `observation` gaps when a tool hid that anchor. Neither
 * exists now: every tick reads the visible sources and the three buttons.
 * A↔B route changes are still fenced by the observation lease (MON-11/MON-12).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {item,page} from './fixtures/content-page.mjs';

const tool={id:'tool',userMessageId:null,role:'page',lane:'process',kind:'tool_call',
 text:'read running',format:'text',order:[1],callId:'call-1',name:'read',status:'running'};

test('the monitor never needs a native user anchor: a visible tool cannot hide later content or stop the timer',async t=>{
 const f=page(t);
 f.state.source.items=[tool];
 await f.monitor();
 assert.equal(f.accepted.length,1);
 assert.equal(f.intervals.size,1);
 // More than the old 15s gap budget: the same document still reports sources
 // and buttons. No anchor, heartbeat or quiet-time evidence is consulted.
 f.state.now+=19000;
 f.state.source.items=[tool,item('answer','later answer',{order:[3]})];
 await f.tick(19000);
 assert.equal(f.state.sourceReads,2);assert.equal(f.state.controlReads,2);
 const view=f.accepted.at(-1).event.view;
 assert.deepEqual(view.items.map(value=>value.id),['tool','answer']);
 assert.equal(view.page.state,'running');
 assert.equal(f.intervals.size,1);
 assert.ok(f.requests.every(request=>request.type==='page-view'));
});

/* Retired assertions (mechanism removed):
 * NATIVE-GAP2 A→B→A navigation invalidation -> MON-11 (revoked lease until a
 *   fresh observation arrives) and MON-12 (late old-epoch response cannot
 *   consume the new queue).
 * NATIVE-GAP3 heartbeat needs native in-progress evidence -> there is no
 *   heartbeat lane; liveness is the bound document/lease and each tick's
 *   button read (MON-02/MON-07). A foreign tab/lease is rejected in MON-17.
 */
