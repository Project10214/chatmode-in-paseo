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
const RECOVERY_ACTIVE = new Set(['observing','needs_review']);
export function recoveryActive(session) {
  return Boolean(session?.recovery && RECOVERY_ACTIVE.has(session.recovery.status));
}
const recoveryTurn = recovery => recovery?.turnId ?? null;
/** The selected turn owns historical-read filtering for as long as the
 * original failed turn is current. A completed recovery stays bounded too;
 * clearing it on completion would make the next ordinary frame backfill the
 * whole page. A genuinely new prompt is a NEW turn: its own accepted native
 * user receipt is the only page user that may start normal sync.
 */
function recoveryBoundary(session) {
  const recovery=session?.recovery;
  if(!recovery)return null;
  if(recoveryActive(session))
    return recoveryTurn(recovery)===session.turn?.id?recovery:null;
  // A completed recovery keeps its history boundary until a new turn has its
  // own accepted native receipt. It never reopens the recovery run or
  // suppresses approvals; the new-turn window is handled in recoveryWindow().
  return recovery.status==='completed'?recovery:null;
}
/** The only user turn that may start normal sync after a completed recovery is
 * the new turn's own accepted native user ID. The old recovery anchor is not a
 * permanent prerequisite: it may be virtualized out while the new turn is
 * already receipt-confirmed. */
function newTurnUserMessageId(session,recovery) {
  const turn=session.turn;
  if(!turn||turn.id===recovery.turnId)return null;
  const id=turn.nativeMessageId??session.prompts?.[turn.clientMessageId]?.nativeMessageId;
  if(typeof id!=='string'||!id||id===recovery.userMessageId)return null;
  return id;
}
/** Resolve the selected recovery turn from THIS frame while recovery is active.
 * The page end is known only when another user message exists or the page
 * explicitly proved its mounted transcript is complete. After completion, a
 * genuinely new turn is resolved from its own accepted receipt instead. An
 * unknown window never imports the whole page.
 * `scope` is capture-wide evidence from the content script: a transport frame
 * can split before the anchor/answer, but every frame from that same full-page
 * capture still carries the selected boundary.
 */
export function recoveryWindow(session,items,transcriptComplete,scope=null) {
  const recovery=recoveryBoundary(session);
  if(!recovery)return null;
  const anchor=recovery.userMessageId;
  const current=recoveryActive(session)||recoveryTurn(recovery)===session.turn?.id;
  if(!current&&recovery.status==='completed') {
    const newUserMessageId=newTurnUserMessageId(session,recovery);
    if(!newUserMessageId)return {known:false,reason:'RECOVERY_NEW_TURN_UNBOUND'};
    return {known:true,userMessageId:newUserMessageId,nextUserMessageId:null,
      transcriptComplete:transcriptComplete===true};
  }
  if(scope&&scope.anchorPresent===true&&scope.userMessageId===anchor) {
    const next=typeof scope.nextUserMessageId==='string'&&scope.nextUserMessageId
      ? scope.nextUserMessageId : null;
    if(next||scope.transcriptComplete===true)
      return {known:true,userMessageId:anchor,nextUserMessageId:next,
        transcriptComplete:scope.transcriptComplete===true};
  }
  const users=(Array.isArray(items)?items:[]).filter(item=>item?.role==='user');
  const index=users.findIndex(item=>item.nativeMessageId===anchor||item.userMessageId===anchor||item.id===anchor);
  if(index<0)return {known:false,reason:'RECOVERY_ANCHOR_MISSING'};
  const next=users[index+1];
  if(next)return {known:true,userMessageId:anchor,
    nextUserMessageId:next.nativeMessageId??null,transcriptComplete:transcriptComplete===true};
  if(transcriptComplete===true)return {known:true,userMessageId:anchor,
    nextUserMessageId:null,transcriptComplete:true};
  return {known:false,reason:'RECOVERY_BOUNDARY_UNKNOWN'};
}
function inRecoveryWindow(source,window) {
  if(!window)return true;
  // An unknown boundary is not "no filter": it must import nothing from the
  // page or from previously unprojected ledger rows.
  if(window.known!==true)return false;
  // The anchor user item itself is part of the selected turn even if a page
  // reader omitted its derived userMessageId.
  if(source.role==='user'&&source.nativeMessageId===window.userMessageId)return true;
  return source.userMessageId===window.userMessageId;
}
export function ensureObservation(session) {
  session.observation ??= {lease:randomBytes(24).toString('hex'),generation:0,
    page:null,run:null,lastSequence:0,frameDigest:null,lastObservedAt:null};
  session.approvals ??= {};
  session.sourceProjections ??= [];
  return session.observation;
}
export function observationDescriptor(session) {
  const observation=session.observation,recovery=recoveryBoundary(session);
  return {sessionId:session.id,tabId:session.tabId,documentKey:session.documentKey,
    conversationId:session.conversationId,observationLease:observation.lease,
    generation:observation.generation,runId:observation.run?.id??null,
    // Only an active run needs its page reopened by the extension. Idle or
    // historical bindings must be observed only through an already-open tab.
    active:Boolean(observation.run?.active||['sending','running','stopping'].includes(session.status)),
    // Capture-wide boundary evidence. It lets a large read be split by the
    // existing transport framing without losing the selected user anchor.
    ...(recovery?{recovery:{turnId:recovery.turnId,userMessageId:recovery.userMessageId,
      nextUserMessageId:recovery.nextUserMessageId??null,
      transcriptComplete:recovery.transcriptComplete===true,status:recovery.status}}:{}),
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
    const anchorMatch=recoveryBoundary(session)?.userMessageId===nativeId;
    const turnId=command?.payload.turnId??(session.turn?.nativeMessageId===nativeId||anchorMatch?session.turn.id:null);
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
      // The same diagnostic can be repeated by every DOM-local source in one
      // frame. The page-state card is a summary, so keep one row per code.
      issues:[...new Map(issues.map(issue=>{
        const code=typeof issue?.code==='string'?issue.code:'PAGE_CAPTURE_ISSUE';
        return [code,{code}];
      })).values()]}};
}
function projectSources(session,result,commands,run,events,issues,window=null) {
  const changes=new Map(result.changes.map(change=>[change.item.id,change]));
  // Failed local projections are retried even if the source did not change.
  // These records describe only local history, not host delivery/ACK state.
  for(const source of session.sources??[]) {
    if(!source?.id||!source.revision)continue;
    // Recovery reads one selected turn. This same gate covers newly read items,
    // previously unprojected ledger rows and approval fallback notices.
    if(!inRecoveryWindow(source,window))continue;
    const index=session.sourceProjections.findIndex(row=>row.sourceId===source.id);
    const projection=session.sourceProjections[index];
    if(window?.known&&recoveryActive(session)&&source.role==='assistant'&&
        source.lane==='output'&&source.kind==='message'&&projection) {
      // The answer may already have been projected before the original prompt
      // was marked failed. Recovery still needs that exact row confirmed.
      const item=session.history.find(row=>row.id===projection.itemId);
      if(item?.type==='assistant_message'&&item.text.trim()) {
        session.recovery.required??={};
        session.recovery.required[item.id]={text:item.text};
      }
    }
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
      if(window?.known&&recoveryActive(session)&&item.type==='assistant_message'&&source.role==='assistant'&&
          source.lane==='output'&&source.kind==='message'&&item.text.trim()){
        // Completion still requires the existing host confirmation. This is
        // only the set of projected outputs that must be confirmed.
        session.recovery.required??={};
        session.recovery.required[item.id]={text:item.text};
      }
      // A recovery anchor is a DOM locator, never a Send receipt. Do not
      // promote it to the optional "last verified native message" context.
      if(source.role==='user'&&source.nativeMessageId&&
          session.turn?.observationAnchorNativeMessageId!==source.nativeMessageId)
        session.lastNativeMessageId=source.nativeMessageId;
    } catch(error) {issues.push({code:error.code??'SOURCE_PROJECTION_FAILED',sourceId:source.id});}
  }
}
function closeRun(session,run,events,at) {
  if(!run?.active)return;
  run.active=false;run.endedAt=at;
  if(run.origin==='recovery') {
    // Keep the original failed prompt terminal. Recovery is a separate
    // observation identity; standby only starts host-confirmation waiting.
    if(recoveryActive(session)) {
      session.recovery.pageStandbyAt=at;
      session.recovery.lastObservedAt=at;
      events.push({id:session.id,state:'recovery-standby',turnId:run.id});
    }
    return;
  }
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
  // One page read can be split into several transport frames. Only the last
  // frame of that read is its closing evidence: ending the run on an earlier
  // frame reported the host turn as completed before the remaining content
  // had been received. An absent flag means a single-frame read.
  const readFinal=event.readFinal!==false;
  if(event.sequence<observation.lastSequence)return {accepted:true,stale:true,events:[]};
  if(event.sequence===observation.lastSequence) {
    invariant(digest===observation.frameDigest,'OBSERVATION_SEQUENCE_CONFLICT');
    return {accepted:true,duplicate:true,events:[]};
  }
  // A late frame from a cancelled/expired recovery belongs to a document the
  // user already retired. Accept its sequence bookkeeping so a later monitor
  // can continue, but never turn it into new projected content or status.
  if(session.recovery&&['cancelled','expired'].includes(session.recovery.status)&&
      session.recovery.tabId===session.tabId&&session.recovery.documentKey===session.documentKey){
    observation.lastSequence=event.sequence;observation.frameDigest=digest;observation.lastObservedAt=at;
    return {accepted:true,stale:true,events:[]};
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
  let window=recoveryWindow(session,event.view.items,event.view.transcriptComplete===true,
    event.view.recoveryScope);
  const activeRecovery=recoveryActive(session);
  const unknown=Boolean(window&&!window.known);
  if(unknown) {
    if(activeRecovery) {
      const already=session.recovery.status==='needs_review'&&session.recovery.reason===window.reason;
      session.recovery.status='needs_review';
      session.recovery.needsReviewAt=at;
      session.recovery.reason=window.reason;
      delete session.recovery.pageStandbyAt;
      if(run?.active) {
        run.active=false;run.endedAt=at;
      }
      if(!already) {
        issues.push({code:window.reason});
        events.push({id:session.id,state:'recovery-needs-review',turnId:run?.id??null,reason:window.reason});
      }
    }
  } else if(window?.known&&activeRecovery) {
    if(session.recovery.status==='needs_review')session.recovery.status='observing';
    delete session.recovery.reason;delete session.recovery.needsReviewAt;
    session.recovery.nextUserMessageId=window.nextUserMessageId??null;
    session.recovery.transcriptComplete=window.transcriptComplete===true;
  }
  if(page.state==='running'&&!run?.active) {
    if(activeRecovery&&window?.known) {
      // Resume the same recovery run when the answer grows after a standby
      // read. Never create a parallel page-origin run for the same document.
      run=observation.run;
      if(run?.origin==='recovery') {
        run.active=true;run.endedAt=null;delete session.recovery.pageStandbyAt;
        session.recovery.status='observing';
        events.push({id:session.id,state:'recovery-running',turnId:run.id});
      }
    } else if(!window&&!activeRecovery) {
      run=observation.run={id:randomUUID(),active:true,origin:'page',startedAt:at,endedAt:null};
      events.push({id:session.id,state:'page-running',turnId:run.id});
    }
  }
  const rawItems=Array.isArray(event.view.items)?event.view.items.map(item=>
    object(item)&&item.kind==='notice'&&typeof item.sourceType==='string'?{...item,sourceKind:item.sourceType}:item):[];
  // When the boundary is unknown, no content is reconciled or projected. The
  // user must reselect; approvals below remain independently readable.
  const items=unknown?[]:window?rawItems.filter(item=>inRecoveryWindow(item,window)):rawItems;
  const result=reconcileSources(session,items,{now:at});issues.push(...result.issues);
  projectSources(session,result,commands,run,events,issues,window);
  for(const input of Array.isArray(event.view.approvals)?event.view.approvals:[]) {
    try {
      const approval=approvalEvent({...input,state:'open'});
      const previous=session.approvals[approval.key];
      if(previous?.state==='resolved')continue;
      const value={...approval,state:'open'};
      // Manual intent and vetoes are durable command facts. A later page
      // snapshot must not overwrite them with untrusted DOM observations.
      for(const field of ['manualRequested','manualVeto','autoSuppressed','clickUncertain'])
        if(previous?.[field]===true)value[field]=true;
      // Recovery suppresses only NEW automatic approvals for this session.
      // Manual choices still go through the existing identity/uncertainty gates.
      if(recoveryActive(session))value.autoSuppressed=true;
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
        projectSources(session,fallback,commands,run,events,issues,window);
      }
    }
  }
  for(const entry of Array.isArray(event.view.closedApprovals)?event.view.closedApprovals:[]) {
    const replaced=object(entry)&&entry.reason==='superseded';
    const key=typeof entry==='string'?entry:replaced?entry.key:null;
    if(typeof key!=='string'||!Object.hasOwn(session.approvals,key))continue;
    const approval=session.approvals[key];if(approval.state==='resolved')continue;
    approval.state='resolved';
    if(replaced){approval.withdrawn=true;approval.closeReason='REQUEST_CHANGED';}
    events.push({id:session.id,state:'approval-closed',key,answered:approval.answered??null,
      ...(replaced?{withdrawn:true,reason:'REQUEST_CHANGED'}:{})});
  }
  observation.page=page;observation.lastObservedAt=at;
  observation.lastSequence=event.sequence;observation.frameDigest=digest;delete observation.gap;
  const item=stateItem(session,page,issues);
  const firstState=!session.history.some(row=>row.id===item.id);
  if(firstState)session.history.splice(historyStart,0,item);else putHistory(session,item);
  // Establish the fixed status row before the first native body. Updating it
  // later must not insert a new separator inside that body's native chunks.
  const status={id:session.id,state:'page-status',turnId:run?.id??null,item,page,issues};
  const runningIndex=events.findIndex(value=>value.state==='page-running'||value.state==='recovery-running');
  events.splice(runningIndex>=0?runningIndex+1:0,0,status);
  if(readFinal&&page.state==='standby'&&!run?.awaitCommandView)closeRun(session,run,events,at);
  if(readFinal&&window?.known&&page.state==='standby'&&!observation.run?.active&&recoveryActive(session)&&
      !session.recovery.pageStandbyAt){
    session.recovery.pageStandbyAt=at;session.recovery.lastObservedAt=at;
    events.push({id:session.id,state:'recovery-standby',turnId:session.recovery.runId??null});
  }
  const sending=Object.values(commands).some(c=>c.sessionId===session.id&&c.kind==='send'&&pending(c));
  // Recovery keeps the session visibly busy while waiting for reselect or host
  // confirmation. It must not make the failed original prompt look idle.
  session.status=sending?'sending':recoveryActive(session)?'running':observation.run?.active?'running':'idle';
  return {accepted:true,events,issues,observation:observationDescriptor(session)};
}
export function recordObservationGap(session,event,at=Date.now()) {
  assertObservation(session,event);
  const reason=typeof event.reason==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(event.reason)?event.reason:'OBSERVATION_UNAVAILABLE';
  session.observation.gap={reason,at};
  const page=unreadablePage(at),issues=[{code:'OBSERVATION_UNAVAILABLE',reason}];
  session.observation.page=page;
  const item=stateItem(session,page,issues);putHistory(session,item);
  const events=[{id:session.id,state:'page-status',turnId:session.observation.run?.id??null,item,page,issues}];
  // The page document is gone; an open approval can no longer be answered or
  // observed. Dismiss its Paseo card explicitly as withdrawn/unknown, never as
  // an allow or deny. The user must re-check the ChatGPT page.
  for(const [key,approval] of Object.entries(session.approvals??{})) {
    if(approval?.state!=='open')continue;
    approval.state='resolved';approval.withdrawn=true;
    events.push({id:session.id,state:'approval-closed',key,answered:null,withdrawn:true,reason});
  }
  return {events};
}
