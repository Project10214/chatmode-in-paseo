import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaseoApi} from '@getpaseo/client';
import {createHostObservation} from '../server/host-observation.mjs';
import {createWakeCoordinator} from '../server/wake.mjs';
const sid='c011e670-0000-4000-8000-000000000041';
const other='c011e670-0000-4000-8000-000000000042';
const snapshot=(id=sid,extra={})=>({id:'agent',provider:'chatmode',archivedAt:null,
 persistence:{provider:'chatmode',sessionId:'plugin:'+JSON.stringify({version:1,data:{id}})},...extra});
function setup({agent=snapshot(),after=null,fetchHook=null}={}){
 const observation=createHostObservation(),wake=createWakeCoordinator({observation}),calls=[];
 const api=createPaseoApi({
  fetchAgents:async()=>({entries:[{agent}]}),
  fetchAgent:async()=>{calls.push('refresh');await fetchHook?.();return {agent};},
  fetchAgentTimeline:async()=>{
   calls.push('timeline');
   return {agentId:'agent',agent:after,direction:'tail',projection:'projected',epoch:'epoch',reset:false,
    staleCursor:false,gap:false,hasOlder:false,hasNewer:false,window:{minSeq:0,maxSeq:0,nextSeq:1},
    startCursor:null,endCursor:null,entries:[],error:null};
  }
 });
 wake.adopt(api);
 const scope={agentId:'agent',hostId:'host',bindingGeneration:'binding',isCurrent:()=>true};
 return {observation,wake,api,calls,scope,read:()=>observation.readTimeline(sid,scope)};
}
test('HR-1 production wake/observation adapter reads only an exactly owned agent without Send',async()=>{
 const f=setup();const view=await f.read();
 assert.equal(view.fullCoverage,true);assert.deepEqual(f.calls,['refresh','timeline']);await f.api.dispose();
});
for(const [name,agent]of [
 ['different CIP session',snapshot(other)],['archived',snapshot(sid,{archivedAt:'date'})],
 ['different provider',snapshot(sid,{provider:'other'})],['wrong agent UUID',snapshot(sid,{id:'other'})]
])test('HR-2 refuses '+name+' before reading timeline',async()=>{
 const f=setup({agent});await assert.rejects(f.read(),{code:'HOST_AGENT_MISMATCH'});
 assert.deepEqual(f.calls,['refresh']);await f.api.dispose();
});
test('HR-3 a refetch revealing changed persistence is not delivery evidence for the old binding',async()=>{
 const f=setup({after:snapshot(other)});await assert.rejects(f.read(),{code:'HOST_AGENT_MISMATCH'});
 assert.deepEqual(f.calls,['refresh','timeline']);await f.api.dispose();
});
test('HR-4 invalidating the binding while refresh is in flight fences the subsequent read',async()=>{
 let release;const f=setup({fetchHook:()=>new Promise(r=>{release=r;})});
 const work=f.read();f.scope.isCurrent=()=>false;release();
 await assert.rejects(work,{code:'HOST_BINDING_EXPIRED'});
 assert.deepEqual(f.calls,['refresh']);await f.api.dispose();
});
