// Binding-owned orchestration of the native-delivery coordinator.
// Formal bodies/checkpoints have one emit callback. No direct timeline append,
// Send, status-derived delivery ACK or replay of an ambiguous prepared attempt.
import {randomUUID} from 'node:crypto';
import {createNativeDelivery,normalizeProjectedView} from './native-delivery.mjs';
import {invariant} from './protocol.mjs';

export function createProviderDelivery({sessionId,hostId,store,readHost,emit,isCurrent,isReady,notice,initialSources=[]}) {
  const generation=randomUUID(),sources=new Map(),submitted=new Map(),seeded=new Set();
  for(const row of Array.isArray(initialSources)?initialSources:[])
    if(row&&typeof row.id==='string'&&typeof row.messageId==='string'&&typeof row.text==='string'){
      sources.set(row.id,{type:'assistant_message',id:row.id,messageId:row.messageId,text:row.text});
      seeded.add(row.id);
    }
  let coordinator=null,timer=null,inflight=null,closed=false,agentId=null,lastNotice=null;
  // A delivery that stayed unfinished after a binding/readiness transition must
  // retry even without a new source event. No host ACK is implied.
  const watchdog=setInterval(()=>{if(current()&&unfinished()&&!inflight)kick();},2500);watchdog.unref?.();
  const current=()=>!closed&&isCurrent();
  const ready=()=>current()&&isReady();
  // A source may change while a durable prepare write is awaiting its return.
  // Do not forward the older projection before the next pass submits CURRENT
  // source data. This is dispatch readiness, never host-delivery evidence.
  const publicationReady=source=>{
    const latest=source&&sources.get(source.id);
    return ready()&&(!source||latest?.messageId===source.messageId&&latest?.text===source.text);
  };
  const report=codes=>{
    const safe=[...new Set(codes.map(code=>/^(?:HOST|BODY|CHECKPOINT|DELIVERY|SOURCE|NATIVE)_[A-Z_]+$/.test(code)?code:'DELIVERY_UNAVAILABLE'))].sort();
    const key=safe.join(',');
    // Normal in-flight delivery is not a user-facing problem. Only a real
    // issue set produces one notice per distinct set; clearing it dismisses.
    if(!current()||key===lastNotice||(!key&&lastNotice===null))return;
    lastNotice=key;notice(safe);
  };
  const persist=async durable=>{
    invariant(current(),'DELIVERY_BINDING_EXPIRED');
    await store.transaction(data=>{
      invariant(current()&&data.sessions[sessionId],'DELIVERY_BINDING_EXPIRED');
      const s=data.sessions[sessionId],prior=s.nativeDelivery;
      if(prior&&prior.generation!==generation){
        s.nativeDeliveryHistory??=[];s.nativeDeliveryHistory.push(prior);
      }
      s.nativeDelivery={agentId,generation,durable};
    });
  };
  async function initialize(view) {
    const prior=store.read().sessions[sessionId]?.nativeDelivery;
    let priorUnconfirmed=false;
    if(prior&&prior.generation!==generation){
      invariant(prior.agentId===agentId,'HOST_AGENT_MISMATCH');
      try{
        invariant(prior.durable?.scope?.hostEpoch===view.hostEpoch,'HOST_EPOCH_MISMATCH');
        // Reconcile the PREVIOUS scope read-only against this same Agent's actual
        // retained projection. Never emit on an old binding or relabel old
        // attempts as unsent. Only positive content / its recorded marker settles it.
        let reconciled=prior.durable;
        const previous=createNativeDelivery({...prior.durable.scope,initialState:prior.durable,
          emit:()=>false,isReady:()=>false,persist:async value=>{reconciled=value;},readHost:async()=>view});
        let result;
        try {result=await previous.observeHost({...view,...prior.durable.scope});}
        finally {await previous.close();}
        invariant(!result.issues.length&&!reconciled.deliveries.some(row=>row.pending),'DELIVERY_PRIOR_UNCONFIRMED');
      }catch(error){
        // A new host epoch (reload/reconnect) cannot prove or repair the old
        // native message. Do not replay it: keep its source and report once.
        // New turns must still work instead of being blocked by the old scope.
        if(error?.code!=='HOST_EPOCH_MISMATCH'&&error?.code!=='DELIVERY_PRIOR_UNCONFIRMED'&&
           error?.code!=='HOST_BODY_INVALID')throw error;
        priorUnconfirmed=true;
      }
    }
    invariant(current(),'DELIVERY_BINDING_EXPIRED');
    coordinator=createNativeDelivery({sessionId:hostId,bindingGeneration:generation,hostEpoch:view.hostEpoch,
      emit:async event=>ready()?emit(event):false,persist,isReady:publicationReady,
      readHost:async()=>{const result=await readHost(generation,current);return result.view;}});
    await persist(coordinator.snapshot().durable);
    if(priorUnconfirmed){
      // Seeded sources belong to the rejected old scope. Never forward them
      // into the new epoch; the ledger still holds the full original text.
      for(const id of seeded)sources.delete(id);
      lastNotice='DELIVERY_PRIOR_UNCONFIRMED';notice(['DELIVERY_PRIOR_UNCONFIRMED']);
    }
  }
  async function pass() {
    if(!ready()||!sources.size)return;
    const result=await readHost(generation,current);
    if(!current())return;
    invariant(typeof result.agentId==='string'&&result.agentId,'HOST_AGENT_MISMATCH');
    if(agentId)invariant(result.agentId===agentId,'HOST_AGENT_MISMATCH');else agentId=result.agentId;
    const view=normalizeProjectedView(result.view);
    invariant(view.sessionId===hostId&&view.bindingGeneration===generation,'HOST_BINDING_MISMATCH');
    if(!coordinator)await initialize(view);
    for(const item of sources.values()){
      if(!current())return;
      const signature=JSON.stringify(item);
      if(submitted.get(item.id)===signature)continue;
      await coordinator.submit(item);submitted.set(item.id,signature);
    }
    if(!ready())return;
    const outcome=await coordinator.observeHost(view);
    report(outcome.issues.map(issue=>issue.code));
  }
  function unfinished() {
    if([...sources.values()].some(item=>submitted.get(item.id)!==JSON.stringify(item)))return true;
    if(!coordinator)return sources.size>0;
    const state=coordinator.snapshot();
    return state.issues.length>0||state.durable.sources.some(source=>{
      const row=state.durable.deliveries.find(item=>item.sourceId===source.id);
      return row.pending||row.confirmedText!==source.text;
    });
  }
  function kick() {
    if(!current()||!sources.size||inflight)return;
    clearTimeout(timer);timer=null;
    inflight=pass().catch(error=>report([error.code??'DELIVERY_UNAVAILABLE'])).finally(()=>{
      inflight=null;
      if(current()&&unfinished()){
        timer=setTimeout(kick,lastNotice&&lastNotice!=='DELIVERY_PENDING'?1000:100);timer.unref?.();
      }
    });
  }
  return {
    submit(item){if(!current())return;sources.set(item.id,structuredClone(item));kick();},
    kick,
    close(){closed=true;clearTimeout(timer);timer=null;clearInterval(watchdog);void coordinator?.close();},
    async drain(){if(inflight)await inflight;}
  };
}
