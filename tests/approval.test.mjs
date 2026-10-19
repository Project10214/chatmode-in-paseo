import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import { fixture, until } from './helpers.mjs';
import { approvalEvent, permissionRequest, approvalChoice } from '../server/approval.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';

// The live card's "See details" JSON (2026-10-17).
const input = JSON.stringify({ path: '/asdk_app_6a61dc538d588191aba0dea895a73f80/link_6a61dca44c3c81918f489578c4f991b8/run_shell_command',
  args: { command: 'node --version', cwd: '/example/project', timeout_seconds: 10 } }, null, 2);
const card = { state: 'open', key: '6f1c2d3e-0000-4000-8000-000000000001', app: 'mymac', tool: 'run_shell_command', input };

test('APPROVAL-1 the page report is strict; the Paseo request shows the exact command and offers only allow once / deny', () => {
  assert.throws(() => approvalEvent({ ...card, extra: 1 }), /APPROVAL_INVALID/);
  assert.throws(() => approvalEvent({ ...card, key: 'BAD KEY' }), /APPROVAL_INVALID/);
  assert.deepEqual(approvalEvent({ state: 'closed', key: card.key }), { state: 'closed', key: card.key });
  const request = permissionRequest(approvalEvent(card));
  assert.equal(request.name, 'mymac · run_shell_command');
  assert.deepEqual(request.detail, { type: 'shell', command: 'node --version', cwd: '/example/project' });
  assert.deepEqual(request.actions.map(a => [a.id, a.behavior]), [['allow-once', 'allow'], ['deny', 'deny']]);
  assert.equal(ProviderEventSchema.safeParse({ type: 'session.permission', sessionId: 'h', request }).success, true);
  // A truncated payload is shown as text, never reconstructed.
  const truncated = permissionRequest({ ...card, input: input.slice(0, 60) });
  assert.equal(truncated.detail.type, 'plain_text');
  assert.equal(truncated.input, undefined);
  assert.equal(approvalChoice({ behavior: 'allow' }), 'allow-once');
  assert.equal(approvalChoice({ behavior: 'deny' }), 'deny');
  const denyOnly = permissionRequest(approvalEvent({ ...card, clickable: false, canDeny: true,
    labels: ['Not now'], denyLabel: 'Not now' }));
  assert.deepEqual(denyOnly.actions.map(a => [a.id, a.behavior]), [['deny', 'deny']]);
  assert.throws(() => approvalChoice({ behavior: 'allow', selectedActionId: 'always' }), /APPROVAL_UNSUPPORTED/);
  assert.throws(() => approvalChoice({ behavior: 'allow', updatedPermissions: [{ rule: 'x' }] }), /APPROVAL_UNSUPPORTED/);
});

test('APPROVAL-2 Broker: the bound open card remains actionable in standby, once, by a confirmed click', async t => {
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const seen=[];f.broker.subscribe(s.id,event=>seen.push(event));
  await f.view(s,{state:'standby',approvals:[card]});
  const current=f.broker.snapshot(s.id);
  assert.equal(current.turn.outcome,'completed');
  assert.equal(current.approvals[card.key].state,'open');
  await f.view(s,{state:'standby',approvals:[card]});
  assert.equal(seen.filter(event=>event.state==='approval').length,1);
  await assert.rejects(f.broker.answerApproval(s.id,'ffffffff-0000-4000-8000-000000000000','allow-once'),/APPROVAL_GONE/);
  await assert.rejects(f.broker.answerApproval(s.id,card.key,'always'),/APPROVAL_INVALID/);
  const answering=f.broker.answerApproval(s.id,card.key,'allow-once');answering.catch(()=>{});
  const command=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  assert.deepEqual(command.payload,{observationLease:current.observation.lease,tabId:s.tabId,
    documentKey:s.documentKey,conversationId:current.conversationId,key:card.key,choice:'allow-once'});
  await assert.rejects(f.broker.answerApproval(s.id,card.key,'deny'),/APPROVAL_BUSY/);
  const claim=await f.broker.claim(command.id,s.tabId,s.documentKey);
  await assert.rejects(f.broker.result(command.id,claim.lease,{answered:true,key:card.key,choice:'deny'}),/APPROVAL_UNCONFIRMED/);
  assert.equal(f.broker.snapshot(s.id).approvals[card.key].answered,undefined);
  await f.broker.result(command.id,claim.lease,{answered:true,key:card.key,choice:'allow-once'});
  assert.deepEqual(await answering,{answered:true,choice:'allow-once'});
  await assert.rejects(f.broker.answerApproval(s.id,card.key,'allow-once'),/APPROVAL_GONE/);
  await f.view(s,{state:'standby',closedApprovals:[card.key]});
  const closed=seen.filter(event=>event.state==='approval-closed');
  assert.equal(closed.length,1);assert.equal(closed[0].answered,'allow-once');
  assert.equal(f.broker.snapshot(s.id).approvals[card.key].state,'resolved');
  assert.equal(Object.values(f.store.read().commands).filter(c=>c.kind==='send').length,1);
});

test('APPROVAL-3 Provider: real confirmation resolves once; unknown external closure never fabricates Deny', async t => {
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const connection=await createProvider({...f,status:()=>({connected:true})},event=>ProviderEventSchema.parse(event))
    .connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>connection.close());
  const events=[];connection.onEvent(event=>events.push(event));
  await connection.send({type:'session.open',requestId:'o',sessionId:'host',history:'skip',
    persistence:{version:1,data:{id:s.id}},config:{cwd:'/x',env:{},settings:{},mcpServers:{},persist:true,
      model:'m1',thinkingOption:'standard',providerOptions:{appIds:['asdk_app_a']}}});
  await until(()=>events.some(event=>event.type==='session.ready'));
  await f.view(s,{state:'standby',approvals:[card]});
  await f.view(s,{state:'standby',approvals:[card]});
  assert.equal(events.filter(event=>event.type==='session.permission').length,1);
  assert.equal(f.broker.queued().filter(c=>c.kind==='approval').length,0);
  await connection.send({type:'session.permission',sessionId:'host',permissionId:card.key,response:{behavior:'allow'}});
  const command=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  assert.equal(command.payload.choice,'allow-once');
  assert.equal(events.filter(event=>event.type==='session.permission_resolved').length,0);
  const claim=await f.broker.claim(command.id,s.tabId,s.documentKey);
  await f.broker.result(command.id,claim.lease,{answered:true,key:card.key,choice:'allow-once'});
  await until(()=>events.some(event=>event.type==='session.permission_resolved'));
  await f.view(s,{state:'standby',closedApprovals:[card.key]});
  assert.equal(events.filter(event=>event.type==='session.permission_resolved').length,1);

  const other={...card,key:'6f1c2d3e-0000-4000-8000-000000000002'};
  await f.view(s,{state:'standby',approvals:[other]});
  await f.view(s,{state:'standby',closedApprovals:[other.key]});
  assert.equal(events.filter(event=>event.type==='session.permission_resolved').length,1);
  assert.ok(events.some(event=>event.type==='session.notice'&&event.notice.id==='approval-withdrawn:'+other.key));
  assert.equal(f.broker.snapshot(s.id).approvals[other.key].answered,undefined);

  const third={...card,key:'6f1c2d3e-0000-4000-8000-000000000003'};
  await f.view(s,{state:'standby',approvals:[third]});
  await connection.send({type:'session.permission',sessionId:'host',permissionId:third.key,response:{behavior:'deny'}});
  const failed=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  const failedClaim=await f.broker.claim(failed.id,s.tabId,s.documentKey);
  await f.broker.result(failed.id,failedClaim.lease,{error:'APPROVAL_GONE'});
  await until(()=>events.some(event=>event.type==='session.notice'&&event.notice.id==='approval-withdrawn:'+third.key));
  assert.equal(events.filter(event=>event.type==='session.permission_resolved').length,1,
    'a page-side closure must not synthesize a native Deny');
  assert.equal(f.broker.snapshot(s.id).approvals[third.key].state,'resolved');
  await connection.send({type:'session.permission',sessionId:'host',permissionId:third.key,
    response:{behavior:'deny',selectedActionId:'deny'}});
  await until(()=>events.filter(event=>event.type==='session.permission_resolved').length===2);
  assert.equal(f.broker.queued().filter(c=>c.kind==='approval').length,0,
    'explicitly dismissing a stale request must not click the website');
  assert.equal(f.broker.snapshot(s.id).approvals[third.key].withdrawn,true);
});

test('APPROVAL-4 an unrecognized card still becomes a Paseo request that points to the page, and is never answered from Paseo', async t => {
  const odd = { state: 'open', key: '6f1c2d3e-0000-4000-8000-000000000009', app: 'mymac', tool: null, input: null, clickable: false, labels: ['Nope', 'Sure'] };
  const parsed = approvalEvent(odd);
  assert.equal(parsed.clickable, false);
  assert.throws(() => approvalEvent({ ...odd, allowLabel: 'Sure' }), /APPROVAL_INVALID/, 'no captions for actions it cannot click');
  assert.throws(() => approvalEvent({ ...odd, labels: ['x\ny'] }), /APPROVAL_INVALID/);
  const request = permissionRequest(parsed);
  assert.equal(request.description, '无法识别网页按钮，请到 ChatGPT 网页处理。');
  assert.equal(ProviderEventSchema.safeParse({ type: 'session.permission', sessionId: 'h', request }).success, true);
  const labelled = permissionRequest(approvalEvent({ ...card, clickable: true, allowLabel: 'Allow once', denyLabel: 'Deny', labels: ['Always allow', 'Deny', 'Allow once'] }));
  assert.deepEqual(labelled.actions.map(a => a.label), ['允许（Allow once）', '拒绝（Deny）']);
  const f = await fixture(t), s = await f.ready();await f.sending(s);
  await f.view(s,{state:'standby',approvals:[odd]});
  await assert.rejects(f.broker.answerApproval(s.id, odd.key, 'allow-once'), /APPROVAL_UNRECOGNIZED/);
  assert.equal(f.broker.queued().filter(c => c.kind === 'approval').length, 0, 'nothing queued for the page');
});

test('APPROVAL-5 the global auto switch answers an exact anonymous approval without a Paseo click', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.sending(s);
  const connection = await createProvider({ ...f, status: () => ({ connected: true }) }, event => ProviderEventSchema.parse(event))
    .connect({ versions: [1], capabilities: CAPABILITIES });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent(event => events.push(event));
  await connection.send({ type: 'session.open', requestId: 'auto-open', sessionId: 'auto-host', history: 'skip',
    persistence: { version: 1, data: { id: s.id } }, config: { cwd: '/x', env: {}, settings: {}, mcpServers: {}, persist: true,
      model: 'm1', thinkingOption: 'standard', providerOptions: { appIds: ['asdk_app_a'] } } });
  await until(() => events.some(event => event.type === 'session.ready'));

  const auto = { ...card, key: '6f1c2d3e-0000-4000-8000-000000000010', clickable: false,
    autoEligible: true, autoTier: 'once', labels: ['Allow once', 'Deny'] };
  await f.view(s, { state: 'standby', approvals: [auto] });
  assert.equal(f.broker.queued().filter(c => c.kind === 'approval').length, 0,
    'the switch is off by default and never writes an approval command');
  await f.broker.setAutoAllowApprovals(true);
  const on = { ...auto, key: '6f1c2d3e-0000-4000-8000-000000000011' };
  await f.view(s, { state: 'standby', approvals: [on] });
  const command = await until(() => f.broker.queued().find(c => c.kind === 'approval'));
  assert.equal(command.payload.choice, 'allow-auto');
  assert.equal(events.filter(event => event.type === 'session.permission' && event.request.id === on.key).length, 1,
    'the request remains visible as the manual fallback');
  const claim = await f.broker.claim(command.id, s.tabId, s.documentKey);
  await f.broker.result(command.id, claim.lease,
    { answered: true, key: on.key, choice: 'allow-auto', tier: 'once', clicked: 1 });
  await until(() => events.some(event => event.type === 'session.notice' &&
    event.notice.title === '已自动允许网页授权'));
  await f.view(s, { state: 'standby', closedApprovals: [on.key] });
  assert.equal(f.broker.snapshot(s.id).approvals[on.key].state, 'resolved');
  assert.equal(events.filter(event => event.type === 'session.permission_resolved').length, 1);
});

test('APPROVAL-6 losing the page document withdraws an open approval without inventing a decision', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.sending(s);
  await f.view(s, { state: 'standby', approvals: [card] });
  const current = f.broker.snapshot(s.id);
  const seen = [];
  f.broker.subscribe(s.id, event => seen.push(event));
  await f.broker.observeGap({ sessionId: s.id, observationLease: current.observation.lease,
    tabId: current.tabId, documentKey: current.documentKey,
    url: `https://chatgpt.com/c/${current.conversationId}`, reason: 'PAGE_GONE' });
  const closed = seen.find(event => event.state === 'approval-closed' && event.key === card.key);
  assert.ok(closed);
  assert.equal(closed.withdrawn, true);
  assert.equal(closed.answered, null);
  assert.equal(f.broker.snapshot(s.id).approvals[card.key].state, 'resolved');
  assert.equal(f.broker.snapshot(s.id).approvals[card.key].withdrawn, true);
});

test('APPROVAL-7 an older persisted negative-only card can still be denied manually', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.sending(s);
  const old = { state: 'open', key: '6f1c2d3e-0000-4000-8000-000000000012', app: 'app',
    tool: null, input: null, clickable: false, labels: ['Not now'] };
  await f.view(s, { state: 'standby', approvals: [old] });
  const answering = f.broker.answerApproval(s.id, old.key, 'deny'); answering.catch(() => {});
  const command = await until(() => f.broker.queued().find(c => c.kind === 'approval'));
  assert.equal(command.payload.choice, 'deny');
  const claim = await f.broker.claim(command.id, s.tabId, s.documentKey);
  await f.broker.result(command.id, claim.lease, { answered: true, key: old.key, choice: 'deny' });
  assert.deepEqual(await answering, { answered: true, choice: 'deny' });
});


test('APPROVAL-SAFE-1 disabling auto cancels a queued approval and preserves manual Deny',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const request={...card,key:'6f1c2d3e-0000-4000-8000-000000000081',autoEligible:true,autoTier:'persistent'};
  await f.view(s,{state:'standby',approvals:[request]});
  await f.broker.setAutoAllowApprovals(true);
  const automatic=f.broker.answerApproval(s.id,request.key,'allow-auto');automatic.catch(()=>{});
  const command=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  await f.broker.setAutoAllowApprovals(false);
  await assert.rejects(automatic,e=>e.code==='AUTO_APPROVAL_DISABLED');
  await assert.rejects(f.broker.claim(command.id,s.tabId,s.documentKey),e=>e.code==='COMMAND_NOT_CLAIMABLE');
  assert.equal(f.broker.snapshot(s.id).approvals[request.key].state,'open');
  const manual=f.broker.answerApproval(s.id,request.key,'deny');manual.catch(()=>{});
  const next=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  assert.equal(next.payload.choice,'deny');
  const claim=await f.broker.claim(next.id,s.tabId,s.documentKey);
  await f.broker.result(next.id,claim.lease,{answered:true,key:request.key,choice:'deny'});
  assert.equal((await manual).answered,true);
});

test('APPROVAL-SAFE-2 manual Deny supersedes a queued auto command atomically',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const request={...card,key:'6f1c2d3e-0000-4000-8000-000000000082',autoEligible:true,autoTier:'once'};
  await f.broker.setAutoAllowApprovals(true);
  await f.view(s,{state:'standby',approvals:[request]});
  const automatic=f.broker.answerApproval(s.id,request.key,'allow-auto');automatic.catch(()=>{});
  const old=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  const manual=f.broker.answerApproval(s.id,request.key,'deny');manual.catch(()=>{});
  await assert.rejects(automatic,e=>e.code==='APPROVAL_SUPERSEDED');
  await assert.rejects(f.broker.claim(old.id,s.tabId,s.documentKey),e=>e.code==='COMMAND_NOT_CLAIMABLE');
  const next=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  assert.equal(next.payload.choice,'deny');
  assert.equal(f.broker.snapshot(s.id).approvals[request.key].manualRequested,true);
  const claim=await f.broker.claim(next.id,s.tabId,s.documentKey);
  assert.equal((await f.broker.verifyApproval(next.id,claim.lease)).allowed,true);
  await f.broker.result(next.id,claim.lease,{answered:true,key:request.key,choice:'deny'});
  await manual;
});

test('APPROVAL-SAFE-3 an already claimed auto command is vetoed, never reported as manual Deny',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const request={...card,key:'6f1c2d3e-0000-4000-8000-000000000083',autoEligible:true,autoTier:'once'};
  await f.broker.setAutoAllowApprovals(true);
  await f.view(s,{state:'standby',approvals:[request]});
  const automatic=f.broker.answerApproval(s.id,request.key,'allow-auto');automatic.catch(()=>{});
  const command=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  const claim=await f.broker.claim(command.id,s.tabId,s.documentKey);
  assert.equal((await f.broker.verifyApproval(command.id,claim.lease)).allowed,true);
  await assert.rejects(f.broker.answerApproval(s.id,request.key,'deny'),e=>e.code==='APPROVAL_IN_FLIGHT');
  assert.throws(()=>f.broker.verifyApproval(command.id,claim.lease),e=>e.code==='APPROVAL_VETOED');
  await f.broker.result(command.id,claim.lease,{error:'APPROVAL_VETOED'});
  await assert.rejects(automatic,e=>e.code==='APPROVAL_VETOED');
  assert.equal(f.broker.snapshot(s.id).approvals[request.key].state,'open');
  const manual=f.broker.answerApproval(s.id,request.key,'deny');manual.catch(()=>{});
  const next=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  assert.equal(next.payload.choice,'deny');
  const nextClaim=await f.broker.claim(next.id,s.tabId,s.documentKey);
  await f.broker.result(next.id,nextClaim.lease,{answered:true,key:request.key,choice:'deny'});
  await manual;
});

test('APPROVAL-SAFE-4 a claimed auto command is fenced when auto is disabled',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const request={...card,key:'6f1c2d3e-0000-4000-8000-000000000084',autoEligible:true,autoTier:'once'};
  await f.broker.setAutoAllowApprovals(true);
  await f.view(s,{state:'standby',approvals:[request]});
  const automatic=f.broker.answerApproval(s.id,request.key,'allow-auto');automatic.catch(()=>{});
  const command=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  const claim=await f.broker.claim(command.id,s.tabId,s.documentKey);
  await f.broker.setAutoAllowApprovals(false);
  assert.throws(()=>f.broker.verifyApproval(command.id,claim.lease),e=>e.code==='APPROVAL_VETOED');
  await f.broker.result(command.id,claim.lease,{error:'APPROVAL_VETOED'});
  await assert.rejects(automatic,e=>e.code==='APPROVAL_VETOED');
});


async function approvalHost(f,s,t,name) {
  const connection=await createProvider({...f,status:()=>({connected:true})},event=>ProviderEventSchema.parse(event))
    .connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>connection.close());
  const events=[];connection.onEvent(event=>events.push(event));
  await connection.send({type:'session.open',requestId:'open-'+name,sessionId:name,history:'skip',
    persistence:{version:1,data:{id:s.id}},
    config:{cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,
      model:'m1',thinkingOption:'standard',providerOptions:{appIds:['asdk_app_a']}}});
  await until(()=>events.some(event=>event.type==='session.ready'));
  return {connection,events};
}

test('APPROVAL-SAFE-5 Provider manual Deny beats its own queued auto Allow with one genuine resolution',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const {connection,events}=await approvalHost(f,s,t,'manual-over-auto');
  await f.broker.setAutoAllowApprovals(true);
  const request={...card,key:'6f1c2d3e-0000-4000-8000-000000000085',
    autoEligible:true,autoTier:'once'};
  await f.view(s,{state:'standby',approvals:[request]});
  const old=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  assert.equal(old.payload.choice,'allow-auto');
  await connection.send({type:'session.permission',sessionId:'manual-over-auto',permissionId:request.key,
    response:{behavior:'deny',selectedActionId:'deny'}});
  const manual=await until(()=>f.broker.queued().find(c=>c.kind==='approval'&&c.payload.choice==='deny'));
  assert.equal(manual.payload.choice,'deny');
  assert.equal(f.store.read().commands[old.id].error,'APPROVAL_SUPERSEDED');
  const claim=await f.broker.claim(manual.id,s.tabId,s.documentKey);
  await f.broker.result(manual.id,claim.lease,{answered:true,key:request.key,choice:'deny'});
  await until(()=>events.some(event=>event.type==='session.permission_resolved'&&event.permissionId===request.key));
  assert.equal(events.filter(event=>event.type==='session.permission_resolved').length,1);
  assert.equal(events.filter(event=>event.type==='session.notice'&&event.notice.id==='auto-approval:'+request.key).length,0,
    'a canceled auto action cannot announce success after manual rejection');
});

test('APPROVAL-SAFE-6 superseded page card stays unclickable; explicit local Deny clears only stale Paseo request',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const {connection,events}=await approvalHost(f,s,t,'request-changed');
  const old={...card,key:'6f1c2d3e-0000-4000-8000-000000000086'};
  const latest={...card,key:'6f1c2d3e-0000-4000-8000-000000000087',input:'{"new":"details"}'};
  await f.view(s,{state:'standby',approvals:[old]});
  await until(()=>events.some(event=>event.type==='session.permission'&&event.request.id===old.key));
  await f.view(s,{state:'standby',approvals:[latest],
    closedApprovals:[{key:old.key,reason:'superseded'}]});
  assert.equal(f.broker.snapshot(s.id).approvals[old.key].state,'resolved');
  assert.equal(f.broker.snapshot(s.id).approvals[old.key].closeReason,'REQUEST_CHANGED');
  await until(()=>events.some(event=>event.type==='session.notice'&&event.notice.id==='approval-withdrawn:'+old.key));
  assert.equal(events.filter(event=>event.type==='session.permission_resolved').length,0);
  await connection.send({type:'session.permission',sessionId:'request-changed',permissionId:old.key,
    response:{behavior:'allow',selectedActionId:'allow-once'}});
  await until(()=>events.some(event=>event.type==='session.notice'&&event.notice.id==='native-permission-answer'));
  assert.equal(events.filter(event=>event.type==='session.permission_resolved').length,0,
    'stale Allow can neither operate a changed website request nor claim resolution');
  await connection.send({type:'session.permission',sessionId:'request-changed',permissionId:old.key,
    response:{behavior:'deny',selectedActionId:'deny'}});
  await until(()=>events.filter(event=>event.type==='session.permission_resolved').length===1);
  assert.equal(f.broker.queued().filter(c=>c.kind==='approval').length,0);
  assert.equal(f.broker.snapshot(s.id).approvals[latest.key].state,'open',
    'the new request remains independent and actionable');
  assert.ok(events.some(event=>event.type==='session.notice'&&event.notice.id==='approval-local-dismiss:'+old.key));
});


test('APPROVAL-SAFE-7 uncertain post-click approval cannot be repeated after a new page-view',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const request={...card,key:'6f1c2d3e-0000-4000-8000-000000000088'};
  await f.view(s,{state:'standby',approvals:[request]});
  const started=f.broker.answerApproval(s.id,request.key,'allow-once');started.catch(()=>{});
  const command=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  const claim=await f.broker.claim(command.id,s.tabId,s.documentKey);
  await f.broker.result(command.id,claim.lease,{error:'APPROVAL_PARTIAL_UNCONFIRMED'});
  await assert.rejects(started,e=>e.code==='APPROVAL_PARTIAL_UNCONFIRMED');
  const state=f.broker.snapshot(s.id).approvals[request.key];
  assert.equal(state.clickUncertain,true);
  await f.view(s,{state:'standby',approvals:[request]});
  assert.equal(f.broker.snapshot(s.id).approvals[request.key].clickUncertain,true);
  await assert.rejects(f.broker.answerApproval(s.id,request.key,'allow-once'),
    e=>e.code==='APPROVAL_CLICK_UNCONFIRMED');
  await assert.rejects(f.broker.answerApproval(s.id,request.key,'allow-auto'),
    e=>e.code==='APPROVAL_CLICK_UNCONFIRMED');
  assert.equal(f.broker.queued().filter(c=>c.kind==='approval').length,0);
});


test('APPROVAL-SAFE-8 a claimed auto success after manual Deny cannot be translated into fake native Deny',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const {connection,events}=await approvalHost(f,s,t,'claimed-conflict');
  await f.broker.setAutoAllowApprovals(true);
  const request={...card,key:'6f1c2d3e-0000-4000-8000-000000000089',
    autoEligible:true,autoTier:'persistent'};
  await f.view(s,{state:'standby',approvals:[request]});
  const auto=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  assert.equal(auto.payload.choice,'allow-auto');
  const claim=await f.broker.claim(auto.id,s.tabId,s.documentKey);
  await connection.send({type:'session.permission',sessionId:'claimed-conflict',
    permissionId:request.key,response:{behavior:'deny',selectedActionId:'deny'}});
  await until(()=>events.some(event=>event.type==='session.notice'&&event.notice.id==='native-permission-answer'));
  await f.broker.result(auto.id,claim.lease,{answered:true,key:request.key,choice:'allow-auto'});
  await until(()=>events.some(event=>event.type==='session.notice'&&event.notice.id==='approval-conflict:'+request.key));
  assert.equal(events.filter(event=>event.type==='session.permission_resolved').length,0,
    'the host must not translate an auto webpage Allow to its cached manual Deny');
  assert.equal(events.filter(event=>event.type==='session.notice'&&event.notice.id==='auto-approval:'+request.key).at(-1).notice.severity,'warning');
  await connection.send({type:'session.permission',sessionId:'claimed-conflict',
    permissionId:request.key,response:{behavior:'deny',selectedActionId:'deny'}});
  await until(()=>events.filter(event=>event.type==='session.permission_resolved').length===1);
  assert.equal(f.broker.queued().filter(c=>c.kind==='approval').length,0,
    'explicit local stale dismissal cannot click the already-allowed webpage');
});


test('APPROVAL-SAFE-9 durable manual veto wins even before the Provider sees a refusal',async t=>{
  const f=await fixture(t),s=await f.ready();await f.sending(s);
  const {events}=await approvalHost(f,s,t,'durable-veto');
  await f.broker.setAutoAllowApprovals(true);
  const request={...card,key:'6f1c2d3e-0000-4000-8000-000000000091',
    autoEligible:true,autoTier:'persistent'};
  await f.view(s,{state:'standby',approvals:[request]});
  const queued=await until(()=>f.broker.queued().find(c=>c.kind==='approval'&&c.payload.key===request.key));
  const claim=await f.broker.claim(queued.id,s.tabId,s.documentKey);
  // This exercises the in-flight gap where the durable Broker veto becomes
  // visible before an async Provider callback has set manualConflict.
  await assert.rejects(f.broker.answerApproval(s.id,request.key,'deny'),
    e=>e.code==='APPROVAL_IN_FLIGHT');
  assert.equal(f.broker.snapshot(s.id).approvals[request.key].manualVeto,true);
  await f.broker.result(queued.id,claim.lease,
    {answered:true,key:request.key,choice:'allow-auto'});
  await until(()=>events.some(e=>e.type==='session.notice'&&e.notice.id==='approval-conflict:'+request.key));
  assert.equal(events.filter(e=>e.type==='session.permission_resolved').length,0,
    'an earlier durable veto cannot be overwritten by a later automatic result');
  const notice=events.find(e=>e.type==='session.notice'&&e.notice.id==='auto-approval:'+request.key);
  assert.equal(notice?.notice.severity,'warning');
});
