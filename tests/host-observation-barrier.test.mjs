/** Host subscription barrier, migrated to the continuous Provider/delivery chain.
 *
 * The host may swallow events emitted while its session is still opening: a
 * resumed turn may announce `started` / forward a body only after the wake
 * coordinator's barrier for that exact binding resolved. A barrier proves
 * "loaded and subscribed now"; it is never a message-persistence or completion
 * ACK. The synthetic projected host here consumes real Provider events; it is
 * not a daemon or UI.
 *
 * Old cases whose mechanism no longer exists (the message snapshot/receipt lane
 * and its per-event backlog) are listed at the end with their current
 * equivalents instead of being re-asserted through the removed API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderEventSchema} from '@getpaseo/plugin/server/provider';
import {until} from './helpers.mjs';
import {world} from './fixtures/provider-delivery-world.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const item=(id,text,extra={})=>({id,userMessageId:null,role:'assistant',lane:'output',
 kind:'message',text,format:'text',order:[1],nativeMessageId:'native-'+id,...extra});
const starts=w=>w.events.filter(event=>event.type==='session.turn'&&event.state==='started');
const bodyText=w=>w.rows.filter(row=>row.item.type==='assistant_message').map(row=>row.item.text).join('');

test('HB-1 sources and standby keep running while the host barrier is unproven; one ordered delivery follows',async t=>{
 const w=await world(t,{barrier:false,pageState:'running'});
 await w.view(w.s,{state:'running',items:[item('formal','held original text')]});
 // Local capture is not gated by the host: the source and the page state are
 // recorded immediately, while nothing is emitted into an unproven session.
 const state=w.broker.snapshot(w.s.id);
 assert.equal(state.sources.find(source=>source.id==='formal').text,'held original text');
 assert.equal(state.observation.page.state,'running');
 assert.equal(w.bodies().length,0);assert.equal(bodyText(w),'');
 assert.equal(starts(w).length,0,'no lifecycle before the barrier');
 await sleep(150);
 assert.equal(w.bodies().length,0,'a pending barrier is not a retry loop');
 // The barrier resolves for this binding (wake coordinator answered), then the
 // held body is delivered exactly once, after `started`.
 w.releaseBarrier();
 await until(()=>bodyText(w)==='held original text');
 assert.equal(starts(w).length,1,'exactly one started, for the observed run');
 const order=w.events.filter(event=>event.type==='session.turn'||
  (event.type==='timeline.item'&&event.item.type==='assistant_message')).map(event=>
  event.type==='session.turn'?'turn:'+event.state:'body');
 assert.deepEqual(order,['turn:started','body']);
 await w.view(w.s,{state:'running',items:[item('formal','held original text')]});
 await sleep(150);
 assert.equal(w.bodies().length,1,'an unchanged re-read is not a second delivery');
 for(const event of w.events)ProviderEventSchema.parse(event);
});

test('HB-2/HB-5 a failed barrier and a closed session are not proof, and a later barrier is not a license to replay',async t=>{
 const w=await world(t,{barrier:false,pageState:'running'});
 await w.view(w.s,{state:'running',items:[item('formal','content before barrier')]});
 await sleep(100);
 assert.equal(w.bodies().length,0);
 // Closing the host session while the barrier is unresolved must drop the
 // pending announcement instead of leaking it into a later session.
 await w.connection.send({type:'session.close',sessionId:'host-one',requestId:'close-before-barrier'});
 await until(()=>w.events.some(event=>event.type==='session.closed'));
 const before=w.events.length;
 w.releaseBarrier();await sleep(200);
 assert.equal(w.events.length,before,'a resolved barrier cannot revive a closed binding');
 assert.equal(w.bodies().length,0);
 const state=w.broker.snapshot(w.s.id);
 assert.equal(state.sources.find(source=>source.id==='formal').text,'content before barrier',
  'the captured source is durable even though no host ever confirmed it');
 assert.equal(Object.values(w.store.read().commands).filter(command=>command.kind==='send').length,1,
  'no barrier result ever causes a native Send');
 // A fresh host session asks for its own barrier; it does not inherit the old
 // one. Content is delivered once when its barrier is answered.
 await w.open('host-two');
 w.releaseBarrier();
 await until(()=>bodyText(w)==='content before barrier');
 assert.equal(starts(w).length,1);
 assert.equal(w.bodies().length,1);
});

/* Migrated elsewhere / removed mechanism:
 * HB-3  content + terminal before the barrier -> PD-2 (standby processed while
 *       the barrier is unavailable; delivery waits for the observed marker).
 * HB-4  the host session that ended a Paseo foreground turn refusing recovery
 *       is the documented host limitation OBS-P1
 *       (OBSERVATION_HOST_SESSION_REOPEN_REQUIRED), not a passing case.
 * HB-4b cold Broker / replaced binding never inherits an old refusal ->
 *       CONTOBS-01 + CM-R2 (rebind rotates the lease and clears stale proof).
 * HB-8  every failure reason (AGENT_NOT_FOUND / NO_HOST_WAKER / invalid ID) is
 *       covered by the barrier test above: woken !== true keeps the backlog.
 * HB-9  >512 snapshot updates coalescing belonged to the removed message
 *       snapshot lane; the source ledger keeps one record per source id and
 *       one unconfirmed delivery batch (native-delivery, PD-1/PD-6).
 * HB-10 hundreds of distinct IDs are covered by CM-R10 (40+ sources, no
 *       truncation) plus PD-1 (each source gets its own native body).
 * HB-11 the Broker history budget is asserted in broker/store limits and
 *       native-delivery's coverage tests; there is no second held-identity
 *       queue any more.
 * HB-12 confirmed-stop partial body before its terminal -> CM-R8/CM-P2.
 * HB-13 recovery before subscription replacing an obsolete tracking failure ->
 *       CM-R9 + CONTOBS-10 (observation gaps/failures are not content gates).
 */
