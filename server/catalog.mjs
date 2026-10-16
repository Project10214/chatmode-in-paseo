import { BridgeError } from './protocol.mjs';

const services = new WeakMap();
const pending = c => c.kind === 'catalog' && ['queued', 'claimed', 'authorized'].includes(c.phase);
const codeOf = e => /^[A-Z][A-Z0-9_]{0,159}$/.test(e?.code ?? e?.message ?? '') ? e.code ?? e.message : 'CATALOG_FAILED';
/** One discovery owner shared by automatic startup, provider discovery and settings.
 * Reading/polling never starts a browser operation. A browser incarnation starts once;
 * cached success is reused and failed automatic reads are not replayed in a tight loop.
 */
export function catalogService(runtime) {
  let service = services.get(runtime);
  if (!service) { service = new CatalogService(runtime); services.set(runtime, service); }
  return service;
}
class CatalogService {
  constructor(runtime) {
    this.runtime = runtime; this.flight = null; this.lastError = null; this.failureAt = 0;
    this.browser = null; this.autoPending = false; this.closed = false;
  }
  noteBrowser(identity) {
    if (this.closed || this.browser === identity) return;
    this.browser = identity; this.autoPending = true;
    this.tick();
  }
  tick() {
    if (this.closed || !this.autoPending || !this.runtime.status().connected) return;
    const state = this.runtime.store.read();
    if (Object.values(state.sessions).some(s => ['sending', 'running', 'stopping'].includes(s.status))) return;
    this.autoPending = false;
    // Automatic request retains its own consumer until settled; UI closing cannot cancel it.
    void this.ensure({ force: true }).catch(() => {});
  }
  snapshot() {
    const active = Object.values(this.runtime.store.read().commands).find(pending);
    return { refreshing: Boolean(this.flight || active),
      refreshStartedAt: active?.createdAt ?? this.flight?.startedAt ?? null,
      error: this.flight || active ? null : this.lastError };
  }
  async forForm({ signal } = {}) {
    if (this.closed || signal?.aborted) throw new BridgeError('CONNECTION_CLOSED');
    if (!this.runtime.status().connected) throw new BridgeError('EXTENSION_OFFLINE');
    // Paseo asks for choices BEFORE a native conversation exists. This is not
    // an execution authorization or a request to open another discovery tab.
    // Keep the last confirmed choices through age/refresh failures. The native
    // page still verifies the exact model and selected apps before every Send.
    // Do not reset lastError or stamp old data with a new observation time.
    const catalog = this.runtime.store.read().catalog;
    if (catalog) return { catalog, fromCache: true };
    return this.ensure({ signal });
  }
  async ensure({ force = false, signal } = {}) {
    if (this.closed || signal?.aborted) throw new BridgeError('CONNECTION_CLOSED');
    if (!this.runtime.status().connected) throw new BridgeError('EXTENSION_OFFLINE');
    let job = this.flight;
    if (!job) {
      const state = this.runtime.store.read();
      if (!force && this.lastError && Date.now() - this.failureAt < 60000) throw new BridgeError(this.lastError);
      if (!force && !this.lastError && state.catalog && Date.now() - state.catalog.observedAt < 5 * 60000)
        return { catalog: state.catalog };
      job = { controller: new AbortController(), consumers: new Set(), startedAt: Date.now(), settled: false };
      this.flight = job; this.lastError = null;
      job.promise = Promise.resolve().then(() => {
        const existing = Object.values(this.runtime.store.read().commands).find(pending);
        return existing ? this.runtime.broker.wait(existing.id)
          : this.runtime.broker.call('catalog', null, {}, { signal: job.controller.signal });
      }).then(value => { this.lastError = null; return value; }, error => {
        this.lastError = codeOf(error); this.failureAt = Date.now(); throw error;
      }).finally(() => { job.settled = true; if (this.flight === job) this.flight = null; });
      void job.promise.catch(() => {});
    }
    return new Promise((resolve, reject) => {
      const owner = {}; job.consumers.add(owner); let done = false;
      const finish = (error, value) => {
        if (done) return; done = true; signal?.removeEventListener('abort', abort); job.consumers.delete(owner);
        if (!job.settled && !job.consumers.size) job.controller.abort();
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new BridgeError('CONNECTION_CLOSED'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      job.promise.then(value => finish(null, value), error => finish(error));
    });
  }
  start() {
    // Immediate acknowledgement, never await a browser roundtrip inside a settings RPC.
    void this.ensure({ force: true }).catch(() => {});
  }
  close() { this.closed = true; this.autoPending = false; this.flight?.controller.abort(); }
}
