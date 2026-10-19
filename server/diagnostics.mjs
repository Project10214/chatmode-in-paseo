/** Whitelisted operational evidence only: no prompts, app names, URLs or secrets. */
export function safeDiagnostic(value) {
  if (!value || typeof value !== 'object' || !['composer', 'chat-surface', 'models', 'apps', 'receipt', 'binding'].includes(value.stage)) return null;
  const out = { stage: value.stage };
  for (const key of ['editorCount', 'panelCount', 'rowCount', 'matchingUserCount']) {
    const n = value[key];
    if (Number.isInteger(n) && n >= 0 && n <= 128) out[key] = n;
  }
  if (value.stage === 'composer') {
    if (value.draftDiagnosticsVersion === 1) out.draftDiagnosticsVersion = 1;
    if (['configure-start','apps-before-discovery','apps-after-discovery','send-before-insert','catalog-start'].includes(value.checkpoint)) out.checkpoint = value.checkpoint;
    if (typeof value.extensionVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,5}(?:\.\d{1,5})?$/.test(value.extensionVersion)) out.extensionVersion = value.extensionVersion;
    if (['DIV','TEXTAREA','OTHER'].includes(value.editorTag)) out.editorTag = value.editorTag;
    if (['loading','interactive','complete'].includes(value.readyState)) out.readyState = value.readyState;
    for (const key of ['draftChars','rawChars','visibleChars','valueChars','editableChars','nonEditableChars','hiddenChars','placeholderChars','zeroWidthChars','injectionDraftChars','readyDraftChars'])
      if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 64000) out[key] = value[key];
    for (const key of ['textNodes','appCount'])
      if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 128) out[key] = value[key];
    for (const key of ['msSinceInjection','msSinceReady'])
      if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 60000) out[key] = value[key];
    for (const key of ['initiallyEmpty','emptyAtInjection','editorReplaced','hasPaseoContextHeader','sameEditorSinceInjection','snapshotTruncated','pageGenerating'])
      if (typeof value[key] === 'boolean') out[key] = value[key];
  }
  if (value.stage === 'binding' && ['identity_unavailable','message_unavailable','monitor_unavailable','page_loading','route_changed','message_changed','page_closed','multiple_tabs','unsupported_engine','ownership_conflict','invalid_message_id','wait_capacity','observation_rejected','receipt_identity_conflict','receipt_observation_unavailable'].includes(value.reason)) out.reason = value.reason;
  if (value.stage === 'apps') {
    for (const key of ['nativeProbeAttempted', 'hintRequestSeen', 'observerReplySeen'])
      if (typeof value[key] === 'boolean') out[key] = value[key];
  }
  if (value.stage === 'receipt') {
    for (const key of ['exactUserCount', 'escapedUserCount', 'sourceSections', 'sourceMatches', 'sourceUsers']) {
      if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 128) out[key] = value[key];
    }
    if (['raw', 'markdown', 'request', 'mismatch'].includes(value.bodyMatch)) out.bodyMatch = value.bodyMatch;
    if (['unavailable','armed','request','shape','parsed','mismatch','body','response','route','late','accepted'].includes(value.networkStage)) out.networkStage=value.networkStage;
    if (typeof value.networkRouteMoved === 'boolean') out.networkRouteMoved=value.networkRouteMoved;
    for (const key of ['nativeClicked', 'transcriptAvailable', 'pathChanged', 'routeKnown']) if (typeof value[key] === 'boolean') out[key] = value[key];
    if (['chat-changed', 'not-accepted', 'other'].includes(value.refusal)) out.refusal = value.refusal;
    if (['DRAFT_CHANGED','PAGE_GONE','DOCUMENT_CHANGED','WRONG_CONVERSATION','NAVIGATION_CHANGED','COMMAND_CANCELLED','COMMAND_DEADLINE_EXCEEDED','SEND_LIFETIME_REVOKED','GUARD_FAILED'].includes(value.guardCode)) out.guardCode = value.guardCode;
  }
  return out;
}
export function safeError(error) {
  const code = typeof error === 'string' ? error : error?.code || error?.message;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,159}$/.test(code) ? code : 'CATALOG_FAILED';
}
export function catalogAttempt(state) {
  const command = Object.values(state.commands).filter(c => c.kind === 'catalog').sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!command) return null;
  return { phase: command.phase, at: command.createdAt, error: command.error ? safeError(command.error) : null,
    diagnostic: safeDiagnostic(command.diagnostic) };
}
import { catalogService } from './catalog.mjs';
/** The same live binding membership as Broker.observationBindings, not runs.
 * archiveIntent still observes until safe closure; archival removes sessions.
 * Missing/unreadable control evidence is unknown, never confirmed standby.
 * Counts contain no prompts, approval text or source identities.
 */
export function observationHealth(state, _broker) {
  const result = { bound: 0, running: 0, standby: 0, abnormal: 0, sourceIssues: 0, lastObservedAt: null };
  // Same partition as shared/page-state.ts; tested together without requiring
  // a TS runtime loader in this directly executable server module.
  const controlIssues = new Set(['CONTROLS_READ_FAILED', 'CONTROLS_METADATA_TOO_LARGE',
    'PAGE_STATUS_INVALID', 'OBSERVATION_UNAVAILABLE', 'PAGE_OBSERVER_UNAVAILABLE']);
  const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
  for (const [id, session] of Object.entries(state.sessions ?? {})) {
    if (!session?.conversationId || !Number.isInteger(session.tabId) || !session.documentKey ||
        session.status === 'abandoned' || !session.observation) continue;
    result.bound++;
    const observation = session.observation, page = observation?.page;
    const readable = page?.readable === true && ['stop', 'send', 'voice'].every(key =>
      typeof page.controls?.[key]?.visible === 'boolean' && typeof page.controls[key].enabled === 'boolean');
    const status = page?.controls?.stop?.visible === true ? 'running' : !readable ? 'abnormal' :
      page.controls.send.visible || page.controls.voice.visible ? 'standby' : 'abnormal';
    result[status]++;
    // The current page-state history row persists the capture/projection
    // issues; observation.page itself contains only button facts today.
    const card = (session.history ?? []).find(row => row.type === 'plugin' && row.kind === 'page-state' &&
      row.version === 1 && row.id === 'page-state:' + (session.id ?? id));
    const issues = page && card?.data?.observedAt === page.observedAt && Array.isArray(card?.data?.issues) ? card.data.issues :
      Array.isArray(page?.issues) ? page.issues : [];
    result.sourceIssues += issues.filter(issue => typeof issue?.code === 'string' && issue.code && !controlIssues.has(issue.code)).length;
    for (const at of [page?.observedAt, observation?.lastObservedAt])
      if (timestamp(at)) result.lastObservedAt = Math.max(result.lastObservedAt ?? 0, at);
  }
  return result;
}
/** Status reads never acquire a browser tab. Normal startup is automatic; refresh is a fallback. */
export async function settingsSnapshot(runtime, refresh = false) {
  let refreshError = null;
  const service = catalogService(runtime);
  if (refresh) {
    if (!runtime.status().connected) refreshError = 'EXTENSION_OFFLINE';
    else service.start();
  }
  const state = runtime.store.read(), lastCatalogAttempt = catalogAttempt(state);
  const { refreshing, refreshStartedAt, error } = service.snapshot();
  if (!refreshError && !refreshing) refreshError = error || (lastCatalogAttempt?.phase === 'failed' ? lastCatalogAttempt.error : null);
  return { checkedAt: Date.now(), status: runtime.status(), observation: observationHealth(state, runtime.broker), catalog: state.catalog, defaults: state.defaults,
    autoAllow: state.runtimeSettings?.autoAllowApprovals === true,
    capacity: runtime.broker.slots?.snapshot() ?? { limit: 2, active: 0, waiting: 0 },
    refreshing, refreshStartedAt, refreshError, lastCatalogAttempt,
    blocked: Object.values(state.sessions).filter(s => s.status === 'blocked').map(s => ({ id: s.id, error: safeError(s.error ?? 'RESULT_UNCONFIRMED') })) };
}
