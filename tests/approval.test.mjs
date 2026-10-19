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
  assert.ok(events.some(event=>event.type==='session.notice'&&event.notice.id==='approval-closed:'+other.key));
  assert.equal(f.broker.snapshot(s.id).approvals[other.key].answered,undefined);

  const third={...card,key:'6f1c2d3e-0000-4000-8000-000000000003'};
  await f.view(s,{state:'standby',approvals:[third]});
  await connection.send({type:'session.permission',sessionId:'host',permissionId:third.key,response:{behavior:'deny'}});
  const failed=await until(()=>f.broker.queued().find(c=>c.kind==='approval'));
  const failedClaim=await f.broker.claim(failed.id,s.tabId,s.documentKey);
  await f.broker.result(failed.id,failedClaim.lease,{error:'APPROVAL_GONE'});
  await until(()=>events.some(event=>event.type==='session.notice'&&event.notice.id==='approval-withdrawn:'+third.key));
  assert.equal(events.filter(event=>event.type==='session.permission_resolved').length,2);
  assert.equal(f.broker.snapshot(s.id).approvals[third.key].state,'resolved');
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
