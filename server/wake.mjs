// Wake an existing Paseo Agent without submitting a prompt.
// The only host API used for wake is agents.ref(id).commands(): Paseo's
// list_commands_request calls ensureAgentLoaded() for a closed agent.
// Never call send(), run(), refreshAgent(), or native ChatGPT Send here.
import {createHostTimelineReader} from './host-timeline.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sessionIdFromPersistence(persistence) {
  const id=persistence?.data?.id;
  return persistence?.version===1&&typeof id==='string'&&UUID.test(id)?id:null;
}

export function sessionIdFromAgent(agent) {
  if(agent?.provider!=='chatmode'||agent?.persistence?.provider!=='chatmode')return null;
  const raw=agent.persistence.sessionId;
  if(typeof raw!=='string'||!raw.startsWith('plugin:')||raw.length>1200)return null;
  try { return sessionIdFromPersistence(JSON.parse(raw.slice(7))); }
  catch { return null; }
}

/** `observation` (server/host-observation.mjs) is optional and explicit. It
 * may ask for a barrier wake: a FRESH commands() that is never merged with an
 * older in-flight wake, because that one may have been answered for a host
 * session that has since been replaced.
 * @param {{ observation?: ReturnType<typeof import('./host-observation.mjs').createHostObservation> | null }} [options] */
export function createWakeCoordinator({observation=null}={}) {
  let paseo=null;
  const mapped=new Map(),pending=new Set(),inflight=new Map();
  const rememberAgent=async(id)=>{
    if(!paseo||typeof id!=='string')return null;
    try{
      const response=await paseo.agents.ref(id).refresh();
      const agent=response?.agent;
      const sessionId=sessionIdFromAgent(agent);
      if(!sessionId||agent.archivedAt){
        if(sessionId)mapped.delete(sessionId);
        return null;
      }
      mapped.set(sessionId,id);
      return sessionId;
    }catch{return null;}
  };
  const adopt=api=>{
    if(!api?.agents?.ref || !api?.agents?.list)return;
    paseo=api;
    for(const sid of [...pending])void wake(sid).catch(()=>{});
    observation?.hostAvailable(); // pending barriers may ask again; not a proof
  };
  const findAgent=async sid=>{
    let id=mapped.get(sid);
    if(id){
      const result=await rememberAgent(id);
      if(result===sid)return id;
      mapped.delete(sid);
      id=null;
    }
    const list=await paseo.agents.list();
    // A provider connection is owned by a concrete Paseo agent. Never select
    // by workspace, title or the ChatGPT conversation URL.
    const entries=(list?.entries??[]).slice(0,500),matches=new Set();
    for(const entry of entries){
      const agent=entry?.agent??entry;
      if(agent?.provider!=='chatmode'||!agent.id||agent.archivedAt)continue;
      const sessionId=sessionIdFromAgent(agent)??await rememberAgent(agent.id);
      if(sessionId)mapped.set(sessionId,agent.id);
      if(sessionId===sid)matches.add(agent.id);
    }
    // Two Paseo agents owning the same Runtime UUID is an identity conflict,
    // not a reason to choose one based on list order.
    return matches.size===1?[...matches][0]:null;
  };
  const wake=async(sid,{barrier=false}={})=>{
    if(!UUID.test(sid))return {woken:false,reason:'INVALID_SESSION_ID'};
    if(!barrier&&inflight.has(sid))return inflight.get(sid);
    const task=(async()=>{
      if(!paseo){pending.add(sid);return {woken:false,reason:'NO_HOST_CONTEXT'};}
      try{
        const agentId=await findAgent(sid);
        if(!agentId){pending.add(sid);return {woken:false,reason:'AGENT_NOT_FOUND'};}
        // Pure read on the host API, but Paseo lazily restores the persisted
        // Provider session if it is closed. No new native ChatGPT message.
        const response=await paseo.agents.ref(agentId).commands();
        // list_commands_response carries failures as a payload (e.g. "Agent
        // not found"); that is neither a wake nor a subscription barrier.
        if(response&&typeof response==='object'&&!Array.isArray(response)&&response.error){
          pending.add(sid);
          return {woken:false,reason:'HOST_COMMANDS_ERROR'};
        }
        pending.delete(sid);
        // The daemon answers only after ensureAgentLoaded (registration and
        // event subscription) for this Agent. Not a message-persistence proof.
        return {woken:true,agentId};
      }catch{
        pending.add(sid);
        return {woken:false,reason:'HOST_WAKE_UNAVAILABLE'};
      }
    })();
    // A barrier result belongs to its caller only; never shared by session ID.
    if(barrier)return task;
    void task.finally(()=>{if(inflight.get(sid)===task)inflight.delete(sid);});
    inflight.set(sid,task);
    return task;
  };
  observation?.attachWaker(wake);
  observation?.attachTimelineReader(async(sid,scope)=>{
    const api=paseo;
    const fail=code=>{throw Object.assign(new Error(code),{code});};
    if(!api||!scope.isCurrent())fail('HOST_READ_UNAVAILABLE');
    const agent=api.agents.ref(scope.agentId),snapshot=await agent.refresh();
    if(api!==paseo||!scope.isCurrent())fail('HOST_BINDING_EXPIRED');
    if(snapshot?.agent?.id!==scope.agentId||snapshot.agent.archivedAt||
        sessionIdFromAgent(snapshot.agent)!==sid)fail('HOST_AGENT_MISMATCH');
    const view=await createHostTimelineReader({agent,sessionId:scope.hostId,bindingGeneration:scope.bindingGeneration,
      isCurrent:()=>api===paseo&&scope.isCurrent()})();
    // refetch may update the handle with a newer agent snapshot. It must still
    // refer to this CIP session, not just reuse the same Paseo Agent UUID.
    const latest=agent.current?.()??snapshot.agent;
    if(latest.id!==scope.agentId||latest.archivedAt||sessionIdFromAgent(latest)!==sid)
      fail('HOST_AGENT_MISMATCH');
    return view;
  });
  return {adopt,rememberAgent,wake};
}
