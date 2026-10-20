import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const base=new URL('../',import.meta.url);
const main=await readFile(new URL('extension/upstream/cos-send-evidence.js',base),'utf8');
const isolated=await readFile(new URL('extension/upstream/cos-request-receipt.js',base),'utf8');
const native=await readFile(new URL('extension/upstream/cos-native.js',base),'utf8');
const CID='12345678-1234-4234-8234-123456789abc',OTHER='33333333-3333-4333-8333-333333333333',MID='11111111-1111-4111-8111-111111111111';
const TEXT='Synthetic first-send receipt fixture.';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function transport({start='/',moves=[],wrongBody=false,postFirst=true,afterProof=[]}={}){
  const handlers=new Map(),nav=new Map(),sent=[];let windowIdentity;
  const listen=(map,name,fn)=>{if(!map.has(name))map.set(name,new Set());map.get(name).add(fn);};
  const location={origin:'https://chatgpt.com',pathname:start};
  const w={location,URL,Request,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,document:{readyState:'complete'},Date,
    addEventListener:(name,fn)=>listen(handlers,name,fn),
    removeEventListener:(name,fn)=>handlers.get(name)?.delete(fn),
    navigation:{addEventListener:(name,fn)=>listen(nav,name,fn),removeEventListener:(name,fn)=>nav.get(name)?.delete(fn)},
    postMessage(data){sent.push(data);queueMicrotask(()=>{for(const fn of handlers.get('message')||[])fn({data,source:windowIdentity,origin:location.origin});});},
    fetch:async()=>({ok:true,url:'https://chatgpt.com/backend-api/f/conversation',headers:{get:()=> 'text/event-stream'}})};
  w.window=w;const context=vm.createContext(w);windowIdentity=vm.runInContext('window',context);vm.runInContext(main,context);vm.runInContext(isolated,context);
  const proof=await w.CIP_COS_SEND_RECEIPT.arm(TEXT),at=Date.now();assert.ok(proof);
  const move=path=>{location.pathname=path;for(const fn of nav.get('currententrychange')||[])fn();};
  const send=()=>w.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({conversation_id:null,messages:[{id:MID,author:{role:'user'},content:{parts:[wrongBody?'Other synthetic text.':TEXT]}}]})});
  let pending;if(postFirst)pending=send();
  for(const path of moves)move(path);
  if(!postFirst)pending=send();await pending;
  for(let i=0;i<100&&!['accepted','route','mismatch','shape'].includes(proof.status().stage);i++)await pause(5);
  for(const path of afterProof)move(path);
  const result={receipt:proof.since(at)?.id??null,...proof.status(),progress:sent.filter(x=>x.source==='cip-send-evidence-progress').map(x=>x.stage)};
  proof.close();assert.equal(proof.since(at),null);assert.equal(nav.get('currententrychange')?.size,1,'consumer route listener must be removed');return result;
}
async function nativeSend({start=null,target=CID,prior=false,wrongBody=false,authorized=true,edit=false}={}){
  let cid=start,rows=prior?[{id:MID,role:'user',text:TEXT,node:{}}]:[],clicks=0,why=null,check=()=>{};
  const box={isConnected:true,innerText:TEXT,textContent:TEXT,getAttribute:()=>null,querySelectorAll:()=>[]};
  const button={click(){clicks++;cid=target;rows=[{id:MID,role:'user',text:wrongBody?'Other synthetic text.':TEXT,node:{}}];}};
  const w={document:{documentElement:{}},setTimeout,clearTimeout,InputEvent:class{},MutationObserver:class{constructor(fn){check=fn;}observe(){}disconnect(){}}};
  vm.runInContext(native,vm.createContext(w));
  const engine=w.CIP_createCoSNative({composer:()=>box,conversationId:()=>cid,messages:()=>rows,generating:()=>false,stopButton:()=>null,sendButton:()=>button,sendButtonEnabled:()=>true});
  const result=await engine.send({acceptanceTimeoutMs:50,receiptTimeoutMs:5,clearAcceptedDraft:false,
    beforeSend:async()=>{if(edit){box.innerText=box.textContent='Human-edited synthetic draft.';}return authorized;},
    beforeClick:()=>true,acceptUserReceipt:(row,current)=>!!current&&row.id===MID&&row.text===TEXT,
    explain:reason=>{why=reason;}});
  return {receipt:result,clicks,refusal:why,draft:box.textContent===TEXT?'original':'changed'};
}

for(const postFirst of [true,false])test('FIRST-SEND confirms a body-bound new conversation '+(postFirst?'after':'before')+' the POST',async()=>{
  const result=await transport({moves:['/c/'+CID],postFirst});
  assert.equal(result.receipt,MID);assert.equal(result.stage,'accepted');
});
test('FIRST-SEND confirms a new conversation in the starting group',async()=>{
  assert.equal((await transport({start:'/g/fixture',moves:['/g/fixture/c/'+CID]})).receipt,MID);
});
test('FIRST-SEND allows two hops that only normalize the same new conversation trailing slash',async()=>{
  assert.equal((await transport({moves:['/c/'+CID+'/', '/c/'+CID]})).receipt,MID);
});
test('FIRST-SEND keeps existing-conversation receipts across trailing-slash normalization',async()=>{
  assert.equal((await transport({start:'/c/'+CID+'/',moves:['/c/'+CID]})).receipt,MID);
});
test('FIRST-SEND same conversation without navigation still confirms',async()=>{
  assert.equal((await transport({start:'/c/'+CID})).receipt,MID);
});
test('FIRST-SEND rejects a matching POST after an unrelated intermediate page',async()=>{
  assert.equal((await transport({moves:['/search','/c/'+CID]})).receipt,null);
});
test('FIRST-SEND rejects an unrelated departure even after returning to the homepage',async()=>{
  assert.equal((await transport({moves:['/search','/','/c/'+CID]})).receipt,null);
});
test('FIRST-SEND cannot switch an existing conversation',async()=>{
  assert.equal((await transport({start:'/c/'+CID,moves:['/c/'+OTHER]})).receipt,null);
});
test('FIRST-SEND cannot hide a departure by returning to the elected conversation',async()=>{
  assert.equal((await transport({moves:['/c/'+CID,'/c/'+OTHER,'/c/'+CID]})).receipt,null);
});
test('FIRST-SEND cannot cross group ownership',async()=>{
  assert.equal((await transport({start:'/g/fixture',moves:['/g/other/c/'+CID]})).receipt,null);
});
test('FIRST-SEND cannot borrow a proof after its HTTP response was accepted',async()=>{
  assert.equal((await transport({moves:['/c/'+CID],afterProof:['/c/'+OTHER,'/c/'+CID]})).receipt,null);
});
test('FIRST-SEND exact request-body mismatch still refuses',async()=>{
  const result=await transport({moves:['/c/'+CID],wrongBody:true});
  assert.equal(result.receipt,null);assert.equal(result.stage,'mismatch');
});
test('FIRST-SEND native receiver already accepts null to first conversation',async()=>{
  const result=await nativeSend();assert.equal(result.receipt,true);assert.equal(result.clicks,1);
});
test('FIRST-SEND native receiver preserves same-conversation delivery',async()=>{
  const result=await nativeSend({start:CID});assert.equal(result.receipt,true);assert.equal(result.clicks,1);
});
for(const [name,options] of [
  ['another existing conversation',{start:CID,target:OTHER}],
  ['an old native user ID',{prior:true}],
  ['another user body',{wrongBody:true}],
  ['missing Send authorization',{authorized:false}],
  ['a draft edited during authorization',{edit:true}]
])test('FIRST-SEND native receiver rejects '+name,async()=>{
  const result=await nativeSend(options);assert.equal(result.receipt,false);
  if(options.authorized===false||options.edit)assert.equal(result.clicks,0);
});

test('FIRST-SEND rejects a double slash rather than treating it as the homepage',async()=>{
  assert.equal((await transport({moves:['//','/c/'+CID]})).receipt,null);
});
test('FIRST-SEND preserves the starting group across an optional trailing slash',async()=>{
  assert.equal((await transport({start:'/g/fixture/',moves:['/g/fixture','/g/fixture/c/'+CID+'/', '/g/fixture/c/'+CID]})).receipt,MID);
});
