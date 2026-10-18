/** Conversation observation is independent of Send and host-run lifetimes.
 * Only visible Stop / Send / Start Voice controls determine webpage state.
 * Capturing/persisting source items does not acknowledge Paseo delivery.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { invariant, conversationId, object } from './protocol.mjs';
import { approvalEvent } from './approval.mjs';
import { reconcileSources } from './source-ledger.mjs';
import { projectPageItem } from './page-items.mjs';
import { projectSourceProse } from './source-prose.mjs';
import { artifactSourceRevision } from './artifact-identity.mjs';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = command => ['queued','claimed','authorized'].includes(command.phase);
export function ensureObservation(session) {
  session.observation ??= {lease:randomBytes(24).toString('hex'),generation:0,
    page:null,run:null,lastSequence:0,frameDigest:null,lastObservedAt:null};
  session.approvals ??= {};
  session.sourceProjections ??= [];
  return session.observation;
}
export function observationDescriptor(session) {
  const observation=session.observation;
  return {sessionId:session.id,tabId:session.tabId,documentKey:session.documentKey,
    conversationId:session.conversationId,observationLease:observation.lease,
    generation:observation.generation,runId:observation.run?.id??null,
    ...(session.turn?.receiptPending?{receiptPending:true,turnId:session.turn.id,
      lease:session.turn.lease,nativeMessageId:null}:{})};
}
export function assertObservation(session,event) {
  invariant(session&&session.status!=='abandoned','SESSION_UNKNOWN');
  invariant(session.observation&&event.observationLease===session.observation.lease,'OBSERVATION_LEASE_MISMATCH');
  invariant(Number.isInteger(session.tabId)&&typeof session.documentKey==='string'&&session.conversationId&&
    event.tabId===session.tabId&&event.documentKey===session.documentKey&&
    conversationId(event.url)===session.conversationId,'PAGE_IDENTITY_MISMATCH');
}
export function resetObservationDocument(session,tabId,documentKey) {
  const observation=ensureObservation(session);
  session.tabId=tabId;session.documentKey=documentKey;
  observation.lease=randomBytes(24).toString('hex');observation.generation++;
  observation.lastSequence=0;observation.frameDigest=null;
  if(observation.run)delete observation.run.awaitCommandView;
  // Existing captures/permissions survive. No operation is authorized by this.
  return observationDescriptor(session);
}
export function pageControls(value) {
  invariant(object(value)&&Number.isSafeInteger(value.observedAt)&&value.observedAt>0&&
    value.observedAt<=Date.now()+300000&&object(value.controls),'PAGE_STATUS_INVALID');
  const controls={};
  for(const key of ['stop','send','voice']) {
    const control=value.controls[key];
    invariant(object(control)&&typeof control.visible==='boolean'&&typeof control.enabled==='boolean','PAGE_STATUS_INVALID');
    controls[key]={visible:control.visible,enabled:control.enabled};
  }
  const state=controls.stop.visible?'running':value.readable===false?'abnormal':
    controls.send.visible||controls.voice.visible?'standby':'abnormal';
  return {observedAt:value.observedAt,state,controls,readable:value.readable!==false};
}
const unreadablePage = at => ({observedAt:at,state:'abnormal',readable:false,
  controls:{stop:{visible:false,enabled:false},send:{visible:false,enabled:false},voice:{visible:false,enabled:false}}});
/** Link a genuinely delivered Send to the host interval already observed, or
 * initialize its accepted operation. Queuing/authorizing Send must not call it.
 */
export function beginPromptObservation(session,turnId,at=Date.now(),{awaitCommandView=false}={}) {
  const observation=ensureObservation(session);
  if(!observation.run?.active)
    observation.run={id:turnId,active:true,origin:'paseo',startedAt:at,endedAt:null};
  observation.run.promptIds=[...new Set([...(observation.run.promptIds??[]),turnId])];
  if(awaitCommandView&&observation.run.origin==='paseo')
    observation.run.awaitCommandView=session.turn?.commandId??null;
  return observation.run.id;
}
function putHistory(session,item) {
  session.history ??= [];
  const index=session.history.findIndex(row=>row.id===item.id);
  if(index<0)session.history.push(item);else session.history[index]=item;
}
function previousHistoryItem(session,source,commands) {
  if(source.role==='user'&&source.nativeMessageId) {
    const nativeId=source.nativeMessageId;
    const recorded=session.history.find(row=>row.type==='user_message'&&row.messageId===nativeId);
    if(recorded)return recorded;
    const command=Object.values(commands).find(c=>c.sessionId===session.id&&c.kind==='send'&&c.result?.nativeMessageId===nativeId);
    const turnId=command?.payload.turnId??(session.turn?.nativeMessageId===nativeId?session.turn.id:null);
    if(turnId)return session.history.find(row=>row.id==='user:'+turnId)??null;
  }
  if(source.role==='assistant'&&source.kind==='message'&&source.lane==='output'&&source.nativeMessageId)
    return session.history.find(row=>row.type==='assistant_message'&&row.messageId===source.nativeMessageId)??null;
  return null;
}
function stateItem(session,page,issues=[]) {
  return {type:'plugin',pluginId:'chatmode-in-paseo',id:'page-state:'+session.id,
    kind:'page-state',version:1,data:{state:page.state,controls:page.controls,
      observedAt:page.observedAt,readable:page.readable,
      issues:issues.map(issue=>({code:typeof issue?.code==='string'?issue.code:'PAGE_CAPTURE_ISSUE'}))}};
}
function projectSources(session,result,commands,run,events,issues) {
  const changes=new Map(result.changes.map(change=>[change.item.id,change]));
  // Failed local projections are retried even if the source did not change.
  // These records describe only local history, not host delivery/ACK state.
  for(const source of session.sources??[]) {
    if(!source?.id||!source.revision)continue;
    const index=session.sourceProjections.findIndex(row=>row.sourceId===source.id);
    const projection=session.sourceProjections[index];
    if(projection?.revision===source.revision&&session.history.some(row=>row.id===projection.itemId)) {
      issues.push(...(projection.proseIssues??[]));continue;
    }
    // Collection is already persisted. Delay only an exact pending Send echo's
    // UI association until its receipt can reuse the real Paseo user row; this
    // is never a Send receipt or a gate on other content/controls/permissions.
    const sending=session.turn&&commands[session.turn.commandId];
    if(!projection&&source.role==='user'&&sending?.kind==='send'&&!session.turn.nativeMessageId&&
      (pending(sending)||session.turn.receiptPending)&&source.text===sending.payload.text)continue;
    try {
      if(source.role==='assistant'&&source.kind==='message'&&source.nativeMessageId)
        invariant(!Object.values(session.prompts??{}).some(prompt=>prompt.nativeMessageId===source.nativeMessageId)&&
          !session.sources.some(other=>other.role==='user'&&other.nativeMessageId===source.nativeMessageId),
          'NATIVE_MESSAGE_ROLE_CONFLICT');
      // Unannotated historical/producer items retain their prior native text;
      // do not retroactively reinterpret already persisted bodies as DOM.
      // All new extension formal sources carry the explicit prose status.
      const rendered=source.prose&&source.role==='assistant'&&source.lane==='output'&&source.kind==='message'
        ? projectSourceProse(source,projection?.proseState) : null;
      const proseIssues=(rendered?.issues??[]).map(value=>({...value,sourceId:source.id}));
      issues.push(...proseIssues);
      let item=projectPageItem(rendered ? {...source,text:rendered.text,format:'markdown'} : source);
      invariant(item&&typeof item.id==='string','SOURCE_PROJECTION_INVALID');
      const proseRecord=rendered ? {proseState:rendered.state,proseIssues} : {};
      if(item.type==='assistant_message'&&(!item.text.trim()||rendered?.state?.mode==='literal'&&!source.text.trim())) {
        // Captured empty/pending sources are durable, but not successful native
        // answers. A later usable prefix retries this same source identity.
        const record={sourceId:source.id,revision:source.revision,itemId:null,...proseRecord};
        if(index<0)session.sourceProjections.push(record);else session.sourceProjections[index]=record;
        continue;
      }
      const prior=projection&&session.history.find(row=>row.id===projection.itemId);
      const old=prior??previousHistoryItem(session,source,commands);
      if(old) {
        if(item.type==='user_message')item={...item,id:old.id,text:old.text,...(old.clientMessageId?{clientMessageId:old.clientMessageId}:{})};
        else item={...item,id:old.id,...(old.messageId?{messageId:old.messageId}:{})};
      }
      if (old?.type==='plugin' && old.pluginId==='chatmode-in-paseo' &&
          old.kind==='generated-file' && old.version===1 && old.data?.status==='available' &&
          ['image','file'].includes(source.kind) && old.data.sourceId===source.id &&
          session.artifactIdentities?.some(stamp=>stamp.sourceId===source.id &&
            stamp.revision===artifactSourceRevision(session,source))) {
        // A new caption/visibility frame must not downgrade verified bytes to
        // the source placeholder. A changed resource DOES invalidate that card.
        item={...old,data:{...old.data,sourceText:source.text}};
      }
      putHistory(session,item);
      const record={sourceId:source.id,revision:source.revision,itemId:item.id,...proseRecord};
      if(index<0)session.sourceProjections.push(record);else session.sourceProjections[index]=record;
      events.push({id:session.id,state:'source',turnId:run?.id??null,item,
        sourceId:source.id,revision:source.revision,change:changes.get(source.id)?.change??'new'});
      if(source.role==='user'&&source.nativeMessageId)session.lastNativeMessageId=source.nativeMessageId;
    } catch(error) {issues.push({code:error.code??'SOURCE_PROJECTION_FAILED',sourceId:source.id});}
  }
}
function closeRun(session,run,events,at) {
  if(!run?.active)return;
  run.active=false;run.endedAt=at;
  if(session.turn&&(run.id===session.turn.id||run.promptIds?.includes(session.turn.id))) {
    session.turn.outcome='completed';
    const prompt=session.prompts?.[session.turn.clientMessageId];if(prompt)prompt.outcome='completed';
  }
  events.push({id:session.id,state:'page-standby',turnId:run.id});
}
/** Store.transaction caller publishes these events only after persistence. */
export function recordPageView(session,event,commands={},at=Date.now()) {
  assertObservation(session,event);
  invariant(object(event.view)&&Number.isSafeInteger(event.sequence)&&event.sequence>0,'PAGE_VIEW_INVALID');
  invariant(event.view.conversationId===undefined||event.view.conversationId===session.conversationId,'PAGE_IDENTITY_MISMATCH');
  const observation=ensureObservation(session),digest=fingerprint(event.view);
  if(event.sequence<observation.lastSequence)return {accepted:true,stale:true,events:[]};
  if(event.sequence===observation.lastSequence) {
    invariant(digest===observation.frameDigest,'OBSERVATION_SEQUENCE_CONFLICT');
    return {accepted:true,duplicate:true,events:[]};
  }
  const historyStart=session.history.length;
  const events=[],issues=[...(Array.isArray(event.view.issues)?event.view.issues:[])];
  let page;
  try {page=pageControls(event.view.page);}
  catch {page=unreadablePage(at);issues.push({code:'PAGE_STATUS_INVALID'});}
  let run=observation.run;
  const attempt=event.view.sendAttempt,command=object(attempt)?commands[attempt.commandId]:null;
  const ownAttempt=command?.kind==='send'&&command.sessionId===session.id&&
    command.payload.turnId===attempt.turnId&&command.lease===attempt.lease&&
    command.documentKey===attempt.documentKey&&attempt.documentKey===session.documentKey&&
    command.tabId===session.tabId&&session.turn?.id===attempt.turnId&&session.turn.authorized&&
    (command.phase==='authorized'||command.phase==='done');
  if(ownAttempt) {
    if(!command.observationStarted&&!session.turn.outcome) {
      const runId=beginPromptObservation(session,attempt.turnId,at);
      run=observation.run;
      command.observationStarted={runId,sequence:event.sequence,generation:observation.generation};
      session.turn.observedRunId=runId;
      events.push({id:session.id,state:'send-observed',turnId:attempt.turnId,runId});
    }
    if(run?.awaitCommandView===attempt.commandId)delete run.awaitCommandView;
  }
  if(page.state==='running'&&!run?.active) {
    run=observation.run={id:randomUUID(),active:true,origin:'page',startedAt:at,endedAt:null};
    events.push({id:session.id,state:'page-running',turnId:run.id});
  }
  const items=Array.isArray(event.view.items)?event.view.items.map(item=>
    object(item)&&item.kind==='notice'&&typeof item.sourceType==='string'?{...item,sourceKind:item.sourceType}:item):event.view.items;
  const result=reconcileSources(session,items,{now:at});issues.push(...result.issues);
  projectSources(session,result,commands,run,events,issues);
  for(const input of Array.isArray(event.view.approvals)?event.view.approvals:[]) {
    try {
      const approval=approvalEvent({...input,state:'open'});
      const previous=session.approvals[approval.key];
      if(previous?.state==='resolved')continue;
      const value={...approval,state:'open'};
      if(JSON.stringify(previous)!==JSON.stringify(value)) {
        session.approvals[approval.key]=value;
        events.push({id:session.id,state:'approval',approval:value});
      }
    } catch(error) {
      issues.push({code:error.code??'APPROVAL_UNRECOGNIZED',sourceId:null});
      // An unrecognized request is still visible output, never dropped merely
      // because it cannot safely become a clickable permission request.
      if(typeof input?.text==='string') {
        const fallback=reconcileSources(session,[{id:'approval-notice:'+fingerprint(input),userMessageId:null,
          role:'page',lane:'output',kind:'notice',text:input.text,format:'text',order:[]}],{now:at});
        projectSources(session,fallback,commands,run,events,issues);
      }
    }
  }
  for(const key of Array.isArray(event.view.closedApprovals)?event.view.closedApprovals:[]) {
    if(typeof key!=='string'||!Object.hasOwn(session.approvals,key))continue;
    const approval=session.approvals[key];if(approval.state==='resolved')continue;
    approval.state='resolved';
    events.push({id:session.id,state:'approval-closed',key,answered:approval.answered??null});
  }
  observation.page=page;observation.lastObservedAt=at;
  observation.lastSequence=event.sequence;observation.frameDigest=digest;delete observation.gap;
  const item=stateItem(session,page,issues);
  const firstState=!session.history.some(row=>row.id===item.id);
  if(firstState)session.history.splice(historyStart,0,item);else putHistory(session,item);
  // Establish the fixed status row before the first native body. Updating it
  // later must not insert a new separator inside that body's native chunks.
  const status={id:session.id,state:'page-status',turnId:run?.id??null,item,page,issues};
  events.splice(events[0]?.state==='page-running'?1:0,0,status);
  if(page.state==='standby'&&!run?.awaitCommandView)closeRun(session,run,events,at);
  const sending=Object.values(commands).some(c=>c.sessionId===session.id&&c.kind==='send'&&pending(c));
  session.status=sending?'sending':observation.run?.active?'running':'idle';
  return {accepted:true,events,issues,observation:observationDescriptor(session)};
}
export function recordObservationGap(session,event,at=Date.now()) {
  assertObservation(session,event);
  const reason=typeof event.reason==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(event.reason)?event.reason:'OBSERVATION_UNAVAILABLE';
  session.observation.gap={reason,at};
  const page=unreadablePage(at),issues=[{code:'OBSERVATION_UNAVAILABLE',reason}];
  session.observation.page=page;
  const item=stateItem(session,page,issues);putHistory(session,item);
  return {events:[{id:session.id,state:'page-status',turnId:session.observation.run?.id??null,item,page,issues}]};
}
