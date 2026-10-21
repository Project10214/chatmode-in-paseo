// Offline stdin seam for Chromium; ORIGINAL Provider + pinned host world.
import readline from 'node:readline';
import {world} from './provider-host-world.mjs';
import {loadInstalledPaseoContract,realTranslate,realRender,PINNED_HOST_VERSIONS} from './paseo-real-contract.mjs';
const cleanup=[],w=await world({after:fn=>cleanup.push(fn)});
const client=await loadInstalledPaseoContract();
if(!client||!PINNED_HOST_VERSIONS.includes(client.appVersion))throw Error('PINNED_CLIENT_REQUIRED');
const snapshot=()=>w.broker.snapshot(w.s.id);
const binding=()=>{const s=snapshot();return {sessionId:s.id,conversationId:s.conversationId,tabId:s.tabId,
 documentKey:s.documentKey,observationLease:s.observation.lease};};
const inspect=()=>({session:snapshot(),text:w.text(),
 clientAssistants:realRender(realTranslate(w.wire,client),client).filter(row=>row.kind==='assistant_message'),
 rows:w.manager.fetchTimeline('c011e670-0000-4000-8000-000000000031',{direction:'tail',limit:0}).rows,
 sendCount:Object.values(w.store.read().commands).filter(c=>c.kind==='send').length});
process.stdout.write(JSON.stringify({binding:binding()})+'\n');
try {for await(const line of readline.createInterface({input:process.stdin})){
 try {
  const m=JSON.parse(line);let value;
  if(m.op==='close'){process.stdout.write('{"closed":true}\n');break;}
  if(m.op==='bind'){
   const b=binding();
   await w.broker.rebindObservation({...b,previousDocumentKey:b.documentKey,documentKey:m.documentKey,
     url:'https://chatgpt.com/c/'+b.conversationId});
   value=binding();
  } else if(m.op==='rpc'){
   if(m.message.type!=='page-view')throw Error('UNEXPECTED_RPC');
   value={ok:true,value:await w.broker.observeView(m.message.event)};
  } else if(m.op==='inspect')value=inspect();
  else throw Error('UNEXPECTED_OPERATION');
  process.stdout.write(JSON.stringify({value})+'\n');
 } catch(error){process.stdout.write(JSON.stringify({error:error.code??error.message})+'\n');}
}} finally {for(const fn of cleanup.reverse())await fn();}
