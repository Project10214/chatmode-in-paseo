/* Isolated-world adapter to the CoS passive system_hints observer.
 * A bounded native composer probe can make the page request its own completion
 * data. No direct endpoint fetch, copied credentials, menu scraping or Send.
 */
(() => {
  'use strict';
  globalThis.CIP_createAppCatalog = ({ fail, activate }) => {
    async function read(guard = () => {}, timeout = 18000) {
      guard(); const route = location.pathname;
      return new Promise((resolve, reject) => {
        let done = false, nonce = null, askedAt = 0, probe = null, probeAttempted = false;
        let replySeen = false, hintRequestSeen = false, pending = false;
        const makeError = code => Object.assign(new Error(code), { code });
        const finish = (error, value) => {
          if (done) return; done = true; clearInterval(timer);
          window.removeEventListener('message', receive);
          if (probe && probe.dispose() !== true && !error) error = makeError('APP_PROBE_CLEANUP_UNCONFIRMED');
          if (error && typeof error === 'object') error.diagnostic = { stage: 'apps',
            nativeProbeAttempted: probeAttempted, hintRequestSeen, observerReplySeen: replySeen };
          error ? reject(error) : resolve(value);
        };
        const refuse = code => { try { fail(code); } catch (error) { finish(error); } };
        const startedAt = performance.now();
        const check = () => {
          guard(); if (location.pathname !== route) throw makeError('APP_CATALOG_PAGE_CHANGED');
          probe?.check();
        };
        function ask() {
          if (done) return;
          try { check(); } catch (error) { return finish(error); }
          const elapsed = performance.now() - startedAt;
          if (elapsed >= timeout) return refuse('APP_CATALOG_UNAVAILABLE');
          // Passive observation is preferred. Only a known live observer with no
          // pending native response may ask the empty composer to load hints once.
          if (replySeen && !pending && !probeAttempted && typeof activate === 'function' && elapsed >= Math.min(500, timeout / 3)) {
            probeAttempted = true;
            try { probe = activate(guard); probe?.check(); } catch (error) { return finish(error); }
          }
          if (nonce && performance.now() - askedAt < 1500) return;
          nonce = crypto.randomUUID(); askedAt = performance.now();
          window.postMessage({ source: 'cip-cos-app-catalog-ask', nonce }, location.origin);
        }
        function receive(event) {
          const data = event.data;
          if (event.source !== window || event.origin !== location.origin) return;
          if (data?.source === 'cip-cos-apps-changed' && data.v === 1) { nonce = null; ask(); return; }
          if (data?.source !== 'cip-cos-app-catalog-reply' || data.v !== 1 || data.nonce !== nonce) return;
          nonce = null; replySeen = true;
          pending = data.pending === true;
          hintRequestSeen ||= pending || data.available === true || Boolean(data.error);
          try { check(); } catch (error) { return finish(error); }
          if (data.path !== route) return refuse('APP_CATALOG_PAGE_CHANGED');
          if (data.error) return refuse(typeof data.error === 'string' && /^APP_[A-Z_]{1,100}$/.test(data.error) ? data.error : 'APP_LIST_UNREADABLE');
          if (data.available !== true) return;
          if (pending || !Array.isArray(data.apps) || data.apps.length > 32 || !Number.isFinite(data.observedAt) || data.observedAt <= 0)
            return refuse('APP_ID_UNPROVEN');
          const apps = [], seen = new Set();
          for (const row of data.apps) {
            if (!row || typeof row.id !== 'string' || !/^asdk_app_[A-Za-z0-9_-]{1,160}$/.test(row.id) ||
                typeof row.label !== 'string' || !row.label.trim() || row.label.length > 80 || seen.has(row.id)) return refuse('APP_ID_UNPROVEN');
            seen.add(row.id); apps.push({ id: row.id, label: row.label });
          }
          finish(null, apps);
        }
        window.addEventListener('message', receive);
        const timer = setInterval(ask, 100); ask();
      });
    }
    return { read };
  };
})();
