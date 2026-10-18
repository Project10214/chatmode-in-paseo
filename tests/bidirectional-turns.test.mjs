/** Deferred configuration across a running turn, and the host wake path.
 *
 * The old external-turn import lane (importExternalTurn / TURN-A/B/F) no longer
 * exists: a user message typed in the ChatGPT page is observed as a source and
 * a page run, never imported as a Paseo Send turn. Current coverage: CONTOBS-11
 * (a new visible Stop interval starts a page run without prompt_result or Send),
 * CPROV-05, and the HTTP wake test (one wake per new frame, no Send).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,until} from './helpers.mjs';
import {createProvider,CAPABILITIES} from '../server/provider.mjs';
import {createWakeCoordinator,sessionIdFromAgent} from '../server/wake.mjs';

const config={cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,
  model:'m1',thinkingOption:'standard',providerOptions:{appIds:['asdk_app_a']}};
const url=s=>`https://chatgpt.com/c/chat-${s.tabId}`;

test('TURN-C: running turn configuration is durable but only applied after the native run ends',async t=>{
  const f=await fixture(t),s=await f.ready();
  await f.sending(s,'active','text');
  const desired={...s.config,appIds:[]};
  await f.broker.stageConfiguration(s.id,desired);
  assert.deepEqual(f.broker.snapshot(s.id).config.appIds,['asdk_app_a']);
  assert.deepEqual(f.broker.snapshot(s.id).pendingConfig.appIds,[]);
  await f.view(f.broker.snapshot(s.id),{state:'standby'});
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
  const f=await fixture(t),s=await f.ready();await f.sending(s);
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
  await f.view(f.broker.snapshot(s.id),{state:'standby'});
  assert.equal(f.broker.snapshot(s.id).status,'idle');
  assert.equal(f.broker.snapshot(s.id).turn.outcome,'completed');
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

test('TURN-G: switching pending tools back to active settings clears the deferred change',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s,'running','text');
  await f.broker.stageConfiguration(s.id,{...s.config,appIds:[]});
  assert.deepEqual(f.broker.snapshot(s.id).pendingConfig.appIds,[]);
  const cleared=await f.broker.stageConfiguration(s.id,s.config);
  assert.equal(cleared.pending,false);
  assert.equal(f.broker.snapshot(s.id).pendingConfig,undefined);
  await f.view(f.broker.snapshot(s.id),{state:'standby'});
  const newTurn=await f.broker.prompt(s.id,'following','new');
  assert.ok(newTurn.turnId);
});
