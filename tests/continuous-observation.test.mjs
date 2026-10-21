import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureObservation, observationDescriptor, resetObservationDocument,
  beginPromptObservation, recordPageView
} from '../server/continuous-observation.mjs';

let nextOrder = 0;
const control = visible => ({ visible, enabled: visible });
const source = (id, text, extra = {}) => ({
  id, userMessageId: null, role: 'assistant', lane: 'output', kind: 'message',
  text, format: 'text', order: [nextOrder++], ...extra
});
const approval = (key = 'approval-0001') => ({
  key, app: 'mymac', tool: 'run_shell_command',
  input: '{"args":{"command":"echo fixture"}}', clickable: true,
  labels: ['Allow once', 'Deny']
});

/** A page DTO derived only from the visible native controls. */
function buttonState(state, { observedAt = Date.now(), readable = true, sendVisible, voiceVisible } = {}) {
  const running = state === 'running';
  const standby = state === 'standby';
  return {
    observedAt, readable,
    controls: {
      stop: control(running),
      send: control(sendVisible ?? standby),
      voice: control(voiceVisible ?? false)
    }
  };
}

function session(extra = {}) {
  const value = {
    id: 'session-a', status: 'idle', tabId: 71, documentKey: 'document-a',
    conversationId: 'chat-a', history: [], prompts: {}, commands: {},
    ...extra
  };
  ensureObservation(value);
  return value;
}

function frame(s, {
  sequence = 1, state = 'running', items = [], approvals = [], closedApprovals = [],
  issues = [], page = {}, readFinal
} = {}) {
  return {
    sessionId: s.id, observationLease: s.observation.lease,
    tabId: s.tabId, documentKey: s.documentKey,
    url: `https://chatgpt.com/c/${s.conversationId}`, sequence,
    ...(readFinal === undefined ? {} : { readFinal }),
    view: {
      conversationId: s.conversationId, page: buttonState(state, page),
      items, approvals, closedApprovals, issues
    }
  };
}

const events = (result, state) => result.events.filter(event => event.state === state);

test('CONTOBS-01 lease, document, tab and URL conversation are fenced; reset rotates the lease', () => {
  const s = session();
  s.history.push({ type: 'user_message', id: 'user:kept', text: 'kept history' });
  s.approvals['approval-kept'] = { state: 'open', key: 'approval-kept' };
  const commands = {};
  const valid = frame(s, { sequence: 1, items: [source('fenced', 'visible')] });

  for (const [patch, code] of [
    [{ observationLease: 'other-lease' }, /OBSERVATION_LEASE_MISMATCH/],
    [{ tabId: 72 }, /PAGE_IDENTITY_MISMATCH/],
    [{ documentKey: 'document-b' }, /PAGE_IDENTITY_MISMATCH/],
    [{ url: 'https://chatgpt.com/c/chat-b' }, /PAGE_IDENTITY_MISMATCH/]
  ]) {
    assert.throws(() => recordPageView(s, { ...valid, ...patch }, commands, 100), code);
  }
  assert.equal(s.observation.lastSequence, 0);

  const oldLease = s.observation.lease;
  const reset = resetObservationDocument(s, 72, 'document-b');
  assert.equal(reset.generation, 1);
  assert.notEqual(reset.observationLease, oldLease);
  assert.equal(s.observation.lastSequence, 0);
  assert.equal(s.history.at(-1).id, 'user:kept');
  assert.equal(s.approvals['approval-kept'].state, 'open');
  assert.throws(() => recordPageView(s, {
    ...valid, observationLease: oldLease, tabId: 72, documentKey: 'document-b'
  }, commands, 100), /OBSERVATION_LEASE_MISMATCH/);

  const accepted = recordPageView(s, {
    ...valid, observationLease: reset.observationLease, tabId: 72, documentKey: 'document-b'
  }, commands, 100);
  assert.equal(accepted.accepted, true);
  assert.equal(events(accepted, 'source').length, 1);

  const abandoned = session({ status: 'abandoned' });
  assert.throws(() => recordPageView(abandoned, frame(abandoned), commands, 100), /SESSION_UNKNOWN/);
  // An archive intent waits for safe closure; it is not yet an unbinding.
  const archiving = session({ archiveIntent: { id: 'archive-1' } });
  const archivedFrame=recordPageView(archiving,frame(archiving),commands,100);
  assert.equal(archivedFrame.accepted,true);
  assert.throws(()=>recordPageView(undefined,frame(archiving),commands,100),/SESSION_UNKNOWN/);
});

test('CONTOBS-02 sequence is idempotent, stale frames are ignored, and a changed duplicate conflicts', () => {
  const s = session();
  const commands = {};
  const first = frame(s, { sequence: 1, items: [source('sequence-a', 'A')] });
  const one = recordPageView(s, first, commands, 100);
  assert.equal(one.accepted, true);
  assert.equal(s.observation.lastSequence, 1);

  const history = JSON.stringify(s.history);
  const duplicate = recordPageView(s, first, commands, 200);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.events, []);
  assert.equal(JSON.stringify(s.history), history);

  assert.throws(() => recordPageView(s, {
    ...first, view: { ...first.view, items: [source('sequence-b', 'B')] }
  }, commands, 300), /OBSERVATION_SEQUENCE_CONFLICT/);
  assert.equal(s.observation.lastSequence, 1);

  const two = recordPageView(s, frame(s, { sequence: 2, items: [source('sequence-b', 'B')] }), commands, 400);
  assert.equal(two.accepted, true);
  assert.equal(s.observation.lastSequence, 2);
  const stale = recordPageView(s, frame(s, { sequence: 1, items: [source('sequence-c', 'C')] }), commands, 500);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.events, []);
  assert.equal(s.observation.lastSequence, 2);
  assert.equal(s.history.some(row => row.id === 'page:sequence-c'), false);
  assert.throws(() => recordPageView(s, { ...first, sequence: 0 }, commands, 600), /PAGE_VIEW_INVALID/);
});

test('CONTOBS-03 running, standby and abnormal frames all receive visible content', () => {
  for (const state of ['running', 'standby', 'abnormal']) {
    const s = session();
    const item = source(`state-${state}`, `${state} content`);
    const result = recordPageView(s, frame(s, { sequence: 1, state, items: [item] }), {}, 100);
    const sourceEvent = events(result, 'source').find(event => event.sourceId === item.id);
    assert.ok(sourceEvent, `${state} source event`);
    assert.equal(sourceEvent.item.text, `${state} content`);
    const pageEvent = events(result, 'page-status')[0];
    assert.equal(pageEvent.page.state, state);
    assert.equal(s.history.some(row => row.id === `page:${item.id}`), true);
  }
});

test('CONTOBS-04 one malformed source becomes an issue without blocking later sources', () => {
  const s = session();
  const bad = {
    id: 'bad-source', userMessageId: null, role: 'assistant', lane: 'output',
    kind: 'message', text: 42, format: 'text', order: [0]
  };
  const result = recordPageView(s, frame(s, {
    sequence: 1,
    items: [source('good-a', 'A'), bad, source('good-b', 'B')]
  }), {}, 100);
  assert.deepEqual(events(result, 'source').map(event => event.sourceId), ['good-a', 'good-b']);
  assert.equal(result.issues.some(issue => issue.code === 'SOURCE_TEXT_INVALID'), true);
  assert.equal(events(result, 'page-status')[0].issues.some(issue => issue.code === 'SOURCE_TEXT_INVALID'), true);
  assert.equal(s.history.some(row => row.id === 'page:bad-source'), false);
  assert.deepEqual(
    s.history.filter(row => row.type === 'assistant_message').map(row => row.text),
    ['A', 'B']
  );
});

test('CONTOBS-05 Work process and formal output keep distinct source identities', () => {
  const s = session();
  const work = source('work-1', 'visible work', { lane: 'process', kind: 'reasoning' });
  const formal = source('formal-1', 'formal answer', { lane: 'output', kind: 'message' });
  const result = recordPageView(s, frame(s, { sequence: 1, items: [formal, work] }), {}, 100);
  const sourceEvents = events(result, 'source');
  assert.deepEqual(
    sourceEvents.map(event => [event.sourceId, event.item.type]),
    [['work-1', 'reasoning'], ['formal-1', 'assistant_message']]
  );
  assert.notEqual(sourceEvents[0].item.id, sourceEvents[1].item.id);
  assert.equal(sourceEvents[0].item.text, 'visible work');
  assert.equal(sourceEvents[1].item.text, 'formal answer');
  assert.equal(sourceEvents[0].item.text.includes('source:'), false);
  assert.equal(sourceEvents[1].item.text.includes('source:'), false);
  assert.equal(s.history.find(row => row.id === 'page:work-1').type, 'reasoning');
  assert.equal(s.history.find(row => row.id === 'page:formal-1').type, 'assistant_message');
});

test('CONTOBS-06 collapsed Work does not delete the formal answer or old source records', () => {
  const s = session();
  const work = source('work-collapse', 'work body', { lane: 'process', kind: 'reasoning' });
  const formal = source('formal-collapse', 'formal body', { lane: 'output', kind: 'message' });
  recordPageView(s, frame(s, { sequence: 1, items: [work, formal] }), {}, 100);
  const collapsed = recordPageView(s, frame(s, { sequence: 2, items: [work] }), {}, 200);
  assert.deepEqual(events(collapsed, 'source'), []);
  assert.equal(s.sources.some(record => record.id === 'formal-collapse'), true);
  assert.equal(s.history.some(row => row.id === 'page:formal-collapse'), true);
  const empty = recordPageView(s, frame(s, { sequence: 3, items: [] }), {}, 300);
  assert.deepEqual(events(empty, 'source'), []);
  assert.equal(s.sources.find(record => record.id === 'formal-collapse').text, 'formal body');
  assert.equal(s.history.find(row => row.id === 'page:formal-collapse').text, 'formal body');
});

test('CONTOBS-07 an original Send user echo is reused instead of duplicated', () => {
  const s = session();
  s.history = [{ type: 'user_message', id: 'user:turn-1', text: 'original request', clientMessageId: 'client-1' }];
  const commands = {
    send: { id: 'send-1', sessionId: s.id, kind: 'send', phase: 'done',
      payload: { turnId: 'turn-1' }, result: { nativeMessageId: 'native-user' } }
  };
  const echo = source('user-echo-source', '[injected context]\noriginal request', {
    role: 'user', lane: 'output', kind: 'message', nativeMessageId: 'native-user'
  });
  const result = recordPageView(s, frame(s, { sequence: 1, items: [echo] }), commands, 100);
  const event = events(result, 'source')[0];
  assert.equal(event.item.id, 'user:turn-1');
  assert.equal(event.item.text, 'original request');
  assert.equal(event.item.clientMessageId, 'client-1');
  assert.equal(s.history.filter(row => row.id === 'user:turn-1').length, 1);
  assert.equal(s.history.filter(row => row.type === 'user_message').length, 1);
  assert.deepEqual(Object.keys(commands), ['send']);
  assert.equal(commands.send.phase, 'done');
});

test('CONTOBS-08 a pending Send does not suspend observation or rewrite the command', () => {
  const s = session();
  s.turn = { id: 'turn-pending', receiptPending: true, lease: 'send-lease', nativeMessageId: null };
  const commands = {
    send: { id: 'send-pending', sessionId: s.id, kind: 'send', phase: 'queued',
      payload: { turnId: 'turn-pending' } }
  };
  const result = recordPageView(s, frame(s, {
    sequence: 1, state: 'running', items: [source('pending-content', 'visible during pending send')]
  }), commands, 100);
  assert.equal(result.accepted, true);
  assert.equal(events(result, 'source').length, 1);
  assert.equal(s.status, 'sending');
  assert.equal(result.observation.receiptPending, true);
  assert.equal(commands.send.phase, 'queued');
});

test('CONTOBS-09 standby ends the run but keeps observation content and open authorization', () => {
  const s = session();
  s.prompts = { prompt: { outcome: null } };
  s.turn = { id: 'turn-1', clientMessageId: 'prompt', outcome: null };
  beginPromptObservation(s, 'turn-1', 100);
  const card = approval('approval-standby');
  const running = recordPageView(s, frame(s, {
    sequence: 1, state: 'running', approvals: [card],
    items: [source('standby-work', 'work before standby', { lane: 'process', kind: 'reasoning' })]
  }), {}, 100);
  assert.equal(events(running, 'approval').length, 1);
  const lease = s.observation.lease;

  const standby = recordPageView(s, frame(s, {
    sequence: 2, state: 'standby', items: [source('standby-content', 'content while ending')]
  }), {}, 200);
  assert.equal(events(standby, 'page-standby').length, 1);
  assert.equal(s.observation.run.active, false);
  assert.equal(s.observation.run.endedAt, 200);
  assert.equal(s.turn.outcome, 'completed');
  assert.equal(s.prompts.prompt.outcome, 'completed');
  assert.equal(s.observation.lease, lease);
  assert.equal(s.observation.run.id, 'turn-1');
  assert.equal(s.approvals[card.key].state, 'open');
  assert.equal(observationDescriptor(s).runId, 'turn-1');
  assert.equal(events(standby, 'source').some(event => event.sourceId === 'standby-content'), true);
});

test('CONTOBS-10 abnormal content is received but does not close the active run', () => {
  const s = session();
  s.turn = { id: 'turn-abnormal', outcome: null };
  beginPromptObservation(s, 'turn-abnormal', 100);
  const result = recordPageView(s, frame(s, {
    sequence: 1, state: 'abnormal', items: [source('abnormal-content', 'received while abnormal')]
  }), {}, 200);
  assert.equal(events(result, 'source').length, 1);
  assert.equal(s.observation.run.active, true);
  assert.equal(s.observation.run.endedAt, null);
  assert.equal(s.turn.outcome, null);
  assert.equal(s.status, 'running');
  assert.equal(events(result, 'page-standby').length, 0);
});

test('CONTOBS-11 a new visible Stop interval starts a new page run without a new Send', () => {
  const s = session();
  beginPromptObservation(s, 'turn-old', 100);
  const commands = {
    existing: { id: 'existing', sessionId: s.id, kind: 'send', phase: 'done',
      payload: { turnId: 'old' }, result: { nativeMessageId: 'old-user' } }
  };
  const before = JSON.stringify(commands);
  recordPageView(s, frame(s, { sequence: 1, state: 'standby', items: [] }), commands, 200);
  assert.equal(s.observation.run.active, false);

  const result = recordPageView(s, frame(s, {
    sequence: 2, state: 'running', items: [source('after-stop', 'after the stop interval')]
  }), commands, 300);
  const running = events(result, 'page-running')[0];
  assert.ok(running);
  assert.notEqual(running.turnId, 'turn-old');
  assert.equal(s.observation.run.id, running.turnId);
  assert.equal(s.observation.run.active, true);
  assert.equal(s.observation.run.origin, 'page');
  assert.equal(JSON.stringify(commands), before);
  assert.equal(events(result, 'source').length, 1);
});

test('CONTOBS-12 an explicitly closed approval is resolved without inventing Deny', () => {
  const s = session();
  const card = approval('approval-closed');
  const opened = recordPageView(s, frame(s, {
    sequence: 1, state: 'running', approvals: [card]
  }), {}, 100);
  assert.equal(events(opened, 'approval').length, 1);

  const closed = recordPageView(s, frame(s, {
    sequence: 2, state: 'running', closedApprovals: [card.key]
  }), {}, 200);
  const event = events(closed, 'approval-closed')[0];
  assert.ok(event);
  assert.equal(event.answered, null);
  assert.equal(s.approvals[card.key].state, 'resolved');
  assert.equal(s.approvals[card.key].answered, undefined);
  assert.equal(JSON.stringify(event).includes('deny'), false);

  const repeat = recordPageView(s, frame(s, {
    sequence: 3, state: 'running', closedApprovals: [card.key]
  }), {}, 300);
  assert.equal(events(repeat, 'approval-closed').length, 0);
});

test('CONTOBS-13 unknown sourceKind is retained and reaches the projected source item', () => {
  const s = session();
  const unknown = source('unknown-kind', 'visible unknown item', { role: 'page', kind: 'future-widget' });
  const knownNotice = source('known-notice', 'known notice text', { role: 'page', kind: 'notice' });
  const result = recordPageView(s, frame(s, {
    sequence: 1, state: 'running', items: [unknown, knownNotice]
  }), {}, 100);

  const stored = s.sources.find(record => record.id === 'unknown-kind');
  assert.equal(stored.kind, 'notice');
  assert.equal(stored.sourceKind, 'future-widget');
  const projected = events(result, 'source').find(event => event.sourceId === 'unknown-kind');
  assert.ok(projected);
  assert.equal(projected.item.type, 'plugin');
  assert.equal(projected.item.kind, 'page-source');
  assert.equal(projected.item.data.source.sourceKind, 'future-widget');
  assert.equal(projected.item.data.source.text, 'visible unknown item');

  const notice = events(result, 'source').find(event => event.sourceId === 'known-notice');
  assert.equal(notice.item.data.source.text, 'known notice text');
  assert.equal(notice.item.data.source.sourceKind, undefined);
  assert.equal(stored.text, 'visible unknown item');
});

test('CONTOBS-14 a split page read ends the run only on its final frame', () => {
  // One page read can be split into several transport frames. Ending the run on
  // an earlier frame reported the host turn as completed before the remaining
  // content had been received.
  const s = session();
  s.prompts = { prompt: { outcome: null } };
  s.turn = { id: 'turn-1', clientMessageId: 'prompt', outcome: null };
  beginPromptObservation(s, 'turn-1', 100);

  const running = recordPageView(s, frame(s, {
    sequence: 1, state: 'running', readFinal: false,
    items: [source('split-1', 'first part')]
  }), {}, 100);
  assert.equal(events(running, 'page-standby').length, 0);

  const middle = recordPageView(s, frame(s, {
    sequence: 2, state: 'standby', readFinal: false,
    items: [source('split-2', 'second part')]
  }), {}, 200);
  assert.equal(events(middle, 'page-standby').length, 0);
  assert.equal(s.observation.run.active, true);
  assert.equal(s.turn.outcome, null);

  const last = recordPageView(s, frame(s, {
    sequence: 3, state: 'standby', readFinal: true,
    items: [source('split-3', 'last part')]
  }), {}, 300);
  assert.equal(events(last, 'page-standby').length, 1);
  assert.equal(s.observation.run.active, false);
  assert.equal(s.turn.outcome, 'completed');
  // Every part of the split read was projected before the run ended.
  assert.deepEqual(s.history.filter(row => row.type === 'assistant_message').map(row => row.text),
    ['first part', 'second part', 'last part']);
});

test('CONTOBS-15 a read without a finality flag keeps the single-frame behaviour', () => {
  // An extension that does not split its reads sends no flag at all.
  const s = session();
  s.prompts = { prompt: { outcome: null } };
  s.turn = { id: 'turn-1', clientMessageId: 'prompt', outcome: null };
  beginPromptObservation(s, 'turn-1', 100);
  recordPageView(s, frame(s, { sequence: 1, state: 'running' }), {}, 100);
  const standby = recordPageView(s, frame(s, { sequence: 2, state: 'standby' }), {}, 200);
  assert.equal(events(standby, 'page-standby').length, 1);
  assert.equal(s.turn.outcome, 'completed');
});
