import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const contentSource=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
const backgroundSource=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
const url='https://chatgpt.com/c/chat-browser',extensionId='a'.repeat(32);
const nativeUser=(id,text)=>({id,role:'user',text,final:true});

function contentPage(users){
  let listener,sendCount=0;
  const sandbox={
    console,URL,crypto:webcrypto,Promise,setTimeout,clearTimeout,
    location:{href:url,pathname:'/c/chat-browser',hostname:'chatgpt.com'},
    addEventListener:()=>{},removeEventListener:()=>{},
    setInterval:()=>0,clearInterval:()=>{},performance:{now:()=>1},
    CIP_DOM:{
      conversationId:()=> 'chat-browser',
      refreshTranscript:async()=>{},messages:()=>users,
      send:()=>{sendCount++}
    },
    chrome:{runtime:{id:extensionId,onMessage:{addListener:fn=>{listener=fn}},
      sendMessage:async()=>({ok:true,value:{}})}}
  };
  vm.runInNewContext(contentSource,sandbox);
  return {
    message:async session=>new Promise(resolve=>listener({type:'external-candidate',session},{id:extensionId},resolve)),
    sent:()=>sendCount
  };
}

test('COS1-W1: idle ChatGPT page identifies only a NEW anchored user, without sending a message',async()=>{
  const users=[nativeUser('old-user','Before'),nativeUser('new-user','Manual browser prompt')];
  const page=contentPage(users);
  const s={conversationId:'chat-browser',previousNativeMessageId:'old-user'};
  const observation=await page.message(s);
  assert.equal(observation.ok,true);
  assert.equal(observation.value.available,true);
  assert.equal(observation.value.nativeMessageId,'new-user');
  assert.equal(observation.value.text,'Manual browser prompt');
  assert.equal(page.sent(),0);
  const unknown=await page.message({...s,previousNativeMessageId:'not-in-document'});
  assert.equal(unknown.value.available,false);
  users.push(nativeUser('third-user','One more'));
  const ambiguous=await page.message(s);
  assert.equal(ambiguous.value.available,false);
  assert.equal(page.sent(),0);
});

function browserWorker(){
  let tab={id:71,url},report={available:true,documentKey:'document-new',url,
    previousNativeMessageId:'old-user',nativeMessageId:'new-user',text:'Manual browser prompt'};
  const calls=[], local={config:{endpoint:'http://127.0.0.1:17843',token:'test-token'},
    tabs:{71:{sessionId:'session-a',documentKey:'document-old'}}};
  const session={sessionId:'session-a',conversationId:'chat-browser',tabId:71,
    documentKey:'document-old',previousNativeMessageId:'old-user'};
  const sandbox={
    console,URL,crypto:webcrypto,AbortSignal,setTimeout,clearTimeout,structuredClone,
    fetch:async(target,options)=>{
      const route=new URL(target).pathname,body=options?.body?JSON.parse(options.body):null;
      calls.push({route,body});
      const answer=route==='/external-turn'
        ? {sessionId:session.sessionId,conversationId:session.conversationId,turnId:'new-turn',
          lease:'new-lease',nativeMessageId:'new-user',documentKey:report.documentKey,tabId:71,imported:true}
        : {accepted:true};
      return {ok:true,text:async()=>JSON.stringify(answer)};
    },
    chrome:{
      storage:{local:{setAccessLevel:async()=>{},get:async()=>structuredClone(local),
        set:async value=>Object.assign(local,structuredClone(value))},
        session:{get:async()=>({}),set:async()=>{}}},
      runtime:{id:extensionId,getURL:p=>'chrome-extension://'+extensionId+'/'+p,
        onMessage:{addListener:()=>{}},onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}}},
      alarms:{onAlarm:{addListener:()=>{}},create:()=>{}},
      tabs:{
        get:async(id)=>{if(!tab||tab.id!==id)throw new Error('tab not found');return tab;},
        query:async()=>tab?[tab]:[],
        sendMessage:async(id,message)=>{
          calls.push({message:message.type,tabId:id});
          if(message.type==='external-candidate')return {ok:true,value:report};
          if(message.type==='monitor')return {ok:true,value:{active:true}};
          return {ok:false,error:'UNEXPECTED'}
        },
        onRemoved:{addListener:()=>{}}
      }
    }
  };
  const src=backgroundSource.replace(/\nvoid pump\(\);\s*$/,'');
  vm.runInNewContext(src+'\nglobalThis.__test={load,watch:session=>watchIdle(session,config)};',sandbox);
  return {session,local,calls,setTab:t=>{tab=t},setCandidate:x=>{report=x},
    run:async()=>{await sandbox.__test.load();await sandbox.__test.watch(session)}};
}

test('COS1-W2: Chrome worker forwards native user event, never queues a second Send',async()=>{
  const f=browserWorker();
  await f.run();
  const imported=f.calls.filter(x=>x.route==='/external-turn');
  assert.equal(imported.length,1);
  assert.equal(imported[0].body.nativeMessageId,'new-user');
  assert.equal(imported[0].body.previousNativeMessageId,'old-user');
  assert.equal(imported[0].body.text,'Manual browser prompt');
  assert.ok(f.calls.some(x=>x.message==='monitor'));
  assert.equal(f.calls.some(x=>x.route==='/authorize'||x.route==='/claim'||x.message==='command'),false);
  assert.equal(f.local.tabs[71].documentKey,'document-new');
});

test('COS1-W3: worker declines conflicting routes and unverified candidates',async()=>{
  const f=browserWorker();
  f.setTab({id:71,url:'https://chatgpt.com/c/unrelated'});
  await f.run();
  assert.equal(f.calls.some(x=>x.route==='/external-turn'),false);
  const g=browserWorker();
  g.setCandidate({available:false});
  await g.run();
  assert.equal(g.calls.some(x=>x.route==='/external-turn'),false);
});
