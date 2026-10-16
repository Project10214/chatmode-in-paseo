import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const harnessScript = source.replace(/\nvoid pump\(\);\s*$/, '') +
  '\nglobalThis.testArchive={load, close:(command,claim)=>closeArchivedTab(command,claim,config)};';
const command = { id:'command-close', kind:'close-tab', sessionId:'session-a',
  payload:{tabId:71,documentKey:'document-a',conversationId:'durable-chat'} };
const claim = { id:command.id, lease:'lease-a' };

async function harness({ active=false, ownedKey='document-a', pageKey='document-a', idle=true } = {}) {
  const requests=[], removed=[];
  const local={config:{endpoint:'http://127.0.0.1:17843',token:'fake-token'},
    loadedChromeVersion:'0.2.22',
    tabs:{71:{sessionId:'session-a',documentKey:ownedKey}}};
  const session={};
  const context=vm.createContext({
    URL, AbortSignal, structuredClone, crypto:webcrypto, console, setTimeout, clearTimeout,
    fetch:async(url,opts)=>{
      const path=new URL(url).pathname;
      requests.push({path,body:opts?.body ? JSON.parse(opts.body) : null});
      return {ok:true,text:async()=>JSON.stringify({allowed:true})};
    },
    chrome:{
      runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,
        getManifest:()=>({version:'0.2.22'}),
        onMessage:{addListener:()=>{}},onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}}},
      storage:{
        local:{setAccessLevel:async()=>{},get:async()=>structuredClone(local),
          set:async value=>Object.assign(local,structuredClone(value))},
        session:{get:async()=>structuredClone(session),
          set:async value=>Object.assign(session,structuredClone(value))}
      },
      alarms:{onAlarm:{addListener:()=>{}},create:()=>{}},
      tabs:{
        get:async id=>({id,url:'https://chatgpt.com/c/durable-chat',active}),
        sendMessage:async(id,message)=>{
          assert.equal(message.type,'archive-idle');
          return {ok:true,value:{documentKey:pageKey,
            url:'https://chatgpt.com/c/durable-chat',idle}};
        },
        remove:async id=>removed.push(id),
        onRemoved:{addListener:()=>{}}
      }
    }
  });
  vm.runInContext(harnessScript,context);
  await context.testArchive.load();
  return {close:()=>context.testArchive.close(command,claim),requests,removed,local};
}

test('ARCHIVE-EXT-ACTIVE: current active ChatGPT tab is never closed', async()=>{
  const f=await harness({active:true});
  assert.equal((await f.close()).skipped,'ACTIVE_TAB');
  assert.deepEqual(f.removed,[]);
  assert.equal(f.requests.some(r=>r.path==='/verify-tab-close'),false);
});

test('ARCHIVE-EXT-DOCUMENT: a replaced document key is never closed', async()=>{
  for(const options of [{ownedKey:'new-document'},{pageKey:'new-document'}]){
    const f=await harness(options);
    assert.equal((await f.close()).skipped,'DOCUMENT_CHANGED');
    assert.deepEqual(f.removed,[]);
  }
});

test('ARCHIVE-EXT-IDLE: only an owned matching idle background tab can close', async()=>{
  const f=await harness();
  const result=await f.close();
  assert.equal(result.closed,true);
  assert.deepEqual(f.removed,[71]);
  assert.equal(f.requests.filter(r=>r.path==='/verify-tab-close').length,1);
});
