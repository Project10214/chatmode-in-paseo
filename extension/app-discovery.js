/* CIP integration, not an unchanged CoS function.
 * A passive CoS response observer cannot cause the native page to load its hints.
 * When necessary, expose the composer's native @ completion once. Read the page's
 * own response; never fetch an authenticated endpoint, click Send or grant access.
 */
(() => {
  'use strict';
  globalThis.CIP_activateAppDiscovery = ({ composer, authored, chips, insert, guard, fail }) => {
    guard(); const box = composer(), route = location.pathname;
    if (authored(box)) fail('DRAFT_CONFLICT');
    const host = box.closest('form');
    if (host?.querySelector('[data-composer-attachments]:not(:empty),[data-inline-file-uploading]')) fail('ATTACHMENT_UNSUPPORTED');
    const appIds = () => JSON.stringify(chips().map(c => c.id).sort());
    const originalApps = appIds();
    const panelSelector='[role="listbox"],[role="menu"],[role="dialog"],[cmdk-root],[data-radix-popper-content-wrapper],[data-tippy-root]';
    const visiblePanel=node=>node.getClientRects().length>0 && getComputedStyle(node).visibility!=='hidden' &&
      !node.closest('[hidden],[inert],[aria-hidden="true"],[data-message-author-role],.markdown,.clf-stream');
    const priorPanels=new Set([...document.querySelectorAll(panelSelector)].filter(visiblePanel));
    let touched = false, editing = false, disposed = false;
    const names = ['keydown','beforeinput','paste','drop','compositionstart','pointerdown'];
    const userEdit = event => {
      if (!event.isTrusted || editing) return;
      const node = event.target;
      if (!node || (node !== box && !box.contains(node))) return;
      if (event.type === 'pointerdown') {
        // A caret click is not an edit. A trusted removal action on an
        // existing native app mark is, even if its label later looks equal.
        const chip = node.closest?.('[app-mention-path],[data-prompt-link-href^="app://"]');
        if (!chip || !node.closest?.('button,[role="button"]')) return;
      }
      if (event.type === 'keydown' &&
          ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Shift','Control','Meta','Alt','Tab','Escape','PageUp','PageDown'].includes(event.key))
        return;
      touched = true;
    };
    for (const name of names) document.addEventListener(name, userEdit, true);
    const owned = () => !touched && box.isConnected && location.pathname === route && composer() === box &&
      appIds() === originalApps && authored(box) === '@';
    const check = () => { guard(); if (!owned()) fail('APP_PROBE_INTERRUPTED'); };
    // Only a menu opened by this exact @ probe may prove app identities.
    const panel = () => {
      check();
      const nodes=[...document.querySelectorAll(panelSelector)].filter(n=>visiblePanel(n)&&!priorPanels.has(n));
      const outer=nodes.filter(n=>!nodes.some(parent=>parent!==n&&parent.contains(n)));
      if(outer.length>1)fail('AMBIGUOUS_APP_MENU');
      return outer[0]??null;
    };
    const dispose = () => {
      if (disposed) return true; disposed = true;
      for (const name of names) document.removeEventListener(name, userEdit, true);
      try {
        if (!owned()) return false;
        // Remove only the single native @ text node, preserving pre-existing app
        // marks. Never select-all, undo an unrelated edit or clear a human draft.
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        let node, target = null;
        while ((node = walker.nextNode())) {
          if (node.parentElement?.closest('[app-mention-path],[data-prompt-link-href^="app://"]') || !node.nodeValue.includes('@')) continue;
          if (target) return false; target = node;
        }
        if (!target) return false;
        box.focus(); const at = target.nodeValue.indexOf('@');
        const range = document.createRange(); range.setStart(target, at); range.setEnd(target, at + 1);
        const selection = document.getSelection(); if (!selection) return false;
        selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('delete', false)) return false;
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return box.isConnected && composer() === box && location.pathname === route && authored(box) === '' && appIds() === originalApps;
      } catch { return false; }
    };
    try {
      editing = true; box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: '@', code: 'Digit2', shiftKey: true, bubbles: true, cancelable: true }));
      guard();
      if (!authored(box)) insert('@');
      box.dispatchEvent(new KeyboardEvent('keyup', { key: '@', code: 'Digit2', shiftKey: true, bubbles: true }));
      editing = false; check();
      return { check, panel, dispose };
    } catch (error) { editing = false; dispose(); throw error; }
  };
})();
