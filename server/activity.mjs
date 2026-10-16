/** Bounded, exact-turn native public activity. No arguments, URLs, results or reasoning text. */
import { invariant } from './protocol.mjs';
const PHASES=new Set(['working','thinking','tool','search','exec','image','approval','finalizing','completed']);
const KINDS=new Set(['tool','search','exec','image']);
const LABEL=/^[a-zA-Z0-9_.:\- ·\u4e00-\u9fff]{1,160}$/;
export function nativeActivity(value) {
  invariant(value && typeof value==='object' && !Array.isArray(value), 'ACTIVITY_INVALID');
  invariant(Object.keys(value).every(k=>['phase','nativeStatus','steps'].includes(k)), 'ACTIVITY_INVALID');
  invariant(PHASES.has(value.phase) && ['complete','in_progress',null].includes(value.nativeStatus), 'ACTIVITY_INVALID');
  invariant(Array.isArray(value.steps)&&value.steps.length<=12,'ACTIVITY_INVALID');
  const steps=value.steps.map((step)=>{
    invariant(step && typeof step==='object' && !Array.isArray(step) &&
      Object.keys(step).every(k=>['kind','label','done'].includes(k)) &&
      KINDS.has(step.kind)&&typeof step.label==='string'&&LABEL.test(step.label)&&typeof step.done==='boolean',
      'ACTIVITY_INVALID');
    return {kind:step.kind,label:step.label,done:step.done};
  });
  // Native turn.status is useful evidence, NOT permission to publish a Paseo
  // terminal event. Only Broker's verified terminal transaction may say completed.
  const phase=value.phase==='completed'||value.nativeStatus==='complete'?'finalizing':value.phase;
  return {phase,nativeStatus:value.nativeStatus,steps};
}
/** Mutates exactly one persisted timeline item within the transaction. No new card. */
export function settleActivity(session,outcome) {
  if (!session?.turn?.id) return null;
  const id=`activity:${session.turn.id}`,at=session.history.findIndex(row=>row.id===id&&row.kind==='native-activity');
  if(at<0)return null;
  const previous=session.history[at];
  const phase=outcome==='completed'?'completed':outcome==='canceled'?'canceled':'failed';
  const nativeStatus=outcome==='completed'?'complete':null;
  if(previous.data.phase===phase&&previous.data.nativeStatus===nativeStatus)return null;
  const row={...previous,data:{...previous.data,phase,nativeStatus}};
  session.history[at]=row;
  return row;
}
export const phaseLabel=phase=>({
  working:'网页正在处理',thinking:'ChatGPT 正在思考',tool:'正在调用工具',
  search:'正在搜索资料',exec:'正在执行代码',image:'正在生成图片',
  approval:'正在等待网页授权',finalizing:'正在确认最终回答',
  completed:'任务已完成',canceled:'本轮已取消',failed:'本轮已停止跟踪'
})[phase] ?? '网页状态未知';