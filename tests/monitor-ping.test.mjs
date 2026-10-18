/** Monitor continuity when a tab is slow/quiet (formerly "monitor pulse").
 *
 * The old pulse delivered a finished body and an identity-bound completion when
 * tab timers were throttled. The continuous contract has no pulse and no
 * quiet-time completion: every tick reports sources + the three visible
 * buttons, and only a visible standby frame changes the reported state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {item,page} from './fixtures/content-page.mjs';

test('TURN a quiet, unfinished page keeps reporting and is never completed by elapsed time',async t=>{
 const f=page(t);
 f.state.source.items=[item('answer','half visible',{order:[1]})];
 await f.monitor();
 assert.equal(f.accepted.length,1);
 assert.equal(f.accepted[0].event.view.page.state,'running');
 // Eight seconds later (older than the removed pulse budget) the same document
 // still reports. No body is invented and no completion is emitted.
 f.state.now+=8000;
 await f.tick(8000);
 assert.equal(f.accepted.at(-1).event.view.page.state,'running');
 assert.equal(f.accepted.at(-1).event.view.items[0].text,'half visible');
 assert.equal(f.state.sourceReads,2);assert.equal(f.state.controlReads,2);
 // Only a visible standby control sample changes the state.
 f.state.state='standby';
 await f.tick();
 assert.equal(f.accepted.at(-1).event.view.page.state,'standby');
 assert.equal(f.state.sends,0);assert.equal(f.state.stops,0);
 assert.ok(f.requests.every(request=>request.type==='page-view'));
});
