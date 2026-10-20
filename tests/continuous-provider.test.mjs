import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import { fixture, selection, until } from './helpers.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';

const CONFIG = {
  cwd: '/fixture', env: {}, settings: {}, mcpServers: {}, persist: true,
  model: selection.model, thinkingOption: selection.thinkingOption,
  providerOptions: { appIds: selection.appIds }
};
const validate = event => ProviderEventSchema.parse(event);
const control = visible => ({ visible, enabled: visible });
let nextOrder = 0, nextSequence = 0;

const source = (id, text, extra = {}) => ({
  id, userMessageId: null, role: 'assistant', lane: 'output', kind: 'message',
  text, format: 'text', order: [nextOrder++], ...extra
});
const approval = key => ({
  key, app: 'mymac', tool: 'run_shell_command',
  input: '{"args":{"command":"echo fixture"}}', clickable: true,
  labels: ['Allow once', 'Deny']
});

function buttonState(state) {
  const running = state === 'running';
  const standby = state === 'standby';
  return {
    observedAt: Date.now(), readable: true,
    controls: {
      stop: control(running),
      send: control(standby),
      voice: control(false)
    }
  };
}

function frame(session, {
  sequence = ++nextSequence, state = 'running', items = [], approvals = [],
  closedApprovals = [], issues = [], page = null
} = {}) {
  return {
    sessionId: session.id,
    observationLease: session.observation.lease,
    tabId: session.tabId,
    documentKey: session.documentKey,
    url: `https://chatgpt.com/c/${session.conversationId}`,
    sequence,
    view: {
      conversationId: session.conversationId,
      ...(session.turn?.authorized&&session.turn.lease?{sendAttempt:{commandId:session.turn.commandId,
        turnId:session.turn.id,lease:session.turn.lease,documentKey:session.documentKey}}:{}),
      page: page ?? buttonState(state),
      items, approvals, closedApprovals, issues
    }
  };
}

const timeline = events => events.filter(event => event.type === 'timeline.item');
const byItemId = (events, id) => timeline(events).filter(event => event.item.id === id);
const bodies = events => timeline(events).filter(event => event.item.type === 'assistant_message');
const turns = (events, state) => events.filter(event => event.type === 'session.turn' && event.state === state);

async function context(t) {
  const f = await fixture(t);
  const runtime = { ...f, status: () => ({ connected: true }) };
  const events = [];
  const connection = await createProvider(runtime, validate)
    .connect({ versions: [1], capabilities: CAPABILITIES });
  t.after(() => connection.close());
  connection.onEvent(event => events.push(event));

  async function active(hostId = 'host-a') {
    // Actual Broker + Store: one native Send is claimed, authorized and
    // receipted exactly once by the simulated worker.
    const ready = await f.ready();
    const sent = await f.sending(ready);
    await connection.send({ type: 'session.open', requestId: 'open-' + hostId, sessionId: hostId,
      config: CONFIG, history: 'skip', persistence: { version: 1, data: { id: ready.id } } });
    await until(() => events.some(event => event.type === 'session.ready' && event.sessionId === hostId));
    await until(() => events.some(event => event.type === 'session.turn' &&
      event.state === 'started' && event.turnId === sent.result.turnId));
    return { session: f.broker.snapshot(ready.id), sent, hostId };
  }

  async function observe(session, options) {
    const event = frame(session, options);
    const receipt = await f.broker.observeView(event);
    return { event, receipt };
  }

  function current(id) { return f.broker.snapshot(id); }
  function assertNoInvalid() {
    assert.deepEqual(events.filter(event => event.type === 'session.runtime_failed'), []);
  }

  return { ...f, runtime, connection, events, active, observe, frame, current, assertNoInvalid, validate, config: CONFIG };
}

test('CPROV-01 formal assistant identity is stable across Work expansion; process sources stay separate', async t => {
  const p = await context(t);
  const { session, sent } = await p.active();
  const formal = source('formal-1', 'formal answer', { order: [0] });
  const work = source('work-1', 'work summary', { lane: 'process', kind: 'reasoning', order: [1] });

  await p.observe(session, { state: 'running', items: [formal, work] });
  const formalItems = () => p.events.filter(event => event.type === 'timeline.item' &&
    event.item.id === 'page:formal-1');
  assert.equal(formalItems().length, 1);
  assert.equal(formalItems()[0].item.type, 'assistant_message');
  assert.equal(formalItems()[0].item.text, 'formal answer');
  assert.equal(byItemId(p.events, 'page:work-1')[0].item.type, 'reasoning');
  assert.equal(byItemId(p.events, 'page:work-1')[0].item.text, 'work summary');

  const before = p.current(session.id).sources.find(record => record.id === 'formal-1');
  await p.observe(p.current(session.id), {
    state: 'running',
    items: [formal, work,
      source('work-tool', 'visible tool detail', { lane: 'process', kind: 'tool_call',
        callId: 'call-1', name: 'mymac · read', status: 'completed', order: [2] }),
      source('work-progress', 'visible commentary', { lane: 'process', kind: 'message', order: [3] })]
  });
  const after = p.current(session.id).sources.find(record => record.id === 'formal-1');

  assert.equal(after.revision, before.revision);
  assert.equal(formalItems().length, 1, 'expanding Work must not re-emit the formal answer');
  assert.equal(formalItems()[0].item.text, 'formal answer');
  assert.equal(byItemId(p.events, 'page:work-tool')[0].item.type, 'tool_call');
  // Anonymous Work commentary has no native tool identity; it is presented as
  // one compact activity card, never as a second page-source card.
  assert.equal(byItemId(p.events,'page:work-progress').length,0);
  const activity=p.events.filter(event=>event.type==='timeline.item'&&
    event.item.kind==='native-activity').at(-1).item;
  assert.equal(activity.type,'plugin');
  assert.equal(activity.kind,'native-activity');
  assert.ok(activity.data.steps.some(step=>step.label==='visible commentary'));
  assert.notEqual(formalItems()[0].item.id, 'page:work-tool');
  assert.notEqual(formalItems()[0].item.id, activity.id);
  assert.ok(sent.result.turnId);
  p.assertNoInvalid();
});

test('CPROV-12 anonymous Work rows coalesce into one compact activity card', async t => {
  const p = await context(t);
  const { session, sent } = await p.active();
  const id = session.id;

  await p.observe(session, { state: 'running', items: [
    source('work-a', 'Searched 10 websites', { lane: 'process', kind: 'message' }),
    source('work-b', 'Searched 10 websites', { lane: 'process', kind: 'message' }),
    source('work-c', 'Initial verdict: validate this as a PoC', { lane: 'process', kind: 'message' }),
    source('final-answer', 'final answer', { nativeMessageId: 'final-answer' })
  ] });
  assert.equal(byItemId(p.events, 'page:work-a').length, 0);
  assert.equal(byItemId(p.events, 'page:work-b').length, 0);
  await until(() => p.events.some(event => event.type === 'timeline.item' &&
    event.item.kind === 'native-activity' && event.item.data.steps.length === 2));
  const activity = p.events.filter(event => event.type === 'timeline.item' &&
    event.item.kind === 'native-activity').at(-1).item;
  assert.equal(activity.type, 'plugin');
  assert.equal(activity.data.steps.length, 2);
  assert.deepEqual(activity.data.steps.map(step => step.label),
    ['Searched 10 websites', 'Initial verdict: validate this as a PoC']);
  assert.equal(byItemId(p.events, 'page:final-answer')[0].item.type, 'assistant_message');

  await p.observe(p.current(id), { state: 'standby' });
  await until(() => p.events.some(event => event.type === 'timeline.item' &&
    event.item.id === activity.id && event.item.data.phase === 'completed'));
  const completed = p.events.filter(event => event.type === 'timeline.item' &&
    event.item.id === activity.id).at(-1).item;
  assert.equal(completed.data.steps.length, 2);
  assert.ok(completed.data.steps.every(step => step.done));
  p.assertNoInvalid();
});

test('CPROV-02 standby completes the native run, and later frames still deliver new native answers', async t => {
  const p = await context(t);
  const { session, sent } = await p.active();
  const id = session.id;

  await p.observe(session, { state: 'standby' });
  const completed = await until(() => p.events.find(event =>
    event.type === 'session.turn' && event.turnId === sent.result.turnId && event.state === 'completed'));
  assert.equal(completed.turnId, sent.result.turnId);
  assert.equal(p.current(id).turn.outcome, 'completed');

  await p.observe(p.current(id), {
    state: 'standby',
    items: [source('native-answer-2', 'later native answer', { nativeMessageId: 'native-answer-2' })]
  });
  const body = byItemId(p.events, 'page:native-answer-2');
  assert.equal(body.length, 1);
  assert.equal(body[0].item.type, 'assistant_message');
  assert.equal(body[0].item.text, 'later native answer');
  p.assertNoInvalid();
});

test('CPROV-03 authorization survives standby; explicit Paseo choice becomes a real Broker command', async t => {
  const p = await context(t);
  const { session, hostId } = await p.active();
  const id = session.id;
  const card = approval('approval-provider-standby');

  await p.observe(session, { state: 'running', approvals: [card] });
  await until(() => p.events.some(event => event.type === 'session.permission' && event.request.id === card.key));
  assert.equal(p.broker.queued().filter(command => command.kind === 'approval').length, 0,
    'receiving an approval request must not answer it automatically');

  await p.observe(p.current(id), { state: 'standby' });
  assert.equal(p.current(id).turn.outcome, 'completed');
  assert.equal(p.current(id).approvals[card.key].state, 'open');

  await p.connection.send({ type: 'session.permission', sessionId: hostId, permissionId: card.key,
    response: { behavior: 'allow' } });
  const command = await until(() => p.broker.queued().find(candidate =>
    candidate.kind === 'approval' && candidate.payload.key === card.key));
  assert.equal(command.payload.choice, 'allow-once');
  assert.equal(p.events.filter(event => event.type === 'session.permission_resolved').length, 0,
    'nothing resolves before the worker confirms the click');

  const current = p.current(id);
  const claim = await p.broker.claim(command.id, current.tabId, current.documentKey);
  await p.broker.result(command.id, claim.lease,
    { answered: true, key: card.key, choice: 'allow-once' });
  await until(() => p.events.some(event => event.type === 'session.permission_resolved' &&
    event.permissionId === card.key));
  assert.equal(p.current(id).approvals[card.key].state, 'resolved');
  p.assertNoInvalid();
});

test('CPROV-04 external closedApprovals with answered=null never emits a default Deny resolution', async t => {
  const p = await context(t);
  const { session } = await p.active();
  const id = session.id;
  const card = approval('approval-provider-external');

  await p.observe(session, { state: 'running', approvals: [card] });
  await until(() => p.events.some(event => event.type === 'session.permission' && event.request.id === card.key));
  await p.observe(p.current(id), { state: 'running', closedApprovals: [card.key] });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(p.events.filter(event => event.type === 'session.permission_resolved').length, 0);
  assert.equal(p.broker.queued().filter(command => command.kind === 'approval').length, 0);
  const stored = p.current(id).approvals[card.key];
  assert.equal(stored.state, 'resolved');
  assert.equal(stored.answered, undefined);
  p.assertNoInvalid();
});

test('CPROV-05 a new visible Stop interval starts a new page run without prompt_result or Send', async t => {
  const p = await context(t);
  const { session, sent } = await p.active();
  const id = session.id;
  const sendsBefore = Object.values(p.store.read().commands).filter(command => command.kind === 'send').length;
  const promptsBefore = p.events.filter(event => event.type === 'session.prompt_result').length;

  await p.observe(session, { state: 'standby' });
  await until(() => p.current(id).observation.run?.active === false);

  await p.observe(p.current(id), {
    state: 'running', items: [source('new-run-answer', 'answer in a new run')]
  });
  const run = p.current(id).observation.run;
  assert.equal(run.active, true);
  assert.notEqual(run.id, sent.result.turnId);
  await until(() => p.events.some(event => event.type === 'session.turn' &&
    event.state === 'started' && event.turnId === run.id));

  assert.equal(p.events.filter(event => event.type === 'session.prompt_result').length, promptsBefore);
  assert.equal(Object.values(p.store.read().commands).filter(command => command.kind === 'send').length, sendsBefore);
  assert.equal(byItemId(p.events, 'page:new-run-answer')[0].item.text, 'answer in a new run');
  p.assertNoInvalid();
});

test('CPROV-06 interrupt with no Stop and an open authorization queues no Deny', async t => {
  const p = await context(t);
  const { session, hostId } = await p.active();
  const id = session.id;
  const card = approval('approval-provider-nostop');

  await p.observe(session, { state: 'standby', approvals: [card] });
  await until(() => p.events.some(event => event.type === 'session.permission' && event.request.id === card.key));
  const lease = p.current(id).observation.lease;
  await p.connection.send({ type: 'session.interrupt', sessionId: hostId, requestId: 'stop-without-card' });
  let settled = false, denied = false;
  for (let i = 0; i < 200; i++) {
    settled = p.events.some(event => (event.type === 'request.failed' || event.type === 'request.completed') &&
      event.requestId === 'stop-without-card');
    denied = p.broker.queued().some(command => command.kind === 'approval') ||
      Object.values(p.store.read().commands).some(command => command.kind === 'approval' || command.kind === 'stop');
    if (settled || denied) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.equal(denied, false);
  assert.equal(p.broker.queued().filter(command => command.kind === 'approval').length, 0);
  assert.equal(Object.values(p.store.read().commands).filter(command => command.kind === 'stop').length, 0);
  assert.equal(p.events.filter(event => event.type === 'session.permission_resolved').length, 0);
  assert.equal(p.current(id).approvals[card.key].state, 'open');
  assert.equal(p.current(id).observation.lease, lease);
  p.assertNoInvalid();
});

test('CPROV-07 an error page without a composer still delivers its original text', async t => {
  const p = await context(t);
  const { session } = await p.active();
  const id = session.id;
  const text = 'Error: the page failed to load.\nRetry';
  await p.observe(session, {
    state: 'abnormal',
    items: [source('error-page', text, { role: 'page', kind: 'notice', format: 'text' })]
  });

  const item = byItemId(p.events, 'page:error-page')[0];
  assert.ok(item);
  assert.equal(item.item.type, 'plugin');
  assert.equal(item.item.kind, 'page-source');
  assert.equal(item.item.data.source.text, text);
  assert.equal(item.item.data.source.role, 'page');
  assert.equal(p.current(id).observation.page.state, 'abnormal');
  p.assertNoInvalid();
});

test('CPROV-08 a duplicate frame and reconnect replay deliver the native body exactly once', async t => {
  const p = await context(t);
  const { session, hostId } = await p.active();
  const id = session.id;
  const body = source('formal-once', 'body once', { order: [0] });
  const event = p.frame(p.current(id), { sequence: 1, state: 'running', items: [body] });
  await p.broker.observeView(event);
  await until(() => p.events.filter(entry => entry.type === 'timeline.item' &&
    entry.item.id === 'page:formal-once' && entry.item.type === 'assistant_message').length === 1);

  await p.broker.observeView(event);
  assert.equal(p.events.filter(entry => entry.type === 'timeline.item' &&
    entry.item.id === 'page:formal-once' && entry.item.type === 'assistant_message').length, 1);

  await p.connection.close();
  const replayEvents = [];
  const replay = await createProvider(p.runtime, p.validate)
    .connect({ versions: [1], capabilities: CAPABILITIES });
  t.after(() => replay.close());
  replay.onEvent(entry => replayEvents.push(entry));
  await replay.send({ type: 'session.open', requestId: 'replay-open', sessionId: 'host-replay',
    config: p.config, history: 'replay', persistence: { version: 1, data: { id } } });
  await until(() => replayEvents.some(entry => entry.type === 'session.ready' && entry.sessionId === 'host-replay'));
  const replayBodies = () => replayEvents.filter(entry => entry.type === 'timeline.item' &&
    entry.item.id === 'page:formal-once' && entry.item.type === 'assistant_message');
  assert.equal(replayBodies().length, 1);

  await p.broker.observeView(event);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(replayBodies().length, 1);
  assert.equal(hostId, 'host-a');
});

test('CPROV-09 session.close detaches without Stop and leaves page observation alive', async t => {
  const p = await context(t);
  const { session, hostId } = await p.active();
  const id = session.id;
  await p.observe(session, { state: 'running', items: [source('before-close', 'visible before close')] });
  const before = p.current(id);
  assert.equal(before.observation.page.controls.stop.visible, true);
  const lease = before.observation.lease;

  await p.connection.send({ type: 'session.close', requestId: 'close-without-stop', sessionId: hostId });
  let closed = false, stopped = false;
  for (let i = 0; i < 200; i++) {
    closed = p.events.some(event => event.type === 'session.closed' && event.sessionId === hostId);
    stopped = Object.values(p.store.read().commands).some(command => command.kind === 'stop');
    if (closed || stopped) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(stopped, false, 'session.close is not a user Stop');
  assert.equal(closed, true);
  assert.equal(p.broker.owners.has(id), false);

  const after = p.current(id);
  assert.equal(after.observation.lease, lease);
  assert.equal(after.observation.run.active, true);
  const next = await p.observe(after, {
    state: 'running', items: [source('after-close', 'still observed after close')]
  });
  assert.equal(next.receipt.accepted, true);
  assert.equal(p.current(id).history.some(row => row.id === 'page:after-close'), true);
  p.assertNoInvalid();
});

test('CPROV-10 one bad control or item does not block other sources', async t => {
  const p = await context(t);
  const { session } = await p.active();
  const id = session.id;
  const bad = source('bad-item', 'bad');
  bad.text = 42;
  const first = await p.observe(session, {
    state: 'running', items: [bad, source('good-item-1', 'good one')]
  });
  assert.equal(first.receipt.issues.some(issue => issue.code === 'SOURCE_TEXT_INVALID'), true);
  assert.equal(byItemId(p.events, 'page:good-item-1')[0].item.text, 'good one');

  const invalidPage = { observedAt: Date.now(), readable: true, controls: { stop: control(false) } };
  const second = await p.observe(p.current(id), {
    state: 'abnormal', page: invalidPage, items: [source('good-item-2', 'good two')]
  });
  assert.equal(second.receipt.issues.some(issue => issue.code === 'PAGE_STATUS_INVALID'), true);
  assert.equal(byItemId(p.events, 'page:good-item-2')[0].item.text, 'good two');
  assert.equal(p.current(id).observation.page.readable, false);
  p.assertNoInvalid();
});

test('CPROV-11 actual prompt exposes authorization and standby before a delayed Send receipt',async t=>{
  const p=await context(t),tabId=201,documentKey='early-document';
  await p.connection.send({type:'session.open',requestId:'early-open',sessionId:'early-host',config:CONFIG,history:'skip'});
  await until(()=>p.events.some(event=>event.type==='session.ready'&&event.sessionId==='early-host'));
  const id=p.events.find(event=>event.type==='session.opened'&&event.sessionId==='early-host').persistence.data.id;
  await p.connection.send({type:'session.prompt',sessionId:'early-host',prompt:{
    clientMessageId:'early-prompt',delivery:'auto',input:{type:'message',content:[{type:'text',text:'one request'}]}}});
  const open=await until(()=>p.broker.queued().find(command=>command.kind==='open'));
  const opened=await p.broker.claim(open.id,tabId,documentKey);
  await p.broker.result(open.id,opened.lease,{config:open.payload.config,tabId,url:'https://chatgpt.com/'});
  const send=await until(()=>p.broker.queued().find(command=>command.kind==='send'));
  const claimed=await p.broker.claim(send.id,tabId,documentKey);
  await p.broker.authorize(send.id,claimed.lease);
  const url='https://chatgpt.com/c/early-receipt-conversation';
  await p.broker.bindConversation(send.id,claimed.lease,{tabId,documentKey,url});
  const card=approval('approval-before-receipt');
  const first=p.frame(p.current(id),{state:'standby',approvals:[card]});
  // Simulate the content script's first frame after its single native dispatch.
  first.view.sendAttempt={commandId:send.id,turnId:send.payload.turnId,lease:claimed.lease,documentKey};
  await p.broker.observeView(first);
  await until(()=>turns(p.events,'completed').some(event=>event.turnId===send.payload.turnId));
  assert.ok(p.events.some(event=>event.type==='session.permission'&&event.request.id===card.key));
  assert.equal(p.store.read().commands[send.id].phase,'authorized','no message receipt has arrived');
  assert.equal(p.current(id).turn.receivedAt,undefined);
  assert.equal(p.events.filter(event=>event.type==='session.prompt_result').length,1);
  await p.broker.result(send.id,claimed.lease,{receipt:true,config:send.payload.config,url,nativeMessageId:'native-early-user'});
  await p.observe(p.current(id),{state:'standby',items:[source('late-early-answer','answer after receipt')]});
  assert.equal(turns(p.events,'started').length,1);
  assert.equal(turns(p.events,'completed').length,1);
  assert.equal(byItemId(p.events,'page:late-early-answer')[0].item.text,'answer after receipt');
  assert.equal(Object.values(p.store.read().commands).filter(command=>command.kind==='send').length,1);
  p.assertNoInvalid();
});

test('CPROV-13 opening a session during recovery does not invent a host turn for the recovery run',async t=>{
  const p=await context(t),ready=await p.ready();
  await p.broker.prompt(ready.id,'recovery-prompt','recover me');
  const sent=await p.dispatchSend(ready,{state:'running'});
  await p.broker.failTurn(ready.id,'TURN_CHANGED',true,sent.command.payload.turnId);
  const failed=p.current(ready.id);
  const recovery=await p.broker.claimRecovery({sessionId:failed.id,tabId:failed.tabId,
    documentKey:failed.documentKey,url:`https://chatgpt.com/c/${failed.conversationId}`,
    userMessageId:'11111111-1111-4111-8111-111111111111',
    nextUserMessageId:'22222222-2222-4222-8222-222222222222',boundaryKnown:true,
    transcriptComplete:false});
  const runId=recovery.recovery.runId;
  await p.connection.send({type:'session.open',requestId:'open-recovery',sessionId:'host-recovery',
    config:CONFIG,history:'skip',persistence:{version:1,data:{id:failed.id}}});
  await until(()=>p.events.some(event=>event.type==='session.ready'&&event.sessionId==='host-recovery'));
  assert.equal(p.events.filter(event=>event.type==='session.turn'&&event.turnId===runId).length,0);
  assert.equal(p.current(failed.id).status,'running');
  p.assertNoInvalid();
});
