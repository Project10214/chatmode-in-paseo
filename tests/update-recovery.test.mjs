import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const script=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const workerSource=script.replace(/\nvoid pump\(\);\s*$/,'')+
  '\nglobalThis.testWorker={pump,load,upgrade:()=>upgradeRecovery};';
const ENGINE='cos-native-alpha4.3', VERSION='0.2.14', LINK='https://chatgpt.com/c/bound-chat';
const bound={sessionId:'session-1',conversationId:'bound-chat',tabId:71};

async function worker({
  targets=[bound], local=null, oldEngine=false, reloadCompletes=true,
  route=LINK, extraUnrelated=true,commands=[],legacyRuntime=false
}={}){
  const events={},requests=[],reloads=[],stored=local??{
    config:{endpoint:'http://127.0.0.1:17843',token:'demo-only'},
    tabs:{71:{sessionId:bound.sessionId,documentKey:'old-document'}},
    loadedChromeVersion:VERSION
  },ephemeral={};
  if(commands.some(c=>c.sessionId==='session-2'))
    stored.tabs[99]={sessionId:'session-2',documentKey:'doc-99'};
  const tabs=new Map([[71,{id:71,url:route}]]);
  if(extraUnrelated)tabs.set(99,{id:99,url:'https://chatgpt.com/c/other-private-chat'});
  let fresh=!oldEngine,upgraded=!legacyRuntime;
  const respond=value=>({ok:true,text:async()=>JSON.stringify(value)});
  const context=vm.createContext({
    URL,AbortSignal,structuredClone,crypto:webcrypto,console,Date,
    setTimeout:(callback,ms)=>ms===1000?0:setTimeout(callback,ms),
    clearTimeout:handle=>{if(handle)clearTimeout(handle);},
    fetch:async (input,opts)=>{
      const name=new URL(input).pathname,body=opts?.body?JSON.parse(opts.body):null;
      requests.push({name,body});
      if(name==='/hello')return respond({protocol:5,product:'cos-in-paseo'});
      if(name==='/recovery-targets'){
        if(!upgraded)return {ok:false,text:async()=>JSON.stringify({error:'ROUTE_NOT_FOUND'})};
        return respond({sessions:targets});
      }
      if(name==='/resume-agent'){
        if(!upgraded)return {ok:false,text:async()=>JSON.stringify({error:'ROUTE_NOT_FOUND'})};
        return respond({queued:true});
      }
      if(name==='/commands')return respond({commands});
      if(name==='/claim'){
        const command=commands.find(c=>c.id===body.id);
        return respond({...command,tabId:body.tabId,
          documentKey:body.documentKey,lease:'mock-lease',deadline:Date.now()+30000});
      }
      if(name==='/active'||name==='/bindings')
        return respond({sessions:upgraded?[]:targets});
      return respond({accepted:true});
    },
    chrome:{
      runtime:{
        id:'a'.repeat(32),getURL:relative=>'chrome-extension://'+'a'.repeat(32)+'/'+relative,
        getManifest:()=>({version:VERSION}),
        onMessage:{addListener:()=>{}},
        onInstalled:{addListener:fn=>events.install=fn},
        onStartup:{addListener:fn=>events.startup=fn},
        sendNativeMessage:async()=>({ok:true})
      },
      alarms:{onAlarm:{addListener:()=>{}},create:()=>{}},
      storage:{
        local:{setAccessLevel:async()=>{},get:async()=>structuredClone(stored),
          set:async patch=>Object.assign(stored,structuredClone(patch))},
        session:{get:async()=>structuredClone(ephemeral),
          set:async patch=>Object.assign(ephemeral,structuredClone(patch))}
      },
      tabs:{
        get:async id=>{if(!tabs.has(id))throw Error('No such tab');return tabs.get(id);},
        query:async()=>[...tabs.values()],
        reload:async id=>{reloads.push(id);if(reloadCompletes)fresh=true;},
        sendMessage:async (id,msg)=>{
          if(msg.type==='identity')return {ok:true,value:{
            engine:id===99||fresh?ENGINE:'cos-native-alpha4.1',url:tabs.get(id).url,
            documentKey:fresh?'fresh-document':'old-document',
            nativeMessageId:'still-the-native-user'
          }};
          if(msg.type==='command')return {ok:true,value:{receipt:true,nativeMessageId:'safe-other-user',url:tabs.get(id).url}};
          return {ok:false,error:'UNEXPECTED'};
        },
        onRemoved:{addListener:()=>{}}
      }
    }
  });
  vm.runInContext(workerSource,context);
  await context.testWorker.load();
  return {
    local:stored,requests,reloads,events,tabs,
    start:async reason=>{events.install({reason});await context.testWorker.pump();},
    pump:()=>context.testWorker.pump(),
    update:()=>context.testWorker.upgrade(),
    setFresh:flag=>{fresh=flag;},
    upgradeServer:()=>{upgraded=true;},
    setPendingAge:ms=>{
      for(const target of stored.upgradeRecovery?.targets??[])
        if(target.phase==='reload_requested')target.requestedAt=Date.now()-ms;
      // Mirrors persisted storage across MV3 worker restart, not a live mutation.
    }
  };
}

test('UPDATE1 Chrome extension update refreshes ONLY owned bound Conversation, THEN wakes original Agent',async()=>{
  const f=await worker();
  await f.start('update');
  assert.deepEqual(f.reloads,[71]);
  const serverEvents=f.requests.filter(x=>x.name==='/resume-agent');
  assert.equal(serverEvents.length,1);
  assert.equal(serverEvents[0].body.sessionId,bound.sessionId);
  assert.equal(serverEvents[0].body.conversationId,bound.conversationId);
  assert.ok(!f.local.upgradeRecovery);
  assert.equal(f.requests.filter(x=>['/claim','/authorize','/result','/external-turn'].includes(x.name)).length,0);
  assert.equal(f.tabs.get(99).url,'https://chatgpt.com/c/other-private-chat');
  await f.pump();assert.deepEqual(f.reloads,[71],'repeat pump must not re-refresh');
});

test('UPDATE2 install/startup without an UPDATE event does not refresh existing chats',async()=>{
  const f=await worker();
  await f.start('install');
  assert.deepEqual(f.reloads,[]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,0);
});

test('UPDATE3 stale tab mapping or wrong Conversation never refreshes an unrelated ChatGPT tab',async()=>{
  const f=await worker({route:'https://chatgpt.com/c/not-our-chat'});
  await f.start('update');
  assert.deepEqual(f.reloads,[]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,0);
  const g=await worker({local:{config:{endpoint:'http://127.0.0.1:17843',token:'demo-only'},tabs:{71:{sessionId:'someone-else'}}}});
  await g.start('update');
  assert.deepEqual(g.reloads,[]);
  assert.equal(g.requests.filter(x=>x.name==='/resume-agent').length,0);
});

test('UPDATE4 after worker restart, a completed refresh resumes wake WITHOUT a second reload',async()=>{
  const persisted={config:{endpoint:'http://127.0.0.1:17843',token:'demo-only'},
    loadedChromeVersion:VERSION,
    tabs:{71:{sessionId:bound.sessionId,documentKey:'old-document'}},
    upgradeRecovery:{phase:'refresh',createdAt:Date.now(),targets:[
      {...bound,phase:'reload_requested',attempts:1,requestedAt:Date.now()-1000}
    ]}};
  const f=await worker({local:persisted});
  await f.pump();
  assert.deepEqual(f.reloads,[]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,1);
  assert.equal(f.local.upgradeRecovery,null);
});

test('UPDATE5 missing new content script is retried but no new Send/Agent wake is fabricated',async()=>{
  const f=await worker({oldEngine:true,reloadCompletes:false});
  await f.start('update');
  assert.deepEqual(f.reloads,[71]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,0);
  assert.equal(f.local.upgradeRecovery.targets[0].phase,'reload_requested');
  await f.pump();
  assert.deepEqual(f.reloads,[71],'must not enter a rapid refresh loop');
  // A follow-up retry can finish after the page is actually ready.
  f.setFresh(true);await f.pump();
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,1);
});

test('UPDATE6 duplicate bound tab targets do not cause duplicate reloads or Agent wake',async()=>{
  const f=await worker({targets:[bound,{sessionId:'session-2',conversationId:'bound-chat',tabId:71}]});
  await f.start('update');
  assert.deepEqual(f.reloads,[71]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,1);
});

test('UPDATE7 one stale tab cannot block an unrelated Agent command pipeline',async()=>{
  const ownerCommand={id:'owned-wait',kind:'send',sessionId:'session-1',
    payload:{tabId:71,turnId:'turn-one'},createdAt:Date.now()};
  const otherCommand={id:'other-safe',kind:'send',sessionId:'session-2',
    payload:{tabId:99,turnId:'turn-two'},createdAt:Date.now()};
  const f=await worker({oldEngine:true,reloadCompletes:false,
    commands:[ownerCommand,otherCommand]});
  await f.start('update');
  for(let i=0;i<40&&!f.requests.some(x=>x.name==='/claim'&&x.body.id==='other-safe');i++)
    await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.local.upgradeRecovery.targets[0].phase,'reload_requested');
  assert.equal(f.requests.some(x=>x.name==='/claim'&&x.body.id==='owned-wait'),false);
  assert.equal(f.requests.some(x=>x.name==='/claim'&&x.body.id==='other-safe'),true);
});

test('UPDATE8 Chrome-first rolling upgrade refreshes the tab now, activates after Paseo Runtime upgrade',async()=>{
  const f=await worker({legacyRuntime:true});
  await f.start('update');
  assert.deepEqual(f.reloads,[71]);
  assert.equal(f.local.upgradeRecovery.targets[0].phase,'ready');
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,1);
  // The old Runtime has no /resume-agent; keep the durable plan, do not replay Send.
  await f.pump();
  assert.deepEqual(f.reloads,[71],'no second reload during staged upgrade');
  f.upgradeServer();
  await f.pump();
  assert.equal(f.local.upgradeRecovery,null);
  assert.deepEqual(f.reloads,[71]);
  assert.equal(f.requests.filter(x=>x.name==='/claim'||x.name==='/authorize').length,0);
});

test('UPDATE9 a newer extension version supersedes an unfinished prior-version recovery job',async()=>{
  const local={
    config:{endpoint:'http://127.0.0.1:17843',token:'demo-only'},
    loadedChromeVersion:VERSION,
    tabs:{71:{sessionId:bound.sessionId,documentKey:'previous-document'}},
    upgradeRecovery:{engine:'cos-native-alpha4.2',phase:'refresh',
      targets:[{...bound,phase:'done',attempts:1}],createdAt:Date.now()-60000}
  };
  const f=await worker({local});
  await f.start('update');
  assert.deepEqual(f.reloads,[71]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,1);
});

test('UPDATE10 a second actual update event restarts discovery even when engine name is unchanged',async()=>{
  const f=await worker({oldEngine:true,reloadCompletes:false});
  await f.start('update');
  assert.deepEqual(f.reloads,[71]);
  assert.equal(f.local.upgradeRecovery.targets[0].phase,'reload_requested');
  // Patch extension 0.2.3 -> 0.2.4 can leave engine cos-native-alpha4.3
  // unchanged. The new update still needs the CURRENT script reloaded.
  await f.start('update');
  assert.deepEqual(f.reloads,[71,71]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,0,
    'a second update must not invent an Agent wake before script readiness');
  assert.equal(f.requests.filter(x=>x.name==='/claim'||x.name==='/authorize').length,0);
});

test('UPDATE11 developer-mode reload recognizes a CHANGED manifest without onInstalled(update)',async()=>{
  const local={
    config:{endpoint:'http://127.0.0.1:17843',token:'demo-only'},
    tabs:{71:{sessionId:bound.sessionId,documentKey:'old-document'}},
    loadedChromeVersion:'0.2.6'
  };
  const f=await worker({local});
  // Chrome's development reload does NOT reliably dispatch the update reason.
  // The new service worker must discover the changed manifest and recover.
  await f.pump();
  assert.equal(f.local.loadedChromeVersion,VERSION);
  assert.deepEqual(f.reloads,[71]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,1);
  assert.equal(f.requests.filter(x=>['/claim','/authorize','/result','/external-turn'].includes(x.name)).length,0);
  await f.pump();
  assert.deepEqual(f.reloads,[71],'ordinary MV3 worker activity cannot reload twice');
});
test('UPDATE12 first versioned startup from legacy paired state refreshes exactly once',async()=>{
  const f=await worker({local:{
    config:{endpoint:'http://127.0.0.1:17843',token:'demo-only'},
    tabs:{71:{sessionId:bound.sessionId,documentKey:'old-document'}}
  }});
  await f.pump();
  assert.equal(f.local.loadedChromeVersion,VERSION);
  assert.deepEqual(f.reloads,[71]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,1);
  await f.pump();
  assert.deepEqual(f.reloads,[71]);
});
test('UPDATE13 new unpaired installation records version without reloading any tab',async()=>{
  const f=await worker({local:{
    config:{endpoint:'http://127.0.0.1:17843',token:null},
    tabs:{}
  }});
  await f.pump();
  assert.equal(f.local.loadedChromeVersion,VERSION);
  assert.deepEqual(f.reloads,[]);
  assert.equal(f.local.upgradeRecovery,undefined);
});
test('UPDATE14 regular same-version startup does not refresh a bound ChatGPT tab',async()=>{
  const f=await worker();
  await f.pump();
  assert.deepEqual(f.reloads,[]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,0);
});

test('UPDATE15 late onInstalled(update) after version-change fallback never double-refreshes a tab',async()=>{
  const local={config:{endpoint:'http://127.0.0.1:17843',token:'demo-only'},
    tabs:{71:{sessionId:bound.sessionId,documentKey:'old-document'}},
    loadedChromeVersion:'0.2.6'};
  const f=await worker({local});
  await f.pump(); // manifest change already discovered and recovered
  assert.deepEqual(f.reloads,[71]);
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,1);
  await f.start('update'); // same Chrome update event delivered afterward
  assert.deepEqual(f.reloads,[71],'delayed event must not reload twice');
  assert.equal(f.requests.filter(x=>x.name==='/resume-agent').length,1);
});
