import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {createWakeCoordinator} from '../server/wake.mjs';

async function setup(t){
  const f=await fixture(t);
  const s=await f.ready();
  const first=await f.sending(s,'root','Hello');
  await f.broker.observe({...first.event,kind:'snapshot',messageId:'root-answer',text:'Finished'});
  await f.broker.observe({...first.event,kind:'completed',messageId:'root-answer',finalConfirmed:true});
  const old=f.broker.snapshot(s.id);
  return {f,s:old,proof:{
    sessionId:old.id,conversationId:old.conversationId,tabId:old.tabId,
    documentKey:old.documentKey,previousNativeMessageId:old.lastNativeMessageId,
    nativeMessageId:'manual-user-1',text:'From real ChatGPT editor',
    url:`https://chatgpt.com/c/${old.conversationId}`
  }};
}

test('ADV1-04: wake may never revive archived Paseo Agent via stale cache',async()=>{
  const sid='fb482e6c-2e0a-49d5-9e02-66f3ebf57747';
  let archived=false, commands=0, scans=0;
  const agent=()=>({
    id:'archived-agent',provider:'chatmode',archivedAt:archived?'2026-10-15T01:00:00Z':null,
    persistence:{provider:'chatmode',sessionId:'plugin:'+JSON.stringify({version:1,data:{id:sid}})}
  });
  const wake=createWakeCoordinator();
  wake.adopt({agents:{ref:()=>({refresh:async()=>({agent:agent()}),commands:async()=>{commands++;return []}}),
    list:async()=>{scans++;return {entries:[{agent:agent()}]}}}});
  assert.equal((await wake.wake(sid)).woken,true);
  archived=true;
  assert.equal((await wake.wake(sid)).woken,false);
  assert.equal(commands,1);
});

/* Retired assertions (mechanism removed):
 * ADV1-01 duplicate external native user id -> the external-turn import lane is
 *   gone. Source identity conflicts are rejected in the ledger
 *   (SOURCE_IDENTITY_CONFLICT, source-ledger tests) and by CM-R6.
 * ADV1-02 a second tab stealing a binding -> observation identity is fenced by
 *   lease/document/tab: CONTOBS-01, MON-11/MON-17, LINK3, R10.
 * ADV1-03 external-gap notices requiring a durable native id -> noteExternalGap
 *   and the external-gap notice lane are gone; observation gaps are recorded
 *   by recordObservationGap without an invented native id (CM-R9, OBS-HTTP1).
 */
