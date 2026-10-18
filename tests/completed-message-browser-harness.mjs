// Isolated real Store/Broker/Provider transport for a synthetic browser fixture.
import readline from 'node:readline';
import {fixture,selection,until} from './helpers.mjs';
import {createProvider,CAPABILITIES} from '../server/provider.mjs';
import {ProviderEventSchema} from '@getpaseo/plugin/server/provider';
import {loadInstalledPaseoContract,realTranslate,realRender} from './fixtures/paseo-real-contract.mjs';
const cleanups=[],f=await fixture({after(fn){cleanups.push(fn);}}),events=[];
const cid='12345678-1234-1234-1234-123456789abc';
const s=await f.ready(),run=await f.broker.prompt(s.id,'browser-fixture','synthetic');
const command=f.broker.queued().find(c=>c.kind==='send');
const claim=await f.broker.claim(command.id,s.tabId,s.documentKey);await f.broker.authorize(command.id,claim.lease);
await f.broker.result(command.id,claim.lease,{receipt:true,config:s.config,nativeMessageId:'fixture-user',url:'https://chatgpt.com/c/'+cid});
const config={cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,model:selection.model,thinkingOption:selection.thinkingOption,providerOptions:{appIds:selection.appIds}};
const provider=await createProvider({...f,status:()=>({connected:true})},e=>ProviderEventSchema.parse(e)).connect({versions:[1],capabilities:CAPABILITIES});
provider.onEvent(e=>events.push(e));
await provider.send({type:'session.open',requestId:'open',sessionId:'host-fixture',config,history:'replay',persistence:{version:1,data:{id:s.id}}});
await until(()=>events.some(e=>e.type==='session.ready'));
const contract=await loadInstalledPaseoContract();
const descriptor=()=>f.broker.observationBindings().find(b=>b.sessionId===s.id);
console.log(JSON.stringify({ready:true,session:descriptor(),conversationId:cid,contract:!!contract}));
const line=readline.createInterface({input:process.stdin});
try{
 for await(const raw of line){
  let req;
  try{
   req=JSON.parse(raw);let result;
   if(req.action==='rebind')result=await f.broker.rebindObservation({...descriptor(),previousDocumentKey:descriptor().documentKey,documentKey:req.documentKey,url:'https://chatgpt.com/c/'+cid});
   else if(req.action==='observe')result=await f.broker.observe(req.event);
   else if(req.action==='inspect'){
    const state=f.broker.snapshot(s.id);
    const rendered=contract?realRender(realTranslate(events,contract),contract):[];
    result={status:state.status,outcome:state.turn.outcome,history:state.history,events,
     rendered:rendered.filter(x=>x.kind==='assistant_message'),
     sends:Object.values(f.store.read().commands).filter(c=>c.kind==='send').length};
   }else if(req.action==='close'){console.log(JSON.stringify({request:req.request,result:true}));break;}
   else throw new Error('UNKNOWN_FIXTURE_ACTION');
   console.log(JSON.stringify({request:req.request,result}));
  }catch(e){console.log(JSON.stringify({request:req?.request,error:e.code??e.message}));}
 }
}finally{await provider.close();for(const close of cleanups.reverse())await close();}
