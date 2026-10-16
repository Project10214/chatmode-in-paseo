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

test('ADV1-01: a duplicate native user id may never silently change body or document',async t=>{
  const {f,proof}=await setup(t),original=await f.broker.importExternalTurn(proof);
  assert.equal(original.imported,true);
  await assert.rejects(f.broker.importExternalTurn({...proof,text:'FORGED'}),e=>e.code==='EXTERNAL_MESSAGE_CONFLICT');
  await assert.rejects(f.broker.importExternalTurn({...proof,documentKey:'different-doc'}),e=>e.code==='PAGE_IDENTITY_MISMATCH');
  const re=await f.broker.importExternalTurn(proof);
  assert.equal(re.duplicate,true);assert.equal(re.turnId,original.turnId);
  assert.equal(f.broker.snapshot(proof.sessionId).history.filter(x=>x.messageId==='manual-user-1').length,1);
});

test('ADV1-02: a second tab must not steal an extant conversation binding',async t=>{
  const {f,proof}=await setup(t);
  await assert.rejects(f.broker.importExternalTurn({...proof,tabId:9900,documentKey:'foreign-doc'}),e=>e.code==='PAGE_IDENTITY_MISMATCH');
  const s=f.broker.snapshot(proof.sessionId);
  assert.equal(s.tabId,proof.tabId);assert.equal(s.documentKey,proof.documentKey);assert.equal(s.status,'idle');
});

test('ADV1-03: durable native id is mandatory for external-gap notices',async t=>{
  const {f,proof}=await setup(t);
  await assert.rejects(f.broker.noteExternalGap({sessionId:proof.sessionId,conversationId:proof.conversationId,
    url:proof.url,reason:'multiple_unobserved_turns',tabId:90000,documentKey:'not-owned',
    previousNativeMessageId:'unrelated'}),e=>e.code==='PAGE_IDENTITY_MISMATCH');
  assert.equal(f.broker.snapshot(proof.sessionId).externalGap,undefined);
});

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
