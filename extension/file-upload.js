/* Chatmode in Paseo outbound attachment adapter.
 * Adapts the upload-receipt verification from totec448-spec/chat-on-steroids,
 * extension/chatgpt-dom.js uploadImages / composerFileName, main blob
 * f9036940bacc0c63ef4f3dcc173de5fdd0a18c2c (MIT).
 * Delivery differs: CoS elects a native file input per upload kind, which the
 * logged-in composer of 2026-10-16 made ambiguous (four inputs, two of them
 * accept="image/*"). Files are handed to the editor's own paste handler
 * instead, the same path as a user pasting files; no file input is used.
 * Preserves CIP's bounded, authenticated chunk transport and one-shot Send.
 * The CoS desktop app is NOT installed or required. */
(() => {
  'use strict';
  const MAX_FILES = 4, MAX_EACH = 12 * 1024 * 1024, CHUNK = 128 * 1024;
  const fail = (code, diagnostic) => {
    throw Object.assign(new Error(code), { code, notSent: true, ...(diagnostic ? { diagnostic } : {}) });
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const hex = bytes => [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
  const ownedForm = box => box?.closest('form') || fail('COMPOSER_UNAVAILABLE');
  const isUploadBusy = form =>
    !!form.querySelector('[aria-busy="true"],[role="progressbar"],[data-inline-file-uploading],[data-uploading="true"]');

  // Adapted from CoS's composerFileName: a *remove* control is the native
  // ownership witness. A filename substring, an image thumbnail, or the open
  // button alone must never be mistaken for an uploaded file.
  function composerFileName(button) {
    const attachmentHost = button.closest('[data-composer-attachments]');
    const tileParent = button.parentElement;
    if (attachmentHost && tileParent && tileParent !== attachmentHost) {
      const actions = [...tileParent.querySelectorAll('button')];
      if (actions.length === 2 && actions[1] === button) {
        const open = actions[0], name = open.getAttribute('aria-label');
        const removal = button.getAttribute('aria-label') || '';
        const labelled = [...tileParent.querySelectorAll('span')].some(node =>
          !node.children.length && node.textContent === name);
        if (name && removal !== name && removal.endsWith(' ' + name) && labelled &&
            open.closest('[data-composer-attachments]') === attachmentHost) return name;
      }
    }
    const tile = button.closest('[data-composer-attachments] [role="button"][aria-label]');
    if (tile && tile !== button) {
      const name = tile.getAttribute('aria-label');
      const actions = [...tile.querySelectorAll('button')];
      if (name && actions.length === 1 && actions[0] === button &&
          [...tile.querySelectorAll('img[alt]')].some(image => image.getAttribute('alt') === name)) return name;
    }
    const group = button.closest('[role="group"][aria-label]');
    if (group?.querySelector('[data-default-action="true"] button')) {
      const actions = [...group.querySelectorAll('button')].filter(node =>
        !node.closest('[data-default-action="true"]'));
      return actions.length === 1 && actions[0] === button ? group.getAttribute('aria-label') : undefined;
    }
    return /^Remove file(?: \d+)?: (.+)$/.exec(button.getAttribute('aria-label') || '')?.[1];
  }

  function attachmentTiles(form, prior) {
    return [...form.querySelectorAll('button[aria-label]')]
      .filter(button => !prior.has(button) && composerFileName(button));
  }
  function nativeSendReady(form) {
    const controls = globalThis.CIP_COS_CONTROLS;
    const nativeSend = controls?.sendButton?.();
    if (nativeSend) return controls.sendButtonEnabled(nativeSend);
    const candidates = [...form.querySelectorAll(
      'button[data-testid="send-button"],button[type="submit"]')].filter(b => !b.disabled &&
        b.getAttribute('aria-disabled') !== 'true');
    return candidates.length === 1;
  }

  async function loadFile(command, file, index, read, guard) {
    if (!Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_EACH ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        typeof file.mimeType !== 'string' || !/^[-\w.+]+\/[-\w.+]+$/.test(file.mimeType) ||
        typeof file.fileName !== 'string' ||
        !/^[^\\/\x00-\x1f]{1,150}$/.test(file.fileName) ||
        !['file', 'image'].includes(file.uploadKind) ||
        (file.uploadKind === 'image' && !file.mimeType.startsWith('image/')))
      fail('ATTACHMENT_INVALID');
    const buffer = new Uint8Array(file.size);
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      guard();
      const part = await read({ type: 'input-chunk', id: command.id, lease: command.lease,
        documentKey: command.documentKey, index, offset });
      if (part?.offset !== offset || part?.total !== file.size ||
          part?.sha256 !== file.sha256 || typeof part.data !== 'string')
        fail('ATTACHMENT_CHUNK_MISMATCH');
      const binary = atob(part.data);
      const length = Math.min(CHUNK, file.size - offset);
      if (binary.length !== length) fail('ATTACHMENT_CHUNK_MISMATCH');
      for (let i = 0; i < length; i++) buffer[offset + i] = binary.charCodeAt(i);
    }
    guard();
    if (hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))) !== file.sha256)
      fail('ATTACHMENT_INTEGRITY_FAILED');
    return new File([buffer], file.fileName, { type: file.mimeType, lastModified: Date.now() });
  }

  const none = Object.freeze({ proof: () => true, remove: async () => true });
  async function attach(command, box, read, guard, deadline) {
    const descriptors = command?.payload?.files;
    if (!Array.isArray(descriptors) || !descriptors.length) return none;
    if (descriptors.length > MAX_FILES) fail('ATTACHMENT_COUNT_UNSUPPORTED');
    const form = ownedForm(box);
    const prior = new Set(form.querySelectorAll('button[aria-label]'));
    const preExisting = [...prior].some(composerFileName);
    if (preExisting || isUploadBusy(form) ||
        form.querySelector('[data-composer-attachments]:not(:empty)'))
      fail('ATTACHMENT_DRAFT_CONFLICT');

    // Validate and prepare ALL bytes before touching the page.
    const files = [];
    for (let index = 0; index < descriptors.length; index++)
      files.push(await loadFile(command, descriptors[index], index, read, guard));
    guard();
    const names = files.map(file => file.name);

    // Only remove controls that appeared after our delivery AND carry one of
    // our exact file names. A user's own attachment is never touched.
    let ownedTiles = null;
    const ours = () => ownedTiles ?? attachmentTiles(form, prior)
      .filter(button => names.includes(composerFileName(button)));
    const remove = async () => {
      for (const button of ours()) if (button.isConnected) button.click();
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        if (!ours().some(button => button.isConnected) && !isUploadBusy(form)) return true;
        await delay(100);
      }
      return false;
    };

    // One paste of all Files into the empty editor, before any message text.
    // Never click upload menus, touch a file input or open a system picker.
    // An untrusted paste has no browser default action, so a paste the page
    // does not handle writes nothing.
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    guard();
    if (!box.isConnected || ownedForm(box) !== form) fail('ATTACHMENT_PAGE_CHANGED');
    box.focus();
    const paste = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    box.dispatchEvent(paste);
    if (!paste.defaultPrevented) fail('ATTACHMENT_PASTE_UNHANDLED');

    const remaining = Number.isFinite(deadline) ? deadline - Date.now() - 20000 : 60000;
    const end = Date.now() + Math.max(500, Math.min(60000, remaining));
    const proof = () => {
      guard();
      if (!box.isConnected || ownedForm(box) !== form) fail('ATTACHMENT_PAGE_CHANGED');
      const tiles = attachmentTiles(form, prior);
      if (tiles.length > files.length) fail('ATTACHMENT_EXTRA_CHANGED');
      if (!ownedTiles) {
        const unmatched = [...tiles];
        if (files.every(file => {
          const i = unmatched.findIndex(button => composerFileName(button) === file.name);
          if (i < 0) return false;
          unmatched.splice(i, 1);
          return true;
        })) ownedTiles = tiles;
      }
      if (!ownedTiles) return false;
      if (tiles.length !== ownedTiles.length || tiles.some(node => !ownedTiles.includes(node)))
        fail('ATTACHMENT_REMOVED');
      return !isUploadBusy(form) && nativeSendReady(form);
    };
    try {
      while (Date.now() < end) {
        if (proof()) return Object.freeze({ proof, remove });
        await delay(100);
      }
      fail('ATTACHMENT_UPLOAD_UNCONFIRMED');
    } catch (error) {
      // Never strand a half-uploaded file in ChatGPT's persisted draft.
      try { await remove(); } catch {}
      throw error;
    }
  }
  globalThis.CIP_UPLOAD = Object.freeze({ attach });
})();
