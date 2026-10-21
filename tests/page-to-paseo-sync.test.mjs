/* End-to-end guards for the ChatGPT page -> Paseo sync path.
 *
 * These cover the three defects that were reproducible in this dimension:
 *  - an assistant body frozen at its first captured length because the
 *    preceding-user reference was treated as the source's identity;
 *  - a DOM path shift read as a content rewrite, which re-projected and
 *    re-delivered every card of the conversation;
 *  - a transport-split page read that ended the host turn before the rest of
 *    its content had been received.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureObservation, recordPageView, beginPromptObservation
} from '../server/continuous-observation.mjs';
import { projectPageItem } from '../server/page-items.mjs';

const control = visible => ({ visible, enabled: visible });
const buttonState = (state, { observedAt = Date.now(), readable = true } = {}) => ({
  observedAt, readable,
  controls: {
    stop: control(state === 'running'),
    send: control(state === 'standby'),
    voice: control(false)
  }
});
const assistant = (id, text, extra = {}) => ({
  id, userMessageId: null, role: 'assistant', lane: 'output', kind: 'message',
  text, format: 'text', order: [0], ...extra
});
const toolCall = (id, text, extra = {}) => ({
  id, userMessageId: null, role: 'assistant', lane: 'process', kind: 'tool_call',
  text, format: 'text', order: [1], callId: 'call-1', name: 'search', status: 'completed', ...extra
});

function session() {
  const value = {
    id: 'session-sync', status: 'idle', tabId: 71, documentKey: 'document-sync',
    conversationId: 'chat-sync', history: [], prompts: {}, commands: {},
    turn: { id: 'turn-1', clientMessageId: 'prompt', outcome: null }
  };
  ensureObservation(value);
  return value;
}
function frame(s, { sequence, state = 'running', items = [], readFinal } = {}) {
  return {
    sessionId: s.id, observationLease: s.observation.lease,
    tabId: s.tabId, documentKey: s.documentKey,
    url: `https://chatgpt.com/c/${s.conversationId}`, sequence,
    ...(readFinal === undefined ? {} : { readFinal }),
    view: {
      conversationId: s.conversationId, page: buttonState(state),
      items, approvals: [], closedApprovals: [], issues: []
    }
  };
}
const sourceEvents = result => result.events.filter(event => event.state === 'source');
const historyText = s => s.history.filter(row => row.type === 'assistant_message').map(row => row.text);

test('SYNC-01 the assistant body keeps growing when the user-message reference moves', () => {
  const s = session();
  beginPromptObservation(s, 'turn-1', 100);
  const first = recordPageView(s, frame(s, {
    sequence: 1, state: 'running',
    items: [assistant('answer', 'Hel', { userMessageId: 'user-previous', nativeMessageId: 'm-answer' })]
  }), {}, 100);
  assert.deepEqual(sourceEvents(first).map(event => event.item.text), ['Hel']);

  // The page now proves a different preceding user turn for the same message.
  const second = recordPageView(s, frame(s, {
    sequence: 2, state: 'running',
    items: [assistant('answer', 'Hello world', { userMessageId: 'user-current', nativeMessageId: 'm-answer' })]
  }), {}, 200);
  assert.deepEqual(sourceEvents(second).map(event => event.item.text), ['Hello world']);

  const third = recordPageView(s, frame(s, {
    sequence: 3, state: 'running',
    items: [assistant('answer', 'Hello world!', { userMessageId: 'user-current', nativeMessageId: 'm-answer' })]
  }), {}, 300);
  assert.deepEqual(sourceEvents(third).map(event => event.item.text), ['Hello world!']);
  assert.deepEqual(historyText(s), ['Hello world!']);
});

test('SYNC-02 a DOM path shift does not re-project or re-deliver the conversation', () => {
  const s = session();
  const first = recordPageView(s, frame(s, {
    sequence: 1, state: 'running',
    items: [
      assistant('answer', 'Hello', { nativeMessageId: 'm-answer', order: [0] }),
      toolCall('call-row', 'Searching the web', { order: [1] })
    ]
  }), {}, 100);
  assert.equal(sourceEvents(first).length, 2);
  const before = sourceEvents(first).find(event => event.sourceId === 'call-row').item;

  // One sibling is inserted above the conversation: every DOM path shifts.
  const shifted = recordPageView(s, frame(s, {
    sequence: 2, state: 'running',
    items: [
      assistant('answer', 'Hello', { nativeMessageId: 'm-answer', order: [1] }),
      toolCall('call-row', 'Searching the web', { order: [2] })
    ]
  }), {}, 200);
  // No source event at all: nothing is re-projected, so no card of this
  // conversation is delivered to Paseo a second time.
  assert.deepEqual(sourceEvents(shifted), []);
  assert.deepEqual(historyText(s), ['Hello']);

  // The card identity is unchanged, so the same card would be an update of
  // one timeline item rather than a second one.
  const after = projectPageItem({
    id: 'call-row', userMessageId: null, role: 'assistant', lane: 'process', kind: 'tool_call',
    text: 'Searching the web', format: 'text', order: [2], callId: 'call-1', name: 'search', status: 'completed'
  });
  assert.equal(before.id, after.id);
  assert.equal(before.type, after.type);
  assert.equal(before.detail.text, after.detail.text);
});

test('SYNC-03 a transport-split read completes the turn after all its content landed', () => {
  const s = session();
  beginPromptObservation(s, 'turn-1', 100);
  recordPageView(s, frame(s, { sequence: 1, state: 'running', readFinal: false,
    items: [assistant('part-1', 'first part')] }), {}, 100);
  const middle = recordPageView(s, frame(s, { sequence: 2, state: 'standby', readFinal: false,
    items: [assistant('part-2', 'second part')] }), {}, 200);
  assert.equal(middle.events.filter(event => event.state === 'page-standby').length, 0);
  assert.equal(s.turn.outcome, null);

  const last = recordPageView(s, frame(s, { sequence: 3, state: 'standby', readFinal: true,
    items: [assistant('part-3', 'last part')] }), {}, 300);
  assert.equal(last.events.filter(event => event.state === 'page-standby').length, 1);
  assert.equal(s.turn.outcome, 'completed');
  // No content is projected after the turn was reported as completed.
  assert.deepEqual(historyText(s), ['first part', 'second part', 'last part']);
});
