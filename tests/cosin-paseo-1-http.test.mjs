import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRuntime} from '../server/runtime.mjs';
import {validateCatalog} from '../server/protocol.mjs';
import {rawCatalog,selection,until} from './helpers.mjs';

test('COS1-HTTP: authenticated idle observation imports once, wakes once and never enqueues Send',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'cos1-http-')),wake=[];
  const runtime=await createRuntime({directory,port:0,onExternalTurn:id=>{wake.push(id)}});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true})});
  const pairing=JSON.parse(await readFile(path.join(directory,'pairing.json'),'utf8'));
  const extensionId='a'.repeat(32);
  const request=(route,value,headers={})=>fetch(runtime.address+route,{
    method:value===undefined?'GET':'POST',
    headers:{...(value===undefined?{}:{'Content-Type':'application/json'}),...headers},
    body:value===undefined?undefined:JSON.stringify(value)
  });
  const paired=await request('/pair',{code:pairing.code,extensionId});
  assert.equal(paired.status,200);
  const credential=await paired.json(),auth={Authorization:'Bearer '+credential.token,'X-CIP-Extension':extensionId};
  await runtime.store.transaction(d=>{d.catalog=validateCatalog(rawCatalog)});
  const broker=runtime.broker,s=await broker.create(selection);
  const opening=broker.configure(s.id,selection);opening.catch(()=>{});
  const oc=await until(()=>broker.queued().find(c=>c.kind==='open'));
  const oclaim=await broker.claim(oc.id,77,'document-77');
  await broker.result(oc.id,oclaim.lease,{config:selection,tabId:77,url:'https://chatgpt.com/'});
  await opening;
  const sent=await broker.prompt(s.id,'first','hello');
  const sc=broker.queued().find(c=>c.kind==='send');
  const claim=await broker.claim(sc.id,77,'document-77');
  await broker.authorize(sc.id,claim.lease);
  await broker.result(sc.id,claim.lease,{receipt:true,nativeMessageId:'native-first',
    config:selection,url:'https://chatgpt.com/c/chat-77'});
  const old={sessionId:s.id,turnId:sent.turnId,lease:claim.lease,
    tabId:77,documentKey:'document-77',nativeMessageId:'native-first',
    url:'https://chatgpt.com/c/chat-77'};
  await broker.observe({...old,kind:'snapshot',messageId:'prior-answer',text:'done'});
  await broker.observe({...old,kind:'completed',messageId:'prior-answer',finalConfirmed:true});
  assert.equal((await request('/bindings')).status,403);
  const list=await request('/bindings',undefined,auth);assert.equal(list.status,200);
  const bindings=(await list.json()).sessions;
  assert.equal(bindings.length,1);
  assert.equal(bindings[0].previousNativeMessageId,'native-first');
  const before=Object.values(runtime.store.read().commands).filter(c=>c.kind==='send').length;
  const proof={...bindings[0],nativeMessageId:'native-new',text:'Manual user prompt',
    url:'https://chatgpt.com/c/chat-77'};
  assert.equal((await request('/external-turn',proof)).status,403);
  const accepted=await request('/external-turn',proof,auth);assert.equal(accepted.status,200);
  const imported=await accepted.json();
  assert.equal(imported.imported,true);
  await until(()=>wake.includes(s.id));
  assert.equal((await request('/bindings',undefined,auth)).status,200);
  const again=await request('/external-turn',proof,auth);assert.equal((await again.json()).duplicate,true);
  assert.equal(wake.length,1);
  assert.equal(Object.values(runtime.store.read().commands).filter(c=>c.kind==='send').length,before);
  assert.equal(runtime.broker.snapshot(s.id).turn.origin,'browser');
  const live=(await (await request('/active',undefined,auth)).json()).sessions;
  assert.equal(live[0].nativeMessageId,'native-new');
});
