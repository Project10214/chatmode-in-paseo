import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

const content=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');

function pageFixture(t,behavior,{initialRoute='/c/bound',boundId='bound'}={}){
  const base='https://chatgpt.com',events={navigate:[],currententrychange:[],popstate:[],hashchange:[]};
  let route=initialRoute;
  const location={
    hostname:'chatgpt.com',get pathname(){return route;},
    get href(){return base+route;},set pathname(value){route=value;}
  };
  const listeners={};
  const navigation={
    addEventListener(name,fn){(events[name]??=[]).push(fn);},
    removeEventListener(name,fn){events[name]=(events[name]||[]).filter(x=>x!==fn);}
  };
  const D={
    conversationId:()=>/^\/c\/([A-Za-z0-9-]+)(?:\/|$)/.exec(route)?.[1]??null,
    configure:async(cfg,guard)=>{await behavior({location,emit,guard,phase:'configure'});return cfg;},
    send:async(command,authorize,guard)=>{
      await behavior({location,emit,guard,phase:'send'});
      guard();
      await authorize();
      guard(true);
      await behavior({location,emit,guard,phase:'afterDispatch'});
      guard(true);
      return {receipt:true,nativeMessageId:'native-first-send'};
    },
    refreshTranscript:async()=>{},
    messages:()=>[]
  };
  const emit=name=>{for(const fn of [...events[name]??[]])fn();};
  const bridgeMessages=[];
  const chrome={runtime:{id:'verified-paired-extension',
    sendMessage:async message=>{bridgeMessages.push(message);return {ok:true,value:{}};},
    onMessage:{addListener:fn=>{listeners.handle=fn;}}}};
  const windowEvents={};
  const context=vm.createContext({
    crypto:webcrypto,location,navigation,chrome,CIP_DOM:D,
    addEventListener(name,fn){(events[name]??=[]).push(fn);},
    removeEventListener(name,fn){events[name]=(events[name]||[]).filter(x=>x!==fn);},
    setInterval:()=>77,clearInterval:()=>{},
    performance:{now:()=>0},Date,setTimeout,clearTimeout,console
  });
  vm.runInContext(content,context);
  t.after(()=>context.__CIP_CONTENT__&&Object.values(windowEvents).forEach(()=>{}));
  async function command(kind='ensure'){
    const c={id:'command-'+kind,kind,documentKey:context.__CIP_CONTENT__.documentKey,
      payload:{turnId:'native-turn-1',conversationId:boundId,config:{model:'m1',thinkingOption:null,appIds:[]}},
      tabId:123,lease:'lease1',deadline:Date.now()+30000};
    return new Promise(resolve=>{
      const ret=listeners.handle({type:'command',command:c},{id:chrome.runtime.id},resolve);
      assert.equal(ret,true);
    });
  }
  return {command,emit,location,bridgeMessages};
}

test('COLDNAV1 harmless same-Conversation navigation during Ensure does not abort clean startup',async t=>{
  const f=pageFixture(t,async({emit,guard})=>{
    emit('navigate');
    emit('currententrychange');
    guard();
  });
  const result=await f.command();
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.value?.url,'https://chatgpt.com/c/bound');
  assert.equal(result.value?.tabId,123);
});
test('COLDNAV2 A-to-B-to-A during Ensure is refused despite matching final Conversation URL',async t=>{
  const f=pageFixture(t,async({location,emit,guard})=>{
    location.pathname='/c/another';emit('currententrychange');
    location.pathname='/c/bound';emit('currententrychange');
    guard();
  });
  const result=await f.command();
  assert.equal(result.ok,false);
  assert.equal(result.error,'NAVIGATION_CHANGED');
});
test('COLDNAV3 leaving the Conversation during Ensure never succeeds',async t=>{
  const f=pageFixture(t,async({location,emit,guard})=>{
    location.pathname='/';
    emit('currententrychange');
    guard();
  });
  const result=await f.command();
  assert.equal(result.ok,false);
  assert.equal(result.error,'WRONG_CONVERSATION');
});
test('COLDNAV4 configuring a bound chat refuses A-to-B-to-A even with matching final URL',async t=>{
  const f=pageFixture(t,async({location,emit,guard})=>{
    location.pathname='/c/foreign';emit('currententrychange');
    location.pathname='/c/bound';emit('currententrychange');
    guard();
  });
  const result=await f.command('configure');
  assert.equal(result.ok,false);
  assert.equal(result.error,'NAVIGATION_CHANGED');
});
test('NAVOPEN1 initial ChatGPT home emits navigate and currententrychange without changing page',async t=>{
  const f=pageFixture(t,async({emit,guard})=>{
    emit('navigate');emit('currententrychange');guard();
  },{initialRoute:'/',boundId:null});
  const result=await f.command('open');
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.value.url,'https://chatgpt.com/');
  assert.equal(result.value.tabId,123);
});
test('NAVOPEN2 initial new chat refuses route A-to-B-to-A, even if final URL is home',async t=>{
  const f=pageFixture(t,async({location,emit,guard})=>{
    location.pathname='/c/foreign';emit('currententrychange');
    location.pathname='/';emit('currententrychange');
    guard();
  },{initialRoute:'/',boundId:null});
  const result=await f.command('open');
  assert.equal(result.ok,false);
  assert.equal(result.error,'NAVIGATION_CHANGED');
});
test('NAVOPEN3 initial new chat refuses non-Conversation pathname detour and return',async t=>{
  const f=pageFixture(t,async({location,emit,guard})=>{
    location.pathname='/search';emit('currententrychange');
    location.pathname='/';emit('currententrychange');
    guard();
  },{initialRoute:'/',boundId:null});
  const result=await f.command('open');
  assert.equal(result.ok,false);
  assert.equal(result.error,'NAVIGATION_CHANGED');
});
test('NAVCONF1 a harmless same-page navigation event during bound configuration is safe',async t=>{
  const f=pageFixture(t,async({emit,guard})=>{
    emit('navigate');emit('currententrychange');guard();
  });
  const result=await f.command('configure');
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.value.url,'https://chatgpt.com/c/bound');
});
test('NAVCONF2 configuring on home also accepts harmless same-page events',async t=>{
  const f=pageFixture(t,async({emit,guard})=>{
    emit('navigate');emit('currententrychange');guard();
  },{initialRoute:'/',boundId:null});
  const result=await f.command('configure');
  assert.equal(result.ok,true,JSON.stringify(result));
});
test('NAVSEND1 new-chat Send ignores harmless pre-click navigation events',async t=>{
  const f=pageFixture(t,async({emit,guard,phase})=>{
    if(phase!=='send')return;
    emit('navigate');emit('currententrychange');guard();
  },{initialRoute:'/',boundId:null});
  const result=await f.command('send');
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.value.receipt,true);
  assert.equal(f.bridgeMessages.filter(e=>e.type==='authorize').length,1);
});
test('NAVSEND2 new-chat Send refuses actual A-to-B-to-A pre-click departure',async t=>{
  const f=pageFixture(t,async({location,emit,guard,phase})=>{
    if(phase!=='send')return;
    location.pathname='/c/foreign';emit('currententrychange');
    location.pathname='/';emit('currententrychange');
    guard();
  },{initialRoute:'/',boundId:null});
  const result=await f.command('send');
  assert.equal(result.ok,false);
  assert.equal(result.error,'NAVIGATION_CHANGED');
  assert.equal(f.bridgeMessages.filter(e=>e.type==='authorize').length,0);
});
test('NAVSEND3 after one authorized click, a new chat may acquire its first Conversation route',async t=>{
  const f=pageFixture(t,async({location,emit,guard,phase})=>{
    if(phase==='send'){emit('navigate');guard();}
    if(phase==='afterDispatch'){
      location.pathname='/c/new-message-conversation';
      emit('currententrychange');
    }
  },{initialRoute:'/',boundId:null});
  const result=await f.command('send');
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(f.bridgeMessages.filter(e=>e.type==='authorize').length,1);
  assert.equal(f.bridgeMessages.filter(e=>e.type==='bind-conversation').length,1);
});
test('NAVSEND4 a second Conversation departure after Send is always revoked',async t=>{
  const f=pageFixture(t,async({location,emit,phase})=>{
    if(phase!=='afterDispatch')return;
    location.pathname='/c/first-conversation';emit('currententrychange');
    location.pathname='/c/unrelated';emit('currententrychange');
  },{initialRoute:'/',boundId:null});
  const result=await f.command('send');
  assert.equal(result.ok,false);
  assert.equal(result.error,'SEND_LIFETIME_REVOKED');
  assert.equal(f.bridgeMessages.filter(e=>e.type==='authorize').length,1);
});
