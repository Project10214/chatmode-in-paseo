/** Native assistant-message delivery checkpoints (MVP: append-only text only).
 *
 * No SDK/Provider/Broker coupling and no host ACK inferred from emit(). Caller
 * supplies an actually ordered Provider emit, a durable persist(snapshot), and
 * isReady() false for any locally held/deferred stream. Emit must resolve only
 * after forwarding, never after merely queuing. It must NOT deduplicate markers.
 *
 * readHost()/observeHost() accept a PUBLIC PROJECTED VIEW, not canonical events:
 * { sessionId, bindingGeneration, hostEpoch,
 *   coverage:{complete:boolean,startSeq:number|null,endSeq:number|null,nextSeq:number},
 *   rows:[{seqStart,seqEnd,sourceSeqRanges:[{startSeq,endSeq}],item}] }
 * Each row.item is a FULL merged item. The adapter must establish coverage from
 * the public fetch result, not just nextSeq. This conservative MVP needs full
 * retained coverage from seq 1 to the current watermark for absence decisions.
 * An empty cold window with durable nextSeq>1 is NOT empty history.
 *
 * submit() persists only the latest source. sync()/observeHost() perform one
 * reconciliation pass; no polling or waiting for a message to finish. Caller
 * owns cadence. setPageState() is synchronous informational state and NEVER
 * waits for delivery, gates delivery, emits lifecycle or answers permissions.
 *
 * snapshot() separates sources, attempts, observedBodies, checkpoints and delivery state.
 * Persist is called BEFORE every emit. A restored prepared body has ambiguous
 * dispatch evidence: only positive host coverage can settle it; no blind retry.
 * A changed host epoch/generation needs a new explicitly reconciled binding;
 * old snapshots/markers are rejected, never silently adopted. bindingGeneration
 * must rotate when the Provider session/cache is recreated. Source IDs must be
 * stable within the host agent; checkpoint IDs do not depend on binding/run IDs.
 */
import { createHash, randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const string = value => typeof value === 'string' && value.length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a, b) => canonical(a) === canonical(b);
function ranges(row) {
  if (!Array.isArray(row?.sourceSeqRanges) || !row.sourceSeqRanges.length) fail('HOST_RANGES_UNAVAILABLE');
  const sorted = row.sourceSeqRanges.map(range => {
    if (!integer(range?.startSeq) || range.startSeq < 1 || !integer(range.endSeq) || range.endSeq < range.startSeq)
      fail('HOST_RANGES_INVALID');
    return { startSeq: range.startSeq, endSeq: range.endSeq };
  }).sort((a, b) => a.startSeq - b.startSeq);
  const out = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range.startSeq <= last.endSeq + 1) last.endSeq = Math.max(last.endSeq, range.endSeq);
    else out.push(range);
  }
  if (row.seqStart !== out[0].startSeq || row.seqEnd !== out.at(-1).endSeq) fail('HOST_RANGES_INVALID');
  return out;
}
const contains = (a, b) => b.every(range => a.some(outer => outer.startSeq <= range.startSeq && outer.endSeq >= range.endSeq));
const overlaps = (a, b) => a.some(x => b.some(y => x.startSeq <= y.endSeq && y.startSeq <= x.endSeq));
const identity = item => item?.type === 'assistant_message' ? `assistant:${item.messageId}` :
  item?.type === 'plugin' ? `plugin:${item.pluginId}:${item.id}` : null;

/** Deduplicate refetched FULL projected items by their actual source ranges.
 * Overlapping partial projections cannot be safely concatenated and are refused.
 */
export function normalizeProjectedView(view) {
  if (!view || !Array.isArray(view.rows) || !string(view.hostEpoch) || !string(view.sessionId) ||
      !string(view.bindingGeneration)) fail('HOST_VIEW_INVALID');
  const c = view.coverage;
  if (!c || typeof c.complete !== 'boolean' || !integer(c.nextSeq) || c.nextSeq < 1 ||
      !(c.startSeq === null || integer(c.startSeq)) || !(c.endSeq === null || integer(c.endSeq))) fail('HOST_COVERAGE_INVALID');
  const rows = [];
  for (const input of view.rows) {
    const row = { ...clone(input), sourceSeqRanges: ranges(input) };
    if (!row.item || row.seqEnd >= c.nextSeq) fail('HOST_VIEW_INVALID');
    let redundant = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const old = rows[i];
      if (!overlaps(old.sourceSeqRanges, row.sourceSeqRanges)) continue;
      if (!identity(row.item) || identity(row.item) !== identity(old.item)) fail('HOST_PROJECTION_OVERLAP');
      const newerContains = contains(row.sourceSeqRanges, old.sourceSeqRanges);
      const olderContains = contains(old.sourceSeqRanges, row.sourceSeqRanges);
      if (newerContains && olderContains) {
        if (!equal(row.item, old.item)) fail('HOST_PROJECTION_CONFLICT');
        redundant = true; break;
      }
      if (!newerContains && !olderContains) fail('HOST_PROJECTION_OVERLAP');
      const larger = newerContains ? row : old, smaller = newerContains ? old : row;
      if (larger.item.type === 'assistant_message' &&
          (typeof larger.item.text !== 'string' || !larger.item.text.startsWith(smaller.item.text))) fail('HOST_PROJECTION_CONFLICT');
      if (newerContains) rows.splice(i, 1);
      else { redundant = true; break; }
    }
    if (!redundant) rows.push(row);
  }
  rows.sort((a, b) => a.seqStart - b.seqStart);
  const all = rows.flatMap(row => row.sourceSeqRanges).sort((a, b) => a.startSeq - b.startSeq);
  let through = 0;
  for (const range of all) {
    if (range.startSeq > through + 1) break;
    through = Math.max(through, range.endSeq);
  }
  const complete = c.complete && (c.nextSeq === 1 ? rows.length === 0 && c.endSeq === null :
    c.startSeq === 1 && c.endSeq === c.nextSeq - 1 && through === c.endSeq);
  return { ...clone(view), rows, fullCoverage: complete };
}

export function createNativeDelivery({ sessionId, bindingGeneration, hostEpoch, emit, persist, readHost,
  isReady, initialState = null, pluginId = 'chatmode-in-paseo' }) {
  if (![sessionId, bindingGeneration, hostEpoch, pluginId].every(string) ||
      ![emit, persist, readHost, isReady].every(fn => typeof fn === 'function')) fail('DELIVERY_CONFIG_INVALID');
  const scope = { sessionId, bindingGeneration, hostEpoch };
  let state = initialState ? clone(initialState) : { version: 1, scope, sources: [], deliveries: [], attempts: [], checkpoints: [] };
  if (state.version !== 1 || !equal(state.scope, scope) ||
      !['sources', 'deliveries', 'attempts', 'checkpoints'].every(key => Array.isArray(state[key]))) fail('DELIVERY_RESTORE_SCOPE_MISMATCH');
  if (state.attempts.some(attempt => ['sessionId', 'bindingGeneration', 'hostEpoch'].some(key => attempt[key] !== scope[key])))
    fail('DELIVERY_RESTORE_SCOPE_MISMATCH');
  state.hostObservation ??= { nextSeq: 1, fullDigest: null };
  state.observedBodies ??= [];
  if (!Array.isArray(state.observedBodies)) fail('DELIVERY_RESTORE_INVALID');
  const restoredPrepared = new Set(state.attempts.filter(a => a.status === 'prepared').map(a => a.id));
  let closed = false, tail = Promise.resolve(), pageState = null, issues = [], persistenceBlocked = false;
  const note = (code, sourceId = null) => {
    if (!issues.some(issue => issue.code === code && issue.sourceId === sourceId)) issues.push({ code, sourceId });
  };
  const snapshot = () => ({ durable: clone(state), pageState, issues: clone(issues), closed });
  const save = async () => {
    try { await persist(clone(state)); persistenceBlocked = false; }
    catch (error) { persistenceBlocked = true; throw error; }
  };
  const ready = source => !closed && isReady(source) === true;
  const queued = work => {
    const result = tail.then(async () => {
      if (closed) fail('DELIVERY_CLOSED');
      if (persistenceBlocked) await save();
      return work();
    });
    tail = result.catch(() => {}); return result;
  };
  const attemptFor = delivery => state.attempts.find(attempt => attempt.id === delivery.pending);
  function checkpointItem(source, delivery, attempt, id) {
    return { type: 'plugin', pluginId, id: delivery.checkpointId, kind: 'source-checkpoint', version: 1,
      data: { ...scope, sourceId: source.id, phase: attempt ? 'after-body' : 'anchor',
        batch: attempt?.batch ?? 0, through: attempt?.to ?? 0, attemptId: attempt?.id ?? null, probeId: id } };
  }
  async function sendCheckpoint(source, delivery, attempt, view) {
    if (!ready(source) || (attempt && attempt.status !== 'sent')) return;
    const record = { id: randomUUID(), sourceId: source.id, status: 'prepared', afterSeq: view.coverage.nextSeq - 1 };
    record.item = checkpointItem(source, delivery, attempt, record.id);
    state.checkpoints.push(record); await save();
    if (!ready(source)) return;
    try {
      const result = await emit({ type: 'timeline.item', sessionId, item: clone(record.item) });
      record.status = result === false || result?.held || result?.deferred ? 'uncertain' : 'sent';
    } catch { record.status = 'uncertain'; }
    await save();
    if (record.status !== 'sent') note('CHECKPOINT_EMIT_UNCONFIRMED', source.id);
  }
  function observedCheckpoint(source, delivery, view, attempt = null) {
    const rows = view.rows.filter(row => row.item.type === 'plugin' && row.item.pluginId === pluginId &&
      row.item.id === delivery.checkpointId && row.item.kind === 'source-checkpoint' && row.item.version === 1);
    for (const row of rows) {
      const data = row.item.data;
      if (!data || data.sessionId !== sessionId || data.bindingGeneration !== bindingGeneration || data.hostEpoch !== hostEpoch) continue;
      const record = state.checkpoints.find(checkpoint => checkpoint.id === data.probeId && checkpoint.sourceId === source.id);
      if (!record || !equal(record.item.data, data) || row.seqEnd <= record.afterSeq) continue;
      if (attempt ? data.phase === 'after-body' && data.attemptId === attempt.id && data.batch === attempt.batch : data.phase === 'anchor') return row;
    }
    return null;
  }
  function hostText(source, view) {
    const rows = view.rows.filter(row => row.item.type === 'assistant_message' && row.item.messageId === source.messageId);
    if (rows.some(row => typeof row.item.text !== 'string' || row.item.text.includes('\0') ||
        (row.item.text.isWellFormed && !row.item.text.isWellFormed()))) fail('HOST_BODY_INVALID');
    // Each row is already a full projection. No cross-snapshot text accumulator.
    return rows.map(row => row.item.text).join('');
  }
  async function sendBody(source, delivery, view) {
    if (!ready(source)) return;
    let attempt = attemptFor(delivery);
    if (attempt?.status === 'prepared' && !restoredPrepared.has(attempt.id) && !source.text.startsWith(attempt.target)) {
      // In THIS live coordinator a still-prepared attempt has never reached
      // emit. Retire the stale intent before preparing the current source.
      // Restored prepared / uncertain / sent attempts never use this shortcut.
      attempt.status = 'retired'; attempt.reason = 'source-changed-before-send';
      delivery.pending = null; await save(); attempt = null;
    }
    if (!attempt) {
      const target = source.text;
      attempt = { ...scope, id: randomUUID(), sourceId: source.id, messageId: source.messageId,
        batch: ++delivery.nextBatch, segment: delivery.segment,
        transportId: `native:${hash(sessionId + '\0' + source.id)}:${hash(bindingGeneration)}:${delivery.segment}`,
        from: delivery.confirmedText.length, to: target.length, target,
        text: target.slice(delivery.segmentBase), status: 'prepared' };
      state.attempts.push(attempt); delivery.pending = attempt.id;
      await save(); // Durable intent BEFORE the first possible body dispatch.
    }
    if (!ready(source)) return;
    if (attempt.status !== 'prepared' || restoredPrepared.has(attempt.id)) return;
    if (!source.text.startsWith(attempt.target)) { note('SOURCE_NON_PREFIX_REVISION', source.id); return; }
    try {
      const result = await emit({ type: 'timeline.item', sessionId, item: {
        type: 'assistant_message', id: attempt.transportId, messageId: source.messageId, text: attempt.text
      } });
      attempt.status = result === false || result?.held || result?.deferred ? 'uncertain' : 'sent';
    } catch { attempt.status = 'uncertain'; }
    await save(); // The checkpoint can name only a durably recorded forwarded batch.
    if (attempt.status === 'sent') await sendCheckpoint(source, delivery, attempt, view);
    else note('BODY_EMIT_UNCONFIRMED', source.id);
  }
  async function reconcile(input) {
    issues = [];
    let view;
    try {
      view = normalizeProjectedView(input);
      if (view.sessionId !== sessionId || view.bindingGeneration !== bindingGeneration) fail('HOST_BINDING_MISMATCH');
      if (view.hostEpoch !== hostEpoch) fail('HOST_EPOCH_MISMATCH');
      if (view.coverage.nextSeq < state.hostObservation.nextSeq) fail('HOST_VIEW_STALE');
      const digest = view.fullCoverage ? hash(canonical(view.rows.map(row => ({
        item: row.item, ranges: row.sourceSeqRanges
      })))) : null;
      if (view.coverage.nextSeq === state.hostObservation.nextSeq && digest &&
          state.hostObservation.fullDigest && digest !== state.hostObservation.fullDigest) fail('HOST_VIEW_CONFLICT');
      const next = { nextSeq: view.coverage.nextSeq,
        fullDigest: digest ?? (view.coverage.nextSeq === state.hostObservation.nextSeq ? state.hostObservation.fullDigest : null) };
      if (!equal(next, state.hostObservation)) { state.hostObservation = next; await save(); }
    } catch (error) {
      if (persistenceBlocked) throw error;
      note(error.code ?? 'HOST_VIEW_INVALID'); return snapshot();
    }
    for (const source of state.sources) {
      if (closed) break;
      const delivery = state.deliveries.find(row => row.sourceId === source.id);
      if (!delivery.anchorConfirmed) {
        const anchor = observedCheckpoint(source, delivery, view);
        if (!anchor) { await sendCheckpoint(source, delivery, null, view); continue; }
        delivery.anchorConfirmed = true; delivery.anchorSeq = anchor.seqEnd; await save();
      }
      if (!view.fullCoverage) {
        note('HOST_COVERAGE_INCOMPLETE', source.id);
        const attempt = attemptFor(delivery);
        if (attempt?.status === 'sent') await sendCheckpoint(source, delivery, attempt, view);
        continue;
      }
      let actual;
      try { actual = hostText(source, view); } catch (error) { note(error.code, source.id); continue; }
      const observed = { ...scope, sourceId: source.id, messageId: source.messageId, text: actual,
        nextSeq: view.coverage.nextSeq, complete: true };
      const observedIndex = state.observedBodies.findIndex(row => row.sourceId === source.id);
      if (!equal(state.observedBodies[observedIndex], observed)) {
        if (observedIndex < 0) state.observedBodies.push(observed); else state.observedBodies[observedIndex] = observed;
        await save();
      }
      if (!source.text.startsWith(actual)) { note('HOST_BODY_DIVERGED', source.id); continue; }
      const attempt = attemptFor(delivery);
      if (attempt) {
        if (actual.startsWith(attempt.target)) {
          const cacheUnproven = attempt.status !== 'sent';
          attempt.status = 'confirmed'; delivery.pending = null; delivery.confirmedText = actual;
          // Positive coverage settles content, not an ambiguous emitter cache.
          // Future growth must not resend that prefix under an unprimed ID.
          if (cacheUnproven) {
            delivery.retiredSegments.push(delivery.segment);
            delivery.segment++; delivery.segmentBase = actual.length;
          }
          await save();
        } else if (attempt.status === 'sent' && observedCheckpoint(source, delivery, view, attempt)) {
          if (!attempt.target.startsWith(actual) || actual.length < attempt.from) {
            note('HOST_CONFIRMED_PREFIX_MISSING', source.id); continue;
          }
          // A later observed checkpoint in the SAME ordered stream proves that
          // this forwarded body is no longer merely waiting ahead of the marker.
          attempt.status = 'retired'; delivery.pending = null; delivery.confirmedText = actual;
          // Retire durably even if readiness is revoked before the repair emits.
          delivery.retiredSegments.push(delivery.segment);
          delivery.segment++; delivery.segmentBase = actual.length;
          await save();
          await sendBody(source, delivery, view);
          continue;
        } else if (attempt.status === 'prepared' && !restoredPrepared.has(attempt.id)) {
          await sendBody(source, delivery, view); continue;
        } else {
          if (attempt.status === 'sent') await sendCheckpoint(source, delivery, attempt, view);
          else note('BODY_EMIT_UNCONFIRMED', source.id);
          continue;
        }
      } else {
        if (actual.length < delivery.confirmedText.length) { note('HOST_CONFIRMED_PREFIX_MISSING', source.id); continue; }
        if (actual !== delivery.confirmedText) {
          delivery.confirmedText = actual;
          // A newly bound transport has no cached prefix. Existing host text is
          // baseline evidence, not text to resend under this fresh segment ID.
          if (!state.attempts.some(row => row.sourceId === source.id && row.segment === delivery.segment))
            delivery.segmentBase = actual.length;
          await save();
        }
      }
      if (!source.text.startsWith(delivery.confirmedText)) { note('SOURCE_NON_PREFIX_REVISION', source.id); continue; }
      if (source.text.length > delivery.confirmedText.length) await sendBody(source, delivery, view);
    }
    return snapshot();
  }
  return Object.freeze({
    submit(item) {
      return queued(async () => {
        if (item?.type !== 'assistant_message') fail('NATIVE_DELIVERY_TYPE_UNSUPPORTED');
        if (!string(item.id) || !string(item.messageId) || typeof item.text !== 'string' ||
            item.text.includes('\0') || (item.text.isWellFormed && !item.text.isWellFormed())) fail('NATIVE_DELIVERY_ITEM_INVALID');
        const source = state.sources.find(row => row.id === item.id);
        if (source && source.messageId !== item.messageId) fail('NATIVE_MESSAGE_ID_CHANGED');
        if (!source && state.sources.some(row => row.messageId === item.messageId)) fail('NATIVE_MESSAGE_ID_CONFLICT');
        if (source) source.text = item.text;
        else {
          state.sources.push({ id: item.id, messageId: item.messageId, text: item.text });
          state.deliveries.push({ sourceId: item.id, checkpointId: `source-checkpoint:${hash(item.id)}`,
            anchorConfirmed: false, anchorSeq: null, confirmedText: '', pending: null,
            segment: 0, segmentBase: 0, retiredSegments: [], nextBatch: 0 });
        }
        await save(); return snapshot();
      });
    },
    sync() { return queued(async () => {
      let view;
      try { view = await readHost(); } catch { issues = []; note('HOST_READ_UNAVAILABLE'); return snapshot(); }
      return reconcile(view);
    }); },
    observeHost(view) { return queued(() => reconcile(clone(view))); },
    setPageState(value) {
      if (!['running', 'standby', 'abnormal'].includes(value)) fail('PAGE_STATE_INVALID');
      pageState = value; return snapshot();
    },
    snapshot,
    close() { closed = true; return tail; }
  });
}
