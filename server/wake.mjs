// COSINPASEO-1: wake an existing Paseo Agent without submitting a prompt.
// The only host API used for wake is agents.ref(id).commands(): Paseo's
// list_commands_request calls ensureAgentLoaded() for a closed agent.
// Never call send(), run(), refreshAgent(), or native ChatGPT Send here.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sessionIdFromAgent(agent) {
  if(agent?.provider!=='chatmode'||agent?.persistence?.provider!=='chatmode')return null;
  const raw=agent.persistence.sessionId;
  if(typeof raw!=='string'||!raw.startsWith('plugin:')||raw.length>1200)return null;
  try{
    const parsed=JSON.parse(raw.slice(7));
    const id=parsed?.data?.id;
    return parsed?.version===1&&typeof id==='string'&&UUID.test(id)?id:null;
  }catch{return null;}
}

export function createWakeCoordinator() {
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
  const wake=async sid=>{
    if(!UUID.test(sid))return {woken:false,reason:'INVALID_SESSION_ID'};
    if(inflight.has(sid))return inflight.get(sid);
    const task=(async()=>{
      if(!paseo){pending.add(sid);return {woken:false,reason:'NO_HOST_CONTEXT'};}
      try{
        const agentId=await findAgent(sid);
        if(!agentId){pending.add(sid);return {woken:false,reason:'AGENT_NOT_FOUND'};}
        // Pure read on the host API, but Paseo lazily restores the persisted
        // Provider session if it is closed. No new native ChatGPT message.
        await paseo.agents.ref(agentId).commands();
        pending.delete(sid);
        return {woken:true,agentId};
      }catch{
        pending.add(sid);
        return {woken:false,reason:'HOST_WAKE_UNAVAILABLE'};
      }
    })().finally(()=>inflight.delete(sid));
    inflight.set(sid,task);
    return task;
  };
  return {adopt,rememberAgent,wake};
}
