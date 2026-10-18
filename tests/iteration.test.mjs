import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,selection,until} from './helpers.mjs';
import {createProvider,CAPABILITIES} from '../server/provider.mjs';
const config={cwd:'/fixture',env:{},mcpServers:{},settings:{},persist:true,...selection,providerOptions:{appIds:selection.appIds}};
const prompt=(sid,id='p1')=>({type:'session.prompt',sessionId:sid,prompt:{clientMessageId:id,delivery:'auto',input:{type:'message',content:[{type:'text',text:'hello'}]}}});
async function ctx(t){
 const f=await fixture(t),events=[];
 const c=await createProvider({...f,status:()=>({connected:true})}).connect({versions:[1],capabilities:CAPABILITIES});
 c.onEvent(e=>events.push(e));t.after(()=>c.close());
 const open=async(name='a')=>{await c.send({type:'session.open',sessionId:name,requestId:'open-'+name,history:'skip',config});await until(()=>events.some(e=>e.type==='session.ready'&&e.sessionId===name));return events.find(e=>e.type==='session.opened'&&e.sessionId===name).persistence.data.id;};
 return{...f,c,events,open};
}
test('I01 opening and configuring Paseo sessions never launches a tab before first Send',async t=>{
 const f=await ctx(t),sid=await f.open();assert.equal(f.broker.queued().length,0);assert.equal(f.broker.snapshot(sid).tabId,null);
 await f.c.send({type:'session.configure',sessionId:'a',requestId:'cfg',changes:{model:'m2'}});
 await until(()=>f.events.some(e=>e.type==='request.completed'&&e.requestId==='cfg'));
 assert.equal(f.broker.snapshot(sid).config.model,'m2');assert.equal(f.broker.queued().length,0);
 assert(f.events.some(e=>e.type==='session.notice'&&e.notice.id==='native-config-pending'));
});
test('I02 duplicate first Send creates exactly one open and one native Send intent',async t=>{
 const f=await ctx(t),sid=await f.open();await f.c.send(prompt('a'));await f.c.send(prompt('a'));
 const cmd=await until(()=>f.broker.queued().find(c=>c.kind==='open'));assert.equal(f.broker.queued().length,1);
 const lease=await f.broker.claim(cmd.id,901,'doc901');await f.broker.result(cmd.id,lease.lease,{tabId:901,url:'https://chatgpt.com/',config:selection});
 const send=await until(()=>f.broker.queued().find(c=>c.kind==='send'));
 assert.equal(f.broker.queued().filter(c=>c.kind==='send').length,1);
 assert.equal(f.broker.snapshot(sid).tabId,901);
 // Acceptance is reported once the dispatched Send is observed/settled; a
 // queued intent alone is not acceptance.
 const claim=await f.broker.claim(send.id,901,'doc901');
 await f.broker.authorize(send.id,claim.lease);
 await f.broker.result(send.id,claim.lease,{receipt:true,config:selection,tabId:901,
  url:'https://chatgpt.com/c/chat-901',nativeMessageId:'native-first'});
 await until(()=>f.events.filter(e=>e.type==='session.prompt_result').length===1);
 assert.equal(f.events.filter(e=>e.type==='session.prompt_result').length,1);
 assert.equal(f.broker.queued().length,0);
});
test('I03 Stop during first-tab preparation cancels the queued open, never authorizes Send',async t=>{
 const f=await ctx(t);await f.open();await f.c.send(prompt('a'));
 const cmd=await until(()=>f.broker.queued().find(c=>c.kind==='open'));
 await f.c.send({type:'session.interrupt',sessionId:'a',requestId:'stop'});
 await until(()=>f.events.some(e=>e.type==='session.prompt_result'&&e.result.type==='failed'));
 assert.equal(f.broker.queued().length,0);await assert.rejects(f.broker.claim(cmd.id,901,'late'),/COMMAND_NOT_CLAIMABLE/);
});
test('I04 native-config uncertainty during first Send blocks the session instead of sending anyway',async t=>{
 const f=await ctx(t),sid=await f.open();await f.c.send(prompt('a'));
 const cmd=await until(()=>f.broker.queued().find(c=>c.kind==='open')),lease=await f.broker.claim(cmd.id,901,'doc901');
 await f.broker.result(cmd.id,lease.lease,{error:'CONFIG_NOT_CONFIRMED'});
 await until(()=>f.events.some(e=>e.type==='session.prompt_result'&&e.result.type==='failed'));
 assert.equal(f.broker.snapshot(sid).status,'blocked');assert.equal(f.broker.queued().length,0);
});
test('I05 preparing A does not block independent B; configuration cannot race first Send on A',async t=>{
 const f=await ctx(t);await f.open('a');await f.open('b');await f.c.send(prompt('a'));await f.c.send(prompt('b'));
 await until(()=>f.broker.queued().filter(c=>c.kind==='open').length===2);
 await f.c.send({type:'session.configure',sessionId:'a',requestId:'race',changes:{model:'m2'}});
 const rejected=await until(()=>f.events.find(e=>e.type==='request.failed'&&e.requestId==='race'));assert.equal(rejected.error.code,'SESSION_BUSY');
 await f.c.send({type:'session.interrupt',sessionId:'a',requestId:'stopA'});
 await until(()=>f.broker.queued().length===1);assert.equal(f.broker.queued()[0].sessionId,f.events.find(e=>e.type==='session.opened'&&e.sessionId==='b').persistence.data.id);
});
test('I06 abort is checked inside atomic Send admission, not merely before the asynchronous disk queue',async t=>{
 const f=await fixture(t),s=await f.ready(),controller=new AbortController();
 controller.abort();await assert.rejects(f.broker.prompt(s.id,'abort','hello',{signal:controller.signal}),/SEND_CANCELLED/);
 assert.equal(f.broker.queued().length,0);assert.equal(f.broker.snapshot(s.id).status,'idle');
});
