/* Direct CoS DOM function transplant, MIT; pinned ccd23b66cecf2f684fa3e12ca190297be02842cf.
 * Source: extension/chatgpt-dom.js (composer, native controls, Chat surface, New Chat).
 * Presentation/Goal/compaction/desktop features are not included. See vendor/cos/README.md.
 */
(() => {
  'use strict';
  const OWN_SURFACES = '.clf-stream, .clf-stage, .clf-composer, .clf-boot, [data-clf-user-text]';
  const LEGACY_TURN = 'section[data-testid^="conversation-turn"]';
  const SHELL_TURN = '[data-app-shell-main-surface] [data-thread-find-target="conversation"] [data-turn-key]';
  const TURN = `${LEGACY_TURN}, ${SHELL_TURN}, [data-chatgpt-search-unit-key]`;
  const STOP = 'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="Stop answering"]';
  const SEND = 'button[data-testid="send-button"], form button[aria-label^="Send" i], form[data-chatgpt-composer] button[type="submit"]';
  const APPROVAL_CARD = '[data-codex-approval-surface="true"]';
  const STOP_SQUARE = /^\s*M4\.5 5\.75/;
  const safe = (fn, fallback) => { try { const value = fn(); return value === undefined || value === null ? fallback : value; } catch { return fallback; } };
  function onKeptPage(node) {
    for (let page = node?.closest?.('[data-app-shell-page-surface]'); page;
      page = page.parentElement?.closest('[data-app-shell-page-surface]')) {
      if (getComputedStyle(page).display === 'none') return true;
    }
    return false;
  }
  function composerCssVisible(node) {
    return safe(() => {
      if (!node || onKeptPage(node)) return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      return true;
    }, false);
  }
  function composer() {
    return safe(() => {
      const classic = [...document.querySelectorAll('#prompt-textarea')].filter(composerCssVisible);
      if (classic.length) return classic.length === 1 ? classic[0] : null;
      const candidates = [...document.querySelectorAll(
        'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"], ' +
        'form [data-composer-markdown][contenteditable="true"][role="textbox"]'
      )]
        .filter(node => !node.closest(`${OWN_SURFACES},[data-turn-key],.markdown,[hidden],[aria-hidden="true"],[inert]`) && composerCssVisible(node));
      return candidates.length === 1 ? candidates[0] : null;
    }, null);
  }
  function renderedComposerNode(node) {
    if (!node?.isConnected || node.closest(`${OWN_SURFACES}, ${TURN}, [data-message-author-role], [hidden], [aria-hidden="true"], [inert]`)) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  }
  function nativeComposerControls(selector) {
    const form = composer()?.closest('form');
    return [...(form || document).querySelectorAll(selector)].filter(button => renderedComposerNode(button) && (!form || button.closest('form') === form));
  }
  function approvalWaiting() {
    return safe(() => [...document.querySelectorAll(APPROVAL_CARD)].some(card =>
      !onKeptPage(card) && card.getClientRects().length > 0 && card.querySelector('button:not([disabled])') !== null), false);
  }
  function generating() {
    return safe(() => {
      if (stopControls().length > 0) return true;
      const latest = [...document.querySelectorAll(SHELL_TURN)].filter(node =>
        !node.closest(`${OWN_SURFACES},.markdown,[data-markdown-text-style],[data-content-search-unit-key],[contenteditable]`) && !onKeptPage(node)).at(-1);
      if (latest?.getAttribute('data-clf-shell-running') !== location.pathname) return false;
      const primary = primarySlotControls();
      if (primary.length > 0 && !primary.some(isStopSquare)) return false;
      return true;
    }, false);
  }
  function primarySlotControls() {
    const form = composer()?.closest('form');
    if (!form) return [];
    return [...form.querySelectorAll('button[class*="size-token-button-composer"][class*="bg-composer-primary"]')]
      .filter(button => renderedComposerNode(button) && button.closest('form') === form);
  }
  function isStopSquare(button) {
    if (!button || button.hasAttribute('data-state')) return false;
    const paths = button.querySelectorAll('svg path');
    return paths.length === 1 && STOP_SQUARE.test(paths[0].getAttribute('d') || '');
  }
  function localeFreeStopControls() { return primarySlotControls().filter(isStopSquare); }
  function stopControls() {
    const labelled = nativeComposerControls(STOP);
    return labelled.length > 0 ? labelled : localeFreeStopControls();
  }
  function localeFreeSendControls() {
    const box = composer();
    const form = box?.closest('form');
    if (!form) return [];
    const drafted = (typeof box.innerText === 'string' ? box.innerText : box.textContent || '').trim();
    if (drafted === '' || generating()) return [];
    return [...form.querySelectorAll('button[class*="size-token-button-composer"][class*="bg-composer-primary"]')]
      .filter(button => {
        if (!renderedComposerNode(button) || button.closest('form') !== form) return false;
        if (button.hasAttribute('data-state')) return false;
        const paths = button.querySelectorAll('svg path');
        if (paths.length === 1 && STOP_SQUARE.test(paths[0].getAttribute('d') || '')) return false;
        return paths.length >= 1 && paths.length <= 2;
      });
  }
  function sendControls() {
    const labelled = nativeComposerControls(SEND);
    return labelled.length > 0 ? labelled : localeFreeSendControls();
  }
  function stopButton() { return safe(() => { const buttons = stopControls(); return buttons.length === 1 ? buttons[0] : null; }, null); }
  function stopGeneration(stillCurrent) {
    if (typeof stillCurrent !== 'function' || !stillCurrent()) return false;
    const button = stopButton();
    if (!button || !button.isConnected || button.disabled || button.getAttribute('aria-disabled') === 'true' ||
        button.hidden || button.closest('[hidden],[inert]') || button.getClientRects().length === 0) return false;
    const style = getComputedStyle(button);
    if (style.display === 'none' || style.visibility === 'hidden' || !stillCurrent()) return false;
    button.click();
    return true;
  }
  function sendButton() { return safe(() => { const buttons = sendControls(); return buttons.length === 1 ? buttons[0] : null; }, null); }
  function sendButtonEnabled(button) { return !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'; }
  function conversationFromPath(pathname) {
    return safe(() => {
      const match = /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(String(pathname || ''));
      return match ? match[1] : null;
    }, null);
  }
  function conversationId() { return safe(() => conversationFromPath(location.pathname), null); }
  function transportFailure(value) {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    return /^(?:message delivery timed out(?:\. please try again\.?)?|connection interrupted\.? waiting for the complete answer\.?|chatgpt stream recovery polling timed out\.?|stream cache expired\.?|unknown error occurred\.?|there was an error generating (?:a|the) response\.?|error in message stream\.?|network error\.?|a network error occurred\.?(?: please check your connection and try again\.?)?|resume stream unavailable\.?|something went wrong\.?|something went wrong while generating the response(?:\. if this issue persists please contact us through our help center at help\.openai\.com\.?)?\.?)(?: retry)?$/i.test(line);
  }
  async function prepareChatModelSurface(stillCurrent = () => true) {
    const radios = () => [...document.querySelectorAll('[role="radio"][data-tpp-toggle-value]')]
      .filter(node => !node.closest(OWN_SURFACES) && node.getClientRects().length > 0);
    const state = () => {
      const nodes = radios(), chat = nodes.filter(node => node.getAttribute('data-tpp-toggle-value') === 'chatgpt'), work = nodes.filter(node => node.getAttribute('data-tpp-toggle-value') === 'work');
      return chat.length === 1 && work.length === 1 ? { chat: chat[0], work: work[0] } : null;
    };
    if (!stillCurrent()) return false;
    const before = state();
    if (!before) return radios().length === 0;
    if (before.chat.getAttribute('aria-checked') === 'true') return true;
    if (before.work.getAttribute('aria-checked') !== 'true' || before.chat.disabled || before.chat.getAttribute('aria-disabled') === 'true') return false;
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(value); };
      const check = () => {
        if (!stillCurrent()) return finish(false);
        const next = state();
        if (next?.chat.getAttribute('aria-checked') === 'true' && next.work.getAttribute('aria-checked') === 'false') finish(true);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      const timer = setTimeout(() => finish(false), 5000);
      before.chat.click(); check();
    });
  }

  globalThis.CIP_COS_CONTROLS = Object.freeze({ composer, composerCssVisible, onKeptPage, nativeComposerControls, stopControls, sendControls,
    generating, approvalWaiting, stopButton, stopGeneration, sendButton, sendButtonEnabled, conversationFromPath, conversationId, transportFailure,
    prepareChatModelSurface });
})();
