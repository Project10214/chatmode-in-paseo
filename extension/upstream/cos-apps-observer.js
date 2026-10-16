/*
 * Chat On Steroids (MIT) — direct, scoped extraction from extension/usage.js
 * @ e40562640361ca8f74158b2262ca8c555b00abed, inspectSystemHints + installFetchObserver.
 * Copyright (c) 2026 Chat On Steroids contributors. See vendor/cos/LICENSE.
 * CIP changes: all native app IDs instead of Core-only names; complete plugins lists
 * only; request-order fencing; explicit unavailable/errors; nonce-bound replay.
 * PASSIVE: observes only the page's own GET /backend-api/system_hints?mode=plugins.
 * Never initiates a request, reads request headers/bodies, cookies or login tokens.
 */
(() => {
  'use strict';
  const VERSION = 1, HANDLE = '__CIP_COS_APPS_OBSERVER__';
  const prior = window[HANDLE];
  if (prior?.version === VERSION && prior.refresh?.() === true) return;
  if (prior && typeof prior.dispose !== 'function') return;
  prior?.dispose();
  let active = true, observedFetch = null, sequence = 0;
  let latest = null, lastError = null, pending = false;
  const readers = new Set(), inspectedResponses = new WeakSet();
  const nativePost = window.postMessage.bind(window);
  const appId = /^(?:plugin|connector):(asdk_app_[A-Za-z0-9_-]{1,160})$/;
  const isList = value => {
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin && url.pathname === '/backend-api/system_hints' && url.searchParams.get('mode') === 'plugins';
    } catch { return false; }
  };
  const publicState = () => ({ available: latest !== null, pending, error: lastError,
    apps: latest?.apps ?? [], observedAt: latest?.observedAt ?? null });
  const changed = () => { if (active) nativePost({ source: 'cip-cos-apps-changed', v: VERSION }, location.origin); };
  const failed = (order, code) => {
    if (!active || order !== sequence) return;
    latest = null; pending = false; lastError = code; changed();
  };
  // The bounded clone/reader and native hint identity extraction are from CoS.
  async function inspectSystemHints(response, order) {
    if (!active || order !== sequence) return;
    if (!isList(response.url)) return failed(order, 'APP_LIST_RESPONSE_UNCONFIRMED');
    if (!response.ok) return failed(order, response.status === 401 || response.status === 403
      ? 'APP_LIST_LOGIN_REQUIRED' : response.status === 429 ? 'APP_LIST_RATE_LIMITED' : 'APP_LIST_HTTP_ERROR');
    if (!response.headers.get('content-type')?.includes('application/json')) return failed(order, 'APP_LIST_FORMAT_UNSUPPORTED');
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return failed(order, 'APP_LIST_UNREADABLE');
    if (readers.size >= 4) { void reader.cancel().catch(() => {}); return failed(order, 'APP_LIST_READER_LIMIT'); }
    readers.add(reader);
    let expired = false;
    const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 10000);
    let bytes = 0, text = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) return failed(order, 'APP_LIST_TOO_LARGE');
        text += decoder.decode(value, { stream: true });
      }
      if (expired) return failed(order, 'APP_LIST_READ_TIMEOUT');
      const data = JSON.parse(text + decoder.decode()), list = data?.system_hints;
      if (!Array.isArray(list)) return failed(order, 'APP_LIST_FORMAT_UNSUPPORTED');
      if (list.length > 2000) return failed(order, 'APP_LIST_TOO_LARGE');
      // An explicitly paginated result must not masquerade as the full app list.
      if (data.has_more === true || data.next_cursor || data.next_page_token) return failed(order, 'APP_LIST_INCOMPLETE');
      const byId = new Map();
      for (const hint of list) {
        const id = appId.exec(typeof hint?.system_hint === 'string' ? hint.system_hint : '')?.[1];
        if (!id) continue;
        if (typeof hint.name !== 'string' || !hint.name.trim() || hint.name.length > 80 || /[\u0000-\u001f\u007f]/.test(hint.name))
          return failed(order, 'APP_ID_UNPROVEN');
        const name = hint.name.trim();
        if (byId.has(id) && byId.get(id) !== name) return failed(order, 'APP_ID_CONFLICT');
        byId.set(id, name);
      }
      if (byId.size > 32) return failed(order, 'APP_CATALOG_TOO_LARGE');
      if (!active || order !== sequence) return;
      latest = { apps: [...byId].map(([id, label]) => ({ id, label })), observedAt: Date.now() };
      lastError = null; pending = false; changed();
    } catch { failed(order, 'APP_LIST_UNREADABLE'); }
    finally { clearTimeout(timer); readers.delete(reader); void reader.cancel().catch(() => {}); }
  }
  const installFetchObserver = () => {
    if (!active || window.fetch === observedFetch || typeof window.fetch !== 'function') return;
    // Capture per installation, preserving page instrumentation without wrapper cycles.
    const downstreamFetch = window.fetch;
    observedFetch = function (...args) {
      let qualifies = false;
      try {
        const request = args[0];
        const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request?.url;
        const method = String(args[1]?.method || request?.method || 'GET').toUpperCase();
        qualifies = method === 'GET' && isList(url);
      } catch { /* Unknown requests remain entirely untouched. */ }
      const order = qualifies && active ? ++sequence : null;
      if (order !== null) { latest = null; lastError = null; pending = true; changed(); }
      let result;
      try { result = downstreamFetch.apply(this, args); }
      catch (error) { if (order !== null) failed(order, 'APP_LIST_NETWORK_ERROR'); throw error; }
      if (!active || order === null) return result;
      void result.then(response => {
        if (!active || inspectedResponses.has(response)) return;
        inspectedResponses.add(response);
        void inspectSystemHints(response, order).catch(() => failed(order, 'APP_LIST_UNREADABLE'));
      }).catch(() => failed(order, 'APP_LIST_NETWORK_ERROR'));
      return result; // Return the ORIGINAL response promise, never the inspection promise.
    };
    window.fetch = observedFetch;
  };
  const request = event => {
    const data = event.data;
    if (!active || event.source !== window || event.origin !== location.origin || data?.source !== 'cip-cos-app-catalog-ask' ||
        typeof data.nonce !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(data.nonce)) return;
    installFetchObserver();
    nativePost({ source: 'cip-cos-app-catalog-reply', v: VERSION, nonce: data.nonce,
      path: location.pathname, ...publicState() }, location.origin);
  };
  const hide = () => { latest = null; lastError = null; pending = false; sequence++; for (const reader of readers) void reader.cancel().catch(() => {}); };
  installFetchObserver();
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', installFetchObserver, { once: true });
  window.addEventListener('message', request);
  window.addEventListener('pagehide', hide);
  window[HANDLE] = { version: VERSION,
    refresh() { installFetchObserver(); return active; },
    dispose() { active = false; hide(); readers.clear(); window.removeEventListener('message', request);
      window.removeEventListener('pagehide', hide); window.removeEventListener('DOMContentLoaded', installFetchObserver); }
  };
})();
