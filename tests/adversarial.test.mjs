import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fixture, selection, until, sourceItem } from './helpers.mjs';
import { PROTOCOL } from '../server/protocol.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';

const conf = {cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,...selection,providerOptions:{appIds:selection.appIds}};
async function providerFixture(t) {
 const f=await fixture(t); const connection=await createProvider({...f,status:()=>({connected:true})}).connect({versions:[1],capabilities:CAPABILITIES});
 const events=[]; connection.onEvent(e=>events.push(e)); t.after(()=>connection.close());
 async function open(name='host',extra={}) {
  await connection.send({type:'session.open',requestId:'open-'+name,sessionId:name,config:conf,history:'skip',...extra});
  await until(()=>events.some(e=>e.type==='session.ready' && e.sessionId===name));
  const id=events.find(e=>e.type==='session.opened' && e.sessionId===name).persistence.data.id;
  const configured=f.broker.configure(id,f.broker.snapshot(id).config);
  const c=await until(()=>f.broker.queued().find(c=>c.kind==='open'));
  const cl=await f.broker.claim(c.id,500,'doc-500');
  await f.broker.result(c.id,cl.lease,{config:c.payload.config,tabId:500,url:c.payload.conversationId ? `https://chatgpt.com/c/${c.payload.conversationId}` : 'https://chatgpt.com/'});
  await configured;
  return events.find(e=>e.type==='session.opened' && e.sessionId===name).persistence.data.id;
 }
 return {...f,connection,events,open};
}
const message=(id,text='hello')=>({type:'session.prompt',sessionId:'host',prompt:{clientMessageId:id,delivery:'auto',input:{type:'message',content:[{type:'text',text}]}}});

test('A01: configuration screen must have a reachable UI entry',async t=>{
 const code=await readFile(new URL('../index.client.tsx',import.meta.url),'utf8');
 const entry=/addSettingsScreen|addSidebar(?:Header|Footer)Item|addCommandCenterItem/.test(code);
 t.diagnostic('Verified a normal user-facing configuration entry is registered.');
 assert.equal(entry,true);
});

test('A02: default host-injected Paseo MCP must not prevent every new chat',async t=>{
 const f=await providerFixture(t);
 await f.connection.send({type:'session.open',sessionId:'host',requestId:'open',history:'skip',config:{...conf,mcpServers:{paseo:{type:'http',url:'http://127.0.0.1:12345/mcp/agents'}}}});
 const ev=await until(()=>f.events.find(e=>e.type==='request.failed' || e.type==='session.ready') || f.broker.queued()[0]);
 t.diagnostic(JSON.stringify(ev));
 assert.notEqual(ev.error?.code,'MCP_CONFIG_UNSUPPORTED');
});

test('A03: completion racing with interrupt must not leave the session permanently stopping',async t=>{
 const f=await fixture(t); const s=await f.ready(); await f.sending(s);
 await f.view(s,{state:'running',items:[sourceItem('answer','done')]});
 const completion=f.view(s,{state:'standby'});
 const interruption=f.broker.interrupt(s.id); interruption.catch(()=>{}); await completion;
 // A correct implementation may settle this as a no-op without enqueueing Stop.
 const c=f.broker.queued().find(c=>c.kind==='stop');
 if(c){const cl=await f.broker.claim(c.id,s.tabId,s.documentKey);await f.broker.result(c.id,cl.lease,{error:'STOP_UNCONFIRMED'});}
 await interruption.catch(error=>assert.ok(['STOP_NOT_AVAILABLE','STOP_UNCONFIRMED'].includes(error.code),error.message));
 t.diagnostic(JSON.stringify({status:f.broker.snapshot(s.id).status,outcome:f.broker.snapshot(s.id).turn.outcome}));
 assert.equal(f.broker.snapshot(s.id).status,'idle');
});

test('A04: a timed-out claimed configuration must fence unconfirmed browser mutations',async t=>{
 const f=await fixture(t); const s=await f.ready();
 const change=f.broker.configure(s.id,{model:'m2',thinkingOption:null,appIds:[]}); change.catch(()=>{});
 const c=await until(()=>f.broker.queued().find(c=>c.kind==='configure')); await f.broker.claim(c.id,s.tabId,s.documentKey);
 await f.broker.tick(Date.now()+100000); await change.catch(()=>{});
 t.diagnostic(JSON.stringify({status:f.broker.snapshot(s.id).status,error:f.store.read().commands[c.id].error}));
 assert.equal(f.broker.snapshot(s.id).status,'blocked');
});

test('A05: retrying an already-failed message ID must not launch an undisclosed turn',async t=>{
 const f=await providerFixture(t); const id=await f.open();
 await f.broker.prompt(id,'occupier','busy');
 await f.connection.send(message('retry-id'));
 await until(()=>f.events.some(e=>e.type==='session.notice'&&e.notice?.id==='native-prior-turn'&&!e.notice.dismissed));
 await f.connection.send({type:'session.interrupt',sessionId:'host',requestId:'cancel-queued'});
 await until(()=>f.events.find(e=>e.type==='session.prompt_result'&&e.clientMessageId==='retry-id'));
 await f.connection.send(message('retry-id'));
 // Do not wait for the BUG (an illicit Send) as a test precondition.
 await new Promise(r=>setTimeout(r,30)); await f.store.flush();
 const disposition=f.events.filter(e=>e.type==='session.prompt_result'&&e.clientMessageId==='retry-id');
 t.diagnostic(JSON.stringify({disposition,queuedSend:f.broker.queued().some(c=>c.kind==='send')}));
 assert.equal(f.broker.queued().some(c=>c.kind==='send'),false,'failed clientMessageId is terminal; a retry cannot secretly start work without a new disposition');
});

test('A06: resuming a session must update stored cwd and system prompt from the new config',async t=>{
 const f=await providerFixture(t); const id=await f.open();
 await f.connection.send({type:'session.close',requestId:'close',sessionId:'host'});
 await until(()=>f.events.some(e=>e.type==='session.closed'));
 await f.open('resumed',{persistence:{version:1,data:{id}},config:{...conf,cwd:'/new-fixture',systemPrompt:'new instruction'}});
 const s=f.broker.snapshot(id); t.diagnostic(JSON.stringify({reportedCwd:f.events.filter(e=>e.type==='session.opened').at(-1).cwd,storedCwd:s.cwd,storedPrompt:s.systemPrompt}));
 assert.equal(s.cwd,'/new-fixture'); assert.equal(s.systemPrompt,'new instruction');
});

test('A07: message admission must reserve space for at least one assistant answer',async t=>{
 const f=await fixture(t); const s=await f.ready();
 await f.store.transaction(d=>{d.sessions[s.id].history=Array.from({length:999},(_,i)=>({type:'assistant_message',id:'past-'+i,text:'past'}));});
 let event;
 try { ({event}=await f.sending(s)); }
 catch (e) { assert.equal(e.code,'PROMPT_HISTORY_LIMIT'); assert.equal(f.broker.queued().some(c=>c.kind==='send'),false); return; }
 let err;try{await f.view(s,{state:'standby',items:[sourceItem('new-answer','answer already generated')]});}catch(e){err=e;}
 t.diagnostic(JSON.stringify({accepted:true,status:f.broker.snapshot(s.id).status,answerError:err,historyLength:f.broker.snapshot(s.id).history.length}));
 assert.equal(err,undefined,'Already-admitted turn must be able to persist its result, or be refused BEFORE Send');
});

// Execute the unchanged extension service-worker source in a synthetic Chrome host.
// No network, browser account, or local MCP is used. Instrumentation only exposes lexical functions.
async function backgroundFixture(t, options={}) {
 const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
 const engine=/'X-CIP-Engine': '([^']+)'/.exec(source)[1];
 const listeners={},routes=[],sent=[],local={config:{endpoint:'http://127.0.0.1:17843',token:'valid-token'},ledger:{}};
 const rows=options.tabs??{}; let queue=options.commands??[];let lastTab=600;let handler;
 const nativeTabs=Object.fromEntries(Object.keys(rows).map(id=>[id,{id:Number(id),url:'https://chatgpt.com/',active:false}]));
 const response=(obj,ok=true)=>({ok,text:async()=>JSON.stringify(obj)});
 const ctx=vm.createContext({URL,AbortSignal,structuredClone,console,Date,Promise,Set,Map,PROTOCOL,crypto:webcrypto,
  setTimeout:()=>123,clearTimeout:()=>{},
  fetch:async(url,o={})=>{const route=new URL(url).pathname;const body=o.body?JSON.parse(o.body):undefined;routes.push({route,body});
   if(route==='/hello')return response({product:'chatmode-in-paseo',protocol:options.protocol??PROTOCOL,epoch:'e'});
   if(route==='/commands')return response({commands:queue});
   if(route==='/observations')return response({sessions:options.observations??[]});
   if(route==='/claim'){const c=queue.find(c=>c.id===body.id);return response({...c,...body,lease:'lease-1'});}
   if(route==='/pair')return response({error:'PAIRING_REJECTED'},false);
   return response({accepted:true,authorized:true});},
  chrome:{
   storage:{local:{setAccessLevel:async()=>{},get:async()=>structuredClone(local),set:async obj=>Object.assign(local,structuredClone(obj))},session:{get:async()=>({tabs:structuredClone(rows)}),set:async()=>{}}},
   runtime:{id:'a'.repeat(32),getURL:f=>'chrome-extension://'+'a'.repeat(32)+'/'+f,onMessage:{addListener:fn=>handler=fn},onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}}},
   alarms:{onAlarm:{addListener:()=>{}},create:()=>{}},
   tabs:{create:async options=>{const tab={id:++lastTab,url:options.url,active:false};nativeTabs[tab.id]=tab;return tab;},
    query:async()=>Object.values(nativeTabs),
    get:async id=>{if(!nativeTabs[id])throw new Error('No tab with id '+id);return nativeTabs[id];},remove:async id=>{delete nativeTabs[id];},onRemoved:{addListener:()=>{}},
    sendMessage:async(tabId,m)=>{sent.push({tabId,type:m.type,kind:m.command?.kind});if(m.type==='identity')return{ok:true,value:{engine,protocol:PROTOCOL,documentKey:'doc-1',url:nativeTabs[tabId]?.url}};if(options.sendMessage)return options.sendMessage(tabId,m);return {ok:true,value:{idle:true,documentKey:'doc-1'}};}}}
 });
 vm.runInContext(source+'\nglobalThis.__audit={pump,execute,read:()=>({config,ledger,tabs})};',ctx);
 return {ctx,routes,sent,local,setQueue:q=>queue=q,pump:()=>ctx.__audit.pump(),read:()=>ctx.__audit.read(),message:m=>new Promise(resolve=>handler(m,{id:ctx.chrome.runtime.id,url:ctx.chrome.runtime.getURL('popup.html')},resolve))};
}

test('A09: a slow operation on tab A must not stop the dispatcher from picking up Stop for B',async t=>{
 let release,entered=false;const blocked=new Promise(r=>release=r);
 const f=await backgroundFixture(t,{tabs:{200:{sessionId:'b',documentKey:'doc-1'}},commands:[{id:'catalog',kind:'catalog',sessionId:null,payload:{}}],sendMessage:async(_,m)=>{if(m.type==='command'&&m.command.kind==='catalog'){entered=true;return blocked;}return{ok:true,value:{idle:true,documentKey:'doc-1'}};}});
 t.after(async()=>{release({ok:false,error:'TEST_END'});await f.pump();});
 await until(()=>entered); f.setQueue([{id:'stop-b',kind:'stop',sessionId:'b',payload:{tabId:200}}]);
 const second=f.pump();await new Promise(r=>setTimeout(r,25));
 t.diagnostic(JSON.stringify({commandPolls:f.routes.filter(r=>r.route==='/commands').length,stopDispatched:f.sent.some(m=>m.kind==='stop')}));
 assert.equal(f.routes.filter(r=>r.route==='/commands').length>=2,true);
 await until(()=>f.sent.some(m=>m.kind==='stop')); assert.equal(f.sent.some(m=>m.kind==='stop'),true);
});

test('A10: failed re-pairing must preserve an existing working connection',async t=>{
 const f=await backgroundFixture(t);await f.pump();const result=await f.message({type:'pair',endpoint:'http://127.0.0.1:17843',code:'wrong-code'});
 t.diagnostic(JSON.stringify({result,memoryToken:f.read().config.token,persistedToken:f.local.config.token}));
 assert.equal(f.read().config.token,'valid-token');
});

test('A11: browser restart retains the active turn and reopens only its bound chat, never replays Send',async t=>{
 const f=await backgroundFixture(t,{tabs:{},observations:[{sessionId:'running',tabId:777,documentKey:'old-doc',conversationId:'old-conv',observationLease:'observation-lease',generation:1,runId:'run'}]});
 await f.pump();
 await until(()=>Object.values(f.read().tabs).some(row=>row.restoringConversationId==='old-conv'));
 const reopened=Object.values(f.read().tabs).filter(row=>row.restoringConversationId==='old-conv');
 t.diagnostic(JSON.stringify({observationsRead:f.routes.some(r=>r.route==='/observations'),restoring:reopened.length}));
 assert.equal(f.routes.some(r=>r.route==='/observations'),true);
 assert.equal(f.routes.some(r=>r.route==='/active'||r.route==='/event'),false);
 assert.equal(reopened.length,1,JSON.stringify(f.routes));
 assert.equal(f.routes.some(r=>r.route==='/claim'||r.route==='/authorize'||r.route==='/result'),false);
 assert.equal(f.routes.some(r=>r.route==='/event'&&r.body?.kind==='binding_lost'),false);
});


test('A12: saved new-agent defaults must be returned to Paseos create-agent catalog',async t=>{
 const f=await providerFixture(t);
 await f.broker.defaults({model:'m2',thinkingOption:null,appIds:[]});
 const nativeCatalog=f.store.read().catalog;
 await f.store.transaction(d=>{d.catalog=null;}); // First discovery; old confirmed form choices no longer force network refresh.
 await f.connection.send({type:'catalog',requestId:'catalog-defaults'});
 const c=await until(()=>f.broker.queued().find(c=>c.kind==='catalog'));
 const claim=await f.broker.claim(c.id,888,'doc-catalog');
 await f.broker.result(c.id,claim.lease,{catalog:nativeCatalog});
 const event=await until(()=>f.events.find(e=>e.type==='catalog'));
 t.diagnostic(JSON.stringify({savedModel:f.store.read().defaults.model,formDefault:event.catalog.defaultModel}));
 assert.equal(event.catalog.defaultModel,'m2');
});

test('A13: provider model fields must satisfy the published Paseo string-or-omitted contract',async t=>{
 const f=await providerFixture(t);
 const nativeCatalog=f.store.read().catalog;
 await f.store.transaction(d=>{d.catalog=null;}); // Keep testing a native discovery result, not the form cache.
 await f.connection.send({type:'catalog',requestId:'schema-check'});
 const c=await until(()=>f.broker.queued().find(c=>c.kind==='catalog'));
 const cl=await f.broker.claim(c.id,888,'doc-catalog');
 await f.broker.result(c.id,cl.lease,{catalog:nativeCatalog});
 const ev=await until(()=>f.events.find(e=>e.type==='catalog'));
 // Direct field-contract check, NOT a claim that the full SDK / Zod runtime was installed.
 // Source: getpaseo/paseo b923cde6 packages/plugin/src/server/provider.ts modelSchema:
 // defaultThinkingOptionId: z.string().optional()
 const incompatible=ev.catalog.models.filter(m=>m.defaultThinkingOptionId!==undefined&&typeof m.defaultThinkingOptionId!=='string');
 t.diagnostic(JSON.stringify({incompatibleModels:incompatible}));
 assert.deepEqual(incompatible,[]);
});


test('A13: an old CIP runtime is rejected before pairing or consuming a code', async t => {
  const f = await backgroundFixture(t, { protocol: 1 });
  await f.pump();
  const result = await f.message({ type: 'pair', endpoint: 'http://127.0.0.1:17843', code: 'must-not-be-sent' });
  assert.equal(result.ok, false); assert.equal(result.error, 'PROTOCOL_MISMATCH');
  assert.equal(f.routes.some(row => row.route === '/pair'), false);
  assert.equal(f.read().config.token, 'valid-token');
  assert.equal(f.local.config.token, 'valid-token');
});
