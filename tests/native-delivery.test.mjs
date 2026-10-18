import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeDelivery, normalizeProjectedView } from '../server/native-delivery.mjs';

// Unit-only transport fixture. It models snapshots/drops for coordinator policy;
// original PluginAgentSession/AgentManager/coalescer gates run separately in
// continuous-delivery-host.mjs. This fixture is NOT evidence of host support.
const scope = { sessionId: 'session', bindingGeneration: 'generation-one', hostEpoch: 'epoch-one' };
const item = text => ({ type: 'assistant_message', id: 'source-one', messageId: 'native-one', text });
function fixture(initialState = null) {
  const f = { events: [], saves: [], rows: [], nextSeq: 1, ready: true, dropBody: false, dropMarker: false,
    persistFailure: false, beforeEmit: null, afterSave: null, readOverride: null, providerCache: new Map() };
  f.accept = event => {
    const input = event.item;
    if (input.type === 'assistant_message') {
      const previous = f.providerCache.get(input.id) ?? '';
      f.providerCache.set(input.id, input.text);
      const text = input.text.startsWith(previous) ? input.text.slice(previous.length) : input.text;
      if (f.dropBody || !text) return;
      const seq = f.nextSeq++;
      f.rows.push({ seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
        item: { type: 'assistant_message', messageId: input.messageId, text } });
    } else {
      if (f.dropMarker) return;
      const seq = f.nextSeq++, old = f.rows.find(row => row.item.type === 'plugin' && row.item.id === input.id);
      if (old) { old.item = structuredClone(input); old.seqEnd = seq; old.sourceSeqRanges.push({ startSeq: seq, endSeq: seq }); }
      else f.rows.push({ seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], item: structuredClone(input) });
    }
  };
  f.view = () => ({ ...scope, coverage: { complete: true, startSeq: f.rows.length ? 1 : null,
    endSeq: f.nextSeq > 1 ? f.nextSeq - 1 : null, nextSeq: f.nextSeq }, rows: structuredClone(f.rows) });
  f.bodyEvents = () => f.events.filter(event => event.item.type === 'assistant_message');
  f.markers = () => f.events.filter(event => event.item.type === 'plugin');
  f.text = () => f.rows.filter(row => row.item.type === 'assistant_message').map(row => row.item.text).join('');
  f.options = {
    ...scope, initialState, isReady: () => f.ready, readHost: () => f.readOverride ? f.readOverride() : f.view(),
    persist: async value => {
      if (f.persistFailure) throw Error('DISK_FAILURE');
      f.saves.push(structuredClone(value)); await f.afterSave?.(value);
    },
    emit: async event => {
      const persisted = f.saves.at(-1);
      assert(persisted, 'persist precedes every emit');
      if (event.item.type === 'assistant_message') {
        assert(persisted.attempts.some(attempt => attempt.transportId === event.item.id && attempt.status === 'prepared'));
        assert(persisted.deliveries[0].anchorConfirmed, 'host anchor first');
      } else {
        assert(persisted.checkpoints.some(record => record.item.data.probeId === event.item.data.probeId));
        if (event.item.data.phase === 'after-body') assert(persisted.attempts.some(attempt =>
          attempt.id === event.item.data.attemptId && attempt.status === 'sent' && attempt.batch === event.item.data.batch));
      }
      await f.beforeEmit?.(event);
      f.events.push(structuredClone(event)); f.accept(event);
    }
  };
  f.delivery = createNativeDelivery(f.options);
  f.anchor = async () => { await f.delivery.submit(item('')); await f.delivery.sync(); await f.delivery.sync(); };
  return f;
}

test('checkpoint is confirmed before native streaming; source, attempts and observed coverage stay separate', async () => {
  const f = fixture(); await f.delivery.submit(item('A'));
  assert.equal(f.events.length, 0, 'submit persists source, not a fictitious sent batch');
  await f.delivery.sync(); assert.equal(f.bodyEvents().length, 0);
  await f.delivery.sync(); assert.equal(f.text(), 'A');
  assert.equal(f.bodyEvents()[0].item.messageId, 'native-one');
  assert.equal(f.markers().at(-1).item.data.batch, 1);
  assert.equal(f.delivery.snapshot().durable.attempts[0].status, 'sent', 'emit is not host ACK');
  await f.delivery.sync(); assert.equal(f.delivery.snapshot().durable.attempts[0].status, 'confirmed');
  await f.delivery.submit(item('AB')); await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.text(), 'AB');
  assert.equal(f.bodyEvents()[0].item.id, f.bodyEvents()[1].item.id, 'normal streaming keeps segment');
  assert.equal(new Set(f.markers().map(e => e.item.id)).size, 1, 'one fixed checkpoint row');
});

test('one unconfirmed batch; growth stays in source; same snapshot retries only marker then repairs once', async () => {
  const f = fixture(); await f.anchor(); f.dropBody = f.dropMarker = true;
  await f.delivery.submit(item('A')); await f.delivery.sync();
  await f.delivery.submit(item('AB')); await f.delivery.submit(item('ABC'));
  const before = f.markers().length;
  await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.bodyEvents().length, 1);
  assert.equal(f.markers().length, before + 2, 'unchanged snapshots must not deduplicate marker retries');
  assert.equal(f.delivery.snapshot().durable.sources[0].text, 'ABC');
  assert.equal(f.delivery.snapshot().durable.attempts.length, 1);
  assert.equal(f.delivery.snapshot().durable.attempts[0].target, 'A');
  assert.equal(f.delivery.snapshot().durable.observedBodies[0].text, '', 'actual host coverage is neither latest source nor sent attempt');
  assert(f.markers().slice(-2).every(event => event.item.data.batch === 1 && event.item.data.through === 1), 'queued ABC is not a sent watermark');
  f.dropBody = f.dropMarker = false;
  await f.delivery.sync(); assert.equal(f.bodyEvents().length, 1, 'retry marker first, no blind body replay');
  await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.text(), 'ABC'); assert.equal(f.bodyEvents().length, 2);
  assert.notEqual(f.bodyEvents()[0].item.id, f.bodyEvents()[1].item.id);
  assert.equal(f.delivery.snapshot().durable.attempts[0].status, 'retired');
  await f.delivery.submit(item('ABCD')); await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.text(), 'ABCD');
  assert.equal(f.bodyEvents().at(-1).item.id, f.bodyEvents()[1].item.id, 'old segment never reactivated');
});

test('new binding adopts observed native prefix but sends only new suffix under its fresh transport', async () => {
  const f = fixture();
  f.accept({ item: { type: 'assistant_message', id: 'prior-binding-transport', messageId: 'native-one', text: 'AB' } });
  await f.delivery.submit(item('ABC')); await f.delivery.sync(); await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.text(), 'ABC'); assert.equal(f.bodyEvents().length, 1);
  assert.equal(f.bodyEvents()[0].item.text, 'C');
});

test('new session generation reuses the fixed source checkpoint but rejects old marker scope', async () => {
  const f = fixture(); await f.anchor(); await f.delivery.submit(item('A')); await f.delivery.sync(); await f.delivery.sync();
  const newScope = { ...scope, sessionId: 'new-session', bindingGeneration: 'generation-two' };
  const next = createNativeDelivery({ ...f.options, ...newScope, initialState: null,
    readHost: () => ({ ...f.view(), ...newScope }) });
  await next.submit(item('AB')); await next.sync();
  assert.equal(f.bodyEvents().length, 1, 'old generation checkpoint must not release new body');
  await next.sync(); await next.sync();
  assert.equal(f.text(), 'AB'); assert.equal(f.bodyEvents().at(-1).item.text, 'B');
  assert.equal(new Set(f.markers().map(event => event.item.id)).size, 1);
  assert.throws(() => createNativeDelivery({ ...f.options, ...newScope, initialState: f.delivery.snapshot().durable }),
    { code: 'DELIVERY_RESTORE_SCOPE_MISMATCH' });
});

test('body success with marker loss confirms actual coverage without resending text', async () => {
  const f = fixture(); await f.anchor(); f.dropMarker = true;
  await f.delivery.submit(item('body survives')); await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.bodyEvents().length, 1); assert.equal(f.text(), 'body survives');
  assert.equal(f.delivery.snapshot().durable.deliveries[0].pending, null);
});

test('proved missing suffix preserves native messageId and repairs only that suffix', async () => {
  const f = fixture(); await f.anchor();
  await f.delivery.submit(item('prefix')); await f.delivery.sync(); await f.delivery.sync();
  f.dropBody = true;
  await f.delivery.submit(item('prefix suffix')); await f.delivery.sync();
  f.dropBody = false;
  await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.bodyEvents().at(-1).item.text, ' suffix');
  assert(f.bodyEvents().every(event => event.item.messageId === 'native-one'));
  assert.equal(f.text(), 'prefix suffix');
});

test('local held stream sends neither body nor watermark and standby never waits for ACK', async () => {
  const f = fixture(); f.ready = false;
  await f.delivery.submit(item('while idle')); await f.delivery.sync();
  assert.equal(f.events.length, 0);
  assert.equal(f.delivery.setPageState('standby').pageState, 'standby');
  f.ready = true;
  await f.delivery.sync(); await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.text(), 'while idle'); assert.equal(f.delivery.snapshot().pageState, 'standby');
});

test('readiness revoked after body forwarding prevents marker from overtaking a local held stream', async () => {
  const f = fixture(); await f.anchor();
  f.beforeEmit = event => { if (event.item.type === 'assistant_message') f.ready = false; };
  await f.delivery.submit(item('A')); await f.delivery.sync();
  assert.equal(f.markers().filter(e => e.item.data.phase === 'after-body').length, 0);
  f.ready = true; await f.delivery.sync();
  assert.equal(f.bodyEvents().length, 1); assert.equal(f.text(), 'A');
});

test('retirement is durable even when readiness is revoked before gap repair', async () => {
  const f = fixture(); await f.anchor(); f.dropBody = true;
  await f.delivery.submit(item('A')); await f.delivery.sync();
  f.dropBody = false;
  f.afterSave = value => { if (value.attempts[0]?.status === 'retired') f.ready = false; };
  await f.delivery.sync(); assert.equal(f.bodyEvents().length, 1);
  f.afterSave = null; f.ready = true; await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.text(), 'A'); assert.notEqual(f.bodyEvents()[0].item.id, f.bodyEvents()[1].item.id);
});

test('old binding/epoch/watermark snapshots cannot confirm or authorize retries', async () => {
  const f = fixture(); await f.anchor();
  const old = f.view();
  await f.delivery.submit(item('A')); await f.delivery.sync(); await f.delivery.sync();
  const before = f.events.length;
  for (const [field, code] of [['bindingGeneration', 'HOST_BINDING_MISMATCH'], ['hostEpoch', 'HOST_EPOCH_MISMATCH'], ['sessionId', 'HOST_BINDING_MISMATCH']]) {
    const result = await f.delivery.observeHost({ ...f.view(), [field]: 'old' });
    assert(result.issues.some(issue => issue.code === code));
  }
  assert((await f.delivery.observeHost(old)).issues.some(issue => issue.code === 'HOST_VIEW_STALE'));
  assert.equal(f.events.length, before);
});

test('old marker data inside a current binding snapshot is rejected', async () => {
  const f = fixture(); await f.anchor(); f.dropBody = true;
  await f.delivery.submit(item('A')); await f.delivery.sync();
  const view = f.view(), marker = view.rows.find(row => row.item.type === 'plugin');
  marker.item.data.bindingGeneration = 'old-generation';
  await f.delivery.observeHost(view);
  assert.equal(f.bodyEvents().length, 1, 'old marker is not loss proof');
});

test('cold nextSeq without body coverage never means empty history', async () => {
  const f = fixture(); f.nextSeq = 100;
  await f.delivery.submit(item('not safe to replay')); await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.bodyEvents().length, 0);
  assert(f.delivery.snapshot().issues.some(issue => issue.code === 'HOST_COVERAGE_INCOMPLETE'));
});

test('missing coverage blocks correction even when current marker was observed', async () => {
  const f = fixture(); await f.anchor(); f.dropBody = true;
  await f.delivery.submit(item('A')); await f.delivery.sync();
  const view = f.view(); view.coverage.complete = false;
  const result = await f.delivery.observeHost(view);
  assert.equal(f.bodyEvents().length, 1);
  assert(result.issues.some(issue => issue.code === 'HOST_COVERAGE_INCOMPLETE'));
});

test('full merged refetches replace subsets by sourceSeqRanges, never append snapshots twice', () => {
  const row = (text, end) => ({ seqStart: 1, seqEnd: end, sourceSeqRanges: [{ startSeq: 1, endSeq: end }], item: { type: 'assistant_message', messageId: 'native-one', text } });
  const view = { ...scope, coverage: { complete: true, startSeq: 1, endSeq: 2, nextSeq: 3 }, rows: [row('A', 1), row('AB', 2), row('AB', 2)] };
  const normalized = normalizeProjectedView(view);
  assert.equal(normalized.rows.length, 1); assert.equal(normalized.rows[0].item.text, 'AB');
  assert(normalized.fullCoverage);
  assert.throws(() => normalizeProjectedView({ ...view, rows: [row('A', 1), row('X', 1)] }), { code: 'HOST_PROJECTION_CONFLICT' });
});

test('persist failure cannot emit an unrecorded body on the next pass', async () => {
  const f = fixture(); await f.anchor(); await f.delivery.submit(item('A'));
  let failed = false;
  f.afterSave = value => { if (!failed && value.attempts.length === 0 && value.hostObservation.nextSeq > 1) { failed = true; f.persistFailure = true; } };
  f.persistFailure = true;
  await assert.rejects(f.delivery.sync(), /DISK_FAILURE/);
  assert.equal(f.bodyEvents().length, 0);
  f.afterSave = null; f.persistFailure = false;
  await f.delivery.sync(); await f.delivery.sync();
  assert.equal(f.text(), 'A'); assert.equal(f.bodyEvents().length, 1);
});

test('restored prepared body has unknown dispatch evidence; no blind reemit or false sent watermark', async () => {
  const f = fixture(); await f.anchor(); await f.delivery.submit(item('A'));
  f.afterSave = value => { if (value.attempts.at(-1)?.status === 'prepared') f.ready = false; };
  await f.delivery.sync(); assert.equal(f.bodyEvents().length, 0);
  const restored = createNativeDelivery({ ...f.options, initialState: f.saves.at(-1) });
  f.ready = true; f.afterSave = null;
  const result = await restored.observeHost(f.view());
  assert(result.issues.some(issue => issue.code === 'BODY_EMIT_UNCONFIRMED'));
  assert.equal(f.bodyEvents().length, 0);
  assert.equal(f.markers().filter(event => event.item.data.phase === 'after-body').length, 0);
});

test('positive coverage of a restored prepared target does not prove its transport cache was primed', async () => {
  const f = fixture(); await f.anchor(); await f.delivery.submit(item('A'));
  f.afterSave = value => { if (value.attempts.at(-1)?.status === 'prepared') f.ready = false; };
  await f.delivery.sync();
  const restored = createNativeDelivery({ ...f.options, initialState: f.saves.at(-1) });
  f.afterSave = null; f.ready = true;
  f.accept({ item: { type: 'assistant_message', id: 'earlier-binding', messageId: 'native-one', text: 'A' } });
  await restored.observeHost(f.view());
  await restored.submit(item('AB')); await restored.sync(); await restored.sync();
  assert.equal(f.text(), 'AB'); assert.equal(f.bodyEvents()[0].item.text, 'B');
});

test('non-prefix revisions are surfaced, not concatenated as successful native replacements', async () => {
  const f = fixture(); await f.anchor(); await f.delivery.submit(item('old')); await f.delivery.sync(); await f.delivery.sync();
  await f.delivery.submit(item('new')); const result = await f.delivery.sync();
  assert(result.issues.some(issue => issue.code === 'HOST_BODY_DIVERGED'));
  assert.equal(f.text(), 'old'); assert.equal(result.durable.sources[0].text, 'new');
  await assert.rejects(f.delivery.submit({ ...item('new'), type: 'reasoning' }), { code: 'NATIVE_DELIVERY_TYPE_UNSUPPORTED' });
  await assert.rejects(f.delivery.submit({ ...item('new'), messageId: 'changed' }), { code: 'NATIVE_MESSAGE_ID_CHANGED' });
});

test('uncertain/deferred emit is not a forwarded batch; checkpoint cannot overtake it', async () => {
  const f = fixture(); await f.anchor();
  const delivery = createNativeDelivery({ ...f.options, initialState: f.saves.at(-1), emit: async () => ({ held: true }) });
  await delivery.submit(item('A')); await delivery.sync(); const result = await delivery.sync();
  assert(result.issues.some(issue => issue.code === 'BODY_EMIT_UNCONFIRMED'));
  assert.equal(result.durable.checkpoints.filter(record => record.item.data.phase === 'after-body').length, 0);
});

test('close suppresses subsequent emissions and rejects further work', async () => {
  const f = fixture(); await f.delivery.submit(item('A')); await f.delivery.close();
  await assert.rejects(f.delivery.sync(), { code: 'DELIVERY_CLOSED' }); assert.equal(f.events.length, 0);
});
