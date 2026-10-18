/** Bounded, exact-turn native public activity. No arguments, URLs, results or reasoning text. */
import { invariant } from './protocol.mjs';
import { syncSummary } from './observation.mjs';
export { phaseLabel } from '../shared/ui-copy.mjs';
const PHASES=new Set(['working','thinking','tool','search','exec','image','approval','finalizing','completed']);
const KINDS=new Set(['tool','search','exec','image']);
const LABEL=/^[a-zA-Z0-9_.:\- ·一-鿿]{1,160}$/;
export function nativeActivity(value,displayLabel=label=>label) {
  invariant(value && typeof value==='object' && !Array.isArray(value), 'ACTIVITY_INVALID');
  invariant(Object.keys(value).every(k=>['phase','nativeStatus','steps'].includes(k)), 'ACTIVITY_INVALID');
  invariant(PHASES.has(value.phase) && ['complete','in_progress',null].includes(value.nativeStatus), 'ACTIVITY_INVALID');
  invariant(Array.isArray(value.steps)&&value.steps.length<=12,'ACTIVITY_INVALID');
  const steps=value.steps.map((step)=>{
    invariant(step && typeof step==='object' && !Array.isArray(step) &&
      Object.keys(step).every(k=>['kind','label','done'].includes(k)) &&
      KINDS.has(step.kind)&&typeof step.label==='string'&&LABEL.test(step.label)&&typeof step.done==='boolean',
      'ACTIVITY_INVALID');
    return {kind:step.kind,label:displayLabel(step.label),done:step.done};
  });
  // Native turn.status is useful evidence, NOT permission to publish a Paseo
  // terminal event. Only Broker's verified terminal transaction may say completed.
  const phase=value.phase==='completed'||value.nativeStatus==='complete'?'finalizing':value.phase;
  return {phase,nativeStatus:value.nativeStatus,steps};
}
// Card v2 keeps the v1 headline fields (phase/nativeStatus/steps) and adds three
// independent facts: last native observation, CIP sync health and the Paseo
// tracking outcome. A Paseo failure never erases the last native observation.
function upgrade(data,turnId) {
  return {turnId,phase:data?.phase??'observing',nativeStatus:data?.nativeStatus??null,steps:data?.steps??[],
    native:data?.native??{phase:PHASES.has(data?.phase)?data.phase:null,status:data?.nativeStatus??null,observedAt:null},
    sync:data?.sync??{state:'ok',issues:[]},outcome:data?.outcome??null,error:data?.error??null,
    recoveries:data?.recoveries??0,page:data?.page??null};
}
/** Mutates exactly one persisted timeline item within the transaction. No new card unless `create`. */
export function writeActivity(session,change,{create=false,limit=Infinity}={}) {
  if (!session?.turn?.id) return null;
  const id=`activity:${session.turn.id}`,at=session.history.findIndex(row=>row.id===id&&row.kind==='native-activity');
  if(at<0&&(!create||session.history.length>=limit))return null;
  const data=upgrade(at>=0?session.history[at].data:null,session.turn.id);
  change(data);
  const sync=syncSummary(session.turn);
  data.sync={state:sync.state,issues:sync.issues};
  data.recoveries=session.turn.observationRecoveries?.length??0;
  const row={type:'plugin',id,pluginId:'chatmode-in-paseo',kind:'native-activity',version:2,data};
  if(at>=0&&JSON.stringify(session.history[at])===JSON.stringify(row))return null;
  if(at>=0)session.history[at]=row;else session.history.push(row);
  return row;
}
export function settleActivity(session,outcome) {
  return writeActivity(session,data=>{
    data.phase=outcome==='completed'?'completed':outcome==='canceled'?'canceled':'failed';
    data.nativeStatus=outcome==='completed'?'complete':null;
    data.outcome=outcome;
    data.error=outcome==='failed'?(session.error??null):null;
    // A verified completed terminal is native evidence; failure/cancel are not.
    if(outcome==='completed')data.native={...data.native,status:'complete',observedAt:Date.now()};
  });
}
