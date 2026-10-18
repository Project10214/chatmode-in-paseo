// Public ChatGPT reasoning summaries and tool status mapped to Paseo's
// native ProviderTimelineItem types. No raw chain-of-thought, hidden tool args,
// credentials, URLs or arbitrary model/private tool results cross this boundary.
import {invariant,nativeMessageId,text} from './protocol.mjs';

const LABEL=/^[\p{L}\p{N}_.: ·-]{1,160}$/u;
const KEYS=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).every(k=>names.includes(k));

// ChatGPT names one app call two ways: `asdk_app_<id> · tool` while it waits
// for approval, then `codex_apps · <app>.tool` when it runs. Show the app's
// catalog name and the tool, so both read the same and can be merged.
const APP_ID=/^asdk_app_[A-Za-z0-9_-]{1,160}$/;
const appKey=value=>value.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
function splitToolName(name,apps=[]){
  const at=name.indexOf(' · ');
  if(at<0)return null;
  const server=name.slice(0,at),tool=name.slice(at+3);
  if(APP_ID.test(server)){
    const label=apps.find(app=>app?.id===server)?.label;
    return {app:typeof label==='string'&&LABEL.test(label+' · '+tool)?label:'ChatGPT 应用',tool,origin:'pending-app'};
  }
  if(server==='codex_apps'){
    const dot=tool.indexOf('.');
    if(dot>0){
      const app=tool.slice(0,dot),action=tool.slice(dot+1);
      return {app,tool:action,origin:action==='approval_wait'?'approval-wait':'call'};
    }
  }
  return null;
}
export function toolDisplayName(name,apps=[]){
  const parts=typeof name==='string'?splitToolName(name,apps):null;
  return parts?`${parts.app} · ${parts.tool}`:name;
}
export function toolOrigin(input,apps=[]){
  return input?.type==='tool_call'&&typeof input.name==='string'?splitToolName(input.name,apps)?.origin??'call':null;
}

export function nativeTimelineItem(input,turnId,{apps=[]}={}) {
  invariant(typeof turnId==='string','NATIVE_TIMELINE_INVALID');
  invariant(KEYS(input,['type','id','text','callId','name','kind','status','details','settled']),'NATIVE_TIMELINE_INVALID');
  if(input.type==='reasoning'){
    invariant(Object.keys(input).every(k=>['type','id','text'].includes(k)),'NATIVE_TIMELINE_INVALID');
    const id=nativeMessageId(input.id),summary=text(input.text,4096);
    invariant(summary.trim().length>0,'NATIVE_TIMELINE_INVALID');
    return {type:'reasoning',id:`reason:${turnId}:${id}`,text:summary};
  }
  invariant(input.type==='tool_call'&&
    Object.keys(input).every(k=>['type','callId','name','kind','status','details','settled'].includes(k))&&
    (input.settled===undefined||(input.settled===true&&input.status==='completed')),
    'NATIVE_TIMELINE_INVALID');
  const callId=nativeMessageId(input.callId),name=toolDisplayName(text(input.name,160),apps);
  invariant(LABEL.test(name)&&['tool','search','exec','image'].includes(input.kind)&&
    ['running','completed','failed'].includes(input.status),'NATIVE_TIMELINE_INVALID');
  // Paseo's plain_text detail is an explicit native tool detail, not a
  // reconstructed invocation. The webpage exposes only the display name and
  // state in this projection; absent arguments/results are never fabricated.
  let details=null;
  if(input.details!==undefined){
    invariant(KEYS(input.details,['input','output']),'NATIVE_TIMELINE_INVALID');
    for(const value of Object.values(input.details))
      invariant(typeof value==='string'&&value.length>0&&value.length<=2048,
        'NATIVE_TIMELINE_INVALID');
    details=input.details;
  }
  const clean=value=>value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,'$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|token|password|authorization|secret)\s*[:=]\s*)(["']?)[^\s"',};&]+/gi,'$1[REDACTED]');
  const detail={type:'plain_text',label:name,
    text:(input.settled?'本轮已结束；网页未单独确认此调用的结果。':
      '网页状态：'+({running:'执行中',completed:'已完成',failed:'执行失败'})[input.status])+
      (details?[
        ...(details.input?['\n网页可见输入：'+clean(details.input)]:[]),
        ...(details.output?['\n网页可见输出：'+clean(details.output)]:[])
      ].join(''):'\n输入、输出未同步。')};
  return {type:'tool_call',id:`tool:${turnId}:${callId}`,callId,name,
    detail,status:input.status,
    ...(input.status==='failed'?{error:{message:'网页显示该工具调用失败'}}:{error:null})};
}

// Returns {item} when Paseo should upsert it, {issue} when the native item is
// real but cannot be represented faithfully (never thrown: a reasoning/tool
// limit must not stop the answer or page status), or null when unchanged.
export function recordNativeTimeline(session,item,{historyLimit=Infinity,origin='call'}={}){
  const turn=session.turn;
  invariant(turn&&!turn.outcome,'TURN_INACTIVE');
  if(item.type==='tool_call'){
    // The approval card itself becomes a Paseo permission request; its
    // internal wait step is not a separate tool call.
    if(origin==='approval-wait')return null;
    const alias=turn.toolAliases?.[item.callId];
    if(alias)item={...item,id:alias.id,callId:alias.callId};
    else if(origin==='call'&&!session.history.some(r=>r.id===item.id)){
      // The run that follows an approval updates the waiting card instead of
      // adding a second one for the same invocation.
      const tool=item.name.slice(item.name.indexOf(' · ')+3),key=appKey(item.name.slice(0,item.name.indexOf(' · ')));
      const waiting=(turn.pendingToolCards??[]).map(id=>session.history.find(r=>r.id===id))
        .filter(r=>r?.type==='tool_call'&&r.status==='running'&&r.name.slice(r.name.indexOf(' · ')+3)===tool);
      const card=waiting.find(r=>appKey(r.name.slice(0,r.name.indexOf(' · ')))===key)??(waiting.length===1?waiting[0]:null);
      if(card){
        turn.toolAliases={...(turn.toolAliases??{}),[item.callId]:{id:card.id,callId:card.callId}};
        turn.pendingToolCards=turn.pendingToolCards.filter(id=>id!==card.id);
        item={...item,id:card.id,callId:card.callId,name:card.name,detail:{...item.detail,label:card.name}};
      }
    }
  }
  const index=session.history.findIndex(r=>r.id===item.id);
  if(index<0){
    const count=session.history.filter(r=>r.type===item.type&&
      r.id.startsWith((item.type==='reasoning'?'reason:':'tool:')+turn.id+':')).length;
    if(count>=(item.type==='reasoning'?8:32)||session.history.length>=historyLimit)
      return {issue:{code:'NATIVE_TIMELINE_LIMIT',messageId:null}};
    session.history.push(item);
    if(origin==='pending-app')turn.pendingToolCards=[...(turn.pendingToolCards??[]),item.id];
    return {item};
  }
  const previous=session.history[index];
  invariant(previous.type===item.type,'NATIVE_TIMELINE_CONFLICT');
  if(item.type==='reasoning'){
    // Paseo maps repeated cumulative reasoning text to deltas. Rewriting or
    // shrinking would duplicate old words in its timeline; keep the published
    // text and report the unrepresentable revision instead of hiding it.
    if(item.text===previous.text)return null;
    if(!item.text.startsWith(previous.text))
      return {issue:{code:'REASONING_NOT_PREFIX',messageId:item.id.slice(('reason:'+turn.id+':').length)}};
  }else{
    invariant(previous.callId===item.callId&&previous.name===item.name,'NATIVE_TIMELINE_CONFLICT');
    // A card closed by CIP without native evidence may still receive the real
    // native result later (e.g. after observation recovery).
    const unconfirmed=(turn.unconfirmedToolIds??[]).includes(item.id);
    if(previous.status!=='running'&&item.status!==previous.status&&!unconfirmed)return null;
    if(previous.status===item.status&&JSON.stringify(previous.detail)===JSON.stringify(item.detail))return null;
    if(unconfirmed)turn.unconfirmedToolIds=turn.unconfirmedToolIds.filter(id=>id!==item.id);
  }
  session.history[index]=item;
  return {item};
}

// Preserve the last observed native state and visible detail. Tracking ending
// cannot manufacture a native terminal. An explicit freshness warning makes
// clear that the old running state is not a new proof of current execution.
export function settleNativeTimeline(session){
  if(!session?.turn?.id)return [];
  const settled=[];
  for(let i=0;i<session.history.length;i++){
    const previous=session.history[i];
    if(previous.type!=='tool_call'||!previous.id.startsWith('tool:'+session.turn.id+':')||
       previous.status!=='running')continue;
    const next={...previous,
      detail:{type:'plain_text',label:previous.name,
        text:(previous.detail?.text??'')+'\n跟踪已结束；上次网页状态仅供参考，工具是否结束未确认。'}};
    session.history[i]=next;settled.push(next);
  }
  if(settled.length)session.turn.unconfirmedToolIds=[...new Set([...(session.turn.unconfirmedToolIds??[]),...settled.map(x=>x.id)])];
  return settled;
}
