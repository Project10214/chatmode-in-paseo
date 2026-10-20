import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import { fixture, pageView, until } from './helpers.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';
import { sourceRevision } from '../server/source-ledger.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const itemId = (conversationId, role, native) => JSON.stringify([conversationId, 'message', role, native]);
const user = (conversationId, native, text, order) => ({
  id: itemId(conversationId, 'user', native), nativeMessageId: native, userMessageId: native,
  role: 'user', lane: 'output', kind: 'message', text, format: 'text', order: [order]
});
const assistant = (conversationId, native, userNative, text, order) => ({
  id: itemId(conversationId, 'assistant', native), nativeMessageId: native, userMessageId: userNative,
  role: 'assistant', lane: 'output', kind: 'message', text, format: 'text', order: [order]
});
const card = key => ({ state: 'open', key, app: 'mymac', tool: 'run_shell_command',
  input: JSON.stringify({ command: 'node --version' }), autoEligible: true, autoTier: 'once',
  labels: ['Allow once', 'Deny'] });

async function uncertain(t, clientMessageId = 'message-1') {
  const f = await fixture(t), opened = await f.ready();
  await f.broker.prompt(opened.id, clientMessageId, 'hello');
  const dispatched = await f.dispatchSend(opened, { state: 'running' });
  await f.broker.failTurn(opened.id, 'TURN_CHANGED', true, dispatched.command.payload.turnId);
  const s = f.broker.snapshot(opened.id);
  assert.equal(s.turn.outcome, 'failed');
  assert.equal(s.status, 'idle');
  assert.ok(s.conversationId);
  return { f, s, dispatched };
}

function claim(f, s, extra = {}) {
  return f.broker.claimRecovery({ sessionId: s.id, tabId: s.tabId, documentKey: s.documentKey,
    url: `https://chatgpt.com/c/${s.conversationId}`, userMessageId: 'u1',
    boundaryKnown: true, nextUserMessageId: 'u2', ...extra });
}

async function completeRecovery(f, s) {
  const current = f.broker.snapshot(s.id);
  const assistantItem = current.history.find(item => item.type === 'assistant_message');
  assert.ok(assistantItem, 'target answer must be projected before host confirmation');
  await f.store.transaction(d => {
    d.sessions[s.id].nativeDelivery = { generation: 'test-generation', agentId: 'agent-one',
      durable: { version: 1, scope: {}, sources: [], deliveries: [
        { sourceId: assistantItem.id, confirmedText: assistantItem.text, pending: null }
      ], attempts: [], checkpoints: [] } };
  });
  await f.broker.tick(Date.now());
  return until(() => f.broker.snapshot(s.id).recovery?.status === 'completed'
    ? f.broker.snapshot(s.id) : null);
}

test('REC-1 recovery requires a selected turn and a known boundary before creating state', async t => {
  const { f, s } = await uncertain(t);
  await assert.rejects(f.broker.claimRecovery({ sessionId: s.id, tabId: s.tabId,
    documentKey: s.documentKey, url: `https://chatgpt.com/c/${s.conversationId}`,
    userMessageId: 'u1', boundaryKnown: false }), /RECOVERY_BOUNDARY_UNKNOWN/);
  await assert.rejects(claim(f, s, { nextUserMessageId: undefined, transcriptComplete: false }),
    /RECOVERY_BOUNDARY_UNKNOWN/);
  assert.equal(f.broker.snapshot(s.id).recovery, undefined);
  assert.equal(f.broker.manualRecoveryTargets().length, 1);
  assert.equal(f.broker.manualRecoveryTargets()[0].sessionId, s.id);
});

test('REC-2 selected-turn read imports only that turn, reuses the original user row and waits for host confirmation', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  // An already-read but unprojected source outside the selected turn must stay
  // where it is; recovery must not perform a general history catch-up.
  const oldSource = assistant(cid, 'old-a', 'old-u', 'old answer', 0);
  await f.store.transaction(d => {
    const current = d.sessions[s.id];
    const record = { ...oldSource, revision: sourceRevision(oldSource),
      originalText: oldSource.text, firstSeenAt: 1, updatedAt: 1 };
    current.sources = [record];
    current.sourceProjections = [];
  });
  const result = await claim(f, s);
  assert.equal(result.recovery.userMessageId, 'u1');
  assert.equal(f.broker.snapshot(s.id).status, 'running');
  assert.equal(f.store.read().commands[f.store.read().sessions[s.id].turn.commandId].phase, 'failed',
    'the failed turn Send gate is retired before recovery can authorize it');
  await assert.rejects(claim(f, s), /RECOVERY_ALREADY_ACTIVE/);

  const targetUser = user(cid, 'u1', 'the selected question', 2);
  const targetAnswer = assistant(cid, 'a1', 'u1', 'the selected answer', 3);
  const nextUser = user(cid, 'u2', 'later question', 4);
  const nextAnswer = assistant(cid, 'a2', 'u2', 'later answer', 5);
  await f.view(f.broker.snapshot(s.id), { state: 'running', transcriptComplete: false,
    items: [user(cid, 'old-u', 'old question', 0), oldSource, targetUser, targetAnswer, nextUser, nextAnswer] });

  const current = f.broker.snapshot(s.id);
  assert.equal(current.recovery.status, 'observing');
  assert.equal(current.sources.some(value => value.id === oldSource.id), true,
    'the existing unprojected source is retained, not deleted');
  assert.equal(current.sources.some(value => value.id === targetUser.id), true);
  assert.equal(current.sources.some(value => value.id === targetAnswer.id), true);
  assert.equal(current.sources.some(value => value.id === nextUser.id), false,
    'the next user turn is not imported');
  assert.equal(current.history.filter(value => value.type === 'user_message').length, 1,
    'the original Paseo user row is reused');
  assert.equal(current.history.some(value => value.type === 'assistant_message' && value.text === 'the selected answer'), true);
  assert.equal(current.history.some(value => value.text === 'later answer'), false);
  assert.equal(current.history.some(value => value.text === 'old answer'), false);
  assert.equal(current.turn.nativeMessageId, undefined,
    'a DOM user locator is not a Send receipt');

  await f.view(current, { state: 'standby', transcriptComplete: true,
    items: [targetUser, targetAnswer, nextUser] });
  const standby = f.broker.snapshot(s.id);
  assert.equal(standby.recovery.status, 'observing');
  assert.ok(standby.recovery.pageStandbyAt);
  assert.equal(standby.turn.outcome, 'failed',
    'recovery never rewrites the original prompt outcome');

  const completed = await completeRecovery(f, s);
  assert.equal(completed.status, 'idle');
  assert.equal(completed.recovery.status, 'completed');
  assert.equal(completed.history.filter(value => value.type === 'assistant_message').length, 1);
  assert.equal(Object.values(f.store.read().commands).filter(command => command.kind === 'send').length, 1,
    'recovery never sends or re-sends a prompt');
});

test('REC-3 changing the anchor makes the boundary unknown; no whole-page content is imported', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  const oldSource = assistant(cid, 'old-a', 'other-user', 'unprojected outside turn', 9);
  await f.store.transaction(d => {
    const current = d.sessions[s.id];
    current.sources = [{ ...oldSource, revision: sourceRevision(oldSource),
      originalText: oldSource.text, firstSeenAt: 1, updatedAt: 1 }];
    current.sourceProjections = [];
  });
  await claim(f, s);
  const before = f.broker.snapshot(s.id);
  await f.view(before, { state: 'running', transcriptComplete: true,
    approvals: [{ ...card('6f1c2d3e-0000-4000-8000-000000000105'),
      text: 'fallback notice outside the selected turn' }],
    items: [assistant(cid, 'a9', 'other-user', 'unrelated answer', 9)] });
  const current = f.broker.snapshot(s.id);
  assert.equal(current.recovery.status, 'needs_review');
  assert.equal(current.recovery.reason, 'RECOVERY_ANCHOR_MISSING');
  assert.equal(current.history.some(value => value.text === 'unrelated answer'), false);
  assert.equal(current.history.some(value => value.text === 'unprojected outside turn'), false);
  assert.equal(current.history.some(value => value.text === 'fallback notice outside the selected turn'), false);
  assert.equal(current.status, 'running');
  assert.equal(current.turn.outcome, 'failed');
});

test('REC-4 cancel is terminal for late frames and allows explicit abandon', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  await claim(f, s);
  const historyBefore = JSON.stringify(f.broker.snapshot(s.id).history);
  await f.broker.cancelRecovery(s.id);
  const canceled = f.broker.snapshot(s.id);
  assert.equal(canceled.status, 'blocked');
  assert.equal(canceled.error, 'RECOVERY_CANCELLED');
  assert.equal(canceled.recovery.status, 'cancelled');
  const stale = await f.view(canceled, { state: 'standby', transcriptComplete: true,
    items: [user(cid, 'u1', 'selected', 1), assistant(cid, 'a1', 'u1', 'late answer', 2)] });
  assert.equal(stale.stale, true);
  assert.equal(JSON.stringify(f.broker.snapshot(s.id).history), historyBefore);
  assert.equal(f.broker.snapshot(s.id).status, 'blocked');
  assert.equal(f.broker.manualRecoveryTargets()[0].recovery.status, 'cancelled');
  await f.broker.abandon(s.id);
  assert.equal(f.broker.snapshot(s.id).status, 'abandoned');
  assert.equal(f.broker.manualRecoveryTargets().length, 0);
});

test('REC-5 recovery expiry releases the session without importing late results', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  await f.broker.claimRecovery({ sessionId: s.id, tabId: s.tabId, documentKey: s.documentKey,
    url: `https://chatgpt.com/c/${s.conversationId}`, userMessageId: 'u1',
    boundaryKnown: true, transcriptComplete: true });
  await f.store.transaction(d => { d.sessions[s.id].recovery.expiresAt = Date.now() - 1; });
  await f.broker.tick(Date.now());
  const expired = f.broker.snapshot(s.id);
  assert.equal(expired.recovery.status, 'expired');
  assert.equal(expired.status, 'blocked');
  assert.equal(expired.error, 'RECOVERY_EXPIRED');
  const before = JSON.stringify(expired.history);
  const stale = await f.view(expired, { state: 'standby', transcriptComplete: true,
    items: [user(cid, 'u1', 'selected', 1), assistant(cid, 'a1', 'u1', 'late after expiry', 2)] });
  assert.equal(stale.stale, true);
  assert.equal(JSON.stringify(f.broker.snapshot(s.id).history), before);
  await f.broker.prepareContinuation(s.id);
  const answer = f.broker.prompt(s.id, 'message-2', 'fresh prompt');
  answer.catch(() => {});
  const queued = await until(() => f.broker.queued().find(c => c.kind === 'send' && c.sessionId === s.id));
  assert.ok(queued, 'a fresh prompt after explicit expiry is a new Send, never an automatic resend');
  assert.equal(f.broker.snapshot(s.id).recovery, undefined);
});

test('REC-6 provider recovery emits the target body through normal host confirmation without a prompt result', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  const events = [], rows = [], cache = new Map(), listeners = new Set();
  let seq = 0;
  const observation = {
    request: async () => ({ woken: true, agentId: 'agent-one' }),
    onHostAvailable: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    async readTimeline(id, scope) {
      assert.equal(id, s.id);
      assert.equal(scope.agentId, 'agent-one');
      return { sessionId: scope.hostId, bindingGeneration: scope.bindingGeneration, hostEpoch: 'recovery-host-epoch',
        coverage: { complete: true, startSeq: rows.length ? 1 : null, endSeq: seq || null, nextSeq: seq + 1 },
        rows: structuredClone(rows) };
    }
  };
  const connection = await createProvider({ ...f, status: () => ({ connected: true }) },
    event => ProviderEventSchema.parse(event), { hostObservation: observation })
    .connect({ versions: [1], capabilities: CAPABILITIES });
  t.after(() => connection.close());
  connection.onEvent(event => {
    events.push(event);
    if (event.type !== 'timeline.item') return;
    const item = structuredClone(event.item);
    if (item.type === 'assistant_message') {
      const old = cache.get(item.id) ?? '';
      cache.set(item.id, item.text);
      item.text = item.text.slice(old.length);
    }
    rows.push({ seqStart: ++seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], item });
  });
  await connection.send({ type: 'session.open', requestId: 'open-recovery', sessionId: 'host-recovery',
    history: 'replay', persistence: { version: 1, data: { id: s.id } },
    config: { cwd: '/fixture', env: {}, settings: {}, mcpServers: {}, persist: true,
      model: s.config.model, thinkingOption: s.config.thinkingOption,
      providerOptions: { appIds: s.config.appIds } } });
  await until(() => events.some(event => event.type === 'session.ready'));

  await claim(f, s);
  const targetUser = user(cid, 'u1', 'provider question', 2);
  const targetAnswer = assistant(cid, 'a1', 'u1', 'provider answer', 3);
  await f.view(f.broker.snapshot(s.id), { state: 'standby', transcriptComplete: true,
    items: [targetUser, targetAnswer] });
  await until(() => rows.some(row => row.item.type === 'assistant_message' && row.item.text === 'provider answer'));
  await until(() => f.broker.snapshot(s.id).nativeDelivery?.durable?.deliveries
    ?.some(row => row.confirmedText === 'provider answer'));
  await f.broker.tick(Date.now());
  const completed = await until(() => f.broker.snapshot(s.id).recovery?.status === 'completed'
    ? f.broker.snapshot(s.id) : null);
  assert.equal(completed.status, 'idle');
  await until(() => events.some(event => event.type === 'session.notice'
    && event.notice.id === 'recovery-status:' + s.id && event.notice.dismissed === true));
  assert.equal(events.filter(event => event.type === 'session.prompt_result').length, 0,
    'recovery is not a second prompt_result');
  assert.equal(Object.values(f.store.read().commands).filter(command => command.kind === 'send').length, 1);
  await sleep(50);
});

test('REC-7 recovery suppresses existing and new auto approvals but keeps manual allow', async t => {
  const { f, s } = await uncertain(t);
  const existing = card('6f1c2d3e-0000-4000-8000-000000000101');
  const fresh = card('6f1c2d3e-0000-4000-8000-000000000102');
  await f.view(f.broker.snapshot(s.id), { state: 'running', approvals: [existing] });
  assert.notEqual(f.broker.snapshot(s.id).approvals[existing.key].autoSuppressed, true);
  await f.broker.setAutoAllowApprovals(true);
  await claim(f, s);
  assert.equal(f.broker.snapshot(s.id).approvals[existing.key].autoSuppressed, true);
  await f.view(f.broker.snapshot(s.id), { state: 'running', approvals: [fresh] });
  assert.equal(f.broker.snapshot(s.id).approvals[fresh.key].autoSuppressed, true);
  await assert.rejects(f.broker.answerApproval(s.id, fresh.key, 'allow-auto'), /AUTO_APPROVAL_DISABLED/);
  const manual = f.broker.answerApproval(s.id, fresh.key, 'allow-once');
  const command = await until(() => f.broker.queued().find(c => c.kind === 'approval' && c.sessionId === s.id));
  assert.equal(command.payload.choice, 'allow-once');
  const claimCommand = await f.broker.claim(command.id, s.tabId, s.documentKey);
  await f.broker.result(command.id, claimCommand.lease, { answered: true, key: fresh.key, choice: 'allow-once' });
  assert.deepEqual(await manual, { answered: true, choice: 'allow-once' });
});

test('REC-8 a claimed auto approval is vetoed when recovery begins, not treated as safe to click', async t => {
  const { f, s } = await uncertain(t);
  const autoCard = card('6f1c2d3e-0000-4000-8000-000000000103');
  await f.view(f.broker.snapshot(s.id), { state: 'running', approvals: [autoCard] });
  await f.broker.setAutoAllowApprovals(true);
  const auto = f.broker.answerApproval(s.id, autoCard.key, 'allow-auto');
  auto.catch(() => {});
  const command = await until(() => f.broker.queued().find(c => c.kind === 'approval' && c.sessionId === s.id));
  const claimed = await f.broker.claim(command.id, s.tabId, s.documentKey);
  await claim(f, s);
  const current = f.store.read().commands[command.id];
  assert.equal(current.vetoed, true);
  assert.equal(current.vetoReason, 'RECOVERY_ENTERED');
  assert.throws(() => f.broker.verifyApproval(command.id, claimed.lease), /APPROVAL_VETOED/);
  assert.equal(f.broker.snapshot(s.id).approvals[autoCard.key].autoSuppressed, true);
});

test('REC-11 an answer projected before the failed turn still requires host confirmation', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  const targetUser = user(cid, 'u1', 'already visible question', 1);
  const targetAnswer = assistant(cid, 'a1', 'u1', 'already visible answer', 2);
  await f.view(f.broker.snapshot(s.id), { state: 'running', items: [targetUser, targetAnswer] });
  assert.equal(f.broker.snapshot(s.id).history.some(value => value.text === 'already visible answer'), true);
  await claim(f, s);
  await f.view(f.broker.snapshot(s.id), { state: 'standby', transcriptComplete: true,
    items: [targetUser, targetAnswer] });
  const current = f.broker.snapshot(s.id);
  const projected = current.history.find(value => value.type === 'assistant_message');
  assert.ok(projected);
  assert.deepEqual(current.recovery.required[projected.id], { text: 'already visible answer' });
  const completed = await completeRecovery(f, s);
  assert.equal(completed.recovery.status, 'completed');
  assert.equal(completed.history.filter(value => value.type === 'assistant_message').length, 1);
});

test('REC-12 a recovery selected from a reopened tab moves the existing observer and rejects the old document', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId, before = f.broker.snapshot(s.id);
  await claim(f, s, { tabId: 909, documentKey: 'reopened-document' });
  const moved = f.broker.snapshot(s.id);
  assert.equal(moved.tabId, 909);
  assert.equal(moved.documentKey, 'reopened-document');
  assert.notEqual(moved.observation.lease, before.observation.lease);
  assert.equal(moved.recovery.tabId, 909);
  assert.equal(moved.recovery.documentKey, 'reopened-document');
  await assert.rejects(f.broker.observeView(pageView(before, { state: 'standby', transcriptComplete: true,
    items: [user(cid, 'u1', 'selected', 1), assistant(cid, 'a1', 'u1', 'old document answer', 2)] })),
    /OBSERVATION_LEASE_MISMATCH/);
  await f.view(moved, { state: 'standby', transcriptComplete: true,
    items: [user(cid, 'u1', 'selected', 1), assistant(cid, 'a1', 'u1', 'reopened answer', 2)] });
  const completed = await completeRecovery(f, s);
  assert.equal(completed.recovery.status, 'completed');
  assert.equal(completed.history.filter(item => item.type === 'assistant_message').length, 1);
});

test('REC-13 recovery suppression is scoped to the recovered session, not global auto-approval', async t => {
  const { f, s } = await uncertain(t);
  await claim(f, s);
  const second = await f.ready();
  await f.sending(second, 'message-2');
  await f.view(second, { state: 'standby' });
  const other = card('6f1c2d3e-0000-4000-8000-000000000106');
  await f.view(second, { state: 'standby', approvals: [other] });
  await f.broker.setAutoAllowApprovals(true);
  const auto = f.broker.answerApproval(second.id, other.key, 'allow-auto');
  auto.catch(() => {});
  const command = await until(() => f.broker.queued().find(c => c.kind === 'approval' && c.sessionId === second.id));
  assert.equal(command.payload.choice, 'allow-auto');
  assert.notEqual(f.broker.snapshot(second.id).approvals[other.key].autoSuppressed, true);
  assert.equal(f.broker.snapshot(s.id).approvals[other.key], undefined);
  await f.broker.setAutoAllowApprovals(false);
});

test('REC-14 completion is scoped to the recovered turn; stale reselect fails and a later failed turn is offered', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  await claim(f, s);
  await f.view(f.broker.snapshot(s.id), { state: 'standby', transcriptComplete: true,
    items: [user(cid, 'u1', 'selected', 1), assistant(cid, 'a1', 'u1', 'first answer', 2)] });
  assert.equal((await completeRecovery(f, s)).recovery.status, 'completed');
  await assert.rejects(claim(f, s), /RECOVERY_NOT_AVAILABLE/);
  const result = await f.broker.prompt(s.id, 'message-2', 'again');
  const dispatched = await f.dispatchSend(f.broker.snapshot(s.id), { state: 'running' });
  const turnId = dispatched.command.payload.turnId;
  assert.equal(turnId, result.turnId);
  await f.broker.failTurn(s.id, 'TURN_CHANGED', true, turnId);
  const targets = f.broker.manualRecoveryTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].sessionId, s.id);
});

test('REC-9 approvals discovered on a later normal turn are not suppressed', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  await claim(f, s);
  await f.view(f.broker.snapshot(s.id), { state: 'standby', transcriptComplete: true,
    items: [user(cid, 'u1', 'selected', 1), assistant(cid, 'a1', 'u1', 'answer', 2)] });
  await completeRecovery(f, s);
  const later = card('6f1c2d3e-0000-4000-8000-000000000104');
  await f.broker.setAutoAllowApprovals(true);
  await f.view(f.broker.snapshot(s.id), { state: 'standby', approvals: [later] });
  const approval = f.broker.snapshot(s.id).approvals[later.key];
  assert.equal(approval.state, 'open');
  assert.notEqual(approval.autoSuppressed, true,
    'the recovery suppression is scoped to cards read during recovery');
  const auto = f.broker.answerApproval(s.id, later.key, 'allow-auto');
  auto.catch(() => {});
  const command = await until(() => f.broker.queued().find(c => c.kind === 'approval' && c.sessionId === s.id));
  assert.equal(command.payload.choice, 'allow-auto');
  await f.broker.setAutoAllowApprovals(false);
});

test('REC-10 archive waits for recovery completion and then closes only the archived idle tab', async t => {
  const { f, s } = await uncertain(t);
  const cid = s.conversationId;
  await claim(f, s);
  await f.broker.archiveSession(s.id);
  const archived = f.broker.snapshot(s.id);
  assert.ok(archived.archiveIntent, 'archive intent is durable');
  assert.equal(archived.status, 'running');
  assert.equal(archived.tabId, s.tabId, 'an active recovery is never closed as idle');
  assert.equal(f.broker.manualRecoveryTargets().length, 0);
  assert.equal(f.broker.queued().some(c => c.kind === 'close-tab'), false);

  await f.view(archived, { state: 'standby', transcriptComplete: true,
    items: [user(cid, 'u1', 'selected', 1), assistant(cid, 'a1', 'u1', 'answer', 2)] });
  await completeRecovery(f, s);
  assert.ok(f.broker.queued().some(c => c.kind === 'close-tab' && c.sessionId === s.id),
    'once recovery completes, the archived idle tab follows the existing close path');
});
