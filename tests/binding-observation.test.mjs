import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { nativeMessageId } from '../server/protocol.mjs';
import { fixture } from './helpers.mjs';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const engine = /'X-CIP-Engine': '([^']+)'/.exec(source)[1];
const session = { sessionId:'session-a',turnId:'turn-a',lease:'test-lease',tabId:71,documentKey:'document-a',conversationId:'chat-a',nativeMessageId:'native-user-a' };
async function worker(local = {config:{endpoint:'http://127.0.0.1:17843',token:'test-only'}}, clock = {now:10000}) {
  const calls=[], state={tab:{id:71,url:'https://chatgpt.com/c/chat-a'},identity:{engine,documentKey:'document-a',url:'https://chatgpt.com/c/chat-a',nativeMessageId:'native-user-a'},matches:[],created:[],monitor:true};
  let handler, tabRemoved;
  const context=vm.createContext({console,URL,AbortSignal,structuredClone,crypto:webcrypto,setTimeout,clearTimeout,
    Date:class extends Date { static now(){return clock.now;} },
    fetch:async(url,options)=>{
      const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;calls.push({route,body});
      let result={accepted:true};
      if(route==='/rebind-observation')result={...session,documentKey:body.documentKey,tabId:body.tabId};
      return {ok:true,text:async()=>JSON.stringify(result)};
    },
    chrome:{
      storage:{local:{setAccessLevel:async()=>{},get:async()=>structuredClone(local),set:async value=>Object.assign(local,structuredClone(value))},session:{get:async()=>({}),set:async()=>{}}},
      runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:{addListener:fn=>handler=fn},onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}}},
      alarms:{onAlarm:{addListener:()=>{}},create:()=>{}},
      tabs:{
        get:async id=>{
          if(Number(id)===71 && state.tab)return state.tab;
          const created=state.created.find(t=>t.id===Number(id));
          if(created)return created;
          throw new Error('No tab');
        },
        query:async()=>state.matches.length ? state.matches : state.created,
        create:async ({url,active})=>{
          const created={id:72+state.created.length,url,active,status:'complete'};
          state.created.push(created);return created;
        },
        onRemoved:{addListener:fn=>{tabRemoved=fn;}},sendMessage:async(id,m)=>{
        calls.push({message:m.type});
        if(m.type==='identity')return state.identity?{ok:true,value:state.identity}:{ok:false,error:'CONTENT_UNAVAILABLE'};
        if(m.type==='pending-receipt')return state.pendingProbe??{ok:false,error:'TRANSCRIPT_UNCONFIRMED'};
        if(m.type==='monitor')return {ok:state.monitor,value:{active:state.monitorActive===true}};
        return {ok:state.monitor};
      }}
    }
  });
  // Explicit single-iteration worker tests; the unmodified pump is exercised by binding-mv3-flow.py.
  vm.runInContext(source.replace(/\nvoid pump\(\);\s*$/,'')+'\nglobalThis.testBinding={load,watch:s=>watchSession(s,config)};',context);
  await context.testBinding.load();
  return {state,calls,local,clock,closeTab:async id=>tabRemoved(id),watch:(s=session)=>context.testBinding.watch(s),message:(m,sender)=>new Promise(resolve=>handler(m,sender,resolve))};
}
test('BIND1 a temporary missing native row preserves same-document monitoring, then resumes the same ID',async()=>{
  const f=await worker();f.state.identity.nativeMessageId=null;await f.watch();
  assert.ok(f.calls.filter(c=>c.route==='/event').every(c=>c.body.kind==='heartbeat'));
  assert.equal(Object.keys(f.local.bindingWaits??{}).length,0);
  assert.equal(f.calls.filter(c=>c.message==='monitor').length,1);
  f.state.identity.nativeMessageId=session.nativeMessageId;await f.watch();
  assert.equal(f.calls.filter(c=>c.message==='monitor').length,2);
  assert.equal(Object.keys(f.local.bindingWaits??{}).length,0);
  assert.equal(f.calls.some(c=>c.route==='/claim'||c.route==='/authorize'),false);
});
test('BIND2 retry deadline survives worker restart; 15 seconds is a warning, not terminal',async()=>{
  const clock={now:10000}, f=await worker(undefined,clock);f.state.identity=null;await f.watch();
  clock.now=26001;const restarted=await worker(f.local,clock);restarted.state.identity=null;await restarted.watch();
  const gap=restarted.calls.find(c=>c.route==='/event');assert.equal(gap.body.kind,'observation_gap');
  assert.equal(restarted.calls.some(c=>c.body?.kind==='binding_lost'),false);
  assert.equal(Object.keys(restarted.local.bindingWaits).length,1);
});
test('BIND3 a newer same-document user is reconciled by the old monitor before import',async()=>{
  const f=await worker();f.state.identity.nativeMessageId='different-native-id';await f.watch();
  assert.equal(f.calls.some(c=>c.route==='/event'&&c.body.kind==='binding_lost'),false);
  assert.equal(f.calls.filter(c=>c.message==='monitor').length,1);
  assert.equal(Object.keys(f.local.bindingWaits??{}).length,1);
  assert.equal(f.calls.some(c=>c.route==='/rebind-observation'),false);
});
test('BIND3b a different document and different user cannot claim old observation ownership',async()=>{
  const f=await worker();f.state.identity.nativeMessageId='different-native-id';
  f.state.identity.documentKey='untrusted-document';await f.watch();
  assert.equal(f.calls.find(c=>c.route==='/event'),undefined);
  assert.equal(Object.keys(f.local.bindingWaits).length,1);
  assert.equal(f.calls.some(c=>c.route==='/rebind-observation'||c.message==='monitor'),false);
});
test('BIND4 another route cannot borrow the prior message binding',async()=>{
  const f=await worker();f.state.tab.url='https://chatgpt.com/c/another-chat';await f.watch();
  assert.equal(f.state.created.length,1,JSON.stringify({calls:f.calls,wait:f.local.bindingWaits}));
  assert.equal(f.state.created[0].url,sessionUrl());
  assert.equal(f.state.tab.url,'https://chatgpt.com/c/another-chat');
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
  assert.equal(f.calls.some(c=>c.route==='/authorize'||c.route==='/claim'),false);
});
test('BIND5 document reload rebinds only the exact conversation and native user',async()=>{
  const f=await worker();f.state.identity.documentKey='document-reloaded';await f.watch();
  assert.equal(f.calls.find(c=>c.route==='/rebind-observation').body.nativeMessageId,session.nativeMessageId);
  assert.ok(f.calls.some(c=>c.message==='monitor'));
  assert.ok(f.calls.filter(c=>c.route==='/event').every(c=>c.body.kind==='heartbeat'));
});
test('BIND6 multiple possible replacement tabs refuse observation custody',async()=>{
  const f=await worker();f.state.tab=null;f.state.matches=[{id:72,url:sessionUrl()},{id:73,url:sessionUrl()}];await f.watch();
  assert.equal(f.state.created.length,0,'ambiguous tabs must not create a third tab');
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
  assert.equal(Object.keys(f.local.bindingWaits).length,1);
});
function sessionUrl(){return 'https://chatgpt.com/c/chat-a';}
test('COLD1 Chrome tab gone, active turn opens only bound URL with no Send',async()=>{
  const f=await worker();f.state.tab=null;
  await f.watch();
  assert.equal(f.state.created.length,1,JSON.stringify({calls:f.calls,wait:f.local.bindingWaits}));
  assert.equal(f.state.created[0].url,sessionUrl());
  assert.equal(f.calls.some(c=>['/claim','/authorize','/result'].includes(c.route)),false);
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
});
test('COLD2 restart worker adopts reopened original tab with exact native ID, no new Send',async()=>{
  const first=await worker();first.state.tab=null;await first.watch();
  assert.equal(first.state.created.length,1);
  const restored=await worker(first.local);restored.state.tab=null;
  restored.state.created=[...first.state.created];
  restored.state.identity.documentKey='new-document-after-reboot';
  await restored.watch();
  assert.equal(restored.state.created.length,1,'restart must reuse the same restored tab');
  assert.equal(restored.calls.filter(c=>c.route==='/rebind-observation').length,1);
  assert.equal(restored.calls.find(c=>c.route==='/rebind-observation').body.nativeMessageId,session.nativeMessageId);
  assert.equal(restored.calls.filter(c=>c.message==='monitor').length,1);
  assert.equal(restored.calls.some(c=>['/claim','/authorize','/result'].includes(c.route)),false);
  assert.equal(restored.calls.some(c=>c.body?.kind==='binding_lost'),false);
});
test('COLD3 lost native user row on fresh page retries; never adopts another user',async()=>{
  const f=await worker();f.state.tab=null;await f.watch();
  f.state.identity.nativeMessageId=null;f.state.identity.documentKey='new-document';
  await f.watch();
  assert.equal(f.calls.some(c=>c.route==='/rebind-observation'),false);
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
  f.state.identity.nativeMessageId=session.nativeMessageId;await f.watch();
  assert.equal(f.calls.filter(c=>c.route==='/rebind-observation').length,1);
  assert.equal(f.calls.filter(c=>c.message==='monitor').length,1);
});
test('COLD4 foreign-owned exact URL cannot be stolen or receive Send',async()=>{
  const f=await worker({config:{endpoint:'http://127.0.0.1:17843',token:'test-only'},
    tabs:{72:{sessionId:'foreign'}}});
  f.state.tab=null;f.state.matches=[{id:72,url:sessionUrl()}];
  await f.watch();
  assert.equal(f.state.created.length,0);
  assert.equal(f.calls.some(c=>c.route==='/rebind-observation'||c.message==='monitor'),false);
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
});
test('COLD5 unconfirmed prior Send remains awaiting evidence after Chrome exits',async()=>{
  const f=await worker();f.state.tab=null;
  await f.watch({...session,receiptPending:true});
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
  assert.equal(f.calls.some(c=>['/claim','/authorize','/result'].includes(c.route)),false);
  assert.equal(Object.keys(f.local.bindingWaits).length,1);
});
test('COLD6 tab removal during Chrome Quit must not immediately recreate Chrome windows',async()=>{
  const f=await worker({config:{endpoint:'http://127.0.0.1:17843',token:'test-only'},
    tabs:{71:{sessionId:session.sessionId,documentKey:session.documentKey}}});
  f.state.tab=null;
  await f.closeTab(71);
  assert.equal(f.state.created.length,0);
  assert.equal(f.calls.some(c=>c.route==='/claim'||c.route==='/authorize'),false);
  await f.watch();
  assert.equal(f.state.created.length,1,'recovery resumes on a later explicit poll/startup');
});
test('BIND7 foreign extension cannot impersonate our popup',async()=>{
  const f=await worker();const result=await f.message({type:'status'},{id:'b'.repeat(32),url:'chrome-extension://'+'a'.repeat(32)+'/popup.html'});
  assert.equal(result.ok,false);assert.equal(f.calls.length,0);
});
test('BIND8 own popup is valid both in a popup and an extension tab',async()=>{
  const f=await worker();const result=await f.message({type:'status'},{id:'a'.repeat(32),tab:{id:7},url:'chrome-extension://'+'a'.repeat(32)+'/popup.html'});
  assert.equal(result.ok,true);assert.equal(result.value.paired,true);
});
test('BIND9 Runtime rejects a layout key before publishing a send receipt',async t=>{
  const f=await fixture(t), s=await f.ready();const {claim}=await f.sending(s,'binding-message','hello',false);
  await assert.rejects(f.broker.result(claim.id,claim.lease,{receipt:true,config:s.config,nativeMessageId:'fallback-turn-0:0:user',url:'https://chatgpt.com/c/chat-a'}),/NATIVE_MESSAGE_ID_UNPROVEN/);
  assert.equal(f.broker.snapshot(s.id).turn.receivedAt,undefined);
});
test('BIND10 Runtime refuses a layout-shaped streamed answer without changing history',async t=>{
  const f=await fixture(t),s=await f.ready();const {event}=await f.sending(s);
  await assert.rejects(f.broker.observe({...event,kind:'snapshot',messageId:'some-slot:1:assistant',text:'not stable'}),/NATIVE_MESSAGE_ID_UNPROVEN/);
  assert.equal(f.broker.snapshot(s.id).history.length,1);
});
test('BIND11 valid native IDs remain accepted; all known layout forms are denied',()=>{
  for(const id of ['fallback-turn-0:0:user','turn-7:1:assistant','slot:user'])assert.throws(()=>nativeMessageId(id),/NATIVE_MESSAGE_ID_UNPROVEN/);
  assert.equal(nativeMessageId('8dc7d1b2-001a-45b2-961a-53cbd367af54'),'8dc7d1b2-001a-45b2-961a-53cbd367af54');
});

test('BIND12 post-navigation events use current Chrome tab identity, not the old document URL',async()=>{
  const local={config:{endpoint:'http://127.0.0.1:17843',token:'test-only'},tabs:{71:{sessionId:session.sessionId,documentKey:session.documentKey}}};
  const f=await worker(local);
  const result=await f.message({type:'observation',event:{...session,kind:'snapshot',url:sessionUrl(),messageId:'native-answer-a',text:'answer'}},
    {id:'a'.repeat(32),tab:{id:71},frameId:0,url:'https://chatgpt.com/'});
  assert.equal(result.ok,true);assert.equal(f.calls.find(c=>c.route==='/event').body.url,sessionUrl());
});
test('BIND13 claimed event URL from another chat is refused despite a valid sender and tab number',async()=>{
  const local={config:{endpoint:'http://127.0.0.1:17843',token:'test-only'},tabs:{71:{sessionId:session.sessionId,documentKey:session.documentKey}}};
  const f=await worker(local);
  const result=await f.message({type:'observation',event:{...session,kind:'snapshot',url:'https://chatgpt.com/c/wrong-chat',messageId:'native-answer-a',text:'wrong answer'}},
    {id:'a'.repeat(32),tab:{id:71},frameId:0,url:'https://chatgpt.com/'});
  assert.equal(result.ok,false);assert.equal(f.calls.some(c=>c.route==='/event'),false);
});

test('BIND14 current document keeps an already verified user anchor when its native row is temporarily unmounted for over 15 seconds', async()=>{
  const clock={now:10000},f=await worker(undefined,clock);
  f.state.identity.nativeMessageId=null;
  await f.watch();clock.now=28000;await f.watch();
  assert.ok(f.calls.filter(c=>c.route==='/event').every(c=>c.body.kind==='heartbeat'));
  assert.equal(f.calls.filter(c=>c.message==='monitor').length,2);
  assert.equal(Object.keys(f.local.bindingWaits??{}).length,0);
  assert.equal(f.calls.some(c=>c.route==='/claim'||c.route==='/authorize'),false);
});
test('BIND15 replaced document cannot be rebound without native identity, but remains retryable',async()=>{
  const clock={now:10000},f=await worker(undefined,clock);
  f.state.identity.documentKey='document-reloaded';f.state.identity.nativeMessageId=null;
  await f.watch();clock.now=26001;await f.watch();
  assert.equal(f.calls.some(c=>c.route==='/rebind-observation'||c.message==='monitor'),false);
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
  assert.equal(f.calls.find(c=>c.route==='/event')?.body.kind,'observation_gap');
});

test('BIND16 only an authorized current tab may bind a newly created URL independently of receipt',async()=>{
  const local={config:{endpoint:'http://127.0.0.1:17843',token:'test-only'},
    tabs:{71:{sessionId:session.sessionId,documentKey:session.documentKey}},
    ledger:{'native-send':{tabId:71,documentKey:session.documentKey,
      lease:session.lease,phase:'authorized',endpoint:'http://127.0.0.1:17843',
      command:{kind:'send',sessionId:session.sessionId}}}};
  const f=await worker(local);
  const msg={type:'bind-conversation',id:'native-send',lease:session.lease,
    documentKey:session.documentKey,url:sessionUrl()};
  const sender={id:'a'.repeat(32),tab:{id:71},frameId:0,url:'https://chatgpt.com/'};
  const good=await f.message(msg,sender);
  assert.equal(good.ok,true);
  const route=f.calls.find(c=>c.route==='/bind-conversation');
  assert.equal(route.body.url,sessionUrl());
  assert.equal(route.body.lease,session.lease);
  assert.equal(f.calls.some(c=>c.route==='/authorize'||c.route==='/claim'),false);
  const before=f.calls.length;
  for(const altered of [
    {...msg,lease:'wrong'},
    {...msg,documentKey:'another'},
    {...msg,url:'https://chatgpt.com/c/another'},
  ]) assert.equal((await f.message(altered,sender)).ok,false);
  assert.equal(f.calls.length,before);
});

const receiptPending={...session,nativeMessageId:null,receiptPending:true};
test('BIND17 pending receipt with verified same-page activity renews observation, never sends again',async()=>{
  const f=await worker();f.state.pendingProbe={ok:true,value:{available:true,active:true}};
  await f.watch(receiptPending);
  const event=f.calls.find(c=>c.route==='/event')?.body;
  assert.equal(event?.kind,'heartbeat');
  assert.equal(event.nativeMessageId,null);
  assert.equal(f.calls.some(c=>c.message==='command'||c.route==='/authorize'||c.route==='/claim'),false);
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
});
test('BIND18 late native ID is recovered on the same binding without a second Send',async()=>{
  const f=await worker();f.state.pendingProbe={ok:true,value:{available:true,nativeMessageId:'native-recovered'}};
  await f.watch(receiptPending);
  const event=f.calls.find(c=>c.route==='/event')?.body;
  assert.equal(event?.kind,'receipt_recovered');
  assert.equal(event.nativeMessageId,'native-recovered');
  assert.equal(event.lease,receiptPending.lease);
  assert.equal(event.url,sessionUrl());
  assert.equal(f.calls.some(c=>c.message==='command'),false);
});
test('BIND19 conflicting pending identity terminates only the current turn',async()=>{
  const f=await worker();f.state.pendingProbe={ok:true,value:{conflict:true}};
  await f.watch(receiptPending);
  const event=f.calls.find(c=>c.route==='/event')?.body;
  assert.equal(event?.kind,'binding_lost');
  assert.equal(event.diagnostic.reason,'receipt_identity_conflict');
  assert.equal(f.calls.some(c=>c.body?.kind==='receipt_recovered'),false);
});
test('BIND20 temporarily unreadable pending receipt remains recoverable after warning grace',async()=>{
  const clock={now:10000},f=await worker(undefined,clock);
  await f.watch(receiptPending);clock.now=26001;await f.watch(receiptPending);
  const event=f.calls.find(c=>c.route==='/event')?.body;
  assert.equal(event?.kind,'observation_gap');
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
});

test('BIND21 only verified native work renews runtime liveness; visible idle tab does not',async()=>{
  const f=await worker();
  await f.watch();
  assert.equal(f.calls.some(c=>c.body?.kind==='heartbeat'),false);
  f.state.monitorActive=true;
  await f.watch();
  assert.equal(f.calls.filter(c=>c.body?.kind==='heartbeat').length,1);
  assert.equal(f.calls.some(c=>c.body?.kind==='completed'),false);
});
test('BIND22 a reloaded document cannot turn an uncertain Send into a false binding loss',async()=>{
  const f=await worker();
  f.state.pendingProbe={ok:false,error:'PAGE_IDENTITY_CHANGED'};
  await f.watch(receiptPending);
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
  assert.equal(Object.keys(f.local.bindingWaits??{}).length,1);
  assert.equal(f.calls.some(c=>c.body?.kind==='receipt_recovered'||c.message==='command'),false);
});
test('BIND23 a reused old tab on a different Conversation cannot terminate an uncertain Send',async()=>{
  const f=await worker();
  f.state.tab.url='https://chatgpt.com/c/unrelated-chat';
  await f.watch(receiptPending);
  assert.equal(f.calls.some(c=>c.body?.kind==='binding_lost'),false);
  assert.equal(Object.keys(f.local.bindingWaits??{}).length,1);
  assert.equal(f.calls.some(c=>c.body?.kind==='receipt_recovered'||c.message==='command'),false);
});
