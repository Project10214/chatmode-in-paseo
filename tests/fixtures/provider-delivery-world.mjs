// Actual production Provider/Broker/Store; SYNTHETIC projected host only.
import assert from 'node:assert/strict';
import {ProviderEventSchema} from '@getpaseo/plugin/server/provider';
import {fixture,selection,sourceItem,until} from '../helpers.mjs';
import {createProvider,CAPABILITIES} from '../../server/provider.mjs';
export const config={cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,
  model:selection.model,thinkingOption:selection.thinkingOption,providerOptions:{appIds:selection.appIds}};
const body=text=>sourceItem('formal',text,{nativeMessageId:'native-formal'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function world(t,{barrier=true,pageState='standby',history=[]}={}) {
  const f=await fixture(t),s=await f.ready();await f.sending(s);await f.view(s,{state:pageState});
  if(history.length)await f.store.transaction(d=>d.sessions[s.id].history.push(...structuredClone(history)));
  const events=[],rows=[],cache=new Map(),listeners=new Set(),proofErrors=[];
  t.after(()=>assert.deepEqual(proofErrors,[],'durable attempt must exist BEFORE forwarding'));let seq=0,readHook=null,dropBody=false,failBody=false,holdMarker=false,epoch='host-epoch';
  const observation={
    request:async()=>({woken:barrier,agentId:'agent-one'}),
    onHostAvailable:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},
    async readTimeline(id,scope){
      assert.equal(id,s.id);assert.equal(scope.agentId,'agent-one');
      await readHook?.();
      return {sessionId:scope.hostId,bindingGeneration:scope.bindingGeneration,hostEpoch:epoch,
        coverage:{complete:true,startSeq:rows.length?1:null,endSeq:seq||null,nextSeq:seq+1},rows:structuredClone(rows)};
    }
  };
  const runtime={...f,status:()=>({connected:true})};
  const connection=await createProvider(runtime,e=>ProviderEventSchema.parse(e),{hostObservation:observation})
    .connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>connection.close());
  connection.onEvent(event=>{
    events.push(event);
    if(event.type!=='timeline.item')return;
    let item=structuredClone(event.item);
    const durable=f.store.read().sessions[s.id]?.nativeDelivery?.durable;
    if(item.type==='assistant_message'&&!durable?.attempts.some(a=>a.transportId===item.id&&a.status==='prepared'))
      proofErrors.push('body:'+item.id);
    if(item.kind==='source-checkpoint'&&!durable?.checkpoints.some(c=>c.id===item.data.probeId&&c.status==='prepared'))
      proofErrors.push('checkpoint:'+item.id);
    if(item.type==='assistant_message'){
      if(failBody)throw Error('TEST_EMIT_UNCERTAIN');
      const old=cache.get(item.id)??'';cache.set(item.id,item.text);
      item.text=item.text.slice(old.length);
      if(dropBody)return;
    }
    if(item.kind==='source-checkpoint'&&holdMarker)return;
    rows.push({seqStart:++seq,seqEnd:seq,sourceSeqRanges:[{startSeq:seq,endSeq:seq}],item});
  });
  const open=async(hostId='host-one')=>{
    await connection.send({type:'session.open',requestId:'open-'+hostId,sessionId:hostId,config,
      history:'replay',persistence:{version:1,data:{id:s.id}}});
    await until(()=>events.some(e=>e.type==='session.ready'&&e.sessionId===hostId));
  };
  await open();
  return {...f,s,events,rows,connection,runtime,open,
    capture:text=>f.view(s,{state:'standby',items:[body(text)]}),
    text:()=>rows.filter(r=>r.item.type==='assistant_message').map(r=>r.item.text).join(''),
    bodies:()=>events.filter(e=>e.type==='timeline.item'&&e.item.type==='assistant_message'),
    markers:()=>events.filter(e=>e.type==='timeline.item'&&e.item.kind==='source-checkpoint'),
    setRead:fn=>{readHook=fn;},drop:value=>{dropBody=value;},fail:value=>{failBody=value;},holdMarker:value=>{holdMarker=value;},
    epoch:value=>{epoch=value;},releaseBarrier:()=>{barrier=true;for(const fn of listeners)fn();}};
}
