/** Public tool/process sources under the continuous page-view contract.
 *
 * The old `kind:'activity'` snapshot lane and its `native-activity` card are no
 * longer produced by the observation path; tools arrive as individually
 * identified public sources and project to native tool_call items. The legacy
 * `nativeActivity` validator is kept below because the card renderer still
 * accepts already-persisted v1/v2 rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,sourceItem} from './helpers.mjs';
import {nativeActivity,phaseLabel} from '../server/activity.mjs';

const step=(kind='search',done=false)=>({kind,label:'web.run',done});
const activity=(phase='search',steps=[step()])=>({phase,nativeStatus:'in_progress',steps});
const tool=(id,status,text,extra={})=>sourceItem(id,text,{role:'page',lane:'process',kind:'tool_call',
 callId:'call-'+id,name:'read · web.run',status,order:[1],...extra});

test('NATIVE1 public native activity is bounded to status/tool names only',()=>{
  assert.deepEqual(nativeActivity(activity()),activity());
  for(const bad of [
    {...activity(),secret:'token'},
    {...activity(),steps:[{...step(),arguments:{authorization:'abc'}}]},
    {...activity(),steps:[{...step(),label:'https://example.com/?key=secret'}]},
    {...activity(),steps:Array(13).fill(step())},
    {...activity(),phase:'fabricated'},
    {...activity(),nativeStatus:'error'},
    {...activity(),steps:[{kind:'search',label:'query',done:'true'}]}
  ])assert.throws(()=>nativeActivity(bad),/ACTIVITY_INVALID/);
  assert.equal(phaseLabel('approval'),'等待授权');
});

test('NATIVE2/4 one public tool source is one tool_call item, updated in place, never an answer',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  await f.view(s,{items:[tool('tool-1','running','running read')]});
  let state=f.broker.snapshot(s.id),rows=state.history.filter(row=>row.type==='tool_call');
  assert.equal(rows.length,1);assert.equal(rows[0].callId,'call-tool-1');
  assert.equal(rows[0].status,'running');
  assert.equal(rows[0].detail.text,'running read');
  assert.equal(state.history.filter(row=>row.type==='assistant_message').length,0,
    'a tool row never fabricates assistant prose');
  assert.equal(state.status,'running');
  const id=rows[0].id;
  await f.view(s,{items:[tool('tool-1','completed','completed read')]});
  state=f.broker.snapshot(s.id);rows=state.history.filter(row=>row.type==='tool_call');
  assert.equal(rows.length,1,'the same tool call updates its own row');
  assert.equal(rows[0].id,id);assert.equal(rows[0].status,'completed');
  assert.equal(rows[0].detail.text,'completed read');
  assert.equal(state.turn.outcome,null,'a tool status is never Paseo turn completion');
  assert.equal(state.observation.page.state,'running');
});

/* Retired assertions (mechanism removed):
 * NATIVE3 activity-status ownership across tabs/leases/turns -> the observation
 *   lease + document/URL fence is CONTOBS-01 and MON-11/17.
 * NATIVE5 failed-turn activity card -> an abnormal/unreadable page is a page
 *   state and issue, not a fabricated failed turn (CONTOBS-10, CPROV-07).
 * NATIVE6 Provider upsert of the native-activity plugin card -> the page-state
 *   card is the only status card now; provider upsert/replay is covered by
 *   CPROV-02/CPROV-08 and the page-observation migration test.
 */
