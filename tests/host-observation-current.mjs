/** Current continuous-sync host gate against ORIGINAL Paseo host classes.
 * Run: CIP_PASEO_SERVER_PACKAGE=/path node --test tests/host-observation-current.mjs
 * Real AgentManager/PluginAgentClient/ensureAgentLoaded/listCommands barrier and
 * real CIP Provider/Broker on a temporary Store. Synthetic Send/observe frames
 * only; no daemon, Chrome, account, real Send/Stop or UI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { Broker } from '../server/broker.mjs';
import { errorLabel } from '../shared/ui-copy.mjs';
import { createProvider } from '../server/provider.mjs';
import { createHostObservation } from '../server/host-observation.mjs';
import { createWakeCoordinator } from '../server/wake.mjs';
import { validateCatalog } from '../server/protocol.mjs';
import { loadPaseoHost } from './fixtures/paseo-host-sources.mjs';
import { pageView, sourceItem } from './helpers.mjs';

const HOST = await loadPaseoHost(process.env.CIP_PASEO_SERVER_PACKAGE);
const { AgentManager, PluginAgentClientRegistry, ensureAgentLoaded, ProviderEventSchema } = HOST;
console.log(`# paseo host @getpaseo/server@${HOST.version} (pinned sources verified)`);

const noop = () => {};
const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child() { return logger; } };
const settle = async (manager, id) => { for (let i = 0; i < 4; i++) { await manager.drainSessionEvents(id); await Promise.resolve(); } };
const catalog = { defaultModel: 'm1', models: [{ id: 'm1', label: 'Model One', thinkingOptions: [] }], apps: [] };
const agentId = '0b0e1d2c-3a4b-4c5d-8e6f-708192a3b4c5';

async function world(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cip-host-barrier-'));
  const store = await new Store(directory).open();
  await store.transaction(d => { d.catalog = validateCatalog(catalog); });
  const broker = new Broker(store, {});
  const observation = createHostObservation();
  const runtime = { broker, store, status: () => ({ connected: true, paired: true }), chromeWake: async () => {} };
  const registration = createProvider(runtime, e => ProviderEventSchema.parse(e), { hostObservation: observation });
  const registry = new PluginAgentClientRegistry(logger); registry.replace([registration]);
  const client = registry.clients().chatmode;
  const newManager = () => new AgentManager({ logger, clients: { chatmode: client }, providerDefinitions: registry.definitions(), agentStreamCoalesceWindowMs: 0 });
  const state = { manager: null, handle: null, commandsFails: 0, beforeList: null, beforeRegister: null,
    calls: 0, holds: new Map() };
  const hookManager = manager => {
    manager.getRegisteredProviderIds ??= () => ['chatmode'];
    const register = manager.registerSession.bind(manager);
    // Runs after the provider's session.open completed but before the host subscribes.
    manager.registerSession = async (...args) => { if (state.beforeRegister) { const f = state.beforeRegister; state.beforeRegister = null; await f(); } return register(...args); };
    return manager;
  };
  state.manager = hookManager(newManager());
  const storage = { get: async id => id === agentId && state.handle ? { id, provider: 'chatmode', cwd: '/tmp', persistence: state.handle, labels: {}, config: {} } : null };
  // Emulation of session.js handleListCommandsRequest (0.11.4), calling the real ensureAgentLoaded.
  const commands = async () => {
    const call = ++state.calls;
    if (state.commandsFails > 0) { state.commandsFails--; throw new Error('daemon unavailable (synthetic)'); }
    const existing = state.manager.getAgent(agentId), stored = existing ? null : await storage.get(agentId);
    const agent = existing || stored ? await ensureAgentLoaded(agentId, { agentManager: state.manager, agentStorage: storage, logger }) : null;
    if (!agent?.session?.listCommands) return { agentId, commands: [], error: 'Agent not found: ' + agentId };
    if (state.beforeList) { const f = state.beforeList; state.beforeList = null; await f(); }
    const reply = { agentId, commands: await agent.session.listCommands(), error: null };
    const hold = state.holds.get(call); if (hold) await hold.promise; // reply delayed in transit
    return reply;
  };
  const holdCall = n => { let release; const promise = new Promise(r => { release = r; }); state.holds.set(n, { promise }); return release; };
  const paseo = { agents: {
    list: async () => ({ entries: state.handle ? [{ agent: { id: agentId, provider: 'chatmode', archivedAt: null, persistence: state.handle } }] : [] }),
    ref: () => ({ refresh: async () => ({ agent: { id: agentId, provider: 'chatmode', archivedAt: null, persistence: state.handle } }), commands }) } };
  const wake = createWakeCoordinator({ observation });
  // A second, independent host connection to the same Provider (e.g. after the
  // first one was closed). Same Broker/Store and the same observation.
  const secondClient = () => {
    const r = new PluginAgentClientRegistry(logger);
    r.replace([createProvider(runtime, e => ProviderEventSchema.parse(e), { hostObservation: observation })]);
    t.after(() => r.shutdown().catch(() => {}));
    return { client: r.clients().chatmode, manager: hookManager(new AgentManager({ logger, clients: { chatmode: r.clients().chatmode }, providerDefinitions: r.definitions(), agentStreamCoalesceWindowMs: 0 })) };
  };
  wake.adopt(paseo); // production: index.server host hooks adopt context.paseo before any session opens
  // In-process browser stand-in for the bootstrap open + one Send only.
  let stop = false; const answered = new Set(), loopErrors = [];
  const loop = (async () => { while (!stop) {
    for (const c of broker.queued()) {
      if (stop) break;
      try {
      // Stand-in for the bootstrap open, a later ensure and user-initiated Sends only.
      // Never answers stop: a Stop must not be produced at all in these tests.
      if (answered.has(c.id) || !['open', 'ensure', 'send'].includes(c.kind)) continue; answered.add(c.id);
      const claim = await broker.claim(c.id, 41, 'document-41', { url: 'https://chatgpt.com/c/chat-41' });
      if (c.kind === 'open') await broker.result(c.id, claim.lease, { config: c.payload.config, tabId: 41, url: 'https://chatgpt.com/' });
      else if (c.kind === 'ensure') await broker.result(c.id, claim.lease, { config: c.payload.config, tabId: 41, url: 'https://chatgpt.com/c/chat-41' });
      else { await broker.authorize(c.id, claim.lease); await broker.result(c.id, claim.lease, { receipt: true, config: c.payload.config, nativeMessageId: 'native-user-' + answered.size, url: 'https://chatgpt.com/c/chat-41' }); }
      } catch (error) { if (!stop) loopErrors.push(error); } // teardown may fail an in-flight synthetic Send
    }
    await new Promise(r => setImmediate(r));
  } })();
  t.after(async () => {
    stop = true; await loop; // never close the Broker under an in-flight stand-in step
    await registry.shutdown().catch(() => {}); await broker.close(); await rm(directory, { recursive: true, force: true });
    if (loopErrors.length) throw loopErrors[0]; // an error DURING the test is still a failure
  });
  return { store, broker, client, runtime, observation, wake, paseo, state, newManager: () => hookManager(newManager()), secondClient, holdCall };
}
const snapshot=(manager,id=agentId)=>{const a=manager.getAgent(id);return a&&{lifecycle:a.lifecycle,
  activeTurnId:a.activeTurnId??null,finalized:[...(a.finalizedForegroundTurnIds??[])],run:manager.runs.getRun(id)?.kind??null};};
// Public timeline page shape (session.js fetch_agent_timeline_response) built
// from the REAL AgentManager projection, so the production host reader and the
// delivery coordinator see actual host rows.
const projectedPage=(manager,id,options={})=>{
  const page=manager.fetchTimeline(id,{direction:'tail',limit:0,...options});
  return {agentId:id,projection:'projected',direction:'tail',epoch:page.epoch,
    reset:page.reset,staleCursor:page.staleCursor,gap:page.gap,window:page.window,
    hasOlder:page.hasOlder,hasNewer:page.hasNewer,
    startCursor:page.startSeq!=null?{epoch:page.epoch,seq:page.startSeq}:null,
    endCursor:page.endSeq!=null?{epoch:page.epoch,seq:page.endSeq}:null,
    entries:page.rows.map(row=>({item:row.item,seqStart:row.seqStart,seqEnd:row.seqEnd,
      sourceSeqRanges:row.sourceSeqRanges})),error:null};
};
const timelineText=w=>JSON.stringify(w.state.manager.getTimeline(agentId));
const hostBody=w=>w.state.manager.getTimeline(agentId).filter(e=>e.type==='assistant_message').map(e=>e.text??'').join('');
const nextPromptAccepted=async w=>{
  const seen=[];
  const run=(async()=>{for await(const e of w.state.manager.streamAgent(agentId,'next',{clientMessageId:'cm-next'})){seen.push(e);break;}})()
    .catch(e=>seen.push({type:'error',message:e.message}));
  await run;return seen.find(e=>e.type==='error')?.message??'accepted';
};
const waitUntil=async(w,fn,ms=5000)=>{const start=Date.now();while(Date.now()-start<ms){await settle(w.state.manager,agentId);if(fn())return true;await new Promise(r=>setTimeout(r,10));}return false;};
const withHostTimeline=w=>{
  const ref=w.paseo.agents.ref;
  const timeline=id=>({refetch:options=>projectedPage(w.state.manager,id,options)});
  w.paseo.agents.ref=id=>{
    const original=ref(id);
    const refresh=original.refresh;
    return {...original,id,timeline:timeline(id),refresh:async()=>{
      const result=await refresh();
      const agent=result?.agent;
      return agent?{...result,agent:{...agent,id,timeline:timeline(id)}}:result;
    }};
  };
  return w;
};


async function foreground(w,{holdBarrier=false}={}){
  let releaseBarrier=()=>{};
  if(holdBarrier)w.state.beforeList=async()=>{await new Promise(r=>{releaseBarrier=r;});};
  const session=await w.client.createSession({provider:'chatmode',cwd:'/tmp'});
  await w.state.manager.registerSession(session,{provider:'chatmode',cwd:'/tmp'},agentId,{historyPrimed:true});
  w.state.handle=session.describePersistence();
  const run=(async()=>{for await(const _ of w.state.manager.streamAgent(agentId,'hello',{clientMessageId:'cm-1'}));})().catch(()=>{});
  const received=()=>Object.values(w.store.read().sessions)[0]?.turn?.receivedAt;
  for(let i=0;i<800&&!received();i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(received(),'the browser stand-in confirmed the Send');
  const s=Object.values(w.store.read().sessions)[0];
  return {session,s,run,releaseBarrier:()=>releaseBarrier()};
}

test('HOST-CURRENT-1 a body waiting for the host barrier is delivered once after it; standby ends the run once',async t=>{
  const w=withHostTimeline(await world(t)),f=await foreground(w,{holdBarrier:true});
  await settle(w.state.manager,agentId);
  await w.broker.observeView(pageView(w.broker.snapshot(f.s.id),{state:'running',
    items:[sourceItem('answer','held body',{nativeMessageId:'native-answer'})]}));
  await settle(w.state.manager,agentId);
  assert.equal(timelineText(w).includes('held body'),false,'no body before the host barrier');
  f.releaseBarrier();
  assert.equal(await waitUntil(w,()=>timelineText(w).includes('held body')),true,'the body is delivered after the barrier');
  assert.equal(snapshot(w.state.manager)?.activeTurnId,f.s.turn.id,'the original Paseo turn id');
  assert.equal(timelineText(w).split('held body').length-1,1,'the held body is delivered exactly once');
  // Only the visible standby frame ends the host run; the body is not repeated.
  await w.broker.observeView(pageView(w.broker.snapshot(f.s.id),{state:'standby',
    items:[sourceItem('answer','held body',{nativeMessageId:'native-answer'})]}));
  assert.equal(await waitUntil(w,()=>snapshot(w.state.manager).lifecycle==='idle'),true,'standby ends the host run');
  assert.equal(timelineText(w).split('held body').length-1,1);
  assert.equal(await nextPromptAccepted(w),'accepted');
  await f.run;
});

test('HOST-CURRENT-2 a replaced host connection gets its own barrier; the old reply does not unlock it',async t=>{
  const w=withHostTimeline(await world(t));
  const releaseOld=w.holdCall(1); // first binding's commands() reply is delayed
  const f=await foreground(w);
  await settle(w.state.manager,agentId);
  await w.broker.observeView(pageView(w.broker.snapshot(f.s.id),{state:'running',
    items:[sourceItem('answer','after replace',{nativeMessageId:'native-answer'})]}));
  assert.equal(timelineText(w).includes('after replace'),false,'no delivery through the unconfirmed binding');
  // Replace the host connection: the old provider is closed (not a Stop) and a
  // new host instance attaches to the same Agent/Broker.
  await w.client.runtime.close();
  const second=w.secondClient();w.state.manager=second.manager;
  const releaseNew=w.holdCall(3); // the new binding's own commands() reply
  assert.equal((await w.wake.wake(f.s.id)).woken,true);
  await settle(w.state.manager,agentId);
  releaseOld();
  for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
  await settle(w.state.manager,agentId);
  assert.equal(timelineText(w).includes('after replace'),false,'the old barrier answer is not borrowed');
  releaseNew();
  assert.equal(await waitUntil(w,()=>timelineText(w).includes('after replace')),true,'the new barrier delivers');
  assert.equal(timelineText(w).split('after replace').length-1,1,'delivered once to the new connection');
  assert.equal(snapshot(w.state.manager)?.activeTurnId,f.s.turn.id);
  await f.run;
});

const waitFor=async(fn,ms=8000)=>{const start=Date.now();for(;;){const value=await fn();if(value)return value;if(Date.now()-start>ms)throw new Error('wait timed out');await new Promise(r=>setTimeout(r,10));}};

test('HOST-CURRENT-3 a host cancel stops the page and the visible tail is delivered once before the run ends',async t=>{
  const w=withHostTimeline(await world(t)),f=await foreground(w);
  // The first barrier can race session registration (AGENT_NOT_FOUND); the
  // host retry is the same explicit path used when the host API becomes ready.
  w.observation.hostAvailable();
  const frame=(state,text)=>w.broker.observeView(pageView(w.broker.snapshot(f.s.id),{state,
    items:[sourceItem('answer',text,{nativeMessageId:'native-answer'})]}));
  await frame('running','停止前');
  await waitUntil(w,()=>timelineText(w).includes('停止前'),8000);
  // Paseo-side cancel goes through the real AgentManager -> session.interrupt.
  const cancelling=w.state.manager.cancelAgentRun(agentId);cancelling.catch(()=>{});
  const stop=await waitFor(()=>w.broker.queued().find(c=>c.kind==='stop'));
  const claim=await w.broker.claim(stop.id,f.s.tabId,f.s.documentKey);
  await w.broker.result(stop.id,claim.lease,{stopped:true});
  // A click receipt alone never ends the run: the visible tail is still
  // captured, then the visible standby frame ends it.
  await frame('running','停止前可见的半段');
  await frame('standby','停止前可见的半段');
  const settled=await cancelling;
  assert.equal(settled.status,'settled');
  assert.equal(await waitUntil(w,()=>snapshot(w.state.manager).lifecycle==='idle'),true);
  assert.equal(await waitUntil(w,()=>hostBody(w)==='停止前可见的半段',8000),true,'the late visible tail reaches the host');
  assert.equal(hostBody(w),'停止前可见的半段','the host body is the visible prefix once, not duplicated');
  assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='stop').length,1);
  assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='send').length,1);
  await f.run;
});


test('HOST-CURRENT-4 a second prompt on the real host session waits and keeps the prior body once',async t=>{
  const w=withHostTimeline(await world(t)),f=await foreground(w);
  w.observation.hostAvailable();
  const frame=(state,text)=>w.broker.observeView(pageView(w.broker.snapshot(f.s.id),{state,
    items:[sourceItem('answer',text,{nativeMessageId:'native-answer'})]}));
  await frame('running','先到正文');
  assert.equal(await waitUntil(w,()=>hostBody(w)==='先到正文',8000),true,'the first body is delivered');
  // A second prompt is sent through the REAL host PluginAgentSession while the
  // first run is active. It must wait for this turn instead of racing it.
  const agent=w.state.manager.getAgent(agentId);
  const next=agent.session.startTurn('next',{clientMessageId:'cm-2'});
  next.catch(()=>{});
  await new Promise(r=>setTimeout(r,120));
  assert.equal(Object.values(w.store.read().commands).filter(c=>c.kind==='send').length,1,
    'no second Send while the first run is active');
  // Frames arriving while that prompt is pending are staged by the Provider
  // (binding.deferred); they must be replayed, never silently dropped.
  await frame('running','先到正文，后补尾');
  assert.equal(hostBody(w),'先到正文','the pending prompt does not duplicate or lose the delivered prefix');
  await frame('standby','先到正文，后补尾');
  await next;
  assert.equal(await waitUntil(w,()=>hostBody(w)==='先到正文，后补尾',8000),true,
    'the staged prior tail is replayed once after the pending prompt is accepted');
  assert.equal(await waitUntil(w,()=>Object.values(w.store.read().commands)
    .filter(c=>c.kind==='send').length===2,8000),true,'the queued prompt proceeds after standby');
  const sends=Object.values(w.store.read().commands).filter(c=>c.kind==='send');
  assert.equal(sends[1].payload.text.includes('next'),true,'the second Send is the new prompt');
  assert.equal(hostBody(w).split('先到正文，后补尾').length-1,1,'the prior body is not duplicated');
  await f.run;
});
