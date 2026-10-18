/** Host subscription barrier, shared by the wake coordinator and Provider.
 *
 * Paseo 0.11.4 (agent-loading.js ensureAgentLoaded -> registerSession, which
 * calls subscribeToSession last) answers list_commands_request only after a
 * resumed Agent's host session is registered AND subscribed. Events a Provider
 * emits while that host session is still opening are kept only as bridge
 * history and never processed as lifecycle. So a resumed turn's `started`
 * must wait for a commands() that resolved without an error.
 *
 * Proof scope: each barrier request is issued by ONE Provider host binding
 * after its session.ready, and only that request's own result may unlock that
 * same binding object. There is no broadcast and no reuse of an older wake
 * that may have been answered for a previous host session. A barrier proves
 * only "loaded and subscribed now", never message persistence.
 * Explicit wiring only; there is deliberately no module singleton.
 */
export function createHostObservation() {
  let waker = null, timelineReader = null;
  const retryListeners = new Set(), outstanding = new Set();
  return {
    /** The wake coordinator registers its read-only commands() barrier. */
    attachWaker(fn) { waker = fn; return () => { if (waker === fn) waker = null; }; },
    available() { return typeof waker === 'function'; },
    attachTimelineReader(fn) { timelineReader=fn;return ()=>{if(timelineReader===fn)timelineReader=null;}; },
    async readTimeline(sessionId,scope) {
      if(!timelineReader)throw Object.assign(new Error('HOST_READ_UNAVAILABLE'),{code:'HOST_READ_UNAVAILABLE'});
      return timelineReader(sessionId,scope);
    },
    /** A fresh barrier for one binding. Resolves {woken:true} only after commands() succeeded. */
    request(sessionId) {
      if (!waker) return Promise.resolve({ woken: false, reason: 'NO_HOST_WAKER' });
      const work = Promise.resolve().then(() => waker(sessionId, { barrier: true }))
        .catch(() => ({ woken: false, reason: 'HOST_WAKE_UNAVAILABLE' }));
      outstanding.add(work); void work.finally(() => outstanding.delete(work));
      return work;
    },
    /** The host API became (re)available: pending bindings may ask again. Not a proof. */
    hostAvailable() { for (const fn of [...retryListeners]) { try { fn(); } catch { /* isolated */ } } },
    onHostAvailable(fn) { retryListeners.add(fn); return () => retryListeners.delete(fn); },
    /** Test/diagnostic aid: settles once no barrier request is in flight. */
    async drain() { while (outstanding.size) await Promise.allSettled([...outstanding]); }
  };
}
