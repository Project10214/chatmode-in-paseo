import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fixture, until } from './helpers.mjs';

const observed={phase:'tool',nativeStatus:'in_progress',steps:[{kind:'tool',label:'mymac · run_shell_command',done:false}]};
const activityOf=s=>s.history.find(x=>x.kind==='native-activity')?.data;
async function started(t){const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);return{f,s,event};}
test('STRICT-A01: only terminal confirmation can turn activity into completed',async t=>{
 const {f,s,event}=await started(t);
 await f.broker.observe({...event,kind:'activity',activity:{...observed,phase:'completed',nativeStatus:'complete',steps:[]}});
 let state=f.broker.snapshot(s.id);
 assert.equal(state.turn.outcome,null);
 assert.equal(activityOf(state).phase,'finalizing');
 await f.broker.observe({...event,kind:'snapshot',messageId:'final-1',text:'Hello'});
 state=f.broker.snapshot(s.id);
 assert.equal(activityOf(state).phase,'finalizing');
 await f.broker.observe({...event,kind:'completed',messageId:'final-1',finalConfirmed:true});
 assert.equal(activityOf(f.broker.snapshot(s.id)).phase,'completed');
});
test('STRICT-A02a: lost browser updates the activity card before end',async t=>{
 const {f,s,event}=await started(t),emitted=[];
 f.broker.subscribe(s.id,e=>emitted.push(e));
 await f.broker.observe({...event,kind:'activity',activity:observed});
 await f.broker.observe({...event,kind:'binding_lost',diagnostic:{stage:'binding',reason:'page_closed'}});
 assert.equal(activityOf(f.broker.snapshot(s.id)).phase,'failed');
 const e=emitted.find(x=>x.state==='failed');
 assert.equal(e?.activityItem?.data.phase,'failed');
});
test('STRICT-A02b: failTurn, watchdog, reboot persist terminal card',async t=>{
 const {f,s,event}=await started(t);
 await f.broker.observe({...event,kind:'activity',activity:observed});
 await f.broker.failTurn(s.id,'STOP_UNCONFIRMED',true,event.turnId);
 assert.equal(activityOf(f.broker.snapshot(s.id)).phase,'failed');
});
test('STRICT-A02d: Runtime recover retains verified active turn and current activity',async t=>{
 const {f,s,event}=await started(t);
 await f.broker.observe({...event,kind:'activity',activity:observed});
 await f.broker.recover();
 const state=f.broker.snapshot(s.id);
 assert.equal(state.status,'running');
 assert.equal(state.turn.outcome,null);
 assert.equal(state.turn.nativeMessageId,event.nativeMessageId);
 assert.equal(activityOf(state).phase,'tool');
});
test('STRICT-A02e: actual timeout watchdog marks active timeline card failed',async t=>{
 const {f,s,event}=await started(t);
 await f.broker.observe({...event,kind:'activity',activity:observed});
 await f.broker.tick(Date.now()+f.broker.turnTimeout+2000);
 const state=f.broker.snapshot(s.id);
 assert.equal(state.status,'idle');
 assert.equal(state.turn.outcome,'failed');
 assert.equal(state.conversationId,'chat-'+s.tabId);
 assert.equal(activityOf(state).phase,'failed');
});
test('STRICT-A02c: successful Stop produces final activity, not a live tool',async t=>{
 const {f,s,event}=await started(t);
 await f.broker.observe({...event,kind:'activity',activity:observed});
 const stop=f.broker.interrupt(s.id);stop.catch(()=>{});
 const cmd=await until(()=>f.broker.queued().find(x=>x.kind==='stop'&&x.sessionId===s.id));
 const claim=await f.broker.claim(cmd.id,s.tabId,s.documentKey);
 await f.broker.result(cmd.id,claim.lease,{stopped:true,nativeMessageId:event.nativeMessageId});
 await stop;
 assert.equal(activityOf(f.broker.snapshot(s.id)).phase,'canceled');
});
test('STRICT-A03: tool metadata in hidden or analysis channels is never public',()=>{
 const context={};vm.runInNewContext(readFileSync('extension/upstream/cos-activity-main.js','utf8'),context);
 const m=(id,extra={})=>({type:'mcp-tool-call',callId:id,completed:false,invocation:{server:'internal_service',tool:'secret_lookup',arguments:{password:'NEVER_EXPOSE'}},...extra});
 const steps=[
  m('analysis-call',{channel:'analysis'}),m('hidden-call',{isVisuallyHidden:true}),m('transient-call',{isTransient:true}),
  m('hidden-meta',{metadata:{is_visually_hidden_from_conversation:true}}),m('private-actor',{recipient:'analysis'}),
  {type:'chatgpt-reasoning-group',reasoningRecap:{type:'hide_all'},items:[m('nested-hidden')]},
  {type:'chatgpt-reasoning-group',reasoningRecap:{type:'show'},channel:'analysis',items:[m('group-hidden')]},
  {type:'chatgpt-reasoning-group',reasoningRecap:{type:'show'},items:[{type:'mcp-tool-call',callId:'public',invocation:{server:'mymac',tool:'run_shell_command'},completed:false}]}
 ];
 const result=context.CIP_COS_ACTIVITY.shellTurnTrace({status:'in_progress',items:steps});
 assert.equal(result.steps.length,1);
 assert.equal(result.steps[0].label,'mymac · run_shell_command');
 assert.ok(!JSON.stringify(result).includes('NEVER_EXPOSE'));
});
test('STRICT-A06: code exec remains an exec phase',()=>{
 const context={};vm.runInNewContext(readFileSync('extension/upstream/cos-activity-main.js','utf8'),context);
 const result=context.CIP_COS_ACTIVITY.shellTurnTrace({status:'in_progress',items:[{type:'dynamic-tool-call',tool:'exec',callId:'exec-1',completed:false}]});
 assert.equal(result.phase,'exec');
});
