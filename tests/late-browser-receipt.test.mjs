import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const content=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
const background=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');

function contentFixture(mode) {
  const url='https://chatgpt.com/c/chat-a', location={hostname:'chatgpt.com',pathname:'/c/chat-a',href:url};
  const id='a'.repeat(32),calls=[],navigationEvents={};let handler;
  const D={
    conversationId:()=>location.pathname.split('/')[2]??null,
    messages:()=>[],
    refreshTranscript:async()=>{},
    send:async()=>{
      calls.push('send');
      if(mode==='late')return {receipt:true,nativeMessageId:'native-exact-late',url};
      throw Object.assign(new Error('RECEIPT_UNCONFIRMED'),
        {code:'RECEIPT_UNCONFIRMED',bindingUrl:url});
    },
    probePendingReceipt:async()=>({available:true,nativeMessageId:'native-recovered-after-wait'})
  };
  const ctx=vm.createContext({crypto:webcrypto,location,console,
    setInterval:()=>1,clearInterval:()=>{},addEventListener:()=>{},removeEventListener:()=>{},
    navigation:{addEventListener:(name,fn)=>{(navigationEvents[name]??=[]).push(fn);},
      removeEventListener:(name,fn)=>{navigationEvents[name]=(navigationEvents[name]??[]).filter(f=>f!==fn);}},
    chrome:{runtime:{id,onMessage:{addListener:fn=>handler=fn},
      sendMessage:async()=>({ok:true,value:{authorized:true}})}},
    CIP_DOM:D});
  vm.runInContext(content,ctx);
  const send=message=>new Promise(resolve=>handler(message,{id},resolve));
  const command={id:'one-shot',kind:'send',documentKey:ctx.__CIP_CONTENT__.documentKey,
    lease:'one-time-lease',deadline:Date.now()+10000,
    payload:{turnId:'turn-a',conversationId:'chat-a',text:'body',config:{}}};
  const pending={sessionId:'session-a',turnId:'turn-a',conversationId:'chat-a',
    documentKey:command.documentKey,receiptPending:true};
  const navigate=route=>{
    location.pathname='/c/'+route;location.href='https://chatgpt.com'+location.pathname;
    for(const fn of navigationEvents.currententrychange??[])fn();
  };
  const samePageEvent=()=>{
    for(const fn of navigationEvents.currententrychange??[])fn();
  };
  return {calls,send,command,pending,navigate,samePageEvent};
}

test('LATE-1 content retains genuine native proof even if the caller has stopped awaiting the command',async()=>{
  const f=contentFixture('late');
  const receipt=await f.send({type:'command',command:f.command});
  assert.equal(receipt.ok,true);
  assert.equal(receipt.value.nativeMessageId,'native-exact-late');
  const late=await f.send({type:'pending-receipt',session:f.pending});
  assert.equal(late.ok,true);
  assert.equal(late.value.nativeMessageId,'native-exact-late');
  assert.deepEqual(f.calls,['send'],'no second native Send');
});
test('LATE-2 same document can recover unconfirmed native identity, not an invented browser delivery',async()=>{
  const f=contentFixture('unconfirmed');
  const error=await f.send({type:'command',command:f.command});
  assert.equal(error.ok,false);
  assert.equal(error.error,'RECEIPT_UNCONFIRMED');
  const probe=await f.send({type:'pending-receipt',session:f.pending});
  assert.equal(probe.ok,true);
  assert.equal(probe.value.nativeMessageId,'native-recovered-after-wait');
  assert.deepEqual(f.calls,['send']);
});
test('LATE-3 route A→B→A cannot borrow a cached late Send receipt',async()=>{
  const f=contentFixture('late');
  await f.send({type:'command',command:f.command});
  f.navigate('chat-b');f.navigate('chat-a');
  const reply=await f.send({type:'pending-receipt',session:f.pending});
  assert.equal(reply.ok,false);
  assert.equal(reply.error,'PAGE_IDENTITY_CHANGED');
  assert.deepEqual(f.calls,['send']);
});
test('LATE-4 route A→B→A cannot resume unconfirmed Send observation',async()=>{
  const f=contentFixture('unconfirmed');
  await f.send({type:'command',command:f.command});
  f.navigate('chat-b');f.navigate('chat-a');
  const reply=await f.send({type:'pending-receipt',session:f.pending});
  assert.equal(reply.ok,false);
  assert.equal(reply.error,'TRANSCRIPT_UNCONFIRMED');
  assert.deepEqual(f.calls,['send']);
});

test('LATE-5 timed-out authorized Send does not send a destructive cancel-command',async()=>{
  const calls=[];let callHandler;
  const ignore=()=>{};
  const ctx=vm.createContext({URL,console,structuredClone,AbortSignal,
    setTimeout,clearTimeout,crypto:webcrypto,
    chrome:{runtime:{id:'a'.repeat(32),getURL:()=>'',onMessage:{addListener:fn=>callHandler=fn},
      onInstalled:{addListener:ignore},onStartup:{addListener:ignore}},
      tabs:{sendMessage:async (_tab,m)=>{
        calls.push(m);
        if(m.type==='cancel-command')return {ok:true};
        return await new Promise(()=>{});
      },onRemoved:{addListener:ignore}},
      alarms:{onAlarm:{addListener:ignore},create:ignore},
      storage:{local:{},session:{}}
    }
  });
  vm.runInContext(background.replace(/\nvoid pump\(\);\s*$/,'')+
    '\nglobalThis.testSend=tabRpc;',ctx);
  await assert.rejects(ctx.testSend(71,{type:'command',command:{id:'send-id',kind:'send'}},12),/CONTENT_TIMEOUT/);
  assert.equal(calls.filter(m=>m.type==='cancel-command').length,0);
  await assert.rejects(ctx.testSend(71,{type:'command',command:{id:'prepare-id',kind:'configure'}},12),/CONTENT_TIMEOUT/);
  assert.equal(calls.filter(m=>m.type==='cancel-command').length,1);
  assert.equal(calls.at(-1).id,'prepare-id');
});
test('LATE-6 harmless same-page navigation event preserves exact late native receipt',async()=>{
  const f=contentFixture('late');
  await f.send({type:'command',command:f.command});
  f.samePageEvent();
  const reply=await f.send({type:'pending-receipt',session:f.pending});
  assert.equal(reply.ok,true,JSON.stringify(reply));
  assert.equal(reply.value.nativeMessageId,'native-exact-late');
  assert.deepEqual(f.calls,['send']);
});
test('LATE-7 harmless same-page event preserves pending receipt reconciliation',async()=>{
  const f=contentFixture('unconfirmed');
  await f.send({type:'command',command:f.command});
  f.samePageEvent();
  const reply=await f.send({type:'pending-receipt',session:f.pending});
  assert.equal(reply.ok,true,JSON.stringify(reply));
  assert.equal(reply.value.nativeMessageId,'native-recovered-after-wait');
  assert.deepEqual(f.calls,['send']);
});
test('LATE-8 same-page event while reading identity does not destroy live binding',async()=>{
  const f=contentFixture('late');
  const pending=f.send({type:'identity'});
  f.samePageEvent();
  const reply=await pending;
  assert.equal(reply.ok,true,JSON.stringify(reply));
  assert.equal(reply.value.url,'https://chatgpt.com/c/chat-a');
});
/* Retired: external-candidate discovery and its async identity wait.
 * The external-turn RPC no longer exists (MON-23 rejects it); browser-origin
 * runs are observed sources. A→B→A route identity is still enforced and is
 * covered by LATE-3/LATE-4 above plus MON-11/MON-12. */