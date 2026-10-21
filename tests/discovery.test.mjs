import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDiagnostic, safeError, catalogAttempt, settingsSnapshot } from '../server/diagnostics.mjs';
import { readFileSync } from 'node:fs';
import { fixture, until } from './helpers.mjs';

test('DIA1 diagnostics discard arbitrary text, endpoints, tokens and unknown stages', () => {
  assert.deepEqual(safeDiagnostic({stage:'apps',editorCount:1,panelCount:2,rowCount:9,text:'PRIVATE',token:'SECRET',url:'SECRET'}),{stage:'apps',editorCount:1,panelCount:2,rowCount:9});
  assert.equal(safeDiagnostic({stage:'PRIVATE'}),null);
  assert.deepEqual(safeDiagnostic({stage:'apps',rowCount:129,panelCount:-1,editorCount:NaN}),{stage:'apps'});
  assert.equal(safeError(new Error('Bearer private-secret')),'CATALOG_FAILED');
});
test('DIA1b the model picker diagnostic keeps the request and the wait, and drops anything else', () => {
  assert.deepEqual(safeDiagnostic({stage:'model',model:'gpt-6',thinkingOption:'xhigh',
    waitedMs:8123,budgetMs:20000,lastProofCode:'MODEL_IDENTITY_UNPROVEN'}),
    {stage:'model',model:'gpt-6',thinkingOption:'xhigh',waitedMs:8123,budgetMs:20000,
     lastProofCode:'MODEL_IDENTITY_UNPROVEN'});
  // An unproven model id, an oversized wait or a foreign stage never leaks:
  // the unusable fields are dropped, not carried.
  assert.deepEqual(safeDiagnostic({stage:'model',model:'a b',thinkingOption:'x'.repeat(41),
    waitedMs:999999}),{stage:'model'});
  assert.equal(safeDiagnostic({stage:'model',model:'gpt-6',waitedMs:1,secret:'PRIVATE'}).secret,undefined);
  assert.equal(safeDiagnostic({stage:'private'}),null);
});
test('DIA2 failed catalog returns fresh connection and keeps last confirmed catalog', async () => {
  const state={sessions:{},commands:{c:{kind:'catalog',phase:'failed',createdAt:5,error:'APP_MENU_TIMEOUT',diagnostic:{stage:'apps'}}},catalog:{models:[{id:'m'}]},defaults:{appIds:[]}};
  const runtime={status:()=>({connected:true,paired:true}),store:{read:()=>structuredClone(state)},broker:{call:async()=>{throw Object.assign(new Error('APP_MENU_TIMEOUT'),{code:'APP_MENU_TIMEOUT'})}}};
  const accepted=await settingsSnapshot(runtime,true);
  assert.equal(accepted.refreshing,true); assert.equal(accepted.refreshError,null);
  await new Promise(resolve=>setImmediate(resolve));
  const s=await settingsSnapshot(runtime,false);
  assert.equal(s.refreshing,false);
  assert.equal(s.status.connected,true); assert.equal(s.refreshError,'APP_MENU_TIMEOUT');
  assert.equal(s.lastCatalogAttempt.diagnostic.stage,'apps'); assert.equal(s.catalog.models[0].id,'m');
});
test('DIA3 offline refresh refuses without opening a tab or queue entry', async () => {
  let calls=0;const runtime={status:()=>({connected:false}),store:{read:()=>({sessions:{},commands:{},catalog:null,defaults:{appIds:[]}})},broker:{call:async()=>calls++}};
  assert.equal((await settingsSnapshot(runtime,true)).refreshError,'EXTENSION_OFFLINE'); assert.equal(calls,0);
});
test('DIA4 overlapping catalog requests share one browser operation', async () => {
  let calls=0,release; const wait=new Promise(r=>release=r);
  const runtime={status:()=>({connected:true}),store:{read:()=>({sessions:{},commands:{},catalog:null,defaults:{appIds:[]}})},broker:{call:async()=>{calls++;await wait}}};
  const a=settingsSnapshot(runtime,true),b=settingsSnapshot(runtime,true); await until(()=>calls===1);release();await Promise.all([a,b]);assert.equal(calls,1);
});
test('DIA5 catalog diagnostic survives receipt and restart-readable state', async t => {
  const f=await fixture(t),call=f.broker.call('catalog',null);call.catch(()=>{});
  const c=await until(()=>f.broker.queued().find(c=>c.kind==='catalog'));const claim=await f.broker.claim(c.id,55,'page');
  await f.broker.result(c.id,claim.lease,{error:'APP_MENU_TIMEOUT',diagnostic:{stage:'apps',rowCount:0,secret:'MUST_NOT_STORE'}});
  await assert.rejects(call,/APP_MENU_TIMEOUT/);const state=f.store.read();
  assert.deepEqual(state.commands[c.id].diagnostic,{stage:'apps',rowCount:0});assert.ok(!JSON.stringify(state).includes('MUST_NOT_STORE'));
  assert.equal(catalogAttempt(state).error,'APP_MENU_TIMEOUT');
});

test('DIA6 the snapshot carries the build the RUNNING extension reported', async () => {
  // The plugin's own build and the installed extension build are inlined into
  // the CLIENT bundle: the server bundle is evaluated from memory and cannot
  // read its own package directory. The snapshot therefore carries only the
  // version the running extension reported over the wire.
  const state = { sessions: {}, commands: {}, catalog: null, defaults: { appIds: [] } };
  const runtime = { status: () => ({ connected: true }), store: { read: () => structuredClone(state) },
    broker: { call: async () => {} }, extensionVersion: '0.2.52' };
  const snapshot = await settingsSnapshot(runtime, false);
  assert.equal(snapshot.extensionVersion, '0.2.52');
  assert.equal('pluginVersion' in snapshot, false);
  assert.equal('installedExtensionVersion' in snapshot, false);

  // An extension that reported nothing, or reported something unusable, is
  // unknown - never reported as the installed build.
  assert.equal((await settingsSnapshot({ ...runtime, extensionVersion: undefined }, false)).extensionVersion, null);
  assert.equal((await settingsSnapshot({ ...runtime, extensionVersion: 'not-a-version' }, false)).extensionVersion, null);
});
