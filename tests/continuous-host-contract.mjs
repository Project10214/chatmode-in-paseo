/** Public-provider capability probes against byte-pinned ORIGINAL Paseo classes.
 * Opt-in: source ../logs/validation-env-012b2.sh; node --test tests/continuous-host-contract.mjs
 * The event source is synthetic. Host session, lifecycle, permissions, conversion
 * and canonical projection are real. No running daemon/browser/account is used.
 * These characterize integration choices; passing is NOT a completed CIP feature.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPaseoHost } from './fixtures/paseo-host-sources.mjs';
import { permissionRequest } from '../server/approval.mjs';

const { AgentManager, PluginAgentClientRegistry, ProviderEventSchema, version } =
  await loadPaseoHost(process.env.CIP_PASEO_SERVER_PACKAGE);
console.log(`# continuous-sync public protocol on original Paseo ${version}`);
const noop = () => {};
const logger = { trace:noop, debug:noop, info:noop, warn:noop, error:noop, fatal:noop, child(){return this;} };
const agentId = 'c011e670-0000-4000-8000-000000000001';
const capabilities = ['prompt.message', 'permission', 'session.interrupt', 'timeline.plugin'];
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) {
  for(let i=0;i<1000;i++){if(fn())return;await tick();}
  assert.fail('Expected host event did not arrive');
}
async function drain(w) {
  for(let i=0;i<4;i++){await w.manager.drainSessionEvents(agentId);await tick();}
}
async function world(t) {
  const listeners = new Set(), inputs = [];
  let sessionId, wireId, runNumber = 0;
  const emit = value => {
    const checked = ProviderEventSchema.safeParse({sessionId,...value});
    assert.ok(checked.success,JSON.stringify({value,issues:checked.error?.issues}));
    for(const fn of listeners)fn(checked.data);
  };
  const registration = {
    id:'chatmode',label:'CIP capability probe',icon:'icon.svg',
    async connect(request){
      const accepted=capabilities.filter(c=>request.capabilities.includes(c));
      return {
        version:1,capabilities:accepted,
        onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);},
        async send(input){
          inputs.push(input);
          switch(input.type){
            case 'catalog':
              emit({type:'catalog',requestId:input.requestId,catalog:{models:[{id:'probe',label:'Probe'}],modes:[],thinkingOptions:[],defaultModel:'probe'}});return;
            case 'session.open':
              sessionId=input.sessionId;
              emit({type:'session.opened',requestId:input.requestId,capabilities:accepted,restoration:'core',cwd:input.config.cwd});
              emit({type:'session.config',config:{model:'probe',models:[{id:'probe',label:'Probe'}],modes:[],thinkingOptions:[],settings:[]}});
              emit({type:'session.ready',requestId:input.requestId});return;
            case 'session.prompt':
              wireId='button-run-'+(++runNumber);
              emit({type:'session.prompt_result',clientMessageId:input.prompt.clientMessageId,result:{type:'turn',turnId:wireId}});
              emit({type:'session.turn',turnId:wireId,state:'started'});return;
            case 'session.permission':
              emit({type:'session.permission_resolved',permissionId:input.permissionId});return;
            case 'session.interrupt':
              emit({type:'session.turn',turnId:wireId,state:'completed'});
              emit({type:'request.completed',requestId:input.requestId});return;
            case 'session.close':
              emit({type:'session.closed'});emit({type:'request.completed',requestId:input.requestId});return;
            default:throw new Error('Unexpected probe input '+input.type);
          }
        },
        async close(){listeners.clear();}
      };
    }
  };
  const registry=new PluginAgentClientRegistry(logger);registry.replace([registration]);
  const client=registry.clients().chatmode;
  const manager=new AgentManager({logger,clients:{chatmode:client},providerDefinitions:registry.definitions(),agentStreamCoalesceWindowMs:0});
  const session=await client.createSession({provider:'chatmode',cwd:'/tmp',model:'probe'});
  await manager.registerSession(session,{provider:'chatmode',cwd:'/tmp'},agentId,{historyPrimed:true});
  t.after(async()=>{await registry.shutdown();});
  const w={manager,session,emit,inputs,get wireId(){return wireId;},get agent(){return manager.getAgent(agentId);},
    async start(){
      const previous=wireId,events=[];
      const done=(async()=>{for await(const event of manager.streamAgent(agentId,'synthetic test prompt',{clientMessageId:'prompt-'+(runNumber+1)}))events.push(event);})();
      await until(()=>wireId!==previous);await drain(w);return {wireId,done,events};
    },
    async standby(run){emit({type:'session.turn',turnId:run.wireId,state:'completed'});await drain(w);await run.done;},
    async runAgain(){wireId='button-run-'+(++runNumber);emit({type:'session.turn',turnId:wireId,state:'started'});await drain(w);return wireId;},
    async permission(key='approval-1'){
      emit({type:'session.permission',request:permissionRequest({key,app:'mymac',tool:'printf',input:'fixed marker only'})});await drain(w);
    },
    async item(item){emit({type:'timeline.item',item});await drain(w);},
    rows(){return manager.getTimeline(agentId).map(item=>({item}));}
  };
  return w;
}
const tool=status=>({type:'tool_call',id:'web-tool-1',callId:'native-call-1',name:'mymac · printf',detail:{type:'plain_text',label:'printf',text:'fixed marker only'},status,error:null});
const card=status=>({type:'plugin',pluginId:'chatmode-in-paseo',id:'web-source-1',kind:'observed-content',version:1,data:{sourceId:'native-call-1',status,text:'原文'}});

test('CS-HOST-1: standby completes foreground without clearing a pending permission; response still reaches provider',async t=>{
  const w=await world(t),run=await w.start();
  await w.permission();
  assert.equal(w.agent.pendingPermissions.size,1);
  assert.equal(w.inputs.filter(i=>i.type==='session.permission').length,0);
  await w.standby(run);
  assert.equal(w.agent.lifecycle,'idle');
  assert.equal(w.agent.pendingPermissions.size,1,'completion is not cancellation/denial');
  await w.manager.respondToPermission(agentId,'approval-1',{behavior:'allow',selectedActionId:'allow-once'});
  await drain(w);
  assert.equal(w.inputs.filter(i=>i.type==='session.permission').length,1);
  assert.equal(w.agent.pendingPermissions.size,0);
  assert.equal(w.inputs.filter(i=>i.type==='session.prompt').length,1,'no resending the original prompt');
});

test('CS-HOST-2: permission arriving after standby is accepted; a new button-run restores native Stop',async t=>{
  const w=await world(t),run=await w.start();await w.standby(run);
  await w.permission('after-idle');
  assert.equal(w.agent.pendingPermissions.size,1);
  const next=await w.runAgain();
  assert.notEqual(next,run.wireId);
  assert.equal(w.agent.lifecycle,'running');
  await w.manager.cancelAgentRun(agentId);await drain(w);
  assert.equal(w.inputs.filter(i=>i.type==='session.interrupt').length,1);
  assert.equal(w.inputs.filter(i=>i.type==='session.permission').length,0,'native Stop does not synthesize an Allow/Deny response');
  assert.equal(w.agent.lifecycle,'idle');
});

test('CS-HOST-3 characterization: native tool identity is scoped to host run, not only webpage callId',async t=>{
  const w=await world(t),run=await w.start();await w.item(tool('running'));await w.standby(run);
  await w.runAgain();await w.item(tool('completed'));
  const calls=w.rows().filter(r=>r.item.type==='tool_call');
  assert.equal(calls.length,2,'documents a native projection limitation, NOT a CIP acceptance pass');
  assert.deepEqual(calls.map(r=>r.item.status),['running','completed']);
});

test('CS-HOST-4: plugin-owned identity updates once across running and standby, independent of host run',async t=>{
  const w=await world(t),run=await w.start();await w.item(card('running'));await w.standby(run);
  await w.item(card('waiting'));await w.runAgain();
  const revised=card('completed');revised.data.text='修订后的原文';await w.item(revised);
  const items=w.rows().filter(r=>r.item.type==='plugin');
  assert.equal(items.length,1);
  assert.equal(items[0].item.data.status,'completed');
  assert.equal(items[0].item.data.text,'修订后的原文');
});

test('CS-HOST-5: direct append adds missing history at the tail and replaces same-id content',async t=>{
  const w=await world(t),run=await w.start();await w.standby(run);
  // This is the exact unmodified method called by session.js's public
  // agent_timeline_append_request handler, not a patch or provider event.
  const newer=card('newer-source-content');newer.id='already-visible-newer';
  await w.manager.appendTimelineItem(agentId,newer);
  const first=await w.manager.appendTimelineItem(agentId,card('late-history'));
  await w.manager.appendTimelineItem(agentId,card('updated-history'));
  assert.equal(typeof first.seq,'number');
  const items=w.rows().filter(r=>r.item.type==='plugin');
  assert.deepEqual(items.map(r=>r.item.id),['already-visible-newer','web-source-1'],'missing earlier content is appended, not inserted into an old position');
  assert.equal(items[1].item.data.status,'updated-history');
  assert.equal(w.agent.lifecycle,'idle');
});

test('CS-HOST-6: direct append survives pre-provider prompt failure; permission and lifecycle need redelivery',async t=>{
  const w=await world(t),first=await w.start();await w.standby(first);
  let entered=false,release;
  const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  // Fault injection at the public session boundary: original host source and
  // queues are unchanged. No second prompt reaches the event-source provider.
  const original=w.session.startTurn;
  w.session.startTurn=async()=>{entered=true;await gate;throw new Error('CS_PRE_PROVIDER_FAILURE');};
  let failure;
  const pending=(async()=>{for await(const _ of w.manager.streamAgent(agentId,'unrelated pending prompt',{clientMessageId:'pending-failure'}));})().catch(e=>{failure=e;});
  await until(()=>entered);
  const lostWire=await w.runAgain();
  await w.permission('pending-permission');
  const transient=card('via-provider');transient.id='provider-only';await w.item(transient);
  const durable=card('via-direct-append');durable.id='direct-during-pending';
  await w.manager.appendTimelineItem(agentId,durable);
  assert.ok(w.manager.runs.getPendingRun(agentId).stagedEvents.length>=3);
  release();await pending;await drain(w);w.session.startTurn=original;
  assert.match(failure?.message??'',/CS_PRE_PROVIDER_FAILURE/);
  assert.equal(w.rows().filter(r=>r.item.id==='provider-only').length,0,'Provider event was discarded by the failed pending prompt');
  assert.equal(w.rows().filter(r=>r.item.id==='direct-during-pending').length,1,'public plugin append target bypasses pending staging');
  assert.equal(w.agent.pendingPermissions.size,0,'native permission event was also staged and lost');
  // A new observation can repeat the still-visible request and current button
  // state without resending the webpage prompt or answering the permission.
  w.emit({type:'session.turn',turnId:lostWire,state:'started'});await w.permission('pending-permission');await drain(w);
  assert.equal(w.agent.lifecycle,'running');assert.equal(w.agent.pendingPermissions.size,1);
  w.emit({type:'session.turn',turnId:lostWire,state:'completed'});await drain(w);
  assert.equal(w.agent.lifecycle,'idle');assert.equal(w.agent.pendingPermissions.size,1);
  assert.equal(w.inputs.filter(i=>i.type==='session.prompt').length,1);
  assert.equal(w.inputs.filter(i=>i.type==='session.permission').length,0);
});

test('CS-HOST-7 characterization: native assistant revisions are appended, not replaced',async t=>{
  const w=await world(t),run=await w.start();
  await w.item({type:'assistant_message',id:'same-web-message',text:'初稿甲'});
  await w.item({type:'assistant_message',id:'same-web-message',text:'修订乙'});
  const messages=w.rows().filter(r=>r.item.type==='assistant_message');
  assert.equal(messages.length,1);
  assert.equal(messages[0].item.text,'初稿甲修订乙','documents the original native-delta limitation, not desired CIP output');
  await w.standby(run);
});

test('CS-HOST-8 characterization: plugin-only output is not the native machine final answer',async t=>{
  const w=await world(t),run=await w.start();
  const output=card('answer');output.data.text='网页已经显示的完整回答';
  await w.manager.appendTimelineItem(agentId,output);await w.standby(run);
  assert.ok(w.rows().some(r=>r.item.data?.text==='网页已经显示的完整回答'));
  assert.equal(await w.manager.getLastAssistantMessage(agentId),null,'native machine/finish-notification reader ignores plugin content');
});

test('CS-HOST-9 characterization: page-side authorization closure becomes default deny without a recorded Paseo choice',async t=>{
  const w=await world(t),run=await w.start(),events=[];
  t.after(w.session.subscribe(event=>events.push(event)));
  await w.permission('closed-on-page');await w.standby(run);
  w.emit({type:'session.permission_resolved',permissionId:'closed-on-page'});await drain(w);
  const resolution=events.find(e=>e.type==='permission_resolved');
  assert.equal(resolution.resolution.behavior,'deny');
  assert.equal(resolution.resolution.message,'Resolved by provider');
  assert.equal(w.inputs.filter(i=>i.type==='session.permission').length,0,'no actual allow or deny operation was requested');
});

test('CS-HOST-10 characterization: replaying a lost Allow resolution changes its native meaning to Deny',async t=>{
  const w=await world(t),run=await w.start(),events=[];
  t.after(w.session.subscribe(event=>events.push(event)));
  await w.permission('explicit-allow');await w.standby(run);
  let entered=false,release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const original=w.session.startTurn;
  w.session.startTurn=async()=>{entered=true;await gate;throw new Error('CS_RESOLUTION_PENDING_FAILURE');};
  const pending=(async()=>{for await(const _ of w.manager.streamAgent(agentId,'pending failure',{clientMessageId:'resolution-pending'}));})().catch(e=>e);
  await until(()=>entered);
  await w.manager.respondToPermission(agentId,'explicit-allow',{behavior:'allow',selectedActionId:'allow-once'});
  assert.ok(w.manager.runs.getPendingRun(agentId).stagedEvents.some(e=>e.type==='permission_resolved'&&e.resolution.behavior==='allow'));
  release();const failed=await pending;await drain(w);w.session.startTurn=original;
  assert.match(failed.message,/CS_RESOLUTION_PENDING_FAILURE/);
  w.emit({type:'session.permission_resolved',permissionId:'explicit-allow'});await drain(w);
  assert.deepEqual(events.filter(e=>e.type==='permission_resolved').map(e=>e.resolution.behavior),['allow','deny']);
  assert.equal(w.inputs.filter(i=>i.type==='session.permission').length,1,'re-emitting a resolution must not be mistaken for a second webpage action');
});
