import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.mjs';

const itemId = (conversationId, role, native) => JSON.stringify([conversationId, 'message', role, native]);
const user = (conversationId, native, text, order) => ({
  id: itemId(conversationId, 'user', native), nativeMessageId: native, userMessageId: native,
  role: 'user', lane: 'output', kind: 'message', text, format: 'text', order: [order]
});
const assistant = (conversationId, native, userNative, text, order) => ({
  id: itemId(conversationId, 'assistant', native), nativeMessageId: native, userMessageId: userNative,
  role: 'assistant', lane: 'output', kind: 'message', text, format: 'text', order: [order]
});

async function uncertain(t) {
  const f = await fixture(t), opened = await f.ready();
  await f.broker.prompt(opened.id, 'message-1', 'hello');
  const dispatched = await f.dispatchSend(opened, { state: 'running' });
  await f.broker.failTurn(opened.id, 'TURN_CHANGED', true, dispatched.command.payload.turnId);
  const s = f.broker.snapshot(opened.id);
  assert.equal(s.turn.outcome, 'failed');
  return { f, s };
}
function claim(f, s, extra = {}) {
  return f.broker.claimRecovery({ sessionId: s.id, tabId: s.tabId, documentKey: s.documentKey,
    url: `https://chatgpt.com/c/${s.conversationId}`, userMessageId: 'u1',
    boundaryKnown: true, nextUserMessageId: 'u2', ...extra });
}
async function completeRecovery(f, s) {
  const current = f.broker.snapshot(s.id);
  const answer = current.history.find(item => item.type === 'assistant_message');
  assert.ok(answer);
  await f.store.transaction(d => {
    d.sessions[s.id].nativeDelivery = { generation: 'test-generation', agentId: 'agent-one',
      durable: { version: 1, scope: {}, sources: [], deliveries: [
        { sourceId: answer.id, confirmedText: answer.text, pending: null }
      ], attempts: [], checkpoints: [] } };
  });
  await f.broker.tick(Date.now());
  return until(() => f.broker.snapshot(s.id).recovery?.status === 'completed'
    ? f.broker.snapshot(s.id) : null);
}

test('RCA-1 cancel from needs_review is terminal for late frames and allows explicit reselect', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  await claim(f, s);
  await f.view(f.broker.snapshot(s.id), { state: 'running', transcriptComplete: true,
    items: [assistant(cid, 'other-a', 'other-u', 'unrelated page content', 0)] });
  assert.equal(f.broker.snapshot(s.id).recovery.status, 'needs_review');
  await f.broker.cancelRecovery(s.id);
  const canceled = f.broker.snapshot(s.id);
  assert.equal(canceled.status, 'blocked');
  assert.equal(canceled.recovery.status, 'cancelled');
  assert.equal(f.broker.manualRecoveryTargets()[0].recovery.status, 'cancelled');
  const history = JSON.stringify(canceled.history);
  const stale = await f.view(canceled, { state: 'standby', transcriptComplete: true,
    items: [user(cid, 'u1', 'selected', 1), assistant(cid, 'a1', 'u1', 'late answer', 2)] });
  assert.equal(stale.stale, true);
  assert.equal(JSON.stringify(f.broker.snapshot(s.id).history), history);

  await claim(f, s);
  await f.view(f.broker.snapshot(s.id), { state: 'standby', transcriptComplete: true,
    items: [user(cid, 'u1', 'selected', 1), assistant(cid, 'a1', 'u1', 'reselect answer', 2)] });
  const completed = await completeRecovery(f, s);
  assert.equal(completed.recovery.status, 'completed');
  assert.equal(completed.status, 'idle');
  assert.equal(completed.history.filter(item => item.type === 'user_message').length, 1);
  assert.equal(completed.history.filter(item => item.type === 'assistant_message').length, 1);
  assert.equal(Object.values(f.store.read().commands).filter(command => command.kind === 'send').length, 1);
});

test('RCA-2 archive from needs_review stays open until recovery completes, then uses the normal close path', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  await claim(f, s);
  await f.view(f.broker.snapshot(s.id), { state: 'running', transcriptComplete: false,
    items: [user(cid, 'u1', 'selected', 1)] });
  assert.equal(f.broker.snapshot(s.id).recovery.status, 'needs_review');
  await f.broker.archiveSession(s.id);
  const archived = f.broker.snapshot(s.id);
  assert.ok(archived.archiveIntent);
  assert.equal(archived.status, 'running');
  assert.equal(archived.tabId, s.tabId);
  assert.equal(f.broker.queued().some(command => command.kind === 'close-tab'), false);

  await f.view(archived, { state: 'standby', transcriptComplete: true,
    items: [user(cid, 'u1', 'selected', 1), assistant(cid, 'a1', 'u1', 'archived answer', 2)] });
  const completed = await completeRecovery(f, s);
  assert.equal(completed.recovery.status, 'completed');
  assert.ok(f.broker.queued().some(command => command.kind === 'close-tab' && command.sessionId === s.id));
});
