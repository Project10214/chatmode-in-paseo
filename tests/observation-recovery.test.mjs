/** Field-incident recovery under the continuous observation contract.
 *
 * The old suite reconstructed the deployed alpha.4.16 state where an
 * observation failure FAILED the turn and had to be recovered in place with
 * /active + /recover-observation. That lane is gone:
 * - an unreadable/abnormal page never fails or completes a Paseo turn;
 * - recovery is a document rebind with a fresh observation lease, followed by
 *   the next real page frame; it never sends or replays a prompt;
 * - the source ledger keeps everything captured before the gap.
 * The remaining test below asserts that end-to-end incident outcome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,pageView,sourceItem} from './helpers.mjs';

test('incident recovery: an unreadable page does not fail the turn; a fresh lease continues with history and no Send',async t=>{
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 await f.view(s,{state:'running',items:[sourceItem('answer','已发布正文',{nativeMessageId:'native-answer'})]});
 const before=Object.keys(f.store.read().commands).length;
 await f.broker.observeGap({...pageView(f.broker.snapshot(s.id)),reason:'SOURCE_TEMPORARILY_UNREADABLE'});
 let state=f.broker.snapshot(s.id);
 assert.equal(state.observation.gap.reason,'SOURCE_TEMPORARILY_UNREADABLE');
 assert.equal(state.observation.page.state,'abnormal');
 assert.equal(state.turn.outcome,null,'a lost observer is not a failed native turn');
 assert.ok(state.history.some(row=>row.id==='page:answer'),'captured history survives the gap');
 // Document replacement is recovered by a rebind, not by a prompt or /active.
 const rebound=await f.broker.rebindObservation({sessionId:s.id,
  observationLease:state.observation.lease,previousDocumentKey:state.documentKey,
  documentKey:'recovered-document',tabId:state.tabId,
  url:`https://chatgpt.com/c/${state.conversationId}`});
 assert.notEqual(rebound.observationLease,state.observation.lease);
 await f.view(f.broker.snapshot(s.id),{state:'running',items:[
  sourceItem('answer','已发布正文',{nativeMessageId:'native-answer'}),
  sourceItem('next','继续后的新来源',{nativeMessageId:'native-next',order:[2]})]});
 state=f.broker.snapshot(s.id);
 assert.equal(state.observation.page.state,'running');
 assert.ok(state.sources.find(source=>source.id==='next'));
 assert.equal(Object.keys(f.store.read().commands).length,before,'recovery adds no Send/Stop/approval');
 assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
});

/* Retired assertions (mechanism removed):
 * OBS-D1/D3 a content failure blocked/idled or explicitly failed a turn ->
 *   CONTOBS-10 (abnormal does not close the run), CM-R9 (gap/failure is not a
 *   content or completion gate), CPROV-07 (error page still delivers text).
 * OBS-D2 a non-prefix published answer is refused and never completed -> CM-R4
 *   (retained source, refused host replacement), PD-11.
 * OBS-B1 /active recoveryOnly inventory -> endpoint removed; the bound
 *   observation inventory is /observations and is covered by OBS-HTTP1.
 * OBS-C1/C2/C3 incident sessions recovered by proof-gated /recover-observation,
 *   with a newer user turn making recovery unrecoverable -> turns are no longer
 *   failed by observation at all. Recovery is rebind + fresh lease (the test
 *   above, CONTOBS-01, CM-R2); a newer user/source simply continues
 *   (CONTOBS-03/CONTOBS-05).
 * OBS-T1 timeline overflow and non-prefix reasoning -> explicit frame splitting
 *   (MON-09/10), reasoning upsert by source identity (TIMELINE-04), non-prefix
 *   body refusal (CM-R4).
 * OBS-P1/P2/P3 + OBS-H1 host capability gate for reopening the original
 *   finalized foreground turn, and the Provider sync-blockage notice -> the
 *   continuous contract does not reopen a host foreground turn; it observes
 *   page content. The host limitation remains documented in
 *   docs/IN_PLACE_RECOVERY_PLAN.md and docs/OBS_P1_VERIFICATION.md and is not
 *   claimed as solved. Page/delivery issues surface in the page-state card and
 *   the native-content-delivery notice (PD-2), not a turn failure.
 * OBS-C4 conversation from the observed URL / a disagreeing URL refused ->
 *   assertObservation URL/lease/tab/document fence (CONTOBS-01, CM-R6).
 */
