/** Page facts and CIP sync health, kept apart from native turn outcome.
 * page_status is an observation of what the bound page shows. It is NEVER a
 * native success/failure signal and never settles a Paseo turn by itself.
 */
import { invariant, nativeMessageId, object } from './protocol.mjs';

export const PAGE_LIMITS = Object.freeze({ notices: 16, text: 8192, buttons: 8, label: 160, issues: 64, skewMs: 5 * 60000 });
export const SYNC_LIMITS = Object.freeze({ issues: 8, recoveries: 8, pageRefreshMs: 60000 });
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
// C0 controls other than tab/newline/carriage return are not page text.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SECRETS = [
  /\b(Bearer\s+)()[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b((?:api[_-]?key|access[_-]?token|token|password|authorization|secret)\s*[:=]\s*)(["']?)[^\s"',};&]{6,}/gi,
  /\b()()sk-[A-Za-z0-9_-]{16,}/g
];
const bad = () => { invariant(false, 'PAGE_STATUS_INVALID'); };
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value, k));
const bool = value => typeof value === 'boolean' ? value : bad();

function redact(value) {
  let out = value;
  for (const pattern of SECRETS) out = out.replace(pattern, (_, prefix = '', quote = '') => `${prefix}${quote}[REDACTED]`);
  return { text: out, redacted: out !== value };
}

/** Bounded validation. Original text is kept verbatim except explicit, marked redaction/clipping. */
export function pageStatus(value, now = Date.now()) {
  if (!keys(value, ['observedAt', 'readable', 'nativeStatus', 'controls', 'notices', 'issues', 'truncated'])) bad();
  const observedAt = value.observedAt;
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > now + PAGE_LIMITS.skewMs) bad();
  const readable = bool(value.readable), truncatedInput = bool(value.truncated);
  if (![null, 'in_progress', 'complete'].includes(value.nativeStatus)) bad();
  if (!keys(value.controls, ['stop', 'approval'])) bad();
  const stop = value.controls.stop;
  if (stop !== null && !keys(stop, ['visible', 'enabled'])) bad();
  if (value.controls.approval !== null) bool(value.controls.approval);
  if (!Array.isArray(value.notices) || value.notices.length > PAGE_LIMITS.notices) bad();
  let clippedAny = false;
  const notices = value.notices.map(notice => {
    if (!keys(notice, ['scope', 'text', 'buttons'])) bad();
    if (!['turn', 'page', 'sidebar'].includes(notice.scope)) bad();
    if (typeof notice.text !== 'string' || !notice.text.trim() || CONTROL.test(notice.text)) bad();
    if (!Array.isArray(notice.buttons) || notice.buttons.length > PAGE_LIMITS.buttons) bad();
    const buttons = notice.buttons.map(button => {
      if (!keys(button, ['label', 'enabled']) || typeof button.label !== 'string' || !button.label.trim() ||
        button.label.length > PAGE_LIMITS.label || /[\r\n]/.test(button.label) || CONTROL.test(button.label)) bad();
      return { label: button.label, enabled: bool(button.enabled) };
    });
    const clipped = notice.text.length > PAGE_LIMITS.text;
    clippedAny ||= clipped;
    const { text, redacted } = redact(clipped ? notice.text.slice(0, PAGE_LIMITS.text) : notice.text);
    return { scope: notice.scope, text, buttons, redacted, clipped };
  });
  if (!Array.isArray(value.issues) || value.issues.length > PAGE_LIMITS.issues) bad();
  const issues = value.issues.map(issue => {
    if (!keys(issue, ['messageId', 'code']) || typeof issue.code !== 'string' || !CODE.test(issue.code)) bad();
    return { messageId: issue.messageId === null ? null : nativeMessageId(issue.messageId), code: issue.code };
  });
  return { observedAt, readable, nativeStatus: value.nativeStatus,
    controls: { stop: stop === null ? null : { visible: bool(stop.visible), enabled: bool(stop.enabled) }, approval: value.controls.approval },
    notices, issues, truncated: truncatedInput || clippedAny };
}
/** Change detection that ignores observation time. */
export const pageFingerprint = page => JSON.stringify({ ...page, observedAt: 0 });

// Pure collection failures: the page could not be faithfully read. They say
// nothing about whether the native ChatGPT task is running or stopped.
export const contentSyncCode = code => typeof code === 'string' && /^(ANSWER_|TRANSCRIPT_|OBSERVATION_)/.test(code);
// Observation-class failures that may be resumed after fresh page proof.
export const recoverableCode = code => contentSyncCode(code) || code === 'TURN_CHANGED';

/** Bounded per-turn sync issue ledger. Returns whether a visible transition happened. */
export function noteSyncIssue(turn, { code, messageId = null, blocking, at = Date.now() }) {
  turn.sync ??= { issues: [] };
  const issues = turn.sync.issues;
  const open = issues.find(x => x.code === code && x.messageId === messageId && x.resolvedAt === null);
  if (open) return { changed: false, transition: false };
  const wasBlocked = issues.some(x => x.blocking && x.resolvedAt === null);
  const previous = issues.find(x => x.code === code && x.messageId === messageId);
  if (previous) Object.assign(previous, { count: Math.min(previous.count + 1, 9999), at, resolvedAt: null, blocking });
  else {
    if (issues.length >= SYNC_LIMITS.issues) {
      const resolved = issues.findIndex(x => x.resolvedAt !== null);
      // Never forget an unresolved problem to admit a new one: fold the
      // overflow into a visible marker instead.
      if (resolved < 0) {
        const marker = issues.find(x => x.code === 'SYNC_ISSUES_TRUNCATED');
        if (marker) { marker.count = Math.min(marker.count + 1, 9999); marker.at = at; return { changed: true, transition: false }; }
        issues[issues.length - 1] = { code: 'SYNC_ISSUES_TRUNCATED', messageId: null, count: 1, at, resolvedAt: null, blocking: true };
        return { changed: true, transition: !wasBlocked };
      }
      issues.splice(resolved, 1);
    }
    issues.push({ code, messageId, count: 1, at, resolvedAt: null, blocking });
  }
  return { changed: true, transition: blocking ? !wasBlocked : false };
}
/** A later accepted, prefix-consistent answer proves the content lane is readable again. */
export function resolveContentIssues(turn, messageId, at = Date.now(), { exact = false } = {}) {
  let changed = false;
  for (const issue of turn.sync?.issues ?? []) {
    if (issue.resolvedAt !== null || !issue.blocking || issue.code === 'SYNC_ISSUES_TRUNCATED' ||
        issue.code.startsWith('OBSERVATION_STATUS_')) continue;
    if (issue.messageId !== messageId && (exact || issue.messageId !== null)) continue;
    issue.resolvedAt = at; changed = true;
  }
  return changed;
}
export function syncSummary(turn) {
  const issues = (turn?.sync?.issues ?? []).map(x => ({ ...x }));
  const open = issues.filter(x => x.resolvedAt === null);
  return { state: open.some(x => x.blocking) ? 'blocked' : open.length ? 'partial' : 'ok', issues };
}
export const contentBlocked = turn => syncSummary(turn).state === 'blocked';

/**
 * A failed, confirmed-delivery observation may be resumed. Excludes user
 * cancellation, Stop uncertainty, unconfirmed/discarded delivery, archived or
 * abandoned sessions, newer native turns and anything not observation-class.
 */
export function recoveryEligible(s, data, lastNativeMessageId, locked = false) {
  const t = s?.turn;
  return Boolean(t && s.status === 'idle' && t.outcome === 'failed' && !s.archiveIntent &&
    !data.archiveIndex?.[s.id] && recoverableCode(s.error) &&
    (t.failure?.code ?? s.error) === s.error &&
    s.conversationId && Number.isInteger(s.tabId) && s.tabId >= 0 && typeof s.documentKey === 'string' &&
    t.lease && t.nativeMessageId && !t.cancelRequested && !t.notSent && !t.discarded && t.receiptPending !== true &&
    (Number.isFinite(t.receivedAt) || t.origin === 'browser') &&
    lastNativeMessageId === t.nativeMessageId &&
    (t.observationRecoveries?.length ?? 0) < SYNC_LIMITS.recoveries && !locked &&
    !Object.values(data.commands).some(c => c.sessionId === s.id && ['queued', 'claimed', 'authorized'].includes(c.phase)));
}
export const activeDescriptor = s => ({ sessionId: s.id, tabId: s.tabId, documentKey: s.documentKey, conversationId: s.conversationId,
  turnId: s.turn.id, lease: s.turn.lease, nativeMessageId: s.turn.nativeMessageId ?? null, receiptPending: s.turn.receiptPending === true });
export const recoveryDescriptor = s => ({ sessionId: s.id, tabId: s.tabId, documentKey: s.documentKey, conversationId: s.conversationId,
  turnId: s.turn.id, lease: s.turn.lease, nativeMessageId: s.turn.nativeMessageId, recoveryOnly: true });
/** Observation proof: the original anchor is still present and is still the latest native user. */
export function recoveryProof(proof, nativeMessageId) {
  invariant(keys(proof, ['anchorPresent', 'latestUserId', 'nativeStatus']) && proof.anchorPresent === true &&
    typeof proof.latestUserId === 'string' && proof.latestUserId === nativeMessageId &&
    [null, 'in_progress', 'complete'].includes(proof.nativeStatus), 'RECOVERY_PROOF_REJECTED');
  return { nativeStatus: proof.nativeStatus };
}
