import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const source=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
function harness() {
  const clock={now:10000}, sent=[],listeners={};
  const location={hostname:'chatgpt.com',pathname:'/c/chat-a',href:'https://chatgpt.com/c/chat-a'};
  let identity='missing', tick, handler;
  const extensionId='a'.repeat(32);
  const D={
    conversationId:()=>location.pathname.split('/')[2]??null,
    refreshTranscript:async()=>{},
    messages:()=>[],
    state:()=>{
      if(identity==='missing')throw Object.assign(new Error('TRANSCRIPT_PENDING'),{code:'TRANSCRIPT_PENDING'});
      if(identity==='working')return {busy:true,waiting:false,answer:null,images:[],imageFinalId:null,
        activity:{nativeStatus:'in_progress',steps:[]},error:null};
      return {busy:false,waiting:false,answer:{id:'native-answer-a',text:'answer',final:true},
        images:[],imageFinalId:null,activity:{nativeStatus:'complete',steps:[]},error:null};
    }
  };
  const ctx=vm.createContext({
    console,crypto:webcrypto,location,
    Date:class extends Date {static now(){return clock.now;}},
    performance:{now:()=>clock.now},setInterval:fn=>{tick=fn;return 1;},
    clearInterval:()=>{},addEventListener:(name,fn)=>{listeners[name]=fn;},
    document:{addEventListener:()=>{},removeEventListener:()=>{}},
    navigation:{addEventListener:(name,fn)=>{listeners[name]=fn;}},
    chrome:{runtime:{id:extensionId,onMessage:{addListener:fn=>handler=fn},
      sendMessage:async message=>{
        sent.push(message);return {ok:true,value:{accepted:true,active:true}};
      }}},
    CIP_DOM:D
  });
  vm.runInContext(source,ctx);
  const s={sessionId:'session-a',turnId:'turn-a',lease:'one-time-lease',tabId:71,
    documentKey:ctx.__CIP_CONTENT__.documentKey,conversationId:'chat-a',nativeMessageId:'native-user-a'};
  const send=(message)=>new Promise(resolve=>handler(message,{id:extensionId},resolve));
  return {clock,sent,listeners,location,s,send,tick:()=>tick(),changeState:value=>{identity=value;}};
}
test('NATIVE-GAP1 same document keeps monitoring when a tool hides the native user for >15 seconds',async()=>{
  const f=harness();
  assert.equal((await f.send({type:'monitor',session:f.s})).ok,true);
  await f.tick();f.clock.now+=19000;await f.tick();
  assert.ok(f.sent.every(e=>e.type==='observation'&&e.event.kind==='waiting'),
    'missing user ID may only produce waiting, never a fake final or failed turn');
  assert.equal(f.sent.length,1,'a repeated gap must not spam waiting notices');
  const identity=await f.send({type:'identity'});
  assert.equal(identity.value.nativeMessageId,null);
  assert.equal(identity.value.observationActive,true);
  f.changeState('finished');await f.tick();
  assert.equal(f.sent.filter(e=>e.type==='observation'&&e.event.kind==='snapshot').length,1);
  f.clock.now+=2000;await f.tick();
  assert.equal(f.sent.filter(e=>e.type==='observation'&&e.event.kind==='completed').length,1);
  assert.equal(f.sent.filter(e=>e.type==='command').length,0);
});
test('NATIVE-GAP2 A→B→A browser navigation invalidates a previously established monitor',async()=>{
  const f=harness();
  assert.equal((await f.send({type:'monitor',session:f.s})).ok,true);
  f.location.pathname='/c/chat-b';f.location.href='https://chatgpt.com/c/chat-b';
  f.listeners.currententrychange();
  f.location.pathname='/c/chat-a';f.location.href='https://chatgpt.com/c/chat-a';
  f.listeners.currententrychange();
  assert.equal((await f.send({type:'monitor',session:f.s})).error,'PAGE_IDENTITY_CHANGED');
  await f.tick();
  assert.equal(f.sent.filter(e=>e.type==='observation'&&e.event.kind==='failed').length,1);
});

test('NATIVE-GAP3 monitor heartbeat requires native in-progress evidence, not simply a live tab',async()=>{
  const f=harness();
  const unreadable=await f.send({type:'monitor',session:f.s});
  assert.equal(unreadable.ok,true);
  assert.equal(unreadable.value.active,false);
  f.changeState('working');
  const running=await f.send({type:'monitor',session:f.s});
  assert.equal(running.ok,true);
  assert.equal(running.value.active,true);
  f.changeState('finished');
  const finished=await f.send({type:'monitor',session:f.s});
  assert.equal(finished.ok,true);
  assert.equal(finished.value.active,false);
});
