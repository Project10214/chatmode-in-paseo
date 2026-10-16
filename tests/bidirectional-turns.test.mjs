import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,selection,until} from './helpers.mjs';
import {createProvider,CAPABILITIES} from '../server/provider.mjs';
import {createWakeCoordinator,sessionIdFromAgent} from '../server/wake.mjs';

const config={cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,
  model:'m1',thinkingOption:'standard',providerOptions:{appIds:['asdk_app_a']}};
const url=s=>`https://chatgpt.com/c/chat-${s.tabId}`;
async function completed(f,s){
  const sent=await f.sending(s,'original','Paseo prompt');
  await f.broker.observe({...sent.event,kind:'snapshot',messageId:'answer-before-browser',text:'Done'});
  await f.broker.observe({...sent.event,kind:'completed',messageId:'answer-before-browser',finalConfirmed:true});
  return f.broker.snapshot(s.id);
}
const external=s=>({
  sessionId:s.id,conversationId:s.conversationId,tabId:s.tabId,documentKey:s.documentKey,
  previousNativeMessageId:s.lastNativeMessageId,nativeMessageId:'native-from-browser-1',
  text:'Sent directly in the ChatGPT webpage',url:url(s)
});

test('TURN-A: a browser native user message starts Paseo autonomous events without issuing Send',async t=>{
  const f=await fixture(t),s=await completed(f,await f.ready());
  const runtime={broker:f.broker,store:f.store,status:()=>({connected:true})};
  const connection=await createProvider(runtime).connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>connection.close());
  const events=[];connection.onEvent(x=>events.push(x));
  await connection.send({type:'session.open',requestId:'resume',sessionId:'paseo-1',
    config,persistence:{version:1,data:{id:s.id}},history:'skip'});
  await until(()=>events.some(x=>x.type==='session.ready'));
  const count=Object.values(f.store.read().commands).filter(x=>x.kind==='send').length;
  const imported=await f.broker.importExternalTurn(external(s));
  assert.equal(imported.imported,true);
  assert.equal(f.broker.snapshot(s.id).status,'running');
  assert.equal(f.broker.snapshot(s.id).turn.origin,'browser');
  assert.deepEqual(events.filter(x=>x.type==='session.turn'&&x.state==='started').map(x=>x.turnId),[imported.turnId]);
  const user=events.find(x=>x.type==='timeline.item'&&x.item?.messageId==='native-from-browser-1');
  assert.equal(user?.item.text,external(s).text);
  assert.equal(user?.item.clientMessageId,undefined);
  assert.equal(Object.values(f.store.read().commands).filter(x=>x.kind==='send').length,count);
  await f.broker.observe({...imported,url:url(s),kind:'snapshot',messageId:'browser-answer',text:'Browser reply'});
  await f.broker.observe({...imported,url:url(s),kind:'completed',messageId:'browser-answer',finalConfirmed:true});
  assert.equal(f.broker.snapshot(s.id).status,'idle');
  assert.equal(f.broker.snapshot(s.id).turn.outcome,'completed');
  assert.equal(events.at(-1).type,'session.turn');
  assert.equal(events.at(-1).state,'completed');
  const again=await f.broker.importExternalTurn(external(s));
  assert.equal(again.duplicate,true);
  assert.equal(Object.values(f.store.read().commands).filter(x=>x.kind==='send').length,count);
  assert.equal(f.broker.idleBindings().find(x=>x.sessionId===s.id).previousNativeMessageId,'native-from-browser-1');
});

test('TURN-B: external turn enforces original conversation, exact anchor, owner and idle state',async t=>{
  const f=await fixture(t),s=await completed(f,await f.ready()),proof=external(s);
  for(const [change,code] of [
    [{url:'https://chatgpt.com/c/foreign'},'WRONG_CONVERSATION'],
    [{previousNativeMessageId:'foreign-user'},'EXTERNAL_ANCHOR_MISMATCH'],
    [{documentKey:''},'INVALID_TEXT'],
    [{text:''},'INVALID_TEXT']
  ])await assert.rejects(f.broker.importExternalTurn({...proof,...change}),e=>e.code===code);
  const other=await f.ready();
  await assert.rejects(f.broker.importExternalTurn({...proof,tabId:other.tabId}),
    e=>e.code==='TAB_ALREADY_OWNED');
  const first=await f.broker.importExternalTurn(proof);
  await assert.rejects(f.broker.importExternalTurn({...proof,nativeMessageId:'new-again'}),
    e=>e.code==='SESSION_BUSY');
  const duplicate=await f.broker.importExternalTurn(proof);
  assert.equal(duplicate.turnId,first.turnId);
});

test('TURN-C: running turn configuration is durable but only applied after native finish',async t=>{
  const f=await fixture(t),s=await f.ready();
  const turn=await f.sending(s,'active','text');
  const desired={...s.config,appIds:[]};
  await f.broker.stageConfiguration(s.id,desired);
  assert.deepEqual(f.broker.snapshot(s.id).config.appIds,['asdk_app_a']);
  assert.deepEqual(f.broker.snapshot(s.id).pendingConfig.appIds,[]);
  await f.broker.observe({...turn.event,kind:'snapshot',messageId:'confirmed',text:'Done'});
  await f.broker.observe({...turn.event,kind:'completed',messageId:'confirmed',finalConfirmed:true});
  await assert.rejects(f.broker.prompt(s.id,'should-not-send','text'),/CONFIGURATION_PENDING/);
  const apply=f.broker.configure(s.id,desired);apply.catch(()=>{});
  const command=await until(()=>f.broker.queued().find(x=>x.kind==='configure'&&x.sessionId===s.id));
  const claimed=await f.broker.claim(command.id,s.tabId,s.documentKey);
  await f.broker.result(command.id,claimed.lease,{config:desired,tabId:s.tabId,url:url(s)});
  await apply;
  assert.deepEqual(f.broker.snapshot(s.id).config.appIds,[]);
  assert.equal(f.broker.snapshot(s.id).pendingConfig,undefined);
});

test('TURN-D: native Paseo settings accept an active turn with next-turn tool selection',async t=>{
  const f=await fixture(t),s=await f.ready(),started=await f.sending(s);
  const runtime={broker:f.broker,store:f.store,status:()=>({connected:true})};
  const conn=await createProvider(runtime).connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>conn.close());
  const events=[];conn.onEvent(x=>events.push(x));
  await conn.send({type:'session.open',requestId:'reconnect',sessionId:'paseo',config,
    persistence:{version:1,data:{id:s.id}},history:'skip'});
  await until(()=>events.find(x=>x.type==='session.ready'));
  await conn.send({type:'session.configure',requestId:'change-apps',sessionId:'paseo',changes:{settings:{'app:quick':'none'}}});
  await until(()=>events.find(x=>x.type==='request.completed'&&x.requestId==='change-apps'));
  assert.deepEqual(f.broker.snapshot(s.id).pendingConfig.appIds,[]);
  assert.deepEqual(f.broker.snapshot(s.id).config.appIds,['asdk_app_a']);
  assert.equal(events.filter(x=>x.type==='session.config').at(-1).config.settings[0].value,'none');
  await f.broker.observe({...started.event,kind:'snapshot',messageId:'end',text:'Okay'});
  await f.broker.observe({...started.event,kind:'completed',messageId:'end',finalConfirmed:true});
  assert.equal(f.broker.snapshot(s.id).status,'idle');
});

test('TURN-E: host wake uses the existing Agent commands path, never an outbound chat prompt',async()=>{
  const sid='fb482e6c-2e0a-49d5-9e02-66f3ebf57747',agentId='agent-1';
  const agent={id:agentId,provider:'chatmode',archivedAt:null,
    persistence:{provider:'chatmode',sessionId:'plugin:'+JSON.stringify({version:1,data:{id:sid}})}};
  assert.equal(sessionIdFromAgent(agent),sid);
  assert.equal(sessionIdFromAgent({...agent,provider:'codex'}),null);
  let commands=0;
  const coordinator=createWakeCoordinator();
  const pending=await coordinator.wake(sid);
  assert.equal(pending.reason,'NO_HOST_CONTEXT');
  coordinator.adopt({agents:{
    list:async()=>({entries:[{agent}]}),
    ref:()=>({refresh:async()=>({agent}),commands:async()=>{commands++;return [];}})
  }});
  await until(()=>commands>=1);
  assert.equal((await coordinator.wake(sid)).woken,true);
  assert.equal(commands,2);
});

test('TURN-F: a cold Paseo Provider restores an imported browser turn by persistence',async t=>{
  const f=await fixture(t),s=await completed(f,await f.ready());
  // No Provider owns this session while the browser-origin turn arrives.
  const imported=await f.broker.importExternalTurn(external(s));
  assert.equal(f.broker.owners.has(s.id),false);
  const conn=await createProvider({broker:f.broker,store:f.store,status:()=>({connected:true})})
    .connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>conn.close());
  const events=[];conn.onEvent(e=>events.push(e));
  await conn.send({type:'session.open',requestId:'wake',sessionId:'paseo-recovered',
    config,persistence:{version:1,data:{id:s.id}},history:'skip'});
  await until(()=>events.some(e=>e.type==='session.ready'));
  assert.equal(events.filter(e=>e.type==='session.turn'&&e.turnId===imported.turnId&&e.state==='started').length,1);
  assert.equal(events.filter(e=>e.type==='timeline.item'&&e.item?.messageId==='native-from-browser-1').length,1);
  await f.broker.observe({...imported,url:url(s),kind:'snapshot',messageId:'recovered-answer',text:'Still working'});
  await f.broker.observe({...imported,url:url(s),kind:'completed',messageId:'recovered-answer',finalConfirmed:true});
  assert.equal(events.filter(e=>e.type==='session.turn'&&e.state==='completed').length,1);
  assert.equal(f.broker.snapshot(s.id).status,'idle');
  assert.equal(Object.values(f.store.read().commands).filter(x=>x.kind==='send').length,1);
});

test('TURN-G: switching pending tools back to active settings clears the deferred change',async t=>{
  const f=await fixture(t),s=await f.ready(),turn=await f.sending(s,'running','text');
  await f.broker.stageConfiguration(s.id,{...s.config,appIds:[]});
  assert.deepEqual(f.broker.snapshot(s.id).pendingConfig.appIds,[]);
  const cleared=await f.broker.stageConfiguration(s.id,s.config);
  assert.equal(cleared.pending,false);
  assert.equal(f.broker.snapshot(s.id).pendingConfig,undefined);
  await f.broker.observe({...turn.event,kind:'snapshot',messageId:'final',text:'done'});
  await f.broker.observe({...turn.event,kind:'completed',messageId:'final',finalConfirmed:true});
  const newTurn=await f.broker.prompt(s.id,'following','new');
  assert.ok(newTurn.turnId);
});
