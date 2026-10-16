// Public ChatGPT reasoning summaries and tool status mapped to Paseo's
// native ProviderTimelineItem types. No raw chain-of-thought, hidden tool args,
// credentials, URLs or arbitrary model/private tool results cross this boundary.
import {invariant,nativeMessageId,text} from './protocol.mjs';

const LABEL=/^[\p{L}\p{N}_.: ·-]{1,160}$/u;
const KEYS=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).every(k=>names.includes(k));

export function nativeTimelineItem(input,turnId) {
  invariant(typeof turnId==='string','NATIVE_TIMELINE_INVALID');
  invariant(KEYS(input,['type','id','text','callId','name','kind','status','details']),'NATIVE_TIMELINE_INVALID');
  if(input.type==='reasoning'){
    invariant(Object.keys(input).every(k=>['type','id','text'].includes(k)),'NATIVE_TIMELINE_INVALID');
    const id=nativeMessageId(input.id),summary=text(input.text,4096);
    invariant(summary.trim().length>0,'NATIVE_TIMELINE_INVALID');
    return {type:'reasoning',id:`reason:${turnId}:${id}`,text:summary};
  }
  invariant(input.type==='tool_call'&&
    Object.keys(input).every(k=>['type','callId','name','kind','status','details'].includes(k)),
    'NATIVE_TIMELINE_INVALID');
  const callId=nativeMessageId(input.callId),name=text(input.name,160);
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
    text:'网页公开状态：'+({running:'执行中',completed:'已完成',failed:'执行失败'})[input.status]+
      (details?[
        ...(details.input?['\n网页可见调用输入：'+clean(details.input)]:[]),
        ...(details.output?['\n网页可见调用输出：'+clean(details.output)]:[])
      ].join(''):'；具体输入/输出未获得页面可见证据')};
  return {type:'tool_call',id:`tool:${turnId}:${callId}`,callId,name,
    detail,status:input.status,
    ...(input.status==='failed'?{error:{message:'网页显示该工具调用失败'}}:{error:null})};
}

export function recordNativeTimeline(session,item){
  const turn=session.turn;
  invariant(turn&&!turn.outcome,'TURN_INACTIVE');
  const index=session.history.findIndex(r=>r.id===item.id);
  if(index<0){
    const count=session.history.filter(r=>r.type===item.type&&
      r.id.startsWith((item.type==='reasoning'?'reason:':'tool:')+turn.id+':')).length;
    invariant(count<(item.type==='reasoning'?8:32),'NATIVE_TIMELINE_LIMIT');
    session.history.push(item);
    return item;
  }
  const previous=session.history[index];
  invariant(previous.type===item.type,'NATIVE_TIMELINE_CONFLICT');
  if(item.type==='reasoning'){
    // Paseo maps repeated cumulative reasoning text to deltas. Rewriting or
    // shrinking would duplicate old words in its timeline; fail closed.
    if(!item.text.startsWith(previous.text))return null;
    if(item.text===previous.text)return null;
  }else{
    invariant(previous.callId===item.callId&&previous.name===item.name,'NATIVE_TIMELINE_CONFLICT');
    if(previous.status!=='running'&&item.status!==previous.status)return null;
    if(previous.status===item.status&&JSON.stringify(previous.detail)===JSON.stringify(item.detail))return null;
  }
  session.history[index]=item;
  return item;
}

export function settleNativeTimeline(session){
  if(!session?.turn?.id)return [];
  const settled=[];
  for(let i=0;i<session.history.length;i++){
    const previous=session.history[i];
    if(previous.type!=='tool_call'||!previous.id.startsWith('tool:'+session.turn.id+':')||
       previous.status!=='running')continue;
    const next={...previous,status:'canceled',error:null,
      detail:{type:'plain_text',label:previous.name,
        text:'轮次已结束，但网页没有提供该工具调用的可信最终结果'}};
    session.history[i]=next;settled.push(next);
  }
  return settled;
}
