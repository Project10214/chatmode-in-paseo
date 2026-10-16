export const PROTOCOL = 5; // CIP browser bridge; Paseo Provider protocol remains v1.
export const PRODUCT = 'chatmode-in-paseo';
export const LIMITS = Object.freeze({ text: 64000, answer: 256000, body: 768000, apps: 32, models: 100, commands: 64, history: 1000, turnFragments: 16 });
export class BridgeError extends Error {
  constructor(code, message = code) { super(message); this.name = 'BridgeError'; this.code = code; }
}
export function invariant(ok, code, message) { if (!ok) throw new BridgeError(code, message); }
export const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export function text(x, cap = 200, allowEmpty = false) {
  invariant(typeof x === 'string' && x.length <= cap && (allowEmpty || x.trim().length > 0), 'INVALID_TEXT');
  return x;
}
export function identifier(x) { text(x, 200); invariant(/^[a-zA-Z0-9:._-]+$/.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x), 'INVALID_ID'); return x; }
/** A layout/search key must never become a receipt or streamed-message identity. */
export function nativeMessageId(x) {
  identifier(x);
  invariant(!/^fallback-turn-/i.test(x) && !/:(?:user|assistant)$/.test(x), 'NATIVE_MESSAGE_ID_UNPROVEN');
  return x;
}
export function conversationId(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'chatgpt.com') return null;
    return /^\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9-]+)(?:\/|$)/.exec(u.pathname)?.[1] ?? null;
  } catch { return null; }
}
export function validateCatalog(value) {
  invariant(object(value) && Array.isArray(value.models) && value.models.length > 0 && value.models.length <= LIMITS.models, 'INVALID_CATALOG');
  const options = list => {
    invariant(Array.isArray(list) && list.length <= LIMITS.models, 'INVALID_OPTIONS');
    const seen = new Set();
    return list.map(x => {
      invariant(object(x), 'INVALID_OPTION'); const id = text(x.id, 200), label = text(x.label, 200);
      invariant(!seen.has(id), 'DUPLICATE_OPTION'); seen.add(id); return { id, label };
    });
  };
  const models = options(value.models).map((m, i) => {
    const thinkingOptions = options(value.models[i].thinkingOptions ?? []);
    const def = value.models[i].defaultThinkingOptionId ?? value.models[i].defaultThinkingOption ?? null;
    invariant(def === null || thinkingOptions.some(t => t.id === def), 'INVALID_DEFAULT_THINKING');
    return { ...m, thinkingOptions, defaultThinkingOptionId: def };
  });
  const apps = options(value.apps ?? []);
  invariant(apps.length <= LIMITS.apps, 'TOO_MANY_APPS');
  // Apps must be installed native app identities, never an @name string.
  invariant(apps.every(a => /^asdk_app_[a-zA-Z0-9_-]+$/.test(a.id)), 'APP_ID_UNPROVEN');
  const defaultModel = value.defaultModel ?? models[0].id;
  invariant(models.some(m => m.id === defaultModel), 'INVALID_DEFAULT_MODEL');
  return { models, apps, defaultModel, observedAt: Date.now() };
}
export function validateSelection(selection, catalog) {
  invariant(catalog, 'CATALOG_REQUIRED', 'Refresh the signed-in browser catalog first.');
  const model = selection.model ?? catalog.defaultModel;
  const item = catalog.models.find(m => m.id === model);
  invariant(item, 'MODEL_UNAVAILABLE');
  const thinkingOption = selection.thinkingOption ?? item.defaultThinkingOptionId ?? null;
  invariant(thinkingOption === null || item.thinkingOptions.some(x => x.id === thinkingOption), 'THINKING_UNAVAILABLE');
  const appIds = selection.appIds ?? [];
  invariant(Array.isArray(appIds) && appIds.length <= LIMITS.apps && new Set(appIds).size === appIds.length, 'INVALID_APPS');
  invariant(appIds.every(id => catalog.apps.some(a => a.id === id)), 'APP_UNAVAILABLE');
  return { model, thinkingOption, appIds: [...appIds].sort() };
}
export function sameSelection(a, b) {
  return a?.model === b?.model && (a?.thinkingOption ?? null) === (b?.thinkingOption ?? null) &&
    Array.isArray(a?.appIds) && Array.isArray(b?.appIds) && [...a.appIds].sort().join('\n') === [...b.appIds].sort().join('\n');
}
