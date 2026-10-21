// Conversation-level source ledger. This module records what the page exposed,
// not whether Paseo received it. A source id is an independent content identity:
// it must not be derived from a Paseo run fragment, and it is never removed just
// because a later collapsed/virtualized read omitted it.
import { createHash } from 'node:crypto';

const ROLES = new Set(['user', 'assistant', 'page']);
const LANES = new Set(['process', 'output']);
// Approval cards are not source items; the approval path returns their
// separate request structure and must not feed them into this ledger.
const KINDS = new Set(['message', 'reasoning', 'tool_call', 'notice', 'image', 'file']);
const FORMATS = new Set(['text', 'markdown']);
const STATUSES = new Set(['running', 'completed', 'failed']);
// Hard identity: a source id must keep denoting the same thing.
// `userMessageId` is a REFERENCE to another source, not the source's own
// identity. The extension derives it from the page's ambient "last seen user
// message" cursor, so one and the same assistant message legitimately reports
// a different reference once that user message becomes readable, unreadable
// or re-identified. It is compared separately and never blocks a content
// update: enforcing it here dropped the whole update and froze the assistant
// body at the length of its first captured frame.
const IDENTITY = ['role', 'lane', 'kind', 'nativeMessageId', 'callId'];
const REFERENCE = 'userMessageId';
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class SourceError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.field = field;
  }
}
const fail = (code, field, message) => { throw new SourceError(code, field, message); };

function fieldOf(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { present: false };
  // An accessor is source code, not source data. Reading it could execute page
  // or caller state and is not an acceptable way to validate a source item.
  if (!hasOwn(descriptor, 'value')) return { present: true, invalid: true };
  return { present: true, value: descriptor.value };
}

function sourceText(value, { empty = true } = {}) {
  return typeof value === 'string' && (empty || value.length > 0) &&
    !value.includes('\u0000') && (typeof value.isWellFormed !== 'function' || value.isWellFormed());
}

function jsonClone(value, depth = 0) {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('SOURCE_MEDIA_INVALID', 'media', 'Media must contain only finite JSON numbers.');
    return value;
  }
  if (depth > 64) fail('SOURCE_MEDIA_INVALID', 'media', 'Media nesting is too deep.');
  if (Array.isArray(value)) return value.map(item => jsonClone(item, depth + 1));
  if (!isObject(value)) fail('SOURCE_MEDIA_INVALID', 'media', 'Media must be a JSON object.');
  const copy = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !hasOwn(descriptor, 'value'))
      fail('SOURCE_MEDIA_INVALID', 'media', 'Media must not contain accessors.');
    Object.defineProperty(copy, key, {
      value: jsonClone(descriptor.value, depth + 1),
      enumerable: true, writable: true, configurable: true
    });
  }
  return copy;
}

function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return 'null';
}

/** Stable content revision. Observation time and ledger history are excluded.
 * Position is excluded as well: `order` is a DOM path, not content. A page
 * that inserts or removes one sibling shifts every path and must not be read
 * as a rewrite of the whole conversation. The preceding-user reference is a
 * pointer for the same reason: the extension derives it from the page's
 * ambient cursor, so it moves without the content moving. */
export function sourceRevision(input) {
  const value = isObject(input) && isObject(input.item) && !hasOwn(input, 'text') ? input.item : input;
  if (!isObject(value)) fail('SOURCE_ITEM_INVALID', 'item', 'Source item must be an object.');
  return createHash('sha256').update(canonical([
    value.id ?? null,
    value.role ?? null,
    value.lane ?? null,
    value.kind ?? null,
    value.sourceKind ?? null,
    value.text ?? null,
    value.format ?? null,
    value.nativeMessageId ?? null,
    value.callId ?? null,
    value.name ?? null,
    value.status ?? null,
    value.details ?? null,
    value.media ?? null,
    value.prose ? { ...value.prose, observedAt: undefined } : null
  ]), 'utf8').digest('hex');
}

// Raw representation is an independent supplement. An invalid supplement must
// not discard the captured DOM body or another source. Only own data is read.
function proseOf(field, nativeId, formal) {
  try {
    if (field.invalid || !isObject(field.value) || !formal) throw Error('SOURCE_PROSE_INVALID');
    const get = key => {
      const part = fieldOf(field.value, key);
      if (part.invalid) throw Error('SOURCE_PROSE_INVALID');
      return part.value;
    };
    const status = get('status');
    if (status === 'pending') return { status };
    if (status === 'unavailable') {
      const code = get('code');
      return { status, code: typeof code === 'string' && /^[A-Z_]{1,100}$/.test(code) ? code : 'SOURCE_PROSE_RAW_UNAVAILABLE' };
    }
    if (status !== 'available') throw Error('SOURCE_PROSE_INVALID');
    const id = get('nativeMessageId'), rawText = get('rawText'), representation = get('representation');
    const observedAt = get('observedAt'), eof = get('eof');
    if (!nativeId || id !== nativeId) throw Error('SOURCE_PROSE_IDENTITY_CONFLICT');
    // A final high surrogate may be a UTF-16 chunk boundary, never a published
    // replacement glyph. The renderer holds it until its low surrogate arrives.
    const validText = sourceText(rawText) || eof !== true && typeof rawText === 'string' &&
      /[\uD800-\uDBFF]$/.test(rawText) && sourceText(rawText.slice(0,-1));
    if (!validText || !['markdown','dil'].includes(representation) ||
        !Number.isFinite(observedAt) || observedAt < 0 || eof !== undefined && typeof eof !== 'boolean')
      throw Error('SOURCE_PROSE_INVALID');
    return { status, nativeMessageId:id, rawText, representation, observedAt, ...(eof !== undefined ? {eof} : {}) };
  } catch (error) {
    return { status:'unavailable', code:error.message === 'SOURCE_PROSE_IDENTITY_CONFLICT'
      ? error.message : 'SOURCE_PROSE_INVALID' };
  }
}

function normalize(input, index, at) {
  if (!isObject(input)) fail('SOURCE_ITEM_INVALID', 'item', 'Source item must be an object.');
  const provided = new Set();
  const value = key => {
    const field = fieldOf(input, key);
    // `undefined` is an omitted property, not a malformed value. Null remains
    // meaningful only where the protocol explicitly allows it.
    return field.present && !field.invalid && field.value === undefined ? { present: false } : field;
  };

  const id = value('id');
  if (!id.present || !sourceText(id.value, { empty: false }))
    fail('SOURCE_ID_INVALID', 'id', 'Source id must be a non-empty string.');

  const role = value('role');
  if (!role.present || role.invalid || !ROLES.has(role.value))
    fail('SOURCE_ROLE_INVALID', 'role', 'Source role must be user, assistant or page.');

  const rawKind = value('kind');
  if (rawKind.present && (rawKind.invalid || !sourceText(rawKind.value)))
    fail('SOURCE_KIND_INVALID', 'kind', 'Source kind must be a well-formed string.');
  const rawSourceKind = value('sourceKind');
  if (rawSourceKind.invalid || (rawSourceKind.present && !sourceText(rawSourceKind.value)))
    fail('SOURCE_SOURCE_KIND_INVALID', 'sourceKind', 'sourceKind must be a well-formed string.');
  const knownKind = rawKind.present && KINDS.has(rawKind.value);
  // Unknown source types are not dropped: they are visible output notices.
  // Keep the raw type as metadata so a third-category card can name its source
  // without prefixing a JSON header to the visible progress text.
  const kind = knownKind ? rawKind.value : 'notice';
  let sourceKind;
  if (!knownKind) {
    if (rawKind.present) sourceKind = rawKind.value;
    else if (rawSourceKind.present) sourceKind = rawSourceKind.value;
  } else if (kind === 'notice' && rawSourceKind.present) {
    // Round-trip an already-normalized unknown source. A fresh explicit
    // notice has no sourceKind and stays a normal notice.
    sourceKind = rawSourceKind.value;
  }
  if (rawKind.present) provided.add('kind');
  if (sourceKind !== undefined) provided.add('sourceKind');

  const rawLane = value('lane');
  if (rawLane.invalid || (rawLane.present && typeof rawLane.value !== 'string'))
    fail('SOURCE_LANE_INVALID', 'lane', 'Source lane must be a string.');
  const lane = !knownKind ? 'output'
    : rawLane.present ? (LANES.has(rawLane.value) ? rawLane.value : 'output')
      : (kind === 'reasoning' || kind === 'tool_call' ? 'process' : 'output');

  const rawUser = value('userMessageId');
  if (rawUser.invalid || (rawUser.present && rawUser.value !== null && !sourceText(rawUser.value, { empty: false })))
    fail('SOURCE_USER_MESSAGE_INVALID', 'userMessageId', 'userMessageId must be null or a non-empty string.');
  const userMessageId = rawUser.present && rawUser.value !== null ? rawUser.value : null;
  if (rawUser.present) provided.add('userMessageId');

  const rawText = value('text');
  if (!rawText.present || rawText.invalid || !sourceText(rawText.value))
    fail('SOURCE_TEXT_INVALID', 'text', 'Source text must be a well-formed string.');

  const rawFormat = value('format');
  if (rawFormat.invalid || (rawFormat.present && (typeof rawFormat.value !== 'string' || !FORMATS.has(rawFormat.value))))
    fail('SOURCE_FORMAT_INVALID', 'format', 'Source format must be text or markdown.');
  const format = rawFormat.present ? rawFormat.value : 'text';
  if (rawFormat.present) provided.add('format');

  const rawOrder = value('order');
  let order = [];
  if (rawOrder.present) {
    if (rawOrder.invalid || !Array.isArray(rawOrder.value))
      fail('SOURCE_ORDER_INVALID', 'order', 'Source order must be an array of finite numbers.');
    order = [];
    for (let i = 0; i < rawOrder.value.length; i++) {
      if (!hasOwn(rawOrder.value, i) || typeof rawOrder.value[i] !== 'number' || !Number.isFinite(rawOrder.value[i]))
        fail('SOURCE_ORDER_INVALID', 'order', 'Source order must be an array of finite numbers.');
      order.push(rawOrder.value[i]);
    }
    provided.add('order');
  }

  const optionalText = key => {
    const raw = value(key);
    if (raw.invalid || (raw.present && raw.value !== null && !sourceText(raw.value, { empty: false })))
      fail('SOURCE_FIELD_INVALID', key, `${key} must be a non-empty string when present.`);
    if (raw.present && raw.value !== null) provided.add(key);
    return raw.present && raw.value !== null ? raw.value : undefined;
  };
  const nativeMessageId = optionalText('nativeMessageId');
  const callId = optionalText('callId');
  const name = optionalText('name');

  const rawStatus = value('status');
  if (rawStatus.invalid || (rawStatus.present && rawStatus.value !== null &&
    (typeof rawStatus.value !== 'string' || !STATUSES.has(rawStatus.value))))
    fail('SOURCE_STATUS_INVALID', 'status', 'Source status must be running, completed or failed.');
  const status = rawStatus.present && rawStatus.value !== null ? rawStatus.value : undefined;
  if (status !== undefined) provided.add('status');

  const rawDetails = value('details');
  let details;
  if (rawDetails.present && rawDetails.value !== null) {
    if (rawDetails.invalid || !isObject(rawDetails.value) ||
      !Object.keys(rawDetails.value).every(key => key === 'input' || key === 'output'))
      fail('SOURCE_DETAILS_INVALID', 'details', 'Details may only contain string input and output.');
    details = {};
    for (const key of ['input', 'output']) {
      if (!hasOwn(rawDetails.value, key)) continue;
      const part = fieldOf(rawDetails.value, key);
      if (!part.present || part.invalid || !sourceText(part.value))
        fail('SOURCE_DETAILS_INVALID', 'details', 'Details may only contain string input and output.');
      details[key] = part.value;
    }
    provided.add('details');
  }

  const rawMedia = value('media');
  let media;
  if (rawMedia.present && rawMedia.value !== null) {
    if (rawMedia.invalid || !isObject(rawMedia.value))
      fail('SOURCE_MEDIA_INVALID', 'media', 'Media must be a JSON object.');
    media = jsonClone(rawMedia.value);
    provided.add('media');
  }

  const rawProse = value('prose');
  const prose = rawProse.present ? proseOf(rawProse, nativeMessageId,
    role.value === 'assistant' && lane === 'output' && kind === 'message') : undefined;
  if (rawProse.present) provided.add('prose');

  return { provided, item: {
    id: id.value,
    userMessageId,
    role: role.value,
    lane,
    kind,
    ...(sourceKind !== undefined ? { sourceKind } : {}),
    text: rawText.value,
    format,
    order,
    ...(nativeMessageId !== undefined ? { nativeMessageId } : {}),
    ...(callId !== undefined ? { callId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(media !== undefined ? { media } : {}),
    ...(prose !== undefined ? { prose } : {})
  } };
}

function itemOf(record) {
  return {
    id: record.id,
    userMessageId: record.userMessageId ?? null,
    role: record.role,
    lane: record.lane,
    kind: record.kind,
    ...(typeof record.sourceKind === 'string' ? { sourceKind: record.sourceKind } : {}),
    text: record.text,
    format: record.format ?? 'text',
    order: Array.isArray(record.order) ? [...record.order] : [],
    ...(record.nativeMessageId !== undefined ? { nativeMessageId: record.nativeMessageId } : {}),
    ...(record.callId !== undefined ? { callId: record.callId } : {}),
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.details !== undefined ? { details: { ...record.details } } : {}),
    ...(record.media !== undefined ? { media: jsonClone(record.media) } : {}),
    ...(record.prose !== undefined ? { prose: { ...record.prose } } : {})
  };
}

function itemAlias(record) {
  // Durable records are flat. This non-enumerable alias only makes the
  // `{ item, revision }` reading convenient in memory; it is not serialized.
  try {
    Object.defineProperty(record, 'item', {
      enumerable: false, configurable: true,
      get() { return itemOf(this); }
    });
  } catch { /* A caller-supplied frozen record is still valid data. */ }
  return record;
}

function recordOf(item, {
  revision, originalText, previousText, rewrites, firstSeenAt, updatedAt,
  originalProse, previousProse, proseRewrites
}) {
  // Keep the durable record independent from the item returned to the caller;
  // a projection must not be able to mutate the ledger by editing its copy.
  const record = itemOf(item);
  record.revision = revision;
  record.originalText = originalText;
  if (previousText !== undefined) record.previousText = previousText;
  if (rewrites?.length) record.rewrites = rewrites;
  if (originalProse) record.originalProse = { ...originalProse };
  if (previousProse) record.previousProse = { ...previousProse };
  if (proseRewrites?.length) record.proseRewrites = proseRewrites.map(p => ({...p}));
  record.firstSeenAt = firstSeenAt;
  record.updatedAt = updatedAt;
  return itemAlias(record);
}

function indexId(records, id, record) {
  if (typeof id !== 'string' || id === 'length' || ARRAY_INDEX.test(id)) return;
  if (!DANGEROUS_KEYS.has(id) && (id in Array.prototype || id in Object.prototype)) return;
  try {
    Object.defineProperty(records, id, {
      enumerable: false, configurable: true, get() { return record; }
    });
  } catch { /* Reserved array keys are still stored as normal records. */ }
}

function attachIndexes(records) {
  for (const record of records) {
    if (isObject(record)) indexId(records, record.id, record);
  }
  return records;
}

function readLedger(session, at) {
  const raw = session.sources;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (isObject(raw)) {
    if (Array.isArray(raw.records)) list = raw.records;
    else if (Array.isArray(raw.items)) list = raw.items;
    else if (isObject(raw.byId)) list = Object.values(raw.byId);
    else for (const key of Object.keys(raw)) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor && hasOwn(descriptor, 'value') && isObject(descriptor.value))
        list.push(descriptor.value);
    }
  }
  const byId = new Map();
  const extras = [];
  let position = 0;
  for (const entry of list) {
    try {
      const source = isObject(entry) && isObject(entry.item) ? entry.item : entry;
      const normalized = normalize(source, position++, at).item;
      const revision = sourceRevision(normalized);
      const meta = isObject(entry) ? entry : {};
      const record = recordOf(normalized, {
        revision,
        originalText: typeof meta.originalText === 'string' ? meta.originalText : normalized.text,
        previousText: typeof meta.previousText === 'string' ? meta.previousText : undefined,
        rewrites: Array.isArray(meta.rewrites) ? meta.rewrites : undefined,
        firstSeenAt: Number.isFinite(meta.firstSeenAt) ? meta.firstSeenAt : at,
        updatedAt: Number.isFinite(meta.updatedAt) ? meta.updatedAt : at,
        originalProse:meta.originalProse, previousProse:meta.previousProse, proseRewrites:meta.proseRewrites
      });
      if (byId.has(normalized.id)) extras.push(entry);
      else byId.set(normalized.id, { record, revision });
    } catch { extras.push(entry); }
  }
  return { byId, extras };
}

function merge(old, next, provided) {
  const merged = itemOf(old);
  merged.text = next.text;
  merged.role = next.role;
  merged.lane = next.lane;
  merged.kind = next.kind;
  if (provided.has('sourceKind')) merged.sourceKind = next.sourceKind;
  else if (provided.has('kind')) delete merged.sourceKind;
  if (next.userMessageId !== null) merged.userMessageId = next.userMessageId;
  if (provided.has('format')) merged.format = next.format;
  if (provided.has('order')) merged.order = [...next.order];
  for (const key of ['nativeMessageId', 'callId', 'name', 'status']) {
    if (provided.has(key)) merged[key] = next[key];
  }
  if (provided.has('details')) merged.details = next.details;
  else if (old.details !== undefined) merged.details = { ...old.details };
  if (provided.has('prose')) merged.prose = { ...next.prose };
  if (provided.has('media')) merged.media = jsonClone(next.media);
  else if (old.media !== undefined) merged.media = jsonClone(old.media);
  return merged;
}

function conflicts(old, next) {
  const found = [];
  for (const key of IDENTITY) {
    if (key === 'nativeMessageId' || key === 'callId') {
      const before = old[key], after = next[key];
      if (before !== undefined && before !== null && after !== undefined && after !== null && before !== after)
        found.push(key);
    } else if (old[key] !== next[key]) found.push(key);
  }
  return found;
}
// A moved reference is reported, never enforced. The first reference is kept so
// the source keeps the turn attribution it was first seen with, and so the
// projected item does not move to another activity card. The content update
// still applies.
function referenceMoved(old, next) {
  const before = old[REFERENCE], after = next[REFERENCE];
  if (after === null || after === undefined) return false; // merge keeps the first reference
  return before !== after;
}

function compareOrder(a, b) {
  const left = a.order ?? [], right = b.order ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

function issue(index, id, code, message, at, extra = {}) {
  return { index, id: typeof id === 'string' ? id : null, code, message, at, ...extra };
}

function resolveNow(value) {
  let candidate = value;
  if (typeof candidate === 'function') {
    try { candidate = candidate(); } catch { candidate = undefined; }
  }
  if (candidate instanceof Date) candidate = candidate.getTime();
  return Number.isFinite(candidate) ? candidate : Date.now();
}

/**
 * Merge one observed batch into the conversation source ledger.
 * The caller runs this inside Store.transaction. This function never reads
 * session.turn/session.status and never removes a source that is absent from
 * the batch. Invalid items become issues; the rest of the batch still applies.
 */
export function reconcileSources(session, items, options = {}) {
  const at = resolveNow(options?.now);
  const issues = [];
  const empty = { changes: [], unchanged: 0, issues };
  if (!isObject(session)) {
    issues.push(issue(-1, null, 'SOURCE_SESSION_INVALID', 'Session must be an object.', at));
    return empty;
  }
  if (!Array.isArray(items)) {
    issues.push(issue(-1, null, 'SOURCE_BATCH_INVALID', 'Source batch must be an array.', at));
    return empty;
  }

  let ledger;
  try {
    ledger = readLedger(session, at);
  } catch {
    issues.push(issue(-1, null, 'SOURCE_LEDGER_INVALID', 'The stored source ledger could not be read.', at));
    return empty;
  }
  const { byId, extras } = ledger;
  const changes = [];
  let unchanged = 0;
  let moved = false;

  for (let index = 0; index < items.length; index++) {
    let normalized;
    try {
      normalized = normalize(items[index], index, at);
    } catch (error) {
      const code = error instanceof SourceError ? error.code : 'SOURCE_ITEM_INVALID';
      const message = error instanceof SourceError ? error.message : 'Source item could not be read.';
      const field = error instanceof SourceError ? error.field : 'item';
      let issueId = null;
      try {
        if (isObject(items[index])) {
          const rawId = fieldOf(items[index], 'id');
          if (rawId.present && !rawId.invalid && sourceText(rawId.value, { empty: false })) issueId = rawId.value;
        }
      } catch { /* A hostile item still only produces one issue. */ }
      issues.push(issue(index, issueId, code, message, at, { field }));
      continue;
    }
    const next = normalized.item;
    if (next.prose?.status === 'unavailable')
      issues.push(issue(index,next.id,next.prose.code,'原始表示不可用；DOM 来源仍保留。',at,{field:'prose'}));
    const current = byId.get(next.id);
    if (!current) {
      const revision = sourceRevision(next);
      const record = recordOf(next, {
        revision,
        originalText: next.text,
        originalProse: next.prose?.status === 'available' ? next.prose : undefined,
        firstSeenAt: at,
        updatedAt: at
      });
      byId.set(next.id, { record, revision });
      changes.push({ item: next, revision, change: 'new' });
      continue;
    }

    const old = current.record;
    const changedIdentity = conflicts(old, next);
    if (changedIdentity.length) {
      issues.push(issue(index, next.id, 'SOURCE_IDENTITY_CONFLICT',
        'Source identity changed; the first version was kept.', at, { fields: changedIdentity }));
      continue;
    }
    // The preceding-user reference moved. It is a pointer, not the source's own
    // identity: keep the first reference, like every other identity field, but
    // still apply the content update. Dropping the update here is what froze
    // an assistant body at the length of its first captured frame. The
    // reference itself is not part of the content revision, so a moved pointer
    // is reported on its own and never re-projects or re-delivers the source.
    const movedReference = referenceMoved(old, next);
    if (movedReference)
      issues.push(issue(index, next.id, 'SOURCE_USER_MESSAGE_REVISED',
        'The preceding user turn reference changed; the first reference was kept and the content was not re-delivered.',
        at, { fields: [REFERENCE] }));

    const merged = merge(old, next, normalized.provided);
    if (movedReference) merged[REFERENCE] = old[REFERENCE];
    const revision = sourceRevision(merged);
    if (revision === current.revision) {
      // Position is not content. A DOM path shift must not re-project, re-deliver
      // or re-order the conversation; only the stored position is refreshed.
      if (canonical(merged.order) !== canonical(old.order)) {
        current.record = recordOf(merged, {
          revision: current.revision,
          originalText: old.originalText,
          previousText: old.previousText,
          rewrites: old.rewrites,
          firstSeenAt: old.firstSeenAt,
          updatedAt: old.updatedAt,
          originalProse: old.originalProse,
          previousProse: old.previousProse,
          proseRewrites: old.proseRewrites
        });
        moved = true;
      }
      unchanged++;
      continue;
    }

    const change = next.text.length > old.text.length && next.text.startsWith(old.text) ? 'append' : 'rewrite';
    const rewrites = change === 'rewrite'
      ? [...(Array.isArray(old.rewrites) ? old.rewrites : []),
        { revision: current.revision, text: old.text, at: old.updatedAt ?? at }]
      : old.rewrites;
    const previousProse = old.prose?.status === 'available' ? old.prose : old.previousProse;
    const currentProse = merged.prose?.status === 'available' ? merged.prose : undefined;
    const proseRewrite = previousProse && currentProse && (previousProse.representation !== currentProse.representation ||
      !currentProse.rawText.startsWith(previousProse.rawText));
    const record = recordOf(merged, {
      originalProse:old.originalProse ?? currentProse, previousProse,
      proseRewrites:proseRewrite ? [...(old.proseRewrites??[]),previousProse] : old.proseRewrites,
      revision,
      originalText: old.originalText ?? old.text,
      previousText: old.text,
      rewrites,
      firstSeenAt: old.firstSeenAt ?? at,
      updatedAt: at
    });
    byId.set(next.id, { record, revision });
    changes.push({ item: merged, revision, change });
  }

  if (changes.length || moved) {
    const records = [...byId.values()].map(entry => entry.record).sort(compareOrder);
    try {
      session.sources = attachIndexes(extras.length ? [...records, ...extras] : records);
    } catch {
      issues.push(issue(-1, null, 'SOURCE_LEDGER_WRITE_FAILED',
        'The ledger could not be published on this session.', at));
      return { changes: [], unchanged: 0, issues };
    }
  } else if (Array.isArray(session.sources)) {
    attachIndexes(session.sources);
  }
  changes.sort((a, b) => compareOrder(a.item, b.item));
  return { changes, unchanged, issues };
}
