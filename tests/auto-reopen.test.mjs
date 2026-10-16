import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const background=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const engine=/'X-CIP-Engine': '([^']+)'/.exec(background)[1];
async function fixture({oldUrl=null,latestNative='newer-from-web',redirect=false}={}) {
  const calls=[],tabs=new Map(),local={config:{endpoint:'http://127.0.0.1:17843',token:'test-only'},tabs:{}},session={};
  let created=0;
  if(oldUrl)tabs.set(71,{id:71,url:oldUrl});
  const command={id:'ensure-1',kind:'ensure',sessionId:'s1',payload:{
    tabId:71,conversationId:'bound-conversation',previousNativeMessageId:null,
    config:{model:'model-test',thinkingOption:null,appIds:[]}}};
  const response=(value)=>({ok:true,text:async()=>JSON.stringify(value)});
  const context=vm.createContext({
    URL,AbortSignal,structuredClone,crypto:webcrypto,setTimeout,clearTimeout,console,
    fetch:async (url,opts)=>{
      const route=new URL(url).pathname, body=opts.body?JSON.parse(opts.body):{};
      calls.push({route,body});
      if(route==='/claim')return response({...command,tabId:body.tabId,
        documentKey:body.documentKey,lease:'lease-1',deadline:Date.now()+60000});
      return response({accepted:true});
    },
    chrome:{
      runtime:{id:'a'.repeat(32),getURL:f=>'chrome-extension://'+'a'.repeat(32)+'/'+f,
        sendNativeMessage:async(name,payload)=>{calls.push({native:name,payload});return {ok:true};},
        onMessage:{addListener:()=>{}},onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}}},
      storage:{
        local:{setAccessLevel:async()=>{},get:async()=>structuredClone(local),set:async value=>Object.assign(local,structuredClone(value))},
        session:{get:async()=>structuredClone(session),set:async value=>Object.assign(session,structuredClone(value))}
      },
      alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},
      tabs:{
        get:async id=>{if(!tabs.has(id))throw new Error('missing tab');return tabs.get(id);},
        create:async({url,active})=>{created++;const t={id:71+created,url:redirect?'https://chatgpt.com/c/foreign-chat':url,active};tabs.set(t.id,t);return t;},
        sendMessage:async(id,msg)=>{
          if(msg.type==='identity')return {ok:true,value:{engine,documentKey:'doc-'+id,
            url:tabs.get(id).url,nativeMessageId:latestNative}};
          if(msg.type==='command')return {ok:true,value:{
            config:command.payload.config,url:tabs.get(id).url,tabId:id,nativeMessageId:latestNative}};
          return {ok:true};
        },
        query:async()=>[],onRemoved:{addListener:()=>{}},remove:async()=>{}
      }
    }
  });
  vm.runInContext(background.replace(/\nvoid pump\(\);\s*$/,'')+
    '\nglobalThis.__test={load,execute,ledger,tabs,wakePaseoIfOffline};',context);
  await context.__test.load();
  return {command,run:()=>context.__test.execute(command),wake:error=>context.__test.wakePaseoIfOffline(error),calls,get created(){return created;},tabs};
}

test('REOPEN-V1 closed tab + bound Conversation reopens without any old native message ID',async()=>{
  const f=await fixture();await f.run();
  assert.equal(f.created,1);
  assert.equal(f.tabs.get(72).url,'https://chatgpt.com/c/bound-conversation');
  assert.equal(f.calls.filter(x=>x.route==='/claim').length,1);
  assert.equal(f.calls.filter(x=>x.route==='/result').length,1);
  assert.equal(f.calls.filter(x=>x.route==='/authorize').length,0);
  assert.equal(f.calls.find(x=>x.route==='/claim').body.reopened,true);
  await f.run(); // The same command cannot be sent/claimed twice.
  assert.equal(f.created,1);
  assert.equal(f.calls.filter(x=>x.route==='/claim').length,1);
});
test('REOPEN-V2 reused old tab on a foreign URL is never navigated or stolen',async()=>{
  const f=await fixture({oldUrl:'https://chatgpt.com/c/someone-else'});
  await f.run();
  assert.equal(f.tabs.get(71).url,'https://chatgpt.com/c/someone-else');
  assert.equal(f.tabs.get(72).url,'https://chatgpt.com/c/bound-conversation');
  assert.equal(f.calls.find(x=>x.route==='/claim').body.reopened,true);
});
test('REOPEN-V3 same bound tab with newer native user ID does not force a new chat',async()=>{
  const f=await fixture({oldUrl:'https://chatgpt.com/c/bound-conversation',latestNative:'newer-from-web'});
  f.command.payload.previousNativeMessageId='old-message';
  await f.run();
  assert.equal(f.created,0);
  assert.equal(f.calls.find(x=>x.route==='/claim').body.nativeMessageId,'newer-from-web');
  assert.equal(f.calls.filter(x=>x.route==='/result').length,1);
});
test('REOPEN-V4 wrong destination refuses claim and never enters a Send path',async()=>{
  const f=await fixture({redirect:true});
  await f.run();
  assert.equal(f.calls.filter(x=>x.route==='/claim').length,0);
  assert.equal(f.calls.filter(x=>x.route==='/fail-unclaimed').length,1);
  assert.equal(f.calls.find(x=>x.route==='/fail-unclaimed').body.error,'WRONG_CONVERSATION');
});

test('REOPEN-V5 only offline transport can wake Paseo, never an auth/protocol error',async()=>{
  const f=await fixture();
  await f.wake(Object.assign(new Error('auth'),{code:'AUTH_REQUIRED'}));
  await f.wake(Object.assign(new Error('incompatible'),{code:'PROTOCOL_MISMATCH'}));
  assert.equal(f.calls.filter(x=>x.native).length,0);
  await f.wake(new TypeError('Connection refused'));
  await f.wake(new TypeError('Connection refused'));
  const native=f.calls.filter(x=>x.native);
  assert.equal(native.length,1,'cooldown avoids a restart loop');
  assert.equal(native[0].native,'com.foolwork.cos_in_paseo_wake');
  assert.equal(JSON.stringify(native[0].payload),JSON.stringify({v:1,action:'wake'}));
  assert.equal(f.calls.filter(x=>x.route==='/authorize'||x.route==='/claim').length,0);
});
