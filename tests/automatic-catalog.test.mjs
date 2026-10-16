import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../server/runtime.mjs';
import { catalogService } from '../server/catalog.mjs';
import { settingsSnapshot } from '../server/diagnostics.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';
import { until } from './helpers.mjs';
const engine=/'X-CIP-Engine': '([^']+)'/.exec(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'))[1];
const catalog = { models: [{id:'model-a',label:'Model A',thinkingOptions:[{id:'high',label:'High'}],defaultThinkingOptionId:'high'}],
  apps:[{id:'asdk_app_host',label:'Development host'}],defaultModel:'model-a' };
async function setup(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'cip-auto-test-'));
  const runtime=await createRuntime({directory,port:0});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  const pairing=JSON.parse(await readFile(path.join(directory,'pairing.json'),'utf8'));
  const extensionId='a'.repeat(32);
  const paired=await fetch(runtime.address+'/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({extensionId,code:pairing.code})});
  const {token}=await paired.json();
  const headers={'Authorization':`Bearer ${token}`,'X-CIP-Extension':extensionId,'X-CIP-Engine':engine,'X-CIP-Browser':'test-browser-1234567890'};
  const heartbeat=()=>fetch(runtime.address+'/commands',{headers}).then(r=>r.json());
  return {runtime,headers,heartbeat};
}
test('AUTO1 pairing/hello alone do not open tabs; first authenticated extension heartbeat starts discovery without UI',async t=>{
  const {runtime,heartbeat}=await setup(t);
  await fetch(runtime.address+'/hello');assert.equal(runtime.broker.queued().length,0);
  await heartbeat();const command=await until(()=>runtime.broker.queued().find(c=>c.kind==='catalog'));
  for(let i=0;i<8;i++)await heartbeat();
  assert.equal(runtime.broker.queued().filter(c=>c.kind==='catalog').length,1);
  const s=await settingsSnapshot(runtime,false);assert.equal(s.refreshing,true);assert.equal(s.status.connected,true);
  assert.equal(command.sessionId,null);assert.equal(Object.keys(runtime.store.read().sessions).length,0);
});
test('AUTO2 automatic, manual and provider requests share one read; success reaches Paseo without another click',async t=>{
  const {runtime,heartbeat}=await setup(t);await heartbeat();
  const command=await until(()=>runtime.broker.queued().find(c=>c.kind==='catalog'));
  const provider=await createProvider(runtime).connect({versions:[1],capabilities:CAPABILITIES});t.after(()=>provider.close());
  const events=[];provider.onEvent(e=>events.push(e));await provider.send({type:'catalog',requestId:'provider-read'});
  const initial=await settingsSnapshot(runtime,true);assert.equal(initial.refreshing,true);
  assert.equal(runtime.broker.queued().filter(c=>c.kind==='catalog').length,1);
  const claim=await runtime.broker.claim(command.id,51,'doc-auto');
  await runtime.broker.result(command.id,claim.lease,{catalog});
  await until(()=>events.some(e=>e.type==='catalog'));
  const shown=await settingsSnapshot(runtime,false);assert.equal(shown.refreshing,false);assert.equal(shown.catalog.apps[0].id,'asdk_app_host');
  await provider.send({type:'catalog',requestId:'cached-read'});await until(()=>events.filter(e=>e.type==='catalog').length===2);
  assert.equal(runtime.broker.queued().length,0,'provider polling reuses the confirmed catalog');
});
test('AUTO3 failed automatic discovery is reported, never looped on each heartbeat',async t=>{
  const {runtime,heartbeat}=await setup(t);await heartbeat();
  const command=await until(()=>runtime.broker.queued().find(c=>c.kind==='catalog'));
  const claim=await runtime.broker.claim(command.id,52,'doc-fail');
  await runtime.broker.result(command.id,claim.lease,{error:'APP_CATALOG_UNAVAILABLE',diagnostic:{stage:'apps'}});
  await until(()=>!catalogService(runtime).snapshot().refreshing);
  for(let i=0;i<10;i++)await heartbeat();
  assert.equal(runtime.broker.queued().length,0);assert.equal(Object.keys(runtime.store.read().commands).length,1);
  assert.equal((await settingsSnapshot(runtime,false)).refreshError,'APP_CATALOG_UNAVAILABLE');
});
test('AUTO4 closing a provider does not cancel another consumers automatic discovery',async t=>{
  const {runtime,heartbeat}=await setup(t);await heartbeat();
  const command=await until(()=>runtime.broker.queued().find(c=>c.kind==='catalog'));
  const provider=await createProvider(runtime).connect({versions:[1],capabilities:CAPABILITIES});
  await provider.send({type:'catalog',requestId:'closing-ui'});await new Promise(r=>setImmediate(r));await provider.close();
  assert.equal(runtime.store.read().commands[command.id].phase,'queued');
  const claim=await runtime.broker.claim(command.id,53,'doc-other-owner');await runtime.broker.result(command.id,claim.lease,{catalog});
  await until(()=>!catalogService(runtime).snapshot().refreshing);
  assert.equal(runtime.store.read().catalog.models[0].id,'model-a');
});
