/** Completed native message receiver.
 * The browser hands over one whole public message once it is complete (or
 * provably interrupted by a confirmed Stop). This side validates, decodes once,
 * persists by native identity and answers with a receipt that says only what is
 * true locally. A receipt is not task success and not Paseo host display.
 */
import { createHash } from 'node:crypto';
import { invariant, nativeMessageId, LIMITS } from './protocol.mjs';
import { decodePublicProse } from '../shared/public-prose.mjs';
import { writeActivity } from './activity.mjs';
import { noteSyncIssue, resolveContentIssues } from './observation.mjs';

export const MESSAGE_LIMITS = Object.freeze({ text: LIMITS.answer, positionDepth: 8, positionValue: 1_000_000, aliases: 4 });
const IDENTITY = ['kind', 'sessionId', 'turnId', 'lease', 'nativeMessageId', 'tabId', 'documentKey', 'url'];
const FIELDS = ['messageId', 'text', 'format', 'messageState', 'position'];
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;

export const messageRevision = (messageId, format, messageState, text) =>
  createHash('sha256').update(Buffer.from(JSON.stringify([messageId, format, messageState, text]), 'utf8')).digest('hex');

/** Strict, bounded shape check. Anything malformed is an error, never a receipt. */
export function messageEvent(event) {
  invariant(Object.keys(event).every(k => IDENTITY.includes(k) || FIELDS.includes(k)), 'MESSAGE_INVALID');
  const messageId = nativeMessageId(event.messageId);
  invariant(messageId !== event.nativeMessageId, 'MESSAGE_INVALID');
  invariant(typeof event.text === 'string' && event.text.length <= MESSAGE_LIMITS.text &&
    event.text.isWellFormed() && !event.text.includes('\u0000'), 'MESSAGE_INVALID');
  invariant(['text', 'dil'].includes(event.format) && ['complete', 'interrupted'].includes(event.messageState), 'MESSAGE_INVALID');
  let position = null;
  if (event.position !== undefined) {
    invariant(Array.isArray(event.position) && event.position.length > 0 && event.position.length <= MESSAGE_LIMITS.positionDepth &&
      event.position.every(n => Number.isSafeInteger(n) && n >= 0 && n <= MESSAGE_LIMITS.positionValue), 'MESSAGE_INVALID');
    position = [...event.position];
  }
  const { text, format, messageState } = event;
  return { messageId, text, format, messageState, position, revision: messageRevision(messageId, format, messageState, text) };
}

// Inline citation directives the browser could not pair with a page source
// pill. Shown raw they are noise and a guessed link would be wrong: drop them.
const CITATION = /:{1,2}chatgpt-content-reference\{[^}\n]*\}/g;
// The browser renders a paired directive as `[label](<url>)`. Two versions of
// one message that differ only in citations are the same prose.
const CITATION_LINK = /\s?\[[^\]\n]{1,80}\]\(<https?:\/\/[^>\s]{1,2000}>\)/g;
export const withoutCitationDirectives = text => text.replace(CITATION, '');
const citationFree = text => text.replace(CITATION_LINK, '').replace(CITATION, '');

const delivered = (record, revision) => record && (record.revision === revision || record.aliases?.includes(revision));
const currentDelivered = (record, revision) => record &&
  (record.revision === revision || record.completeAliases?.includes(revision));
const receiptOf = (m, disposition, code) =>
  ({ messageId: m.messageId, revision: m.revision, disposition, host: 'unconfirmed', ...(code ? { code } : {}) });
/** Already stored revision: answered from durable state without a write. */
export function alreadyDelivered(turn, m) {
  const record=turn?.messages?.[m.messageId];
  if(!delivered(record,m.revision))return null;
  // A confirmed current version can resolve this message's open issue. Do
  // that transactionally rather than returning a stale health verdict.
  if(currentDelivered(record,m.revision)&&turn.sync?.issues?.some(i=>
    i.messageId===m.messageId&&i.blocking&&i.resolvedAt===null))return null;
  return receiptOf(m,'unchanged');
}

/**
 * Apply one validated message inside a Store transaction.
 * `stopConfirmed` must come from a completed native Stop result for this turn.
 */
export function receiveMessage(s, m, { stopConfirmed, at, historyLimit = LIMITS.history }) {
  const t = s.turn, rowId = `assistant:${t.id}:${m.messageId}`;
  const record = t.messages?.[m.messageId];
  if (delivered(record, m.revision)) {
    const restored=currentDelivered(record,m.revision)&&resolveContentIssues(t,m.messageId,at,{exact:true});
    const activityItem=restored?writeActivity(s,()=>{}):null;
    return {receipt:receiptOf(m,'unchanged'),...(activityItem?{notification:{
      state:'message',inactive:Boolean(t.outcome),activityItem,syncRestored:true
    }}:{})};
  }
  // A refusal on an active turn is visible on its card and blocks a success claim.
  const reject = (code, issue = !t.outcome) => {
    let activityItem = null, transition = false;
    if (issue) {
      const noted = noteSyncIssue(t, { code, messageId: m.messageId, blocking: true, at });
      transition = noted.transition;
      if (noted.changed) activityItem = writeActivity(s, () => {}, { create: true, limit: historyLimit });
    }
    return { receipt: receiptOf(m, 'rejected', code),
      ...(activityItem ? { notification: { state: transition ? 'sync-blocked' : 'sync-issue', error: code, activityItem } } : {}) };
  };
  if (t.outcome === 'completed') return reject('TURN_SETTLED', false);
  // Only a confirmed native Stop proves the page stopped. A Paseo cancel
  // request, STOP_UNCONFIRMED, a CIP error or a disconnect does not.
  if (t.outcome && (t.outcome !== 'canceled' || !stopConfirmed)) return reject('TURN_NOT_STOPPED', false);
  let decoded;
  try {
    decoded = decodePublicProse({ text: m.text, format: m.format });
    invariant(typeof decoded === 'string' && decoded.length <= MESSAGE_LIMITS.text, 'MESSAGE_DECODE_FAILED');
    decoded = withoutCitationDirectives(decoded);
  } catch (e) { return reject(typeof e?.code === 'string' && CODE.test(e.code) ? e.code : 'MESSAGE_DECODE_FAILED'); }
  if (!decoded.trim()) return reject('MESSAGE_EMPTY', false);
  const index = s.history.findIndex(x => x.id === rowId);
  const row = index >= 0 ? s.history[index] : null;
  let changed = true;
  if (record) {
    // A different revision of a delivered message. Paseo appends assistant
    // text, so only an append-safe continuation of an interrupted body or a
    // representation-only change with identical decoded text is acceptable.
    if (row?.text === decoded || (row && citationFree(row.text) === citationFree(decoded))) changed = false;
    else if (!(record.messageState === 'interrupted' && row && decoded.startsWith(row.text)))
      return reject('MESSAGE_REVISION_CONFLICT');
  } else if (row) {
    // History streamed by the legacy snapshot lane before this message was complete.
    if (row.text === decoded) changed = false;
    else if (!decoded.startsWith(row.text)) return reject('MESSAGE_PREFIX_CONFLICT');
  } else {
    const parts = s.history.filter(x => x.type === 'assistant_message' && x.id.startsWith(`assistant:${t.id}:`));
    if (parts.length >= LIMITS.turnFragments || parts.reduce((n, x) => n + x.text.length, decoded.length) > LIMITS.answer)
      return reject('TURN_OUTPUT_LIMIT');
    if (s.history.length >= historyLimit) return reject('HISTORY_LIMIT');
  }
  const item = { type: 'assistant_message', id: rowId, text: decoded };
  if (changed) { if (row) s.history[index] = item; else s.history.push(item); }
  const aliases = record ? [...new Set([...(record.aliases ?? []), record.revision])].slice(-MESSAGE_LIMITS.aliases) : [];
  // Only complete, text-equivalent versions can certify this complete final.
  // A historical partial receipt is idempotent, but is NOT a final proof.
  const completeAliases=!changed&&record?.messageState==='complete'&&m.messageState==='complete'
    ?[...new Set([...(record.completeAliases??[]),record.revision])].slice(-MESSAGE_LIMITS.aliases):[];
  t.messages = { ...(t.messages ?? {}), [m.messageId]: { revision: m.revision, format: m.format, messageState: m.messageState,
    position: m.position, anchor: t.nativeMessageId, receivedAt: at, length: decoded.length,
    ...(aliases.length ? { aliases } : {}),...(completeAliases.length?{completeAliases}:{}) } };
  if (!t.outcome) t.lastObservedAt = at;
  const restored = resolveContentIssues(t, m.messageId, at);
  const activityItem = restored ? writeActivity(s, () => {}) : null;
  return { receipt: receiptOf(m, changed ? 'stored' : 'unchanged'),
    ...(changed || activityItem ? { notification: { state: 'message', inactive: Boolean(t.outcome), ...(changed ? { item } : {}),
      ...(activityItem ? { activityItem, syncRestored: true } : {}) } } : {}) };
}

/** Completion proof for a message-lane final: the page's final revision was delivered complete. */
export function finalDelivered(turn, messageId, finalRevision) {
  const record = turn.messages?.[messageId];
  return Boolean(record && record.messageState === 'complete' && typeof finalRevision === 'string' &&
    currentDelivered(record,finalRevision));
}
