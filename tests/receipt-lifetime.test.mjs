import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDiagnostic } from '../server/diagnostics.mjs';
import { fixture, selection, until } from './helpers.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';

test('receipt lifetime diagnostics expose a fixed guard code, not private URLs or exception text', () => {
  assert.deepEqual(safeDiagnostic({stage:'receipt',guardCode:'SEND_LIFETIME_REVOKED',pathChanged:true,routeKnown:true,
    url:'PRIVATE',stack:'PRIVATE',body:'PRIVATE',cookie:'PRIVATE'}),
    {stage:'receipt',pathChanged:true,routeKnown:true,guardCode:'SEND_LIFETIME_REVOKED'});
  assert.deepEqual(safeDiagnostic({stage:'receipt',guardCode:'PRIVATE_USER_TEXT',pathChanged:'PRIVATE',routeKnown:7}),{stage:'receipt'});
});

test('unconfirmed native Send replaces queued notice and never publishes receipt or a second Send', async t => {
  const f=await fixture(t);
  const p=await createProvider({...f,status:()=>({connected:true})}).connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>p.close());const events=[];p.onEvent(e=>events.push(e));
  await p.send({type:'session.open',requestId:'open-test',sessionId:'host-test',history:'skip',config:{
    cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,model:selection.model,thinkingOption:selection.thinkingOption,providerOptions:{appIds:[]}}});
  await until(()=>events.some(e=>e.type==='session.ready'));
  await p.send({type:'session.prompt',sessionId:'host-test',prompt:{clientMessageId:'message-test',delivery:'auto',input:{type:'message',content:[{type:'text',text:'test body'}]}}});
  const open=await until(()=>f.broker.queued().find(c=>c.kind==='open'));
  const a=await f.broker.claim(open.id,123,'document-test');
  await f.broker.result(open.id,a.lease,{config:a.payload.config,url:'https://chatgpt.com/',tabId:123});
  const send=await until(()=>f.broker.queued().find(c=>c.kind==='send'));
  const s=await f.broker.claim(send.id,123,'document-test');await f.broker.authorize(send.id,s.lease);
  await f.broker.result(send.id,s.lease,{error:'RECEIPT_UNCONFIRMED',diagnostic:{stage:'receipt',guardCode:'PAGE_GONE',nativeClicked:true}});
  const failed=await until(()=>events.find(e=>e.type==='session.turn'&&e.state==='failed'));
  assert.equal(failed.error.code,'RECEIPT_UNCONFIRMED');assert.match(failed.error.message,/不会自动重发/);
  const notice=events.filter(e=>e.type==='session.notice'&&e.notice.id==='native-delivery').at(-1).notice;
  assert.equal(notice.severity,'warning');assert.equal(notice.dismissed,false);assert.match(notice.title,/并非仍在排队/);
  assert.equal(events.some(e=>e.type==='session.turn'&&e.state==='completed'),false);
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
  assert.equal(f.broker.queued().length,0);
});
