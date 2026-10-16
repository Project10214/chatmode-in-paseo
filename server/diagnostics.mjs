/** Whitelisted operational evidence only: no prompts, app names, URLs or secrets. */
export function safeDiagnostic(value) {
  if (!value || typeof value !== 'object' || !['composer', 'chat-surface', 'models', 'apps', 'receipt', 'binding'].includes(value.stage)) return null;
  const out = { stage: value.stage };
  for (const key of ['editorCount', 'panelCount', 'rowCount', 'matchingUserCount']) {
    const n = value[key];
    if (Number.isInteger(n) && n >= 0 && n <= 128) out[key] = n;
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
  return { checkedAt: Date.now(), status: runtime.status(), catalog: state.catalog, defaults: state.defaults,
    capacity: runtime.broker.slots?.snapshot() ?? { limit: 2, active: 0, waiting: 0 },
    refreshing, refreshStartedAt, refreshError, lastCatalogAttempt,
    blocked: Object.values(state.sessions).filter(s => s.status === 'blocked').map(s => ({ id: s.id, error: safeError(s.error ?? 'RESULT_UNCONFIRMED') })) };
}
