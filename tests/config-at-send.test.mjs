import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {fixture, selection} from './helpers.mjs';

const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const configB={model:'m2',thinkingOption:null,appIds:[]};

test('CATS-01 settings edited during authorized Send do not poison its genuine receipt',async t=>{
  const f=await fixture(t),s=await f.ready();
  const old=await f.sending(s,'original','hello',false);
  const oldCommand=f.store.read().commands[old.claim.id];
  await f.broker.saveSelection(s.id,configB);
  const changed=f.broker.snapshot(s.id);
  assert.deepEqual(changed.config,configB);
  assert.deepEqual(oldCommand.payload.config,selection);
  await f.broker.result(old.claim.id,old.claim.lease,{
    receipt:true,config:oldCommand.payload.config,
    url:old.event.url,nativeMessageId:'native-original'
  });
  assert.equal(f.broker.snapshot(s.id).turn.receivedAt>0,true);
  assert.equal(f.broker.snapshot(s.id).config.model,'m2');
  await f.view(s.id,{state:'standby'});
  await f.broker.prompt(s.id,'new-turn','next');
  const next=f.broker.queued().find(c=>c.kind==='send');
  assert.deepEqual(next.payload.config,configB);
  assert.equal(f.broker.queued().filter(c=>c.kind==='configure').length,0);
});

test('CATS-02 reserve message configuration before Browser wake or slot wait',async t=>{
  const f=await fixture(t),s=await f.ready();
  const id='frozen-turn',raw='exact user input',fp=fingerprint({text:raw});
  const reserved=await f.broker.reservePrompt(s.id,id,fp);
  assert.deepEqual(reserved.config,selection);
  await f.broker.saveSelection(s.id,configB);
  await f.broker.prompt(s.id,id,raw,{reservationFingerprint:fp});
  const send=f.broker.queued().find(c=>c.kind==='send');
  assert.deepEqual(send.payload.config,selection);
  assert.deepEqual(f.broker.snapshot(s.id).config,configB);
  const reply=await f.broker.prompt(s.id,id,raw);
  assert.equal(reply.replay,true);
  assert.equal(reply.turnId,send.payload.turnId);
  await assert.rejects(f.broker.prompt(s.id,id,'changed'),/MESSAGE_ID_CONFLICT/);
});

test('CATS-03 rejected early intent remains spent and cannot silently replay',async t=>{
  const f=await fixture(t),s=await f.ready();
  const id='aborted-before-chrome',fp=fingerprint({text:'never sent'});
  await f.broker.reservePrompt(s.id,id,fp);
  await f.broker.abandonPromptReservation(s.id,id,'CHROME_UNAVAILABLE');
  await assert.rejects(f.broker.reservePrompt(s.id,id,fp),/MESSAGE_ID_CONFLICT/);
  assert.equal(f.broker.queued().filter(c=>c.kind==='send').length,0);
});

test('CATS-04 legacy pendingConfig migration keeps old authorized command unchanged',async t=>{
  const f=await fixture(t),s=await f.ready();
  const old=await f.sending(s,'pre-upgrade','old',false);
  const frozen=structuredClone(f.store.read().commands[old.claim.id].payload.config);
  await f.store.transaction(d=>{d.sessions[s.id].pendingConfig=configB;});
  const reopened=await new Store(f.directory).open();
  assert.deepEqual(reopened.read().sessions[s.id].config,configB);
  assert.equal(reopened.read().sessions[s.id].pendingConfig,undefined);
  assert.deepEqual(reopened.read().commands[old.claim.id].payload.config,frozen);
});

test('CATS-05 failed and late receipts inspect each Send payload, not latest desired model',async t=>{
  const f=await fixture(t),s=await f.ready();
  const old=await f.sending(s,'unconfirmed','body',false);
  const previous=f.store.read().commands[old.claim.id];
  await f.broker.bindConversation(previous.id,old.claim.lease,{
    tabId:s.tabId,documentKey:s.documentKey,url:old.event.url
  });
  await f.broker.saveSelection(s.id,configB);
  await f.broker.result(previous.id,old.claim.lease,{
    error:'CONTENT_TIMEOUT',bindingUrl:old.event.url
  });
  const pending=f.store.read().commands[previous.id];
  assert.equal(pending.result?.receiptPending,true);
  assert.equal(f.broker.snapshot(s.id).turn.receiptPending,true);
  await f.broker.result(previous.id,old.claim.lease,{
    receipt:true,config:previous.payload.config,url:old.event.url,nativeMessageId:'late-real-user'
  });
  assert.equal(f.broker.snapshot(s.id).turn.receiptPending,false);
  assert.equal(f.broker.snapshot(s.id).turn.nativeMessageId,'late-real-user');
  assert.equal(f.broker.snapshot(s.id).config.model,'m2');
});
