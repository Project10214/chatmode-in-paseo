/* ISOLATED-world, optional raw-representation supplement. Does not classify,
 * replace DOM text, decode DIL, wait for completion or choose published formats.
 * The same-page nonce bridge scopes correlation; it is not a trust boundary
 * against a fully compromised page. MAIN independently verifies public owners.
 */
(() => {
  'use strict';
  if (globalThis.CIP_PUBLIC_MESSAGES) return;
  const REQUEST = 'cip-public-message-read', REPLY = 'cip-public-message-reply';
  const conversation = () => /^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9-]+)(?:\/|$)/.exec(location.pathname)?.[1] ?? null;
  let path = location.pathname, epoch = 0;
  const moved = () => { if (location.pathname !== path) { path = location.pathname; epoch++; } };
  globalThis.navigation?.addEventListener('currententrychange', moved);
  addEventListener('popstate', moved); addEventListener('hashchange', moved);
  async function read(items, guard = () => {}) {
    const issues = [], ids = new Set();
    if (!Array.isArray(items)) return { messages: [], issues: [{ code: 'PUBLIC_MESSAGE_INPUT_INVALID', nativeMessageId: null }] };
    for (const item of items) {
      if (!item || item.role !== 'assistant' || item.lane !== 'output' || item.kind !== 'message') continue;
      const id = item.nativeMessageId;
      if (typeof id !== 'string' || !id || id.trim() !== id) {
        issues.push({ code: 'PUBLIC_MESSAGE_NATIVE_ID_MISSING', nativeMessageId: null,
          id: typeof item.id === 'string' ? item.id : null });
      } else ids.add(id);
    }
    if (!ids.size) return { messages: [], issues };
    const capturedPath = location.pathname, cid = conversation(), capturedEpoch = epoch;
    const issueAll = code => [...issues, ...[...ids].map(nativeMessageId => ({ nativeMessageId, code }))];
    if (!cid || location.origin !== 'https://chatgpt.com') return { messages: [], issues: issueAll('PUBLIC_MESSAGE_CONVERSATION_UNPROVEN') };
    const valid = () => {
      guard();
      if (capturedPath !== location.pathname || capturedEpoch !== epoch || cid !== conversation())
        throw new Error('route changed');
    };
    try { valid(); } catch { return { messages: [], issues: issueAll('PUBLIC_MESSAGE_GUARD_REJECTED') }; }
    const nonce = crypto.randomUUID();
    const reply = await new Promise(resolve => {
      let timeout;
      const done = value => { clearTimeout(timeout); window.removeEventListener('message', receive); resolve(value); };
      const receive = event => {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || !data || data.source !== REPLY ||
            data.v !== 1 || data.nonce !== nonce || data.path !== capturedPath || data.conversationId !== cid) return;
        done(data);
      };
      window.addEventListener('message', receive);
      timeout = setTimeout(() => done(null), 1500);
      try { window.postMessage({ source: REQUEST, v: 1, nonce, path: capturedPath, conversationId: cid,
        nativeMessageIds: [...ids] }, location.origin); }
      catch { done(null); }
    });
    try { valid(); } catch { return { messages: [], issues: issueAll('PUBLIC_MESSAGE_GUARD_REJECTED') }; }
    if (!reply || !Array.isArray(reply.messages) || !Array.isArray(reply.issues))
      return { messages: [], issues: issueAll('PUBLIC_MESSAGE_SUPPLEMENT_UNAVAILABLE') };
    const messages = new Map(), conflicts = new Set();
    for (const value of reply.messages) {
      if (!value || !ids.has(value.nativeMessageId)) continue;
      if (typeof value.rawText !== 'string' || !['markdown', 'dil'].includes(value.representation) ||
          !Number.isFinite(value.observedAt) || value.eof !== undefined && typeof value.eof !== 'boolean') {
        conflicts.add(value.nativeMessageId); continue;
      }
      const clean = { nativeMessageId: value.nativeMessageId, rawText: value.rawText,
        representation: value.representation, observedAt: value.observedAt, ...(value.eof === true ? {eof:true} : {}) };
      const previous = messages.get(clean.nativeMessageId);
      if (previous && (previous.rawText !== clean.rawText || previous.representation !== clean.representation || previous.eof !== clean.eof))
        conflicts.add(clean.nativeMessageId);
      else messages.set(clean.nativeMessageId, clean);
    }
    for (const id of conflicts) {
      messages.delete(id); issues.push({ nativeMessageId: id, code: 'PUBLIC_MESSAGE_REPLY_CONFLICT' });
    }
    for (const value of reply.issues) if (value && ids.has(value.nativeMessageId) &&
        typeof value.code === 'string' && /^[A-Z_]{1,100}$/.test(value.code))
      issues.push({ nativeMessageId: value.nativeMessageId, code: value.code });
    for (const id of ids) if (!messages.has(id) && !issues.some(issue => issue.nativeMessageId === id))
      issues.push({ nativeMessageId: id, code: 'PUBLIC_MESSAGE_RAW_UNAVAILABLE' });
    return { messages: [...messages.values()], issues };
  }
  globalThis.CIP_PUBLIC_MESSAGES = Object.freeze({ read });
})();
