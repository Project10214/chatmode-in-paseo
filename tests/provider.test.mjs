import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';
import { fixture, selection, until, sourceItem } from './helpers.mjs';
const config = { cwd: '/example/project', env: {}, settings: {}, mcpServers: {}, persist: true, model: 'm1', thinkingOption: 'standard', providerOptions: { appIds: ['asdk_app_a'] } };
async function context(t) {
  const f = await fixture(t); const runtime = { ...f, status: () => ({ connected: true }) };
  const provider = createProvider(runtime); const connection = await provider.connect({ versions: [1], capabilities: CAPABILITIES });
  const events = []; connection.onEvent(e => events.push(e)); let tab = 300;
  t.after(() => connection.close());
  async function answerCommand(kind, result) {
    const c = await until(() => f.broker.queued().find(c => !kind || c.kind === kind));
    const tabId = c.payload.tabId ?? ++tab; const doc = `doc-${tabId}`;
    const claim = await f.broker.claim(c.id, tabId, doc, {url:'https://chatgpt.com/',nativeMessageId:c.payload.previousNativeMessageId});
    await f.broker.result(c.id, claim.lease, result ?? { config: c.payload.config, tabId, url: 'https://chatgpt.com/' });
    return claim;
  }
  async function open(hostId = 'host-one', extra = {}) {
    await connection.send({ type: 'session.open', requestId: 'open-'+hostId, sessionId: hostId, config, history: 'skip', ...extra });
    await until(() => events.find(e => e.type === 'session.ready' && e.sessionId === hostId));
    const id = events.find(e => e.type === 'session.opened' && e.sessionId === hostId).persistence.data.id;
    // This fixture represents an already-open browser. New lazy-opening tests cover first-send creation.
    const configured = f.broker.configure(id, f.broker.snapshot(id).config);
    await answerCommand('open'); await configured;
    return id;
  }
  return { ...f, runtime, provider, connection, events, answerCommand, open };
}
test('direct provider negotiates only implemented capabilities', async t => {
  const f = await context(t); const c = await f.provider.connect({ versions: [1, 2], capabilities: ['prompt.message', 'prompt.image', 'permission.tool_policy'] });
  assert.deepEqual(c.capabilities, ['prompt.message','prompt.image']); await c.close(); await assert.rejects(f.provider.connect({ versions: [2], capabilities: [] }), /PROTOCOL_UNSUPPORTED/);
});
test('legacy blocked first-page control restores same Paseo Agent, then accepts only a new prompt', async t => {
  const f=await context(t);
  const original=await f.broker.create(selection);
  await f.store.transaction(d=>{
    d.sessions[original.id].status='blocked';
    d.sessions[original.id].error='CONTROL_UNCONFIRMED';
  });
  await f.connection.send({type:'session.open',requestId:'legacy-open',sessionId:'legacy-agent',
    config,persistence:{version:1,data:{id:original.id}},history:'skip'});
  await until(()=>f.events.some(e=>e.type==='session.ready'&&e.sessionId==='legacy-agent'));
  assert.equal(f.events.find(e=>e.type==='session.opened'&&e.sessionId==='legacy-agent').persistence.data.id,original.id);
  assert.equal(f.broker.snapshot(original.id).status,'idle');
  await f.connection.send({type:'session.prompt',sessionId:'legacy-agent',prompt:{
    clientMessageId:'only-new-id',delivery:'auto',input:{type:'message',content:[{type:'text',text:'NEW_SENT_ONCE'}]}
  }});
  await f.answerCommand('open');
  const queued=await until(()=>f.broker.queued().find(c=>c.kind==='send'&&c.sessionId===original.id));
  assert.equal(queued.payload.text.includes('NEW_SENT_ONCE'),true);
  assert.equal(f.store.read().commands[queued.id].phase,'queued');
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send'&&c.sessionId===original.id).length,1);
  assert.equal(f.broker.snapshot(original.id).turn.clientMessageId,'only-new-id');
  await f.broker.interrupt(original.id);
});
test('native Paseo config exposes one quick tool select and no extra composer sliders', async t => {
  const f=await context(t); await f.open();
  const conf=f.events.find(e=>e.type==='session.config');
  assert.equal(conf.config.model,'m1');
  assert.equal(conf.config.settings.length,1);
  const tool=conf.config.settings[0];
  assert.equal(tool.type,'select'); assert.equal(tool.id,'app:quick');
  assert.equal(tool.value,'app:asdk_app_a');
  assert(tool.options.some(x=>x.value==='app:asdk_app_b'));
  assert(tool.options.some(x=>x.value==='none'));
  assert(!tool.options.some(x=>/^add:|^remove:/.test(x.value)));
  assert(f.events.findIndex(e=>e.type==='session.config')<f.events.findIndex(e=>e.type==='session.ready'));
});
test('Paseo MCP configs are refused rather than silently exposed or ignored', async t => {
  const f = await context(t); await f.connection.send({ type: 'session.open', requestId: 'bad-mcp', sessionId: 'mcp', config: { ...config, mcpServers: { x: { type: 'stdio', command: 'danger' } } }, history: 'skip' });
  const error = await until(() => f.events.find(e => e.type === 'request.failed')); assert.equal(error.error.code, 'MCP_CONFIG_UNSUPPORTED'); assert.equal(f.broker.queued().length, 0);
});
test('duplicate prompts emit one disposition and one started turn', async t => {
  const f = await context(t); const sid=await f.open();
  const input = { type: 'session.prompt', sessionId: 'host-one', prompt: { clientMessageId: 'same', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hello' }] } } };
  await f.connection.send(input); await f.connection.send(input);
  await f.answerCommand('ensure'); // Existing browser is now verified before a new turn.
  await until(()=>f.broker.queued().some(c=>c.kind==='send'));
  const {command,claim,event}=await f.dispatchSend(sid);
  await f.broker.result(command.id,claim.lease,{receipt:true,config:command.payload.config,
    url:event.url,nativeMessageId:'native-same'});
  await until(() => f.events.find(e => e.type === 'session.turn')); await new Promise(r => setTimeout(r, 30));
  assert.equal(f.events.filter(e => e.type === 'session.prompt_result').length, 1); assert.equal(f.events.filter(e => e.type === 'session.turn' && e.state === 'started').length, 1);
  await f.connection.send({ type: 'session.interrupt', sessionId: 'host-one', requestId: 'stop' });
  const stop=await until(()=>f.broker.queued().find(c=>c.kind==='stop'));
  const stopped=await f.broker.claim(stop.id,claim.tabId,claim.documentKey);
  await f.broker.result(stop.id,stopped.lease,{stopped:true});
  await f.view(sid,{state:'standby'});
  await until(()=>f.events.some(e=>e.type==='request.completed'&&e.requestId==='stop'));
  assert.equal(f.events.filter(e=>e.type==='session.turn'&&e.state==='completed').length,1,
    'confirmed standby closes the interval; a Stop request alone never does');
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
});
test('Chrome recovery queues only a NEW prompt until previous native turn completes',async t=>{
  const f=await context(t), sid=await f.open();
  const prior=await f.sending(f.broker.snapshot(sid),'old-client-message','OLD_DO_NOT_RESEND',true);
  assert.equal(f.broker.snapshot(sid).status,'running');
  await f.connection.send({type:'session.prompt',sessionId:'host-one',prompt:{
    clientMessageId:'new-after-chrome-quit',delivery:'auto',
    input:{type:'message',content:[{type:'text',text:'NEW_ONCE_AFTER_PRIOR'}]}
  }});
  await until(()=>f.events.some(e=>e.type==='session.notice'&&e.notice?.id==='native-prior-turn'&&!e.notice.dismissed));
  assert.equal(f.broker.queued().filter(c=>c.kind==='ensure'||c.kind==='send').length,0,
    'new prompt waits without reserving or sending while old turn is running');
  assert.equal(f.broker.snapshot(sid).turn.clientMessageId,'old-client-message');
  await f.view(sid,{state:'standby',items:[sourceItem('old-answer','old result',{nativeMessageId:'native-old-answer'})]});
  const ensure=await until(()=>f.broker.queued().find(c=>c.kind==='ensure'));
  const before=f.broker.snapshot(sid),url='https://chatgpt.com/c/'+before.conversationId;
  const claimed=await f.broker.claim(ensure.id,before.tabId,before.documentKey,{url});
  await f.broker.result(ensure.id,claimed.lease,{config:before.config,tabId:before.tabId,url});
  const next=await until(()=>f.broker.queued().find(c=>c.kind==='send'));
  assert.equal(next.payload.text.includes('NEW_ONCE_AFTER_PRIOR'),true);
  assert.equal(next.payload.text.includes('OLD_DO_NOT_RESEND'),false);
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send'&&c.payload.turnId===next.payload.turnId).length,1);
  await f.broker.interrupt(sid);
});
test('stopping a waiting new prompt never sends it or replays the previous native turn',async t=>{
  const f=await context(t),sid=await f.open();
  const prior=await f.sending(f.broker.snapshot(sid),'old-before-stop','ORIGINAL_MESSAGE',true);
  await f.view(sid,{state:'running'});
  await f.connection.send({type:'session.prompt',sessionId:'host-one',prompt:{
    clientMessageId:'waiting-then-stop',delivery:'auto',
    input:{type:'message',content:[{type:'text',text:'NEVER_SEND_AFTER_STOP'}]}
  }});
  await until(()=>f.events.some(e=>e.type==='session.notice'&&e.notice?.id==='native-prior-turn'&&!e.notice.dismissed));
  await f.connection.send({type:'session.interrupt',sessionId:'host-one',requestId:'stop-waiting'});
  const failed=await until(()=>f.events.find(e=>e.type==='session.prompt_result'&&e.clientMessageId==='waiting-then-stop'));
  assert.equal(failed.result.type,'failed');
  assert.equal(failed.result.error.code,'SEND_CANCELLED');
  const stop=await until(()=>f.broker.queued().find(c=>c.kind==='stop'));
  const claimed=await f.broker.claim(stop.id,prior.event.tabId,prior.event.documentKey);
  await f.broker.result(stop.id,claimed.lease,{stopped:true,nativeMessageId:prior.event.nativeMessageId});
  await until(()=>f.events.some(e=>e.type==='request.completed'&&e.requestId==='stop-waiting'));
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send'&&c.payload.text?.includes('NEVER_SEND_AFTER_STOP')).length,0);
});
test('a second provider connection cannot steal an attached native session', async t => {
  const f = await context(t); const id = await f.open(); const previousTab = f.broker.snapshot(id).tabId;
  const other = await f.provider.connect({ versions: [1], capabilities: CAPABILITIES }); const events = []; other.onEvent(e => events.push(e));
  await other.send({ type: 'session.open', requestId: 'steal', sessionId: 'other', config, persistence: { version: 1, data: { id } }, history: 'skip' });
  const error = await until(() => events.find(e => e.type === 'request.failed')); assert.equal(error.error.code, 'SESSION_ALREADY_ATTACHED');
  assert.equal(f.broker.snapshot(id).tabId, previousTab); await other.close();
});
test('provider rejects non-implemented input operations at admission', async t => {
  const f = await context(t); await assert.rejects(f.connection.send({ type: 'session.revert', requestId: 'revert', sessionId: 'none' }), /CAPABILITY_UNSUPPORTED/);
});
test('closing a connection prevents queued work from opening tabs afterwards', async t => {
  const f = await context(t); await f.connection.close(); await assert.rejects(f.connection.send({ type: 'catalog', requestId: 'late' }), /CONNECTION_CLOSED/); assert.equal(f.broker.queued().length, 0);
});
test('model changes choose that models own default, not an old thinking value', async t => {
  const f = await context(t); await f.open(); await f.connection.send({ type: 'session.configure', requestId: 'config2', sessionId: 'host-one', changes: { model: 'm2' } });
  const c = await f.answerCommand('configure'); assert.equal(c.payload.config.model, 'm2'); assert.equal(c.payload.config.thinkingOption, null);
  await until(() => f.events.find(e => e.type === 'request.completed' && e.requestId === 'config2'));
});

test('Paseo session.configure switches native tool with one select without extra settings steps',async t=>{
  const f=await context(t);await f.open();
  for(const [key,value,expect] of [
    ['quick-a','app:asdk_app_b',['asdk_app_b']],
    ['quick-none','none',[]],
    ['quick-all','all',['asdk_app_a','asdk_app_b']]
  ]){
    await f.connection.send({type:'session.configure',requestId:key,sessionId:'host-one',
      changes:{settings:{'app:quick':value}}});
    const command=await f.answerCommand('configure');
    assert.deepEqual(command.payload.config.appIds,expect);
    await until(()=>f.events.some(e=>e.type==='request.completed'&&e.requestId===key));
    const latest=f.events.filter(e=>e.type==='session.config').at(-1).config;
    assert.equal(latest.settings.length,1);
    assert.equal(latest.settings[0].type,'select');
    assert.equal(latest.settings[0].value,value);
  }
});
test('single tool quick select affects only this session and rejects old multi-actions',async t=>{
  const f=await context(t),one=await f.open('host-one'),two=await f.open('host-two');
  assert.deepEqual(f.broker.snapshot(two).config.appIds,['asdk_app_a']);
  await f.connection.send({type:'session.configure',requestId:'only-first',sessionId:'host-one',
    changes:{settings:{'app:quick':'app:asdk_app_b'}}});
  const change=await f.answerCommand('configure');
  assert.deepEqual(change.payload.config.appIds,['asdk_app_b']);
  await until(()=>f.events.some(e=>e.type==='request.completed'&&e.requestId==='only-first'));
  assert.deepEqual(f.broker.snapshot(one).config.appIds,['asdk_app_b']);
  assert.deepEqual(f.broker.snapshot(two).config.appIds,['asdk_app_a']);
  const options=f.events.filter(e=>e.type==='session.config'&&e.sessionId==='host-one').at(-1).config.settings[0].options;
  assert(!options.some(x=>/^add:|^remove:/.test(x.value)));
  for(const requestId of ['add:asdk_app_b','remove:asdk_app_b']){
    await f.connection.send({type:'session.configure',requestId,sessionId:'host-one',
      changes:{settings:{'app:quick':requestId}}});
    const failure=await until(()=>f.events.find(e=>e.type==='request.failed'&&e.requestId===requestId));
    assert.equal(failure.error.code,'SETTING_UNSUPPORTED');
    assert.deepEqual(f.broker.snapshot(one).config.appIds,['asdk_app_b']);
  }
});
test('closing while catalog awaits a browser cancels the actual queued command', async t => {
  const f = await context(t);
  await f.store.transaction(d => { d.catalog = null; }); // No confirmed catalog: this path must still own/cancel first discovery.
  await f.connection.send({ type: 'catalog', requestId: 'in-flight-catalog' });
  const c = await until(() => f.broker.queued().find(c => c.kind === 'catalog'));
  await f.connection.close();
  await until(() => f.store.read().commands[c.id].phase === 'failed');
  assert.equal(f.broker.queued().length, 0);
  await assert.rejects(f.broker.claim(c.id, 800, 'late-doc'), /COMMAND_NOT_CLAIMABLE/);
});
test('closing while session is opening prevents late queued opening', async t => {
  const f = await context(t);
  await f.connection.send({ type: 'session.open', requestId: 'open-pending', sessionId: 'pending', config, history: 'skip' });
  await until(() => f.events.some(e => e.type === 'session.ready' && e.sessionId === 'pending'));
  await f.connection.send({ type: 'session.prompt', sessionId: 'pending', prompt: { clientMessageId: 'first', delivery: 'auto', input: { type: 'message', content: [{type:'text',text:'hello'}] } } });
  const c = await until(() => f.broker.queued().find(c => c.kind === 'open'));
  await f.connection.close();
  await until(() => f.store.read().commands[c.id].phase === 'failed');
  assert.equal(f.broker.queued().length, 0);
  assert.equal(f.broker.queued().filter(c => c.kind === 'send').length, 0);
});
test('closing after configuration was claimed fences uncertain browser effects', async t => {
  const f = await context(t); const sid = await f.open();
  await f.connection.send({ type: 'session.configure', requestId: 'configure-pending', sessionId: 'host-one', changes: { model: 'm2' } });
  const c = await until(() => f.broker.queued().find(c => c.kind === 'configure'));
  const claim = await f.broker.claim(c.id, f.broker.snapshot(sid).tabId, 'configured-doc');
  await f.connection.close();
  await until(() => f.broker.snapshot(sid).status === 'blocked');
  await f.broker.result(c.id, claim.lease, { config: c.payload.config, tabId: claim.tabId, url: 'https://chatgpt.com/' });
  assert.equal(f.broker.snapshot(sid).config.model, 'm1');
  assert.equal(f.broker.snapshot(sid).error, 'CONTROL_UNCONFIRMED');
});

test('a temporarily unreadable binding preserves its link on restore; only standby releases a new prompt',async t=>{
  const f=await fixture(t);
  const s=await f.ready();
  const {event}=await f.sending(s,'old-message','OLD_DO_NOT_RESEND');
  await f.broker.observeGap({...event,observationLease:f.broker.snapshot(s.id).observation.lease,reason:'message_unavailable'});
  assert.equal(f.broker.snapshot(s.id).turn.outcome,null,'a read gap is not completion or failure');
  const provider=createProvider({...f,status:()=>({connected:true})});
  const c=await provider.connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>c.close());
  const events=[];c.onEvent(e=>events.push(e));
  await c.send({type:'session.open',requestId:'reopen',sessionId:'restored',config,
    persistence:{version:1,data:{id:s.id}},history:'replay'});
  await until(()=>events.some(e=>e.type==='session.ready'&&e.sessionId==='restored'));
  let state=f.broker.snapshot(s.id);
  assert.equal(state.tabId,s.tabId);
  assert.equal(state.documentKey,s.documentKey);
  assert.equal(state.conversationId,'chat-'+s.tabId);
  assert.equal(f.broker.queued().length,0,'reopen alone cannot enqueue Send');
  await c.send({type:'session.prompt',sessionId:'restored',prompt:{clientMessageId:'brand-new',
    delivery:'auto',input:{type:'message',content:[{type:'text',text:'a genuinely new request'}]}}});
  await until(()=>events.some(e=>e.type==='session.notice'&&e.notice.id==='native-prior-turn'&&!e.notice.dismissed));
  assert.equal(f.broker.queued().length,0);
  await f.view(s,{state:'standby'});
  const pending=await until(()=>f.broker.queued().find(c=>c.kind==='ensure'));
  assert.equal(pending.payload.conversationId,'chat-'+s.tabId);
  assert.equal(pending.payload.previousNativeMessageId,event.nativeMessageId);
  const claim=await f.broker.claim(pending.id,s.tabId,s.documentKey,
    {url:'https://chatgpt.com/c/chat-'+s.tabId});
  await f.broker.result(pending.id,claim.lease,{config:s.config,tabId:s.tabId,
    url:'https://chatgpt.com/c/chat-'+s.tabId,nativeMessageId:null});
  const next=await until(()=>f.broker.queued().find(c=>c.kind==='send'));
  assert.ok(next.payload.text.endsWith('a genuinely new request'));
  assert.ok(!next.payload.text.includes('OLD_DO_NOT_RESEND'));
  assert.equal(next.payload.conversationId,'chat-'+s.tabId);
  assert.equal(f.broker.queued().filter(c=>c.kind==='send').length,1);
});

test('legacy blocked but URL-bound session can be restored and explicitly continued without replay',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s,'old','OLD_DO_NOT_REPLAY');
  await f.store.transaction(d=>{const item=d.sessions[s.id];
    item.status='blocked';item.error='BROWSER_BINDING_LOST';
    item.turn.outcome='failed';item.prompts.old.outcome='failed';
  });
  const provider=createProvider({...f,status:()=>({connected:true})});
  const c=await provider.connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>c.close());const events=[];c.onEvent(x=>events.push(x));
  await c.send({type:'session.open',requestId:'open-old',sessionId:'old-session',config,
    history:'replay',persistence:{version:1,data:{id:s.id}}});
  await until(()=>events.some(x=>x.type==='session.ready'));
  assert.equal(f.broker.snapshot(s.id).status,'blocked','reopen does not silently resolve old message');
  assert.equal(f.broker.snapshot(s.id).conversationId,'chat-'+s.tabId);
  assert.equal(f.broker.queued().length,0);
  await c.send({type:'session.prompt',sessionId:'old-session',
    prompt:{clientMessageId:'new-from-user',delivery:'auto',input:{type:'message',
      content:[{type:'text',text:'new request'}]}}});
  const ensure=await until(()=>f.broker.queued().find(x=>x.kind==='ensure'));
  assert.equal(f.broker.snapshot(s.id).status,'idle');
  assert.equal(ensure.payload.conversationId,'chat-'+s.tabId);
  assert.equal(ensure.payload.previousNativeMessageId,null);
  const ack=await f.broker.claim(ensure.id,s.tabId,s.documentKey,
    {url:'https://chatgpt.com/c/chat-'+s.tabId});
  await f.broker.result(ensure.id,ack.lease,{config:s.config,tabId:s.tabId,
    url:'https://chatgpt.com/c/chat-'+s.tabId,nativeMessageId:null});
  const next=await until(()=>f.broker.queued().find(x=>x.kind==='send'));
  assert.ok(next.payload.text.endsWith('new request'));
  assert.ok(!next.payload.text.includes('OLD_DO_NOT_REPLAY'));
});

test('browser wake happens before Ensure and never creates a duplicate Send',async t=>{
  const f=await context(t),sid=await f.open();
  // Existing Agent already has a persisted Conversation after its first turn.
  const bound=f.broker.snapshot(sid);
  await f.store.transaction(d=>{d.sessions[sid].conversationId='chat-'+bound.tabId;});
  let connected=false,wakes=0;
  f.runtime.status=()=>({connected,paired:true});
  f.runtime.chromeWake=async()=>{wakes++;connected=true;};
  const prompt={type:'session.prompt',sessionId:'host-one',prompt:{
    clientMessageId:'wake-once',delivery:'auto',input:{type:'message',content:[{type:'text',text:'resume'}]}}};
  await f.connection.send(prompt);
  const ensure=await until(()=>f.broker.queued().find(c=>c.kind==='ensure'));
  assert.equal(wakes,1);
  assert.equal(f.broker.queued().filter(c=>c.kind==='send').length,0,'no Send is queued until Chrome is ready');
  const claim=await f.broker.claim(ensure.id,ensure.payload.tabId,ensure.payload.previousDocumentKey,{
    url:'https://chatgpt.com/c/chat-'+ensure.payload.tabId});
  await f.broker.result(ensure.id,claim.lease,{
    config:ensure.payload.config,tabId:ensure.payload.tabId,
    url:'https://chatgpt.com/c/chat-'+ensure.payload.tabId,nativeMessageId:'from-web-not-the-old-id'
  });
  await until(()=>f.broker.queued().some(c=>c.kind==='send'));
  assert.equal(f.broker.queued().filter(c=>c.kind==='send').length,1);
  await f.connection.send(prompt);
  assert.equal(wakes,1);
  assert.equal(f.broker.queued().filter(c=>c.kind==='send').length,1);
});

test('Paseo warns if exact network POST omitted selected @ app without resending',async t=>{
  const f=await context(t);
  const sid=await f.open('host-one');
  await f.connection.send({type:'session.prompt',sessionId:'host-one',prompt:{
    clientMessageId:'app-evidence',delivery:'auto',
    input:{type:'message',content:[{type:'text',text:'test exact app commit'}]}}});
  await f.answerCommand('ensure');
  const c=await until(()=>f.broker.queued().find(c=>c.kind==='send'&&c.sessionId===sid));
  const lease=await f.broker.claim(c.id,f.broker.snapshot(sid).tabId,f.broker.snapshot(sid).documentKey);
  await f.broker.authorize(c.id,lease.lease);
  await f.broker.result(c.id,lease.lease,{receipt:true,config:c.payload.config,
    url:'https://chatgpt.com/c/chat-'+lease.tabId,nativeMessageId:'native-app-evidence',
    appNetworkEvidence:'omitted'});
  const warning=await until(()=>f.events.find(e=>e.type==='session.notice'&&e.notice?.id==='native-app-evidence'));
  assert.equal(warning.notice.severity,'warning');
  assert.match(warning.notice.title,/@ 应用/);
  assert.equal(f.broker.queued().filter(c=>c.kind==='send').length,0);
});
test('content arriving while a prompt is prepared is delivered once after that prompt fails, never inside it', async t => {
  const f = await context(t), sid = await f.open();
  await f.sending(f.broker.snapshot(sid),'prior','old request');await f.view(sid,{state:'standby'});
  let reached, release; const atWake = new Promise(r => { reached = r; }), gate = new Promise(r => { release = r; });
  f.runtime.chromeWake = async () => { reached(); await gate; throw new Error('synthetic pre-Send failure'); };
  await f.connection.send({ type: 'session.prompt', sessionId: 'host-one', prompt: {
    clientMessageId: 'fails-before-send', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'next' }] } } });
  await atWake;
  // A late prior-turn body (Paseo would stage it into the pending run, then drop it).
  await f.view(sid,{state:'standby',items:[sourceItem('late-prior','LATE_PRIOR_BODY',{nativeMessageId:'native-late-prior'})]});
  const late = () => f.events.filter(e => e.type === 'timeline.item' && e.item.text === 'LATE_PRIOR_BODY');
  assert.equal(late().length, 0, 'held while the prompt is pending on the host');
  let atResult = null;
  f.connection.onEvent(e => { if (e.type === 'session.prompt_result') atResult = late().length; });
  release();
  await until(() => late().length);
  assert.equal(atResult, 0, 'not delivered in the same tick as the failed result');
  const result = f.events.findIndex(e => e.type === 'session.prompt_result');
  assert.equal(f.events[result].result.type, 'failed');
  assert(f.events.indexOf(late()[0]) > result);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(late().length, 1, 'exactly once');
  assert.equal(f.broker.queued().filter(c => c.kind === 'send').length, 0, 'no Send');
});
test('a prompt sent while the composer model is still being applied waits for it instead of failing CONFIGURATION_BUSY', async t => {
  const f = await context(t), sid = await f.open();
  f.runtime.chromeWake = async () => {};
  // The real configure queues its browser command and holds the session lock.
  await f.connection.send({ type: 'session.configure', requestId: 'cfg', sessionId: 'host-one', changes: { model: 'm1', thinkingOption: 'extended' } });
  await until(() => f.broker.queued().find(c => c.kind === 'configure'));
  await f.connection.send({ type: 'session.prompt', sessionId: 'host-one', prompt: {
    clientMessageId: 'after-config', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'next' }] } } });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.events.some(e => e.type === 'session.prompt_result'), false, 'the prompt waits while configuration runs');
  await f.answerCommand('configure');
  await until(() => f.events.some(e => e.type === 'request.completed' && e.requestId === 'cfg'));
  // The prompt continues to its own page check instead of failing busy.
  await until(() => f.broker.queued().find(c => c.kind === 'ensure'));
  assert.equal(f.events.some(e => e.type === 'session.prompt_result' && e.result.type === 'failed'), false);
  await f.broker.interrupt(sid).catch(() => {});
});
