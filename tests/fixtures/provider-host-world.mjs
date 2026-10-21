// Shared opt-in ACTUAL Provider + pinned original SDK/Session/Manager test world.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture,sourceItem} from '../helpers.mjs';
import {loadPaseoHost} from './paseo-host-sources.mjs';
import {PINNED_HOST_VERSIONS} from './paseo-real-contract.mjs';
import {createProvider} from '../../server/provider.mjs';
import {createHostObservation} from '../../server/host-observation.mjs';
import {createWakeCoordinator} from '../../server/wake.mjs';
const dir=process.env.CIP_PASEO_SERVER_PACKAGE;
const {AgentManager,PluginAgentClientRegistry,ProviderEventSchema,version}=await loadPaseoHost(dir);
assert(PINNED_HOST_VERSIONS.includes(version),'UNPINNED_HOST_VERSION: '+version);
assert.equal(createHash('sha256').update(await readFile(path.join(dir,'dist/server/server/session.js'))).digest('hex'),
 '2a22a6716bec6dd2c52ccdc96449a1fe9f33937a8bf4dff1097bfb52f736b752');
const load=relative=>import(pathToFileURL(path.join(dir,relative)).href);
const {Session}=await load('dist/server/server/session.js');
const {createPaseoApi}=await load('node_modules/@getpaseo/client/dist/index.js');
const {DaemonClient}=await load('node_modules/@getpaseo/client/dist/daemon-client.js');
const {FetchAgentTimelineResponseMessageSchema}=await load('node_modules/@getpaseo/protocol/dist/messages.js');
const noop=()=>{},logger={trace:noop,debug:noop,info:noop,warn:noop,error:noop,fatal:noop,child(){return this;}};
export const agentId='c011e670-0000-4000-8000-000000000031';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function until(fn){for(let i=0;i<600;i++){const value=fn();if(value)return value;await pause(5);}assert.fail('original-host pipeline timed out');}
export async function world(t,{history=[]}={}){
  const f=await fixture(t),s=await f.ready();await f.sending(s);await f.view(s,{state:'standby'});
  if(history.length)await f.store.transaction(d=>d.sessions[s.id].history.push(...structuredClone(history)));
  const observation=createHostObservation(),wake=createWakeCoordinator({observation}),wire=[];
  const provider=createProvider({...f,status:()=>({connected:true})},event=>ProviderEventSchema.parse(event),{hostObservation:observation});
  const registry=new PluginAgentClientRegistry(logger);
  registry.replace([{...provider,async connect(request){
    const connection=await provider.connect(request);
    return {...connection,onEvent(fn){return connection.onEvent(event=>{wire.push(event);fn(event);});}};
  }}]);
  const client=registry.clients().chatmode;
  const manager=new AgentManager({logger,clients:{chatmode:client},providerDefinitions:registry.definitions()});
  assert.equal(manager.agentStreamCoalescer.windowMs,60);
  const cfg={provider:'chatmode',cwd:'/tmp',model:'m1',thinkingOption:'standard',providerOptions:{appIds:['asdk_app_a']}};
  const handle={provider:'chatmode',sessionId:'plugin:'+JSON.stringify({version:1,data:{id:s.id}})};
  const session=await client.resumeSession(handle,cfg);
  await manager.registerSession(session,cfg,agentId);
  let count=0;
  const metadata=()=>({id:agentId,provider:'chatmode',archivedAt:null,persistence:session.describePersistence()});
  const rpc={
    createRequestId:()=> 'read-'+(++count),
    async sendRequest({message,select}){
      assert.equal(message.type,'fetch_agent_timeline_request');
      assert.equal(message.agentId,agentId);
      let response;
      await Session.prototype.handleFetchAgentTimelineRequest.call({
        agentManager:manager,agentStorage:null,sessionLogger:logger,
        buildAgentPayload:async()=>null,supportsTimelineItem:()=>true,supports:()=>true,
        emitForSource:value=>{response=value;},emit:value=>{response=value;}
      },message);
      const parsed=FetchAgentTimelineResponseMessageSchema.parse(response);
      assert.equal(parsed.payload.error,null);return select(parsed);
    }
  };
  const api=createPaseoApi({
    fetchAgents:async()=>({entries:[{agent:metadata()}]}),
    fetchAgent:async()=>({agent:metadata()}),
    listCommands:async()=>({agentId,commands:await session.listCommands(),error:null}),
    fetchAgentTimeline:(...args)=>DaemonClient.prototype.fetchAgentTimeline.apply(rpc,args)
  });
  wake.adopt(api);
  t.after(async()=>{await registry.shutdown();await api.dispose();});
  const text=()=>manager.fetchTimeline(agentId,{direction:'tail',limit:0}).rows
    .filter(row=>row.item.type==='assistant_message'&&row.item.messageId==='native-final').map(row=>row.item.text).join('');
  const capture=value=>f.view(s,{state:'standby',items:[sourceItem('formal',value,{nativeMessageId:'native-final'})]});
  const confirmed=value=>f.broker.snapshot(s.id).nativeDelivery?.durable.deliveries.some(row=>row.confirmedText===value&&!row.pending);
  return {...f,s,manager,session,wire,text,capture,confirmed};
}
