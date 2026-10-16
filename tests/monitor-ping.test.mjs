import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const source=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
const wait=()=>new Promise(resolve=>setImmediate(resolve));
const url='https://chatgpt.com/c/chat-test', extensionId='a'.repeat(32);

function fixture({final=true}={}){
 let listener=null,clock=1000,refreshCount=0,sendCount=0;
 const events=[];
 const state=()=>({
   busy:!final,waiting:false,error:null,
   activity:{phase:final?'completed':'thinking',nativeStatus:final?'complete':'in_progress',steps:[]},
   answer:{id:'assistant-1',text:'HELLO',final},
   timeline:null,images:[],imageFinalId:null
 });
 const D={conversationId:()=> 'chat-test',
   refreshTranscript:async()=>{refreshCount++;},
   state:()=>state(),messages:()=>[],send:()=>{sendCount++;}
 };
 const c={crypto:webcrypto,Promise,setTimeout,clearTimeout,performance:{now:()=>clock},
   URL,location:{hostname:'chatgpt.com',pathname:'/c/chat-test',href:url},
   addEventListener:()=>{},removeEventListener:()=>{},setInterval:()=>1,clearInterval:()=>{},
   CIP_DOM:D,chrome:{runtime:{id:extensionId,
      onMessage:{addListener:cb=>{listener=cb;}},
      sendMessage:async message=>{
        if(message.type==='observation'){events.push(message.event);return {ok:true,value:{active:true}};}
        return {ok:true,value:{}};
      }
   }}
 };
 vm.runInNewContext(source,c);
 const s={sessionId:'sid-1',turnId:'turn-1',lease:'lease-1',tabId:71,
   documentKey:c.__CIP_CONTENT__.documentKey,conversationId:'chat-test',nativeMessageId:'user-1'};
 return {events,setTime:value=>clock=value,refreshCount:()=>refreshCount,sendCount:()=>sendCount,
   async monitor(){
     const result=await new Promise(resolve=>listener({type:'monitor',session:s},{id:extensionId},resolve));
     for(let i=0;i<30;i++)await wait();
     return result;
   }
 };
}

test('TURN monitor pulse drives an identity-bound native completion when browser tab timers are throttled',async()=>{
 const f=fixture();
 const first=await f.monitor();
 assert.equal(first.ok,true);
 assert.equal(first.value.active,false,'background ping does not itself claim native activity');
 assert.ok(f.events.some(x=>x.kind==='snapshot'&&x.messageId==='assistant-1'));
 assert.equal(f.events.some(x=>x.kind==='completed'),false);
 f.setTime(2600);
 await f.monitor();
 const done=f.events.filter(x=>x.kind==='completed');
 assert.equal(done.length,1);
 assert.equal(done[0].finalConfirmed,true);
 assert.ok(f.events.every(x=>x.nativeMessageId==='user-1'&&x.turnId==='turn-1'));
 assert.equal(f.sendCount(),0,'monitor must never issue native Send');
 assert.ok(f.refreshCount()>=2);
});
test('TURN monitor pulse does not invent completion while native turn is still in_progress',async()=>{
 const f=fixture({final:false});
 await f.monitor();f.setTime(8000);await f.monitor();
 assert.equal(f.events.some(x=>x.kind==='completed'),false);
 assert.equal(f.sendCount(),0);
});
