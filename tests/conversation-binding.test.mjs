import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.mjs';

test('LINK1 a newly established /c/ URL binds before a native send receipt',async t=>{
  const f=await fixture(t),s=await f.ready(),{claim}=await f.sending(s,'first-id','first message',false);
  const url=`https://chatgpt.com/c/chat-${s.tabId}`;
  const bound=await f.broker.bindConversation(claim.id,claim.lease,{tabId:s.tabId,documentKey:s.documentKey,url});
  assert.equal(bound.conversationId,`chat-${s.tabId}`);
  const snapshot=f.broker.snapshot(s.id);
  assert.equal(snapshot.conversationId,bound.conversationId);
  assert.equal(snapshot.turn.nativeMessageId,undefined,'binding is NOT a send receipt');
  assert.equal(snapshot.turn.receivedAt,undefined);
  assert.equal(snapshot.status,'sending');
});
test('LINK2 failed send preserves conversation URL, accepts only a NEW prompt and does not replay old Send',async t=>{
  const f=await fixture(t),s=await f.ready(),{claim}=await f.sending(s,'first-id','first message',false);
  const url=`https://chatgpt.com/c/chat-${s.tabId}`;
  await f.broker.result(claim.id,claim.lease,{error:'RECEIPT_UNCONFIRMED',bindingUrl:url});
  const failed=f.broker.snapshot(s.id);
  assert.equal(failed.status,'idle');
  assert.equal(failed.conversationId,`chat-${s.tabId}`);
  assert.equal(failed.turn.outcome,'failed');
  assert.equal(failed.turn.receivedAt,undefined);
  await assert.rejects(f.broker.prompt(s.id,'first-id','changed message'),/MESSAGE_ID_CONFLICT/);
  const ensured=f.broker.ensurePage(s.id);ensured.catch(()=>{});
  const ensure=await (async()=>{for(let i=0;i<100;i++){const c=f.broker.queued().find(x=>x.kind==='ensure');if(c)return c;await new Promise(r=>setTimeout(r,5));}throw Error('no ensure');})();
  assert.equal(ensure.payload.previousNativeMessageId,null);
  const ack=await f.broker.claim(ensure.id,s.tabId,s.documentKey,{url});
  await f.broker.result(ensure.id,ack.lease,{config:s.config,tabId:s.tabId,url,nativeMessageId:null});
  await ensured;
  const next=await f.broker.prompt(s.id,'new-id','new message');
  assert.equal(next.replay,false);
  const queue=f.broker.queued().filter(c=>c.kind==='send');
  assert.equal(queue.length,1);
  assert.equal(queue[0].payload.text,'new message');
  assert.equal(queue[0].payload.conversationId,failed.conversationId);
});
test('LINK3 wrong lease, tab, document and route cannot bind a foreign conversation',async t=>{
  const f=await fixture(t),s=await f.ready(),{claim}=await f.sending(s,'first-id','text',false);
  const good={tabId:s.tabId,documentKey:s.documentKey,url:'https://chatgpt.com/c/chat-101'};
  for(const args of [
    {lease:'bad',proof:good},
    {lease:claim.lease,proof:{...good,tabId:999}},
    {lease:claim.lease,proof:{...good,documentKey:'other'}},
    {lease:claim.lease,proof:{...good,url:'https://example.org/c/chat-101'}}
  ])await assert.rejects(f.broker.bindConversation(claim.id,args.lease,args.proof));
  assert.equal(f.broker.snapshot(s.id).conversationId,null);
  await f.broker.bindConversation(claim.id,claim.lease,good);
  await assert.rejects(f.broker.bindConversation(claim.id,claim.lease,{...good,url:'https://chatgpt.com/c/other'}),/WRONG_CONVERSATION/);
});
test('LINK4 confirmed send followed by binding loss ends one turn but retains its usable link',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  await f.broker.observe({...event,kind:'binding_lost',diagnostic:{stage:'binding',reason:'message_unavailable'}});
  const state=f.broker.snapshot(s.id);
  assert.equal(state.status,'idle');
  assert.equal(state.error,'BROWSER_BINDING_LOST');
  assert.equal(state.turn.outcome,'failed');
  assert.equal(state.conversationId,'chat-'+s.tabId);
  assert.equal(f.broker.queued().length,0);
});

test('LINK5 authenticated browser heartbeat keeps a linked running turn beyond its nominal timeout',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  const old=Date.now()-4*60*60*1000;
  await f.store.transaction(d=>{d.sessions[s.id].turn.createdAt=old;});
  await f.broker.observe({...event,kind:'heartbeat'});
  await f.broker.tick(Date.now());
  assert.equal(f.broker.snapshot(s.id).status,'running');
  assert.ok(f.broker.snapshot(s.id).turn.lastObservedAt>old);
  assert.equal(f.broker.queued().length,0);
});
test('LINK6 a foreign tab cannot renew a turn by pretending to be alive',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  for(const patch of [{tabId:900},{documentKey:'wrong'},{lease:'wrong'},{url:'https://chatgpt.com/c/other'}])
    await assert.rejects(f.broker.observe({...event,...patch,kind:'heartbeat'}));
  assert.equal(f.broker.snapshot(s.id).turn.lastObservedAt,undefined);
});
test('LINK7 after an uncertain second prompt, Ensure must not demand the stale first native user ID',async t=>{
  const f=await fixture(t),s=await f.ready(),first=await f.sending(s,'first','hello');
  await f.broker.observe({...first.event,kind:'snapshot',messageId:'first-answer',text:'hello'});
  await f.broker.observe({...first.event,kind:'completed',finalConfirmed:true,messageId:'first-answer'});
  const later=await f.sending(f.broker.snapshot(s.id),'second','new',false);
  await f.broker.result(later.claim.id,later.claim.lease,{error:'RECEIPT_UNCONFIRMED',
    bindingUrl:'https://chatgpt.com/c/chat-'+s.tabId});
  const waiting=f.broker.ensurePage(s.id);waiting.catch(()=>{});
  let ensure;
  for(let i=0;i<100;i++){
    ensure=f.broker.queued().find(c=>c.kind==='ensure');
    if(ensure)break;
    await new Promise(r=>setTimeout(r,5));
  }
  assert.ok(ensure);
  assert.equal(ensure.payload.previousNativeMessageId,null);
  const claim=await f.broker.claim(ensure.id,s.tabId,s.documentKey,{
    url:'https://chatgpt.com/c/chat-'+s.tabId});
  await f.broker.result(ensure.id,claim.lease,{config:s.config,tabId:s.tabId,
    url:'https://chatgpt.com/c/chat-'+s.tabId,nativeMessageId:null});
  await waiting;
});

test('LINK8 a previous-version blocked session with a saved URL remains recoverable by explicit new user intent',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s,'old','old content');
  await f.store.transaction(d=>{
    const old=d.sessions[s.id];
    old.status='blocked';old.error='BROWSER_BINDING_LOST';
    old.turn.outcome='failed';old.prompts.old.outcome='failed';
  });
  await f.broker.prepareContinuation(s.id);
  const restored=f.broker.snapshot(s.id);
  assert.equal(restored.status,'idle');
  assert.equal(restored.conversationId,'chat-'+s.tabId);
  assert.equal(restored.turn.outcome,'failed');
  assert.equal(restored.history.filter(x=>x.type==='user_message').length,1);
  assert.equal(f.broker.queued().length,0);
});

test('LINK9 a failed Stop retains its verified native user ID for safe closed-tab reopening',async t=>{
  const f=await fixture(t),s=await f.ready();
  await f.sending(s,'confirmed','user message');
  await f.broker.failTurn(s.id,'STOP_UNCONFIRMED',true);
  const failed=f.broker.snapshot(s.id);
  assert.equal(failed.status,'idle');
  assert.equal(failed.turn.outcome,'failed');
  assert.equal(failed.turn.nativeMessageId,'native-confirmed');

  const resuming=f.broker.ensurePage(s.id);void resuming.catch(()=>{});
  const ensure=await until(()=>f.broker.queued().find(c=>c.kind==='ensure'&&c.sessionId===s.id));
  assert.equal(ensure.payload.previousNativeMessageId,'native-confirmed');
  const url='https://chatgpt.com/c/chat-'+s.tabId;
  const claim=await f.broker.claim(ensure.id,900,'reloaded-document',{
    reopened:true,url,nativeMessageId:'native-confirmed'
  });
  await f.broker.result(ensure.id,claim.lease,{
    config:s.config,tabId:900,url,nativeMessageId:'native-confirmed'
  });
  await resuming;
  assert.equal(f.broker.snapshot(s.id).tabId,900);
  assert.equal(f.store.read().sessions[s.id].history.filter(x=>x.type==='user_message').length,1);
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
});

test('LINK10 generic observation loss still clears its potentially stale reopen anchor',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s,'observed','message');
  await f.broker.observe({...event,kind:'binding_lost',diagnostic:{stage:'binding',reason:'page_closed'}});
  const resuming=f.broker.ensurePage(s.id);void resuming.catch(()=>{});
  const ensure=await until(()=>f.broker.queued().find(c=>c.kind==='ensure'&&c.sessionId===s.id));
  assert.equal(ensure.payload.previousNativeMessageId,null);
  await f.broker.failUnclaimed(ensure.id,'PAGE_CLOSED');
  await assert.rejects(resuming,/PAGE_CLOSED/);
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
});

test('LINK11 a browser-origin Stop failure preserves its own proven user ID on reopen',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s,'seed','seed');
  await f.broker.observe({...event,kind:'snapshot',messageId:'answer-seed',text:'completed'});
  await f.broker.observe({...event,kind:'completed',messageId:'answer-seed',finalConfirmed:true});
  const settled=f.broker.snapshot(s.id),url='https://chatgpt.com/c/'+settled.conversationId;
  const imported=await f.broker.importExternalTurn({
    sessionId:s.id,conversationId:settled.conversationId,tabId:settled.tabId,
    documentKey:settled.documentKey,previousNativeMessageId:'native-seed',
    nativeMessageId:'web-new-native-user',text:'from webpage',url
  });
  assert.equal(imported.imported,true);
  assert.equal(f.broker.snapshot(s.id).turn.origin,'browser');
  await f.broker.failTurn(s.id,'STOP_UNCONFIRMED',true,imported.turnId);
  const resuming=f.broker.ensurePage(s.id);void resuming.catch(()=>{});
  const ensure=await until(()=>f.broker.queued().find(c=>c.kind==='ensure'&&c.sessionId===s.id));
  assert.equal(ensure.payload.previousNativeMessageId,'web-new-native-user');
  await f.broker.failUnclaimed(ensure.id,'PAGE_CLOSED');
  await assert.rejects(resuming,/PAGE_CLOSED/);
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
});
