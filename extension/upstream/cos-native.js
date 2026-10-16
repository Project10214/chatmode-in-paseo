/*
 * Direct function transplant from Chat On Steroids (MIT).
 * Source: extension/chatgpt-dom.js @ ccd23b66cecf2f684fa3e12ca190297be02842cf
 * Functions: insertPrompt, clearPromptExact, promptWithoutMentions, addAppMention, send.
 * Integration changes: dependency-injected closure; onDispatch hook at the native click;
 * an exact synchronous beforeClick fence; deadline always settles the receipt wait.
 * The upstream send state machine, MutationObserver, authorization and receipt election
 * are retained. See vendor/cos/README.md and THIRD_PARTY_NOTICES.md.
 */
(() => {
  'use strict';
  globalThis.CIP_createCoSNative = function createCoSNative(deps) {
    const { composer, conversationId, messages, generating, stopButton, sendButton, sendButtonEnabled } = deps;
    const APP_MENTION_CHIP = '[data-prompt-link-href^="app://"], [app-mention-path]';
    const safe = (fn, fallback) => { try { const value = fn(); return value === undefined || value === null ? fallback : value; } catch { return fallback; } };

  function insertPrompt(value, mode = false, failure = () => undefined) {
    const box = composer();
    const reject = reason => {
      safe(() => failure(reason), undefined);
      return false;
    };
    try {
      if (!box) return reject('composer_missing');
      const existing = (box.textContent || '').trim();
      if (value === '' && mode !== true) return false;
      const sameAsValue = String(existing).replace(/\s+/g, '') === String(value || '').replace(/\s+/g, '');
      if (existing !== '' && mode === false && !sameAsValue) return reject('existing_draft');
      box.focus();
      const selection = document.getSelection();
      if (!selection) return reject('selection_missing');
      if (existing !== '') {
        selection.selectAllChildren(box);
        if (mode === 'append') {
          selection.collapseToEnd();
          value = `\n${value}`;
        }
      } else selection.selectAllChildren(box);
      if (!box.isConnected || composer() !== box) return reject('editor_replaced');
      if (document.activeElement !== box) return reject('composer_not_focused');
      if (!selection.rangeCount || !box.contains(selection.anchorNode) || !box.contains(selection.focusNode)) return reject('selection_changed');
      const paragraph = document.createElement('p');
      const host = box.matches('[data-composer-markdown]') && box.closest('form[data-chatgpt-composer]')
        ? document.createElement('span') : paragraph;
      if (host !== paragraph) {
        host.setAttribute('data-prompt-literal-paste', '');
        paragraph.append(host);
      }
      value.split('\n').forEach((line, index) => {
        if (index) host.append(document.createElement('br'));
        host.append(document.createTextNode(line));
      });
      if (value === '') host.append(document.createElement('br'));
      if (!document.execCommand('insertHTML', false, paragraph.innerHTML)) return reject('native_edit_rejected');
      const compact = text => String(text || '').replace(/\s+/g, '');
      const expected = mode === 'append' ? existing + value : value;
      if (!box.isConnected || composer() !== box) return reject('editor_replaced');
      if (compact(box.textContent) !== compact(expected)) return reject('text_mismatch');
      return true;
    } catch {
      return reject('insertion_exception');
    }
  }

  function clearPromptExact(value) {
    return safe(() => {
      const box = composer();
      const compact = (text) => String(text || '').replace(/\s+/g, '');
      if (!box || compact(box.textContent) !== compact(value)) return false;
      box.focus();
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return (box.textContent || '').trim() === '';
    }, false);
  }

  function promptWithoutMentions(box) {
    const clone = box.cloneNode(true);
    for (const chip of clone.querySelectorAll(APP_MENTION_CHIP)) chip.remove();
    return String(clone.textContent || '').replace(/\s+/g, '');
  }

  function addAppMention(box, mention) {
    try {
      const path = typeof mention?.path === 'string' && /^app:\/\/asdk_app_[A-Za-z0-9_-]{1,160}$/.test(mention.path) ? mention.path : null;
      const name = typeof mention?.name === 'string' ? mention.name.trim() : '';
      // CIP patch: a non-Latin display name uses the already-proven app id as its mark name.
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || (path && path.slice(6));
      if (!path || !name || name.length > 80 || !slug) return null;
      const plain = () => promptWithoutMentions(box);
      const token = document.createElement('span');
      token.setAttribute('app-mention-name', slug);
      token.setAttribute('app-mention-display-name', name);
      token.setAttribute('app-mention-path', path);
      token.setAttribute('data-prompt-link-href', path);
      token.setAttribute('data-prompt-link-label', `$${slug}`);
      token.textContent = name;
      const expected = plain();
      const before = new Set(box.querySelectorAll('[app-mention-path]'));
      box.focus();
      const selection = document.getSelection();
      if (!selection || document.activeElement !== box) return null;
      selection.selectAllChildren(box);
      selection.collapseToEnd();
      if (!document.execCommand('insertHTML', false, ` ${token.outerHTML}`)) return plain() === expected ? null : false;
      const added = [...box.querySelectorAll('[app-mention-path]')].find(node => !before.has(node) && node.getAttribute('app-mention-path') === path);
      if (added && plain() === expected) return added;
      document.execCommand('undo', false);
      const left = [...box.querySelectorAll(`[app-mention-path="${path}"]`)].filter(node => !before.has(node));
      for (const node of left) node.remove();
      return plain() === expected ? null : false;
    } catch {
      return null;
    }
  }

  async function send({ acceptanceTimeoutMs = 30000, stillCurrent = () => true, matchesUser = null, observeEvidence = null, clearAcceptedDraft = true, beforeSend = null, acceptUserReceipt = null, receiptTimeoutMs = null, mention = null, explain = null, sentRequest = null, whileGenerating = false, onDispatch = null, beforeClick = null, attachmentOnly = false } = {}) {
    const refused = (why) => { try { explain?.(why); } catch { /* Diagnostics never change Send. */ } return false; };
    try {
      const box = composer();
      if (!box || !box.isConnected) return refused('editor-missing');
      if (!stillCurrent()) return refused('chat-changed');
      const busy = () => !whileGenerating && generating();
      if (whileGenerating ? !acceptUserReceipt : generating() || stopButton()) return refused('page-busy');
      if (box.getAttribute('aria-disabled') === 'true' || box.getAttribute('contenteditable') === 'false') return refused('editor-disabled');
      const draftText = () => (typeof box.innerText === 'string' ? box.innerText : [...box.childNodes]
        .map((node) => (node.textContent || '') + (/^(P|DIV|BR)$/.test(node.nodeName) ? '\n' : '')).join('')).trim();
      const submitted = draftText();
      if (!submitted && !attachmentOnly) return refused('draft-empty');
      const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const expected = compact(submitted);
      const beforeConversation = conversationId();
      const beforeGenerating = generating();
      const beforeStop = stopButton();
      const priorUsers = messages().filter((message) => message.role === 'user');
      const priorUserNodes = new Set(priorUsers.map((message) => message.node));
      const priorUserIds = new Set(priorUsers.map((message) => message.id).filter(Boolean));
      let submittedMessageObserved = false;
      let clickedAt = null;
      const accepted = () => {
        const currentConversation = conversationId();
        if (beforeConversation && currentConversation !== beforeConversation) return false;
        const visible = messages();
        for (let at = visible.length - 1; at >= 0; at--) {
          const message = visible[at];
          if (message.role !== 'user') continue;
          if (!priorUserNodes.has(message.node) && !priorUserIds.has(message.id) && (matchesUser ? matchesUser(message, submitted) : compact(message.text) === expected)) {
            if (acceptUserReceipt && !acceptUserReceipt(message, currentConversation)) continue;
            submittedMessageObserved = true;
            return true;
          }
        }
        if (acceptUserReceipt && sentRequest && clickedAt !== null) {
          const sent = safe(() => sentRequest(clickedAt), null);
          if (sent && !priorUserIds.has(sent.id) && acceptUserReceipt({ id: sent.id, role: 'user', sentRequest: true }, currentConversation)) return true;
        }
        if (acceptUserReceipt || currentConversation !== beforeConversation) return false;
        const current = composer();
        if (current === box && box.isConnected && (current.textContent || '').trim() === '') return true;
        if (!beforeGenerating && generating()) return true;
        if (!beforeStop && stopButton()) return true;
        return false;
      };
      return await new Promise((resolve) => {
        let done = false;
        let attempted = false;
        let authorizing = false;
        let observer = null;
        let timer = null;
        let unsubscribeEvidence = null;
        let mentionTried = false;
        let resumeClick = null;
        let mentionAdded = false;
        let mentioning = false;
        let mentionTicked = false;
        let mentionTimers = [];
        let mentionedDraft = null;
        let mentionPlain = '';
        let priorMentions = new Set();
        const ownMentions = () => mentionAdded ? [...box.querySelectorAll(`[app-mention-path="${mention.path}"]`)].filter(node => !priorMentions.has(node)) : [];
        const finish = (value, why = attempted ? 'not-accepted' : 'send-not-ready') => {
          if (done) return;
          if (!value) refused(why);
          done = true;
          const own = value ? [] : safe(ownMentions, []);
          if (own.length) {
            safe(() => { for (const node of own) node.remove(); box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null })); }, undefined);
          }
          if (observer) observer.disconnect();
          if (unsubscribeEvidence) unsubscribeEvidence();
          if (timer !== null) clearTimeout(timer);
          for (const pending of mentionTimers) clearTimeout(pending);
          if (clearAcceptedDraft && value && submittedMessageObserved && stillCurrent() && composer() === box) clearPromptExact(submitted);
          resolve(value);
        };
        const settleMention = (last = false) => {
          if (done || !mentioning || !mentionTicked) return;
          const own = ownMentions().filter(node => node.isConnected);
          if (!own.length && !last) return;
          mentioning = false;
          for (const pending of mentionTimers) clearTimeout(pending);
          mentionTimers = [];
          if (promptWithoutMentions(box) !== mentionPlain) return finish(false, 'mention-changed');
          mentionedDraft = draftText();
          const resume = resumeClick;
          resumeClick = null;
          if (resume) resume();
        };
        const check = () => {
          if (done) return;
          if (!stillCurrent() || (beforeConversation && conversationId() !== beforeConversation)) return finish(false, 'chat-changed');
          if (attempted) { if (accepted()) finish(true); return; }
          if (mentioning) return settleMention();
          if (conversationId() !== beforeConversation || composer() !== box || !box.isConnected ||
              draftText() !== (mentionedDraft ?? submitted) || busy()) return finish(false, busy() ? 'page-busy' : 'draft-changed');
          if (box.getAttribute('aria-disabled') === 'true' || box.getAttribute('contenteditable') === 'false') return;
          const button = sendButton();
          if (!sendButtonEnabled(button)) return;
          if (authorizing) return;
          const click = (resumed = false) => {
            if (done) return;
            // React may replace its button after the asynchronous authorization
            // while keeping exactly the same editor, text and app/model config.
            // Reacquire the ONE visible native Send control scoped to that form;
            // the exact draft/config/ownership fence still runs before clicking.
            const control = sendButton();
            if (!stillCurrent() || conversationId() !== beforeConversation || composer() !== box ||
                !box.isConnected || draftText() !== (mentionedDraft ?? submitted) || busy() ||
                !sendButtonEnabled(control) || box.getAttribute('aria-disabled') === 'true' ||
                box.getAttribute('contenteditable') === 'false') return finish(false, 'send-not-ready');
            if (mention && !mentionTried) {
              mentionTried = true;
              priorMentions = new Set(box.querySelectorAll('[app-mention-path]'));
              mentionPlain = promptWithoutMentions(box);
              const added = addAppMention(box, mention);
              if (added === false) return finish(false, 'mention-not-restored');
              if (added) {
                mentionAdded = true;
                mentioning = true;
                resumeClick = () => click(true);
                mentionTimers = [setTimeout(() => { mentionTicked = true; settleMention(); }, 0),
                  setTimeout(() => { mentionTicked = true; settleMention(true); }, 1500)];
                return;
              }
            }
            // CIP: retain exact text/config/route ownership fence. No await before click.
            try { if (beforeClick && beforeClick() !== true) return finish(false, 'final-fence'); }
            catch { return finish(false, 'final-fence'); }
            attempted = true;
            if (acceptUserReceipt && timer !== null) {
              clearTimeout(timer); timer = null;
              if (Number.isFinite(receiptTimeoutMs) && receiptTimeoutMs > 0)
                timer = setTimeout(() => { check(); finish(false); }, receiptTimeoutMs);
            }
            clickedAt = Date.now();
            try { onDispatch?.(); control.click(); } catch { return finish(false); }
            check();
          };
          if (!beforeSend) return click();
          authorizing = true;
          try { Promise.resolve(beforeSend(() => !done && stillCurrent())).then(allowed => allowed === true ? click() : finish(false, 'not-authorized'), () => finish(false, 'not-authorized')); }
          catch { finish(false, 'not-authorized'); }
        };
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
        if (observeEvidence) unsubscribeEvidence = observeEvidence(check);
        const timeout = Number.isFinite(acceptanceTimeoutMs) ? Math.max(1, Math.min(30000, acceptanceTimeoutMs)) : 30000;
        timer = setTimeout(() => { if (attempted) check(); if (!attempted || !acceptUserReceipt) finish(false); }, timeout);
        check();
      });
    } catch { return false; }
  }
    return { insertPrompt, clearPromptExact, promptWithoutMentions, addAppMention, send };
  };
})();
