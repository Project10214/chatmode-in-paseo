import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../server/runtime.mjs';
import { rawCatalog, selection } from './helpers.mjs';
import { validateCatalog } from '../server/protocol.mjs';

test('UPDATE-HTTP inventory and Agent resumption require pairing, exact stored Conversation, no Send',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'cip-update-'));
  const invoked=[],runtime=await createRuntime({directory:dir,port:0,
    onExternalTurn:sid=>{invoked.push(sid);return {woken:true};}});
  t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
  await runtime.store.transaction(d=>{d.catalog=validateCatalog(rawCatalog);});
  const bound=await runtime.broker.create(selection),unbound=await runtime.broker.create(selection);
  await runtime.store.transaction(d=>{
    d.sessions[bound.id].conversationId='bound-chat';
    d.sessions[bound.id].tabId=71;
    d.sessions[bound.id].documentKey='old-document';
  });
  const base=runtime.address,extId='a'.repeat(32);
  const send=(route,value,headers={})=>fetch(base+route,{
    method:value===undefined?'GET':'POST',
    headers:{...headers,...(value===undefined?{}:{'Content-Type':'application/json'})},
    body:value===undefined?undefined:JSON.stringify(value)
  });
  assert.equal((await send('/recovery-targets')).status,403);
  const {code}=JSON.parse(await readFile(path.join(dir,'pairing.json'),'utf8'));
  const pair=await (await send('/pair',{code,extensionId:extId})).json();
  const auth={Authorization:'Bearer '+pair.token,'X-CIP-Extension':extId};
  const response=await send('/recovery-targets',undefined,auth);
  assert.equal(response.status,200);
  const {sessions}=await response.json();
  assert.equal(sessions.length,1);
  assert.deepEqual(sessions[0],{sessionId:bound.id,conversationId:'bound-chat',tabId:71});
  assert(!sessions.some(s=>s.sessionId===unbound.id));
  const incorrect=await send('/resume-agent',{sessionId:bound.id,conversationId:'other-chat'},auth);
  assert.equal(incorrect.status,400);
  assert.equal(invoked.length,0);
  const unknown=await send('/resume-agent',{sessionId:unbound.id,conversationId:'bound-chat'},auth);
  assert.equal(unknown.status,400);
  const valid=await send('/resume-agent',{sessionId:bound.id,conversationId:'bound-chat'},auth);
  assert.equal(valid.status,200);
  assert.deepEqual(await valid.json(),{queued:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(invoked,[bound.id]);
  assert.equal(runtime.broker.snapshot(bound.id).status,'idle');
  assert.equal(Object.values(runtime.store.read().commands).filter(c=>c.kind==='send').length,0);
});
