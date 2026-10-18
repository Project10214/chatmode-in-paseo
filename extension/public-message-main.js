/* Read-only MAIN-world supplement for an already classified, visible native
 * assistant output. Not a transcript, history/cache reader or state machine.
 * No private reasoning, tool payloads, getters, completion gates or actions.
 */
(() => {
  'use strict';
  if (globalThis.__CIP_PUBLIC_MESSAGE_MAIN__) return;
  globalThis.__CIP_PUBLIC_MESSAGE_MAIN__ = true;
  const REQUEST = 'cip-public-message-read', REPLY = 'cip-public-message-reply';
  const post = window.postMessage.bind(window);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  // An accessor is executable page code, not a proved public representation.
  function own(value, key) {
    if (value === null || typeof value !== 'object') return undefined;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field) return undefined;
    if (!Object.prototype.hasOwnProperty.call(field, 'value')) fail('PUBLIC_MESSAGE_ACCESSOR_UNPROVEN');
    return field.value;
  }
  const conversation = () => /^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9-]+)(?:\/|$)/.exec(location.pathname)?.[1] ?? null;
  const WORK = /^(?:Work(?:\s+for\s+.+)?|Worked\s+for\s+.+|Previous activity|工作(?:过程|记录)?|思考过程|之前的活动)$/i;
  const PRIVATE = '[hidden],[aria-hidden="true"],[inert],.clf-stream,.clf-stage,.clf-composer,.clf-boot,[data-cip-owned],'+
    '[data-message-channel="analysis"],[data-message-channel="private"],[data-channel="analysis"],[data-channel="private"],'+
    '[data-private="true"],[data-reasoning-visibility="private"],[data-summary-type="raw_cot"],'+
    '[contenteditable="true"],textarea,input,aside,nav,[role="navigation"],[role="complementary"]';
  function visible(node, cid, panels = new Set()) {
    if (!node.isConnected || !node.getClientRects().length || node.closest(PRIVATE)) return false;
    for (let at = node; at; at = at.parentElement) {
      if (panels.has(at)) return false;
      const scope = at.getAttribute('data-conversation-id');
      if (scope && scope !== cid) return false;
      const style = getComputedStyle(at);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0' ||
          style.contentVisibility === 'hidden') return false;
      if (at.tagName === 'DETAILS') {
        const summary = at.querySelector(':scope > summary');
        if (!at.open && node !== at && !summary?.contains(node)) return false;
        if (WORK.test(summary?.textContent?.trim() ?? '')) return false;
      }
    }
    return true;
  }
  function workPanels(cid) {
    const panels = new Set();
    for (const button of document.querySelectorAll('button[aria-controls]')) {
      try {
        if (!visible(button, cid) || !WORK.test(button.textContent.trim())) continue;
        const ids = button.getAttribute('aria-controls').trim().split(/\s+/);
        if (ids.length !== 1 || !ids[0]) continue;
        const panel = document.getElementById(ids[0]);
        if (panel && !panel.contains(button)) panels.add(panel);
      } catch { /* An unidentified disclosure never permits hidden reads. */ }
    }
    return panels;
  }
  function nativeIds(node) {
    const values = [], direct = node.getAttribute('data-message-id'), search = node.getAttribute('data-chatgpt-search-message-ids');
    if (direct) values.push(direct);
    if (search) {
      let ids;
      if (search.trim().startsWith('[')) {
        try { ids = JSON.parse(search); } catch { fail('PUBLIC_MESSAGE_DOM_ID_UNPROVEN'); }
        if (!Array.isArray(ids)) fail('PUBLIC_MESSAGE_DOM_ID_UNPROVEN');
      } else ids = search.trim().split(/\s+/);
      values.push(...ids);
    }
    if (values.some(value => typeof value !== 'string' || !value.trim())) fail('PUBLIC_MESSAGE_DOM_ID_UNPROVEN');
    return [...new Set(values.map(value => value.trim()))];
  }
  function assistantDom(node) {
    const role = node.getAttribute('data-message-author-role');
    const unit = node.getAttribute('data-chatgpt-search-unit-key') || node.getAttribute('data-content-search-unit-key');
    const tone = node.getAttribute('data-markdown-text-tone'), style = node.getAttribute('data-markdown-text-style');
    if (role && role !== 'assistant' || /:user$/.test(unit || '') || tone === 'user-message') return false;
    return role === 'assistant' || /:assistant$/.test(unit || '') || style === 'assistant-message';
  }
  function committed(fiber) {
    const path = [], seen = new Set(); let at = fiber;
    while (at && own(at, 'tag') !== 3) {
      if (seen.has(at)) fail('PUBLIC_MESSAGE_FIBER_CYCLE');
      seen.add(at); path.push(at); at = own(at, 'return');
    }
    if (!at) fail('PUBLIC_MESSAGE_COMMIT_UNPROVEN');
    const root = own(at, 'stateNode'), current = own(root, 'current');
    if (!current || current !== at && current !== own(at, 'alternate')) fail('PUBLIC_MESSAGE_COMMIT_UNPROVEN');
    const chain = [current]; let selected = current;
    for (let i = path.length - 1; i >= 0; i--) {
      const wanted = path[i], alternate = own(wanted, 'alternate'), siblings = new Set(); let found = null;
      for (let child = own(selected, 'child'); child; child = own(child, 'sibling')) {
        if (siblings.has(child)) fail('PUBLIC_MESSAGE_FIBER_CYCLE');
        siblings.add(child);
        if (child !== wanted && child !== alternate) continue;
        if (found) fail('PUBLIC_MESSAGE_COMMIT_UNPROVEN');
        found = child;
      }
      if (!found || own(root, 'current') !== current) fail('PUBLIC_MESSAGE_COMMIT_UNPROVEN');
      chain.push(found); selected = found;
    }
    return { root, current, chain: chain.reverse() };
  }
  function fibersOf(anchor) {
    // Only this visible message's nearest mounted React host, never DOM-wide
    // Fiber enumeration, hook state, children-prop recursion or query caches.
    for (let node = anchor; node; node = node.parentElement) {
      const keys = Object.getOwnPropertyNames(node).filter(key => key.startsWith('__reactFiber$'));
      if (keys.length) return keys.map(key => committed(own(node, key)));
    }
    fail('PUBLIC_MESSAGE_FIBER_UNAVAILABLE');
  }
  const forbidden = value => ['analysis', 'private', 'raw_cot', 'commentary', 'hidden'].includes(value);
  function candidateId(value) {
    const type = own(value, 'type');
    if (typeof type === 'string' && !['assistant-message', 'message'].includes(type)) return null;
    const names = type === 'assistant-message' ? ['messageId', 'latestMessageId'] : ['id', 'messageId'];
    const ids = names.map(key => own(value, key)).filter(id => typeof id === 'string' && id.length > 0);
    if (!ids.length) return null;
    return { ids: [...new Set(ids)], typed: type === 'assistant-message' };
  }
  function publicAssistant(value, typed) {
    const role = own(value, 'role'), authorRole = own(own(value, 'author'), 'role');
    if (role !== undefined && role !== 'assistant' || authorRole !== undefined && authorRole !== 'assistant' ||
        !typed && role !== 'assistant' && authorRole !== 'assistant') return false;
    const phase = own(value, 'phase'), channel = own(value, 'channel'), recipient = own(value, 'recipient');
    if (typed && phase !== 'final_answer' || forbidden(phase) || forbidden(channel) || recipient != null && recipient !== 'all') return false;
    if (own(value, 'isVisuallyHidden') === true || forbidden(own(value, 'visibility'))) return false;
    const metadata = own(value, 'metadata');
    for (const key of ['is_visually_hidden', 'is_visually_hidden_from_conversation', 'is_visually_hidden_reasoning_group'])
      if (own(metadata, key) === true) return false;
    return !forbidden(own(metadata, 'summary_type')) && !forbidden(own(metadata, 'visibility'));
  }
  const REFERENCES_ONLY = /^\s*(?:::chatgpt-content-reference\{[^}\n]*\}\s*)+$/;
  // Optional PUBLIC own data only. Never invoke completion/status accessors,
  // and never gate collection or page state on these fields. EOF resolves only
  // ambiguous representation syntax at this one message's terminal boundary.
  function terminal(value) {
    const data = key => {
      const descriptor = Object.getOwnPropertyDescriptor(value,key);
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor,'value') ? descriptor.value : undefined;
    };
    const completed=data('completed'),status=data('status');
    if(completed===false||status==='in_progress')return {};
    return completed===true||['finished_successfully','finished_partial'].includes(status) ? {eof:true} : {};
  }
  function rawOf(value, id) {
    const content = own(value, 'content');
    let raw;
    if (typeof content === 'string') raw = content;
    else if (object(content) && own(content, 'content_type') === 'text') {
      const parts = own(content, 'parts');
      if (Array.isArray(parts)) {
        if (parts.length !== 1 || typeof own(parts, '0') !== 'string') fail('PUBLIC_MESSAGE_MULTIPART_UNSUPPORTED');
        raw = own(parts, '0');
      } else if (typeof own(content, 'text') === 'string') raw = own(content, 'text');
    }
    if (typeof raw === 'string' && !REFERENCES_ONLY.test(raw)) return { rawText: raw, representation: 'markdown', ...terminal(value) };
    const refs = own(value, 'contentReferences'), matching = [];
    if (Array.isArray(refs)) for (let i = 0; i < refs.length; i++) {
      const reference = own(refs, String(i));
      if (own(reference, 'type') === 'dil' && own(reference, 'source_message_id') === id) matching.push(reference);
    }
    if (matching.length > 1) fail('PUBLIC_MESSAGE_DIL_CONFLICT');
    if (matching.length === 1) {
      const text = own(own(matching[0], 'model_dil_v2'), 'fallbackMarkdown');
      if (typeof text === 'string') return { rawText: text, representation: 'dil', ...terminal(value) };
    }
    fail('PUBLIC_MESSAGE_RAW_UNAVAILABLE');
  }
  function candidates(proof, id, cid) {
    const entries = [], turns = [], direct = [], conversations = [], localScopes = [];
    const scope = value => {
      for (const key of ['conversationId', 'clientThreadId']) {
        const found = own(value, key);
        if (found != null) (key === 'conversationId' ? conversations : localScopes).push(found);
      }
    };
    for (const fiber of proof.chain) {
      if (own(fiber, 'tag') === 3) continue;
      const props = own(fiber, 'memoizedProps');
      if (!object(props)) continue;
      scope(props);
      for (const key of ['item', 'message']) { const value = own(props, key); if (object(value)) direct.push(value); }
      const turn = own(props, 'turn'), entry = own(props, 'entry');
      if (object(turn)) { scope(turn); turns.push(turn); }
      if (object(entry)) {
        scope(entry); const ownedTurn = own(entry, 'turn');
        if (object(ownedTurn)) { scope(ownedTurn); turns.push(ownedTurn); }
      }
    }
    // Local-chatgpt aliases are not resolved by scanning hidden caches. Missing
    // or conflicting exact model scope is a per-source refusal, not a guess.
    // The current page can expose a local clientThreadId that differs from the
    // URL conversation id. An explicit conversationId is authoritative; only
    // when no model scope carries one may the local thread id stand in.
    const scopes = conversations.length ? conversations : localScopes;
    if (!scopes.length) fail('PUBLIC_MESSAGE_SCOPE_MISSING');
    if (scopes.some(value => value !== cid)) fail('PUBLIC_MESSAGE_CONVERSATION_UNPROVEN');
    const all = new Set(direct);
    for (const turn of new Set(turns)) {
      const items = own(turn, 'items');
      if (Array.isArray(items)) for (let i = 0; i < items.length; i++) {
        const value = own(items, String(i)); if (object(value)) all.add(value);
      }
    }
    for (const value of all) {
      // Inspect only native identity descriptors until this requested ID is
      // proved. Unrelated private/tool objects never need their type or body.
      const matches = ['id', 'messageId', 'latestMessageId'].some(key => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return field && Object.prototype.hasOwnProperty.call(field, 'value') && field.value === id;
      });
      if (!matches) continue;
      const identity = candidateId(value);
      if (!identity?.ids.includes(id)) continue;
      if (identity.ids.length !== 1) fail('PUBLIC_MESSAGE_MODEL_ID_CONFLICT');
      if (!publicAssistant(value, identity.typed)) fail('PUBLIC_MESSAGE_NOT_PUBLIC_ASSISTANT');
      const ownConversation = own(value, 'conversationId');
      if (ownConversation != null && ownConversation !== cid) fail('PUBLIC_MESSAGE_CONVERSATION_UNPROVEN');
      entries.push(rawOf(value, id));
    }
    if (own(proof.root, 'current') !== proof.current) fail('PUBLIC_MESSAGE_COMMIT_CHANGED');
    return entries;
  }
  function readOne(id, cid) {
    const anchors = [], panels = workPanels(cid);
    for (const node of document.querySelectorAll('[data-message-id],[data-chatgpt-search-message-ids]')) {
      let ids, direct;
      try {
        if (!visible(node, cid, panels)) continue;
        direct = node.getAttribute('data-message-id');
        ids = nativeIds(node);
      } catch (error) {
        if (direct === id) throw error;
        continue; // An unreadable unrelated anchor cannot veto this source.
      }
      if (!ids.includes(id)) continue;
      if (ids.length !== 1) fail('PUBLIC_MESSAGE_DOM_ID_AMBIGUOUS');
      if (!assistantDom(node)) fail('PUBLIC_MESSAGE_DOM_ROLE_UNPROVEN');
      anchors.push(node);
    }
    if (!anchors.length) fail('PUBLIC_MESSAGE_NOT_VISIBLE');
    const variants = new Map();
    for (const anchor of anchors) for (const proof of fibersOf(anchor)) {
      const values = candidates(proof, id, cid);
      for (const value of values) {
        const key=JSON.stringify([value.representation,value.rawText]),previous=variants.get(key);
        if(previous && (!previous.eof || !value.eof)) {
          const {eof,...unknownBoundary}=value;variants.set(key,unknownBoundary);
        } else variants.set(key,value);
      }
    }
    if (!variants.size) fail('PUBLIC_MESSAGE_MODEL_ID_UNPROVEN');
    if (variants.size !== 1) fail('PUBLIC_MESSAGE_CANDIDATE_CONFLICT');
    return { nativeMessageId: id, ...variants.values().next().value, observedAt: Date.now() };
  }
  window.addEventListener('message', event => {
    const data = event.data, cid = conversation(), path = location.pathname;
    if (event.source !== window || event.origin !== location.origin || location.origin !== 'https://chatgpt.com' ||
        !data || data.source !== REQUEST || data.v !== 1 || typeof data.nonce !== 'string' ||
        !/^[A-Za-z0-9-]{16,80}$/.test(data.nonce) || data.path !== path || !cid || data.conversationId !== cid ||
        !Array.isArray(data.nativeMessageIds)) return;
    const messages = [], issues = [];
    for (const id of new Set(data.nativeMessageIds)) {
      if (typeof id !== 'string' || !id || id.trim() !== id) {
        issues.push({ nativeMessageId: null, code: 'PUBLIC_MESSAGE_ID_INVALID' }); continue;
      }
      try { messages.push(readOne(id, cid)); }
      catch (error) { issues.push({ nativeMessageId: id, code: error?.code ?? 'PUBLIC_MESSAGE_READ_FAILED' }); }
    }
    if (location.pathname !== path || conversation() !== cid) return;
    post({ source: REPLY, v: 1, nonce: data.nonce, path, conversationId: cid, messages, issues }, location.origin);
  });
})();
