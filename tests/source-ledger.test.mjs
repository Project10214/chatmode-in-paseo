import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSources, sourceRevision } from '../server/source-ledger.mjs';

const source = (id, text, extra = {}) => ({
  id,
  userMessageId: 'user-1',
  role: 'assistant',
  lane: 'output',
  kind: 'message',
  text,
  format: 'markdown',
  order: [0],
  ...extra
});
const records = session => session.sources;
const byId = (session, id) => records(session).find(record => record.id === id);

test('LEDGER-01 keeps 250 sources in source order without the old 32/12/8 caps', () => {
  const session = {};
  const batch = Array.from({ length: 250 }, (_, i) => source(`message-${i}`, `visible text ${i}`, {
    userMessageId: `user-${Math.floor(i / 10)}`,
    order: [Math.floor(i / 10), i % 10]
  }));
  const result = reconcileSources(session, batch, { now: 1000 });
  assert.deepEqual(result.issues, []);
  assert.equal(result.unchanged, 0);
  assert.equal(result.changes.length, 250);
  assert.deepEqual(result.changes.map(change => change.item.id), batch.map(item => item.id));
  assert.equal(records(session).length, 250);
  assert.deepEqual(records(session).map(record => record.order), batch.map(item => item.order));
  assert(records(session).every((record, i) => record.text === batch[i].text));
  assert(records(session).every(record => record.revision === sourceRevision(record)));
});

test('LEDGER-02 a later partial read fills gaps and never deletes collapsed sources', () => {
  const session = {};
  const final = source('final', 'the formal answer', { order: [2, 0] });
  const process = source('process', 'Work summary', { lane: 'process', kind: 'reasoning', order: [1, 0] });
  const first = reconcileSources(session, [final, process], { now: 100 });
  assert.deepEqual(first.changes.map(change => change.item.id), ['process', 'final']);

  const later = reconcileSources(session, [
    source('process', 'Work summary', { lane: 'process', kind: 'reasoning', order: [1, 0] }),
    source('tool', 'read a file', { lane: 'process', kind: 'tool_call', status: 'running', callId: 'call-1', order: [1, 1] })
  ], { now: 200 });
  assert.equal(later.unchanged, 1);
  assert.deepEqual(later.changes.map(change => [change.item.id, change.change]), [['tool', 'new']]);
  assert.equal(byId(session, 'final').text, 'the formal answer');
  assert.equal(records(session).length, 3);

  const collapsed = reconcileSources(session, [], { now: 300 });
  assert.deepEqual(collapsed.changes, []);
  assert.equal(collapsed.unchanged, 0);
  assert.equal(byId(session, 'final').text, 'the formal answer');
  assert.equal(records(session).length, 3);
});

test('LEDGER-03 changes and stored records follow lexicographic source order', () => {
  const session = {};
  const result = reconcileSources(session, [
    source('late', 'late', { order: [2] }),
    source('deep', 'deep', { order: [1, 2] }),
    source('shallow', 'shallow', { order: [1] }),
    source('first', 'first', { order: [0] })
  ], { now: 10 });
  assert.deepEqual(result.changes.map(change => change.item.id), ['first', 'shallow', 'deep', 'late']);
  assert.deepEqual(records(session).map(record => record.id), ['first', 'shallow', 'deep', 'late']);
});

test('LEDGER-04 equal text from different source ids is never merged', () => {
  const session = {};
  const result = reconcileSources(session, [
    source('answer-a', 'same public text', { order: [0] }),
    source('answer-b', 'same public text', { order: [1] })
  ], { now: 10 });
  assert.equal(result.changes.length, 2);
  assert.equal(records(session).length, 2);
  assert.notEqual(byId(session, 'answer-a').revision, byId(session, 'answer-b').revision);

  const again = reconcileSources(session, [
    source('answer-a', 'same public text', { order: [0] }),
    source('answer-b', 'same public text', { order: [1] })
  ], { now: 20 });
  assert.deepEqual(again.changes, []);
  assert.equal(again.unchanged, 2);
  assert.equal(records(session).length, 2);
});

test('LEDGER-05 prototype keys are data, not prototype mutation', () => {
  const session = {};
  const batch = [
    source('__proto__', 'proto text', { order: [0] }),
    source('constructor', 'constructor text', { order: [1] }),
    source('prototype', 'prototype text', { order: [2] })
  ];
  const result = reconcileSources(session, batch, { now: 10 });
  assert.deepEqual(result.issues, []);
  assert.equal(result.changes.length, 3);
  assert.deepEqual(records(session).map(record => record.id), ['__proto__', 'constructor', 'prototype']);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.getPrototypeOf(records(session)), Array.prototype);
  assert.equal(records(session)['__proto__'].text, 'proto text');

  const media = JSON.parse('{"__proto__":{"polluted":true},"url":"https://example.test/file"}');
  const mediaResult = reconcileSources(session, [
    source('media-file', 'file caption', { kind: 'file', media, order: [3] })
  ], { now: 20 });
  assert.deepEqual(mediaResult.issues, []);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(byId(session, 'media-file').media, '__proto__'), true);
  assert.equal(byId(session, 'media-file').media.url, 'https://example.test/file');
});

test('LEDGER-06 failed states and unknown types are still collected, without reading turn state', () => {
  const session = {
    status: 'failed',
    get turn() { throw new Error('turn state must not be read'); }
  };
  const result = reconcileSources(session, [
    source('failed-tool', '', {
      lane: 'process', kind: 'tool_call', status: 'failed', callId: 'call-failed',
      details: { output: 'visible failure' }, order: [0]
    }),
    source('unknown', 'unclassified page text', { lane: 'process', kind: 'future-widget', order: [1] }),
    source('page-error', 'page error in full', { role: 'page', kind: 'notice', format: 'text', order: [2] })
  ], { now: 10 });
  assert.deepEqual(result.issues, []);
  assert.equal(result.changes.length, 3);
  assert.equal(byId(session, 'failed-tool').status, 'failed');
  assert.equal(byId(session, 'failed-tool').text, '');
  assert.equal(byId(session, 'failed-tool').details.output, 'visible failure');
  assert.equal(byId(session, 'unknown').kind, 'notice');
  assert.equal(byId(session, 'unknown').lane, 'output');
  assert.equal(byId(session, 'unknown').sourceKind, 'future-widget');
  assert.equal(byId(session, 'unknown').text, 'unclassified page text');
  assert.equal(result.changes.find(change => change.item.id === 'unknown').item.sourceKind, 'future-widget');
  assert.equal(result.changes.find(change => change.item.id === 'unknown').item.text, 'unclassified page text');
  assert.equal(byId(session, 'page-error').text, 'page error in full');
  assert.equal(Object.hasOwn(byId(session, 'page-error'), 'sourceKind'), false);

  const withoutSourceKind = { ...byId(session, 'unknown') };
  delete withoutSourceKind.sourceKind;
  assert.notEqual(sourceRevision(byId(session, 'unknown')), sourceRevision(withoutSourceKind));

  const changed = reconcileSources(session, [
    source('unknown', 'unclassified page text', { kind: 'another-widget', order: [1] })
  ], { now: 20 });
  assert.deepEqual(changed.changes.map(change => [change.change, change.item.sourceKind]), [['rewrite', 'another-widget']]);
  assert.equal(changed.changes[0].item.text, 'unclassified page text');
  assert.equal(byId(session, 'unknown').sourceKind, 'another-widget');
  assert.equal(byId(session, 'unknown').text, 'unclassified page text');

  const resumed = { sources: JSON.parse(JSON.stringify(session.sources)) };
  const same = reconcileSources(resumed, [
    source('unknown', 'unclassified page text', { kind: 'another-widget', order: [1] })
  ], { now: 30 });
  assert.deepEqual(same.changes, []);
  assert.equal(same.unchanged, 1);
  assert.equal(byId(resumed, 'unknown').sourceKind, 'another-widget');
});

test('LEDGER-07 one malformed source does not block the valid sources after it', () => {
  const session = {};
  const badText = source('bad-text', 42);
  const badOrder = source('bad-order', 'bad order', { order: [0, 'x'] });
  const badRole = source('bad-role', 'bad role', { role: 'system' });
  const badKind = source('bad-kind', 'bad kind', { kind: 42 });
  const badDetails = source('bad-details', 'bad details', {
    kind: 'tool_call', details: { input: 'visible', private: 'must not be stored' }
  });
  const result = reconcileSources(session, [
    badText,
    source('good-a', 'good A', { order: [0] }),
    badOrder,
    badRole,
    source('good-b', 'good B', { order: [1] }),
    badKind,
    badDetails,
    source('good-c', 'good C', { order: [2] })
  ], { now: 10 });
  assert.deepEqual(result.changes.map(change => change.item.id), ['good-a', 'good-b', 'good-c']);
  assert.equal(result.unchanged, 0);
  assert.deepEqual(result.issues.map(item => item.code), [
    'SOURCE_TEXT_INVALID', 'SOURCE_ORDER_INVALID', 'SOURCE_ROLE_INVALID',
    'SOURCE_KIND_INVALID', 'SOURCE_DETAILS_INVALID'
  ]);
  assert.deepEqual(result.issues.map(item => item.id), [
    'bad-text', 'bad-order', 'bad-role', 'bad-kind', 'bad-details'
  ]);
  assert.deepEqual(records(session).map(record => record.id), ['good-a', 'good-b', 'good-c']);
});

test('LEDGER-08 same-id append and rewrite keep full text, revision and original text', () => {
  const session = {};
  const first = reconcileSources(session, [source('stream', 'A', { order: [0] })], { now: 10 });
  const firstRevision = first.changes[0].revision;
  assert.equal(byId(session, 'stream').originalText, 'A');

  const appended = reconcileSources(session, [source('stream', 'AB', { order: [0] })], { now: 20 });
  assert.deepEqual(appended.changes.map(change => change.change), ['append']);
  assert.notEqual(appended.changes[0].revision, firstRevision);
  assert.equal(appended.changes[0].item.text, 'AB');
  assert.equal(byId(session, 'stream').text, 'AB');
  assert.equal(byId(session, 'stream').originalText, 'A');
  assert.equal(byId(session, 'stream').previousText, 'A');

  const rewritten = reconcileSources(session, [source('stream', 'AC', { order: [0] })], { now: 30 });
  assert.deepEqual(rewritten.changes.map(change => change.change), ['rewrite']);
  assert.equal(rewritten.changes[0].item.text, 'AC');
  assert.equal(byId(session, 'stream').text, 'AC');
  assert.equal(byId(session, 'stream').originalText, 'A');
  assert.equal(byId(session, 'stream').previousText, 'AB');
  assert.equal(byId(session, 'stream').rewrites.at(-1).text, 'AB');
  assert.notEqual(`${byId(session, 'stream').text}`, 'ABAC');

  const same = reconcileSources(session, [source('stream', 'AC', { order: [0] })], { now: 40 });
  assert.deepEqual(same.changes, []);
  assert.equal(same.unchanged, 1);
});

test('LEDGER-09 identity, role and lane changes are conflicts that keep the first record', () => {
  const session = {};
  reconcileSources(session, [source('fixed', 'A', {
    nativeMessageId: 'native-1', userMessageId: 'user-1', order: [0]
  })], { now: 10 });

  const role = reconcileSources(session, [source('fixed', 'B', {
    role: 'page', nativeMessageId: 'native-1', userMessageId: 'user-1', order: [0]
  })], { now: 20 });
  assert.deepEqual(role.changes, []);
  assert.equal(role.issues.length, 1);
  assert.equal(role.issues[0].code, 'SOURCE_IDENTITY_CONFLICT');
  assert.deepEqual(role.issues[0].fields, ['role']);
  assert.equal(byId(session, 'fixed').text, 'A');
  assert.equal(byId(session, 'fixed').role, 'assistant');

  const lane = reconcileSources(session, [source('fixed', 'B', {
    lane: 'process', nativeMessageId: 'native-1', userMessageId: 'user-1', order: [0]
  })], { now: 30 });
  assert.equal(lane.issues[0].code, 'SOURCE_IDENTITY_CONFLICT');
  assert.deepEqual(lane.issues[0].fields, ['lane']);
  assert.equal(byId(session, 'fixed').lane, 'output');

  const native = reconcileSources(session, [source('fixed', 'B', {
    nativeMessageId: 'native-2', userMessageId: 'user-1', order: [0]
  })], { now: 40 });
  assert.equal(native.issues[0].code, 'SOURCE_IDENTITY_CONFLICT');
  assert.deepEqual(native.issues[0].fields, ['nativeMessageId']);
  assert.equal(byId(session, 'fixed').text, 'A');

  const append = reconcileSources(session, [source('fixed', 'AB', {
    nativeMessageId: 'native-1', userMessageId: 'user-1', order: [0]
  })], { now: 50 });
  assert.deepEqual(append.changes.map(change => change.change), ['append']);
  assert.equal(byId(session, 'fixed').text, 'AB');
});

test('LEDGER-10 metadata is complete, long text is not truncated, and unchanged writes nothing', () => {
  const session = {};
  const long = 'x'.repeat(300_000);
  const details = { input: 'visible input', output: 'visible output' };
  const media = { assetId: 'asset-1', width: 64, height: 64, tags: ['a', 'b'] };
  const first = reconcileSources(session, [source('rich', long, {
    kind: 'tool_call', lane: 'process', status: 'completed', callId: 'call-1',
    name: 'app · tool', details, media, order: [0, 1]
  })], { now: 123 });
  assert.deepEqual(first.issues, []);
  assert.equal(byId(session, 'rich').text.length, 300_000);
  assert.deepEqual(byId(session, 'rich').details, details);
  assert.deepEqual(byId(session, 'rich').media, media);
  assert.equal(byId(session, 'rich').firstSeenAt, 123);
  assert.equal(byId(session, 'rich').updatedAt, 123);

  // The projection returned in changes is a copy, not a handle on the ledger.
  first.changes[0].item.order.push(99);
  first.changes[0].item.details.output = 'mutated';
  first.changes[0].item.media.tags.push('mutated');
  assert.deepEqual(byId(session, 'rich').order, [0, 1]);
  assert.deepEqual(byId(session, 'rich').details, details);
  assert.deepEqual(byId(session, 'rich').media, media);

  const before = JSON.stringify(session.sources);
  const same = reconcileSources(session, [source('rich', long, {
    kind: 'tool_call', lane: 'process', status: 'completed', callId: 'call-1',
    name: 'app · tool', details, media, order: [0, 1]
  })], { now: 999 });
  assert.deepEqual(same.changes, []);
  assert.equal(same.unchanged, 1);
  assert.equal(JSON.stringify(session.sources), before);
  assert.equal(byId(session, 'rich').updatedAt, 123);

  // Optional properties explicitly set to undefined are omitted, not treated
  // as destructive updates that clear the stored metadata.
  const partial = {
    id: 'rich', text: long, role: 'assistant', lane: 'process', kind: 'tool_call',
    userMessageId: undefined, format: undefined, order: undefined,
    status: undefined, details: undefined, media: undefined, nativeMessageId: undefined
  };
  const omitted = reconcileSources(session, [partial], { now: 1000 });
  assert.deepEqual(omitted.changes, []);
  assert.equal(omitted.unchanged, 1);
  assert.deepEqual(byId(session, 'rich').details, details);
  assert.deepEqual(byId(session, 'rich').media, media);
  assert.equal(byId(session, 'rich').status, 'completed');
});

test('LEDGER-11 a reconnected session reuses the persisted ledger without duplicates', () => {
  const first = {};
  reconcileSources(first, [
    source('kept', 'kept text', { order: [0] }),
    source('final', 'formal answer', { order: [1] })
  ], { now: 10 });
  const persisted = JSON.parse(JSON.stringify(first.sources));
  const reconnected = { sources: persisted };
  const result = reconcileSources(reconnected, [
    source('kept', 'kept text', { order: [0] }),
    source('final', 'formal answer', { order: [1] }),
    source('new', 'new after reconnect', { order: [2] })
  ], { now: 20 });
  assert.equal(result.unchanged, 2);
  assert.deepEqual(result.changes.map(change => [change.item.id, change.change]), [['new', 'new']]);
  assert.deepEqual(records(reconnected).map(record => record.id), ['kept', 'final', 'new']);
  assert.equal(byId(reconnected, 'kept').text, 'kept text');
});

test('LEDGER-12 a moved user-message reference keeps the first reference but still applies the body', () => {
  // The extension derives userMessageId from the page's ambient "last seen user
  // message" cursor, so one and the same assistant message can report a
  // different reference between two reads. That must never discard the body.
  const session = {};
  const first = reconcileSources(session, [
    source('answer', 'Hel', { userMessageId: 'user-previous' })
  ], { now: 10 });
  assert.deepEqual(first.changes.map(change => change.item.text), ['Hel']);

  const second = reconcileSources(session, [
    source('answer', 'Hello world', { userMessageId: 'user-current' })
  ], { now: 20 });
  assert.deepEqual(second.changes.map(change => [change.item.text, change.change]), [['Hello world', 'append']]);
  assert.equal(second.issues.length, 1);
  assert.equal(second.issues[0].code, 'SOURCE_USER_MESSAGE_REVISED');
  assert.deepEqual(second.issues[0].fields, ['userMessageId']);
  // The first reference is kept, so the turn attribution does not move.
  assert.equal(byId(session, 'answer').userMessageId, 'user-previous');
  assert.equal(byId(session, 'answer').text, 'Hello world');

  const third = reconcileSources(session, [
    source('answer', 'Hello world!', { userMessageId: 'user-current' })
  ], { now: 30 });
  assert.deepEqual(third.changes.map(change => change.item.text), ['Hello world!']);
  assert.equal(byId(session, 'answer').text, 'Hello world!');
});

test('LEDGER-13 a DOM path shift is a position change, not a content rewrite', () => {
  // `order` is a DOM path. A page that inserts one sibling shifts every path.
  // That must not re-project, re-deliver or re-order the conversation.
  const session = {};
  reconcileSources(session, [source('answer', 'Hello', { order: [0] })], { now: 10 });
  const shifted = reconcileSources(session, [source('answer', 'Hello', { order: [1] })], { now: 20 });
  assert.deepEqual(shifted.changes, []);
  assert.equal(shifted.unchanged, 1);
  assert.deepEqual(shifted.issues, []);
  // The stored position is still refreshed so later ordering stays correct.
  assert.deepEqual(byId(session, 'answer').order, [1]);

  const grown = reconcileSources(session, [source('answer', 'Hello world', { order: [2] })], { now: 30 });
  assert.deepEqual(grown.changes.map(change => change.change), ['append']);
  assert.deepEqual(byId(session, 'answer').order, [2]);
  assert.equal(byId(session, 'answer').text, 'Hello world');
});

test('LEDGER-14 a moved preceding-user reference is a pointer, not a content revision', () => {
  // The reference is derived from the page's ambient cursor, so it moves
  // without the content moving. It must not re-project or re-deliver the
  // source, and the first reference must be kept.
  const session = {};
  reconcileSources(session, [
    source('answer', 'Hello', { userMessageId: 'user-previous', order: [0] })
  ], { now: 10 });

  const moved = reconcileSources(session, [
    source('answer', 'Hello', { userMessageId: 'user-current', order: [0] })
  ], { now: 20 });
  assert.deepEqual(moved.changes, []);
  assert.equal(moved.issues.length, 1);
  assert.equal(moved.issues[0].code, 'SOURCE_USER_MESSAGE_REVISED');
  assert.equal(byId(session, 'answer').text, 'Hello');
  assert.equal(byId(session, 'answer').userMessageId, 'user-previous');
  assert.equal(byId(session, 'answer').rewrites, undefined);
});

test('LEDGER-15 a reference that was unknown and is now known is adopted, not kept', () => {
  // The extension reads the assistant message before the user message becomes
  // recognisable, so the first reference it reports is absent. An absent
  // reference means UNKNOWN, not a chosen value: the known one is adopted and
  // the source is projected again so the delivered card carries the real
  // attribution.
  const session = {};
  reconcileSources(session, [
    source('answer', 'Hello', { userMessageId: null, order: [0] })
  ], { now: 10 });
  assert.equal(byId(session, 'answer').userMessageId, null);

  const resolved = reconcileSources(session, [
    source('answer', 'Hello', { userMessageId: 'user-current', order: [0] })
  ], { now: 20 });
  assert.equal(resolved.issues.length, 1);
  assert.equal(resolved.issues[0].code, 'SOURCE_USER_MESSAGE_RESOLVED');
  assert.equal(byId(session, 'answer').userMessageId, 'user-current');
  // The revision covers the reference, so the attribution reaches the delivery.
  assert.equal(resolved.changes.length, 1);
  assert.equal(resolved.changes[0].item.userMessageId, 'user-current');
});
