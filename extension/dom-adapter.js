/* Paseo-specific adapter over transplanted CoS native controls, picker and Send engine.
 * Generic @ catalog, exact configuration, user receipt fences and explicit actions remain CIP code.
 * See vendor/cos/README.md for precise origin and intentional differences. */
(() => {
  'use strict';
  const C = globalThis.CIP_COS_CONTROLS;
  if (!C || !globalThis.CIP_createCoSNative || !globalThis.CIP_createCoSModels) throw new Error('COS_CORE_NOT_LOADED');
  const M = globalThis.CIP_createCoSModels(C);
  let nativeMode = false;
  const nativeShape = () => nativeMode || !trigger('model')?.getAttribute('data-model-id');
  async function refreshModelProof() {
    await M.readPickerState();
    const selected = M.visibleSelection();
    if (!selected) fail('MODEL_IDENTITY_UNPROVEN');
    return selected;
  }

  // Receipt-only state. Never start the former assistant/activity transcript.
  // Continuous collection belongs to CIP_PAGE_CONTENT / CIP_PAGE_CONTROLS.
  let pendingReceiptProbe = null;
  const pageControls = () => {
    const controls = globalThis.CIP_PAGE_CONTROLS;
    if (typeof controls?.read !== 'function') fail('PAGE_CONTROLS_UNAVAILABLE');
    return controls;
  };
  function stopVisible() {
    const view = pageControls().read();
    if (typeof view?.controls?.stop?.visible !== 'boolean') fail('PAGE_CONTROLS_UNAVAILABLE');
    return view.controls.stop.visible;
  }
  // Compatibility name: user-only receipt snapshot, no IPC, cache or observer.
  async function refreshTranscript() { return messages(); }
  const S = {
    composer: '#prompt-textarea',
    chip: '[data-prompt-link-href^="app://"], [app-mention-path]',
    model: 'button[data-testid="model-switcher-dropdown-button"], button[data-testid="composer-model-selector"], button[data-testid="composer-intelligence-picker-trigger"]',
    modelMenu: '[data-testid="composer-intelligence-picker-content"], [data-model-picker-view], [role="menu"], [role="listbox"]',
    thinking: 'button[data-testid="thinking-effort-dropdown-button"], button[data-testid="thinking-time-button"], button[data-testid="composer-thinking-effort"]',
    option: '[role="option"], [role="menuitem"], [role="menuitemradio"]',
    messages: '[data-message-author-role], [data-chatgpt-search-unit-key], [data-content-search-unit-key]'
  };
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const one = selector => {
    const nodes = [...document.querySelectorAll(selector)].filter(visible);
    if (nodes.length > 1) fail('AMBIGUOUS_CONTROL');
    return nodes[0] ?? null;
  };
  const label = node => (node?.getAttribute('aria-label') || node?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const norm = value => value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  const receiptText = globalThis.CIP_createCoSReceiptText({ normalize: norm });
  const delay = ms => new Promise(r => setTimeout(r, ms));
  async function until(fn, timeout = 15000, code = 'DOM_TIMEOUT', guard = () => {}) {
    const end = Date.now() + timeout;
    do { guard(); const value = await fn(); guard(); if (value) return value; await delay(100); } while (Date.now() < end);
    fail(code);
  }
  const composer = () => C.composer() || fail('COMPOSER_UNAVAILABLE');
  // Script injection is not editor readiness. CoS checks the native editable host at use.
  async function waitForComposer(guard = () => {}) {
    return until(() => {
      const box = C.composer();
      return box?.isConnected && box.getAttribute('aria-disabled') !== 'true' &&
        box.getAttribute('contenteditable') !== 'false' && box.getClientRects().length > 0 ? box : null;
    }, 20000, 'COMPOSER_READY_TIMEOUT', guard);
  }
  function errorStage(error, stage) {
    if (!error || typeof error !== 'object') error = new Error('ADAPTER_UNSUPPORTED');
    error.diagnostic ??= { stage };
    return error;
  }
  async function atStage(stage, work) {
    try { return await work(); } catch (error) { throw errorStage(error, stage); }
  }
  // Same deterministic body serialization for editor validation and user receipts.
  // textContent drops block boundaries; innerText on a detached clone also does so.
  function authored(node) {
    const skip = `${S.chip},button,[role="button"],[role="toolbar"],script,style,svg,[aria-hidden="true"]`;
    const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'TABLE', 'TR']);
    function read(n) {
      if (n.nodeType === Node.TEXT_NODE) return n.nodeValue || '';
      if (n.nodeType !== Node.ELEMENT_NODE || n.matches(skip)) return '';
      if (n.tagName === 'BR') return '\n';
      let result = '';
      for (const child of n.childNodes) {
        const value = read(child);
        if (!value) continue;
        const block = child.nodeType === Node.ELEMENT_NODE && blocks.has(child.tagName);
        if (block && result && !result.endsWith('\n')) result += '\n';
        result += value;
        if (block && !result.endsWith('\n')) result += '\n';
      }
      return result;
    }
    return norm(read(node));
  }
  // Observe only lengths/structure, never retain or report draft text/HTML.
  // This is diagnostic evidence, NOT permission to clear or adopt a draft.
  function composerSample(editor = C.composer()) {
    return { editor, chars: editor ? authored(editor).length : null, at: Date.now() };
  }
  const injectedComposer = composerSample();
  function draftError(checkpoint, box, ready = null, code = 'DRAFT_CONFLICT') {
    const diagnostic = { stage: 'composer', checkpoint, draftDiagnosticsVersion: 1 };
    try {
      const cap = value => Math.min(64000, Math.max(0, value));
      const elapsed = at => Math.min(60000, Math.max(0, Date.now() - at));
      const draft = authored(box);
      Object.assign(diagnostic, {
        extensionVersion: globalThis.chrome?.runtime?.getManifest?.().version,
        editorTag: ['DIV','TEXTAREA'].includes(box.tagName) ? box.tagName : 'OTHER',
        readyState: document.readyState,
        draftChars: cap(draft.length), rawChars: cap((box.textContent || '').length),
        visibleChars: cap((box.innerText || '').length),
        valueChars: cap(typeof box.value === 'string' ? box.value.length : 0),
        zeroWidthChars: cap((draft.match(/[\u200b-\u200d\u2060\ufeff]/g) || []).length),
        hasPaseoContextHeader: draft.startsWith('[Paseo context — user-level instructions]'),
        editableChars: 0, nonEditableChars: 0, hiddenChars: 0, placeholderChars: 0,
        textNodes: 0, appCount: Math.min(128, box.querySelectorAll(S.chip).length),
        snapshotTruncated: false, pageGenerating: stopVisible(),
        sameEditorSinceInjection: injectedComposer.editor === box,
        msSinceInjection: elapsed(injectedComposer.at)
      });
      if (injectedComposer.chars !== null) Object.assign(diagnostic, {
        injectionDraftChars: cap(injectedComposer.chars), emptyAtInjection: injectedComposer.chars === 0
      });
      if (ready) Object.assign(diagnostic, {
        readyDraftChars: cap(ready.chars ?? 0), initiallyEmpty: ready.chars === 0,
        editorReplaced: ready.editor !== box, msSinceReady: elapsed(ready.at)
      });
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (diagnostic.textNodes >= 128) { diagnostic.snapshotTruncated = true; break; }
        diagnostic.textNodes++;
        const parent = node.parentElement, size = (node.nodeValue || '').length;
        const within = selector => { const n = parent?.closest(selector); return !!n && box.contains(n); };
        let hidden = false;
        for (let element = parent, depth = 0; element && depth < 64; element = element.parentElement, depth++) {
          const style = getComputedStyle(element);
          if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true' ||
              style.display === 'none' || ['hidden','collapse'].includes(style.visibility)) hidden = true;
          if (element === box) break;
        }
        const nonEditable = within('[contenteditable="false"]');
        const placeholder = within('[data-placeholder],[data-placeholder-text]');
        const decoration = within(`${S.chip},button,[role="button"],[role="toolbar"],script,style,svg`);
        if (hidden) diagnostic.hiddenChars = cap(diagnostic.hiddenChars + size);
        if (nonEditable) diagnostic.nonEditableChars = cap(diagnostic.nonEditableChars + size);
        if (placeholder) diagnostic.placeholderChars = cap(diagnostic.placeholderChars + size);
        if (!hidden && !nonEditable && !placeholder && !decoration)
          diagnostic.editableChars = cap(diagnostic.editableChars + size);
      }
    } catch { /* Evidence collection must never mask the original refusal. */ }
    return Object.assign(new Error(code), { code, diagnostic });
  }
  function caretEnd(box) { box.focus(); const range = document.createRange(); range.selectNodeContents(box); range.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
  function insert(value) {
    const box = composer(); caretEnd(box);
    if (!document.execCommand('insertText', false, value)) fail('NATIVE_INPUT_UNAVAILABLE');
  }
  function clearEmptyProbe() {
    const box = composer(); if (box.querySelector(S.chip) || !['', '@'].includes(authored(box))) fail('DRAFT_CONFLICT');
    box.focus(); const range = document.createRange(); range.selectNodeContents(box); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.execCommand('delete'); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  function appId(node) {
    const fields = ['data-app-id', 'data-prompt-link-href', 'app-mention-path', 'href'];
    for (const e of [node, ...node.querySelectorAll('[data-app-id], [data-prompt-link-href], [app-mention-path], [href]')]) {
      for (const field of fields) { const m = /(?:^|app:\/\/|\/)(asdk_app_[a-zA-Z0-9_-]+)/.exec(e.getAttribute(field) || ''); if (m) return m[1]; }
    }
    return null;
  }
  function chips() {
    const nodes = [...composer().querySelectorAll(S.chip)];
    // ChatGPT may render a native app mark with nested spans carrying the
    // same app URL. Count the outer mark once; never treat its decorative
    // descendants as additional selected tools.
    return nodes.filter(node => !node.parentElement?.closest(S.chip)).map(node => {
      const id = appId(node);
      const nested = [...node.querySelectorAll(S.chip)];
      // Conflicting nested IDs are genuine ambiguity, not harmless markup.
      return { node, id: id && nested.every(inner => appId(inner) === id) ? id : null };
    });
  }
  const menuSelector = '[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"], [data-model-picker-view]';
  function menus() {
    const all = [...document.querySelectorAll(menuSelector)].filter(visible);
    return all.filter(n => !all.some(other => other !== n && other.contains(n)));
  }
  function optionRows(panel) { return [...panel.querySelectorAll(S.option)].filter(visible); }
  function trigger(kind) {
    const nodes = [...document.querySelectorAll(S[kind])].filter(n => visible(n) && !n.closest(menuSelector));
    if (nodes.length > 1) fail('AMBIGUOUS_CONTROL');
    return nodes[0] ?? null;
  }
  function key(node, kind) {
    const attr = node.getAttribute(kind === 'model' ? 'data-model-id' : 'data-thinking-effort') || (kind === 'model' ? node.getAttribute('data-model-slug') : null);
    return attr || fail('OPTION_ID_UNPROVEN');
  }
  function selected(kind) { if (nativeMode) { const v = M.visibleSelection(); return v ? (kind === 'model' ? v.model : v.thinkingOption) : null; } const node = trigger(kind); return node ? key(node, kind) : null; }
  async function openedMenu(action, owner) {
    const before = menus(); action();
    return until(() => {
      const controlled = owner?.getAttribute('aria-controls');
      const explicit = controlled && document.getElementById(controlled);
      if (explicit && visible(explicit) && explicit.matches(menuSelector)) return explicit;
      const newMenus = menus().filter(n => !before.includes(n));
      if (newMenus.length > 1) fail('AMBIGUOUS_MENU');
      return newMenus[0];
    });
  }
  async function choices(kind) {
    const button = trigger(kind);
    if (!button) { if (kind === 'thinking') return []; fail('MODEL_PICKER_UNAVAILABLE'); }
    const panel = await openedMenu(() => button.click(), button);
    await until(() => optionRows(panel).length);
    const rows = optionRows(panel).filter(n => n.getAttribute('aria-haspopup') !== 'menu' &&
      n.getAttribute('aria-disabled') !== 'true' && !n.disabled && label(n));
    const list = rows.map(node => ({ id: key(node, kind), label: label(node), node }));
    if (!list.length || new Set(list.map(n => n.id)).size !== list.length || list.length > 100) fail('AMBIGUOUS_OPTIONS');
    return list;
  }
  function dismiss() { (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
  async function select(kind, id) {
    if (id === null || id === undefined || selected(kind) === id) return;
    const rows = await choices(kind); const row = rows.find(x => x.id === id);
    if (!row) { dismiss(); fail(kind === 'model' ? 'MODEL_UNAVAILABLE' : 'THINKING_UNAVAILABLE'); }
    row.node.click(); dismiss(); await until(() => selected(kind) === id);
  }
  // CoS reads the page's system_hints response at document_start, not an @ popup.
  const appCatalog = globalThis.CIP_createAppCatalog({ fail,
    activate: guard => globalThis.CIP_activateAppDiscovery({ composer, authored, chips, insert, guard, fail }) });
  async function appChoices(guard = () => {}) { return appCatalog.read(guard); }
  let ownedApps = null;
  // Reloaded Chrome documents can restore app-only composer marks without
  // retaining CIP's in-memory ownership. Track real user edits separately
  // instead of treating React's unstable innerHTML as intent.
  let editorTouchEpoch = 0;
  const humanEditorTouch = event => {
    if (!event.isTrusted) return;
    const node = event.target instanceof Element ? event.target : event.target?.parentElement;
    const box = C.composer();
    if (!node || !box?.contains(node)) return;
    // Merely opening model/thinking menus or placing the caret does NOT mean
    // the user changed app marks. Only actual editor intent can revoke them.
    if (event.type === 'pointerdown') {
      const chip = node.closest(S.chip);
      if (!chip || !node.closest('button,[role="button"]')) return;
    }
    if (event.type === 'keydown' && !['Backspace','Delete','Enter'].includes(event.key)) return;
    editorTouchEpoch++;
  };
  // execCommand and React can emit trusted input/beforeinput for OUR OWN
  // native marks. Only explicit human gestures are ownership changes here;
  // authored text and exact chip IDs are checked independently.
  for (const event of ['pointerdown','keydown','paste','drop','compositionstart'])
    document.addEventListener(event, humanEditorTouch, true);
  async function setApps(ids, guard = () => {}, ready = null) {
    guard(); const box = composer();
    if (authored(box)) throw draftError('apps-before-discovery', box, ready);
    // Selected apps require THIS document's complete native evidence. Selecting
    // zero apps grants nothing and must not depend on an unrelated hint request.
    const available = ids.length ? await appChoices(guard) : []; guard();
    if (composer() !== box || !box.isConnected || authored(box))
      throw draftError('apps-after-discovery', composer(), ready ?? composerSample(box));
    if (!ids.every(id => available.some(app => app.id === id))) fail('APP_UNAVAILABLE');
    const wanted = [...ids].sort(), selected = chips().map(c => c.id).sort();
    if (selected.some(id => !id)) fail('APP_ID_UNPROVEN');
    if (selected.some(id => !wanted.includes(id))) {
      // Only an untouched, text-free native editor may lose a restored mark
      // for an explicit Paseo app selection. Do not erase human-edited chips.
      // When we already own marks, any remaining IDs must be a subset:
      // the native editor may discard a mark during a harmless re-render.
      if ((ownedApps && (ownedApps.editEpoch !== editorTouchEpoch ||
            !selected.every(id => ownedApps.ids.includes(id)))) ||
          (!ownedApps && editorTouchEpoch !== 0))
        fail('APP_SELECTION_CHANGED');
      guard();
      if (!N.insertPrompt('', true)) fail('APP_REMOVAL_UNCONFIRMED');
      await delay(0); guard();
      if (composer() !== box || authored(box) || chips().length) fail('APP_REMOVAL_UNCONFIRMED');
    }
    for (const id of wanted) {
      if (chips().some(c => c.id === id)) continue;
      const app = available.find(app => app.id === id);
      guard(); if (!N.addAppMention(box, { path: `app://${id}`, name: app.label })) fail('APP_SELECTION_UNCONFIRMED');
      // Let the native editor parse its mark, as CoS does before clicking Send.
      await delay(0); guard();
      if (composer() !== box || authored(box) || !chips().some(c => c.id === id)) fail('APP_SELECTION_UNCONFIRMED');
    }
    if (JSON.stringify(chips().map(c => c.id).sort()) !== JSON.stringify(wanted)) fail('APPS_NOT_CONFIRMED');
    ownedApps = { ids: wanted, editEpoch: editorTouchEpoch };
  }
  function effectiveConfig() { return { model: selected('model'), thinkingOption: selected('thinking'), appIds: chips().map(x => x.id).sort() }; }
  const sameConfig = (a, b) => a.model === b.model && a.thinkingOption === (b.thinkingOption ?? null) && JSON.stringify(a.appIds) === JSON.stringify([...b.appIds].sort());
  async function configure(config, guard = () => {}, deadline = null) {
    let ready;
    try {
      ready = composerSample(await atStage('composer', () => waitForComposer(guard))); guard();
      if (stopVisible()) {
        // Chrome has reopened the bound page while an earlier ChatGPT turn
        // still has a visible Stop. Wait for its disappearance; do not click
        // Stop, clear its draft or dispatch a competing Send. Reserve time
        // for the one-shot Send receipt and respect the command deadline.
        const budget = Number.isFinite(deadline)
          ? Math.max(0, Math.min(30000, deadline - Date.now() - 35000))
          : 30000;
        if (budget < 600) fail('NATIVE_BUSY');
        let idleSince = 0;
        await atStage('native-idle', () => until(() => {
          if (stopVisible()) { idleSince = 0; return false; }
          idleSince ||= Date.now();
          return Date.now() - idleSince >= 500;
        }, budget, 'NATIVE_BUSY', guard));
        guard();
        if (stopVisible()) fail('NATIVE_BUSY');
      }
      if (authored(composer())) throw draftError('configure-start', composer(), ready);
    } catch (e) { e.notApplied = true; throw e; }
    const stillCurrent = () => { try { guard(); return true; } catch { return false; } };
    if (!await atStage('chat-surface', () => C.prepareChatModelSurface(stillCurrent))) throw errorStage(Object.assign(new Error('CHAT_SURFACE_UNCONFIRMED'), {code:'CHAT_SURFACE_UNCONFIRMED'}), 'chat-surface');
    if (nativeShape()) {
      nativeMode = true;
      if (!await M.selectModelSettings(config.model, config.thinkingOption, stillCurrent)) fail('MODEL_OR_THINKING_UNAVAILABLE');
      await refreshModelProof();
    } else { await select('model', config.model); await select('thinking', config.thinkingOption); }
    guard();
    await atStage('apps', () => setApps(config.appIds, guard, ready)); guard();
    const effective = effectiveConfig();
    // A null request means use the observed native default; report it rather than invent one.
    if (config.thinkingOption === null && effective.thinkingOption !== null) fail('THINKING_DEFAULT_UNSPECIFIED');
    if (effective.model !== config.model || effective.thinkingOption !== config.thinkingOption) fail('CONFIG_NOT_CONFIRMED');
    return effective;
  }
  async function catalog(guard = () => {}) {
    const ready = composerSample(await atStage('composer', () => waitForComposer(guard)));
    if (nativeShape()) {
      nativeMode = true;
      if (authored(composer()) || chips().length || stopVisible())
        throw draftError('catalog-start', composer(), ready, 'CATALOG_TAB_NOT_EMPTY');
      const stillCurrent = () => { try { guard(); return true; } catch { return false; } };
      if (!await atStage('chat-surface', () => C.prepareChatModelSurface(stillCurrent))) throw errorStage(Object.assign(new Error('CHAT_SURFACE_UNCONFIRMED'), {code:'CHAT_SURFACE_UNCONFIRMED'}), 'chat-surface');
      let reason = '';
      const result = await atStage('models', () => M.inspectModelSettings(stillCurrent, value => { reason = value; }));
      if (!result) { const code = 'PICKER_' + (reason || 'UNAVAILABLE').toUpperCase(); throw errorStage(Object.assign(new Error(code), {code}), 'models'); }
      const current = await refreshModelProof(); guard();
      const models = result.map(model => ({ id: model.id, label: model.label,
        thinkingOptions: model.efforts.map(id => ({ id, label: id })),
        defaultThinkingOption: model.id === current.model ? current.thinkingOption : model.efforts[0] }));
      // The app reader owns its single native probe and cleanup. Do not run a
      // second select-all cleanup that could erase a later human @ or draft.
      const apps = (await atStage('apps', () => appChoices(guard))).map(({ id, label }) => ({ id, label }));
      guard(); return { models, apps, defaultModel: current.model };
    }
    if (authored(composer()) || chips().length || stopVisible())
      throw draftError('catalog-start', composer(), ready, 'CATALOG_TAB_NOT_EMPTY');
    const current = selected('model'), currentThinking = selected('thinking'); const models = [];
    try {
      const rows = await atStage('models', () => choices('model')); const options = rows.map(({ id, label }) => ({ id, label })); dismiss();
      for (const model of options) {
        await select('model', model.id);
        const thinkingDefault = selected('thinking');
        const thinking = await choices('thinking'); dismiss();
        models.push({ ...model, thinkingOptions: thinking.map(({ id, label }) => ({ id, label })), defaultThinkingOption: thinkingDefault });
      }
      await select('model', current); await select('thinking', currentThinking);
      const apps = (await atStage('apps', () => appChoices(guard))).map(({ id, label }) => ({ id, label }));
      guard(); return { models, apps, defaultModel: current };
    } finally {
      // Only our still-empty catalog page may be restored. Never overwrite a user's draft.
      try { guard(); if (C.composer() && !authored(composer()) && !chips().length && !stopVisible()) { await select('model', current); guard(); await select('thinking', currentThinking); } } catch { /* Never restore another document. */ }
    }
  }
  function roleOf(n) { return n.getAttribute('data-message-author-role') || /:(user|assistant)$/.exec(n.getAttribute('data-chatgpt-search-unit-key') || n.getAttribute('data-content-search-unit-key') || '')?.[1]; }
  // Search/layout keys identify a rendered slot, not a ChatGPT message.
  const nativeId = id => typeof id === 'string' && /^[a-zA-Z0-9:._-]{1,200}$/.test(id) &&
    !/^fallback-turn-/i.test(id) && !/:(?:user|assistant)$/.test(id);
  // Rendered native USER identities only. Layout keys are never native IDs.
  // Armed HTTP proof remains available before a public user bubble mounts.
  function messages() {
    const result = new Map(), conflicts = new Set(), conversationId = C.conversationId();
    for (const node of document.querySelectorAll(S.messages)) {
      if (roleOf(node) !== 'user' || !node.closest('main,[role="main"],[data-app-shell-main-surface]') ||
          C.onKeptPage(node) || !C.composerCssVisible(node) ||
          node.closest('.clf-stream,.clf-stage,.clf-boot,[data-cip-owned],aside,nav,form,[hidden],[aria-hidden="true"],[inert]')) continue;
      let foreign = false;
      for (let at = node; at; at = at.parentElement) {
        const owner = at.getAttribute('data-conversation-id');
        if (owner && owner !== conversationId) foreign = true;
      }
      if (foreign) continue;
      const raw = node.getAttribute('data-chatgpt-search-message-ids');
      let ids = raw?.trim().split(/\s+/) ?? [];
      if (raw?.trim().startsWith('[')) {
        try { ids = JSON.parse(raw); } catch { continue; }
        if (!Array.isArray(ids)) continue;
      }
      const direct = node.getAttribute('data-message-id');
      if (direct) ids.unshift(direct);
      ids = [...new Set(ids)];
      if (ids.length !== 1 || !nativeId(ids[0])) continue;
      const id = ids[0], text = authored(node);
      if (result.has(id) && result.get(id).text !== text) conflicts.add(id);
      else if (!result.has(id)) result.set(id, { id, role: 'user', text, node });
    }
    return [...result.values()].filter(row => !conflicts.has(row.id));
  }
  function receiptTextMatch(row, expected) {
    if (row?.role !== 'user' || !nativeId(row.id)) return 'mismatch';
    // Rendered DOM is not raw native Markdown; don't unescape a wrong body.
    return receiptText.classify(row.text, expected, false);
  }
  const N = globalThis.CIP_createCoSNative({ composer, messages, conversationId: C.conversationId,
    generating: stopVisible, stopButton: () => pageControls().button?.('stop') ?? null,
    sendButton: C.sendButton, sendButtonEnabled: C.sendButtonEnabled });
  async function send(command, authorize, guard = () => {}, readFile = null) {
    const files=command.payload.files??[];
    let upload=null;
    let clicked = false, owned = null, receipt = null, refusal = null, authorizationError = null;
    let before = new Set();
    pendingReceiptProbe=null;
    let networkProof = null;
    let userTouched = false, writing = false;
    // Only a *trusted composer edit* can revoke draft ownership. Clicks,
    // keystrokes or scroll actions elsewhere on ChatGPT must not fail Send.
    // Keep the pre-click human-edit fence, including edit-and-undo; after the
    // native click, never reinterpret a new draft as a failed old Send.
    const editEvents = ['beforeinput','input','paste','drop','compositionstart','keydown','pointerdown'];
    const trustedEdit = event => {
      if (clicked || writing || !event.isTrusted) return;
      const node = event.target instanceof Element ? event.target : event.target?.parentElement;
      const box = C.composer();
      if (!box || !node || !box.contains(node)) return;
      if (event.type === 'pointerdown') {
        const chip = node.closest(S.chip);
        if (!chip || !node.closest('button,[role="button"]')) return;
      }
      if (event.type === 'keydown' && !['Backspace','Delete','Enter'].includes(event.key)) return;
      userTouched = true;
    };
    let guardCode = null;
    const alive = () => {
      try { if (userTouched) { guardCode = 'DRAFT_CHANGED'; return false; } guard(clicked); return true; }
      catch (error) {
        guardCode = ['PAGE_GONE','DOCUMENT_CHANGED','WRONG_CONVERSATION','NAVIGATION_CHANGED','COMMAND_CANCELLED','COMMAND_DEADLINE_EXCEEDED','SEND_LIFETIME_REVOKED'].includes(error?.code) ? error.code : 'GUARD_FAILED';
        return false;
      }
    };
    const startUrl = location.href, startPath = location.pathname;
    try {
      guard(); const config = await configure(command.payload.config, guard, command.deadline); guard();
      await refreshTranscript(); guard();
      before = new Set(messages().map(x => x.id));
      const box = composer();
      if (authored(box)) throw draftError('send-before-insert', box);
      if (box.closest('form')?.querySelector('[data-composer-attachments]:not(:empty),[data-inline-file-uploading]')) fail('ATTACHMENT_UNSUPPORTED');
      // Capture the identities actually selected through @ before replacing only our own chips.
      const mentions = chips().map(({node,id}) => {
        const copy = node.cloneNode(true); copy.querySelectorAll('button').forEach(n=>n.remove());
        return { path: 'app://' + id, name: node.getAttribute('app-mention-display-name') || copy.textContent.trim() };
      });
      if (userTouched) fail('DRAFT_CHANGED');
      if(!command.payload.text.trim() && !files.length)fail('NATIVE_INPUT_UNAVAILABLE');
      // Observe human edits from here on, through the upload. Native insertion
      // emits trusted events itself, so our synchronous writes are fenced off.
      for (const event of editEvents) document.addEventListener(event, trustedEdit, true);
      // Attachments BEFORE text: a refused or unconfirmed upload then leaves no
      // message text behind in ChatGPT's persisted homepage draft (B01).
      if(files.length) {
        if(!globalThis.CIP_UPLOAD?.attach || typeof readFile!=='function')
          fail('ATTACHMENT_BRIDGE_UNAVAILABLE');
        upload=await globalThis.CIP_UPLOAD.attach(command,box,readFile,()=>{
          guard();if(userTouched)fail('DRAFT_CHANGED');
        },command.deadline);
        guard();if(userTouched)fail('DRAFT_CHANGED');
      }
      writing = true;
      try {
        if(command.payload.text.trim() &&
           !N.insertPrompt(command.payload.text, true, reason => { refusal = reason; }))
          fail('NATIVE_INPUT_UNAVAILABLE');
        owned = { box, config: { ...config, appIds: [] }, editEpoch: editorTouchEpoch };
        if (authored(box) !== norm(command.payload.text)) fail('INPUT_NOT_CONFIRMED');
        for (const mention of mentions) {
          guard(); if (!N.addAppMention(box, mention)) fail('APP_SELECTION_UNCONFIRMED');
          owned.config.appIds.push(mention.path.slice('app://'.length));
        }
      } finally { writing = false; }
      await delay(0); guard();
      if (!sameConfig(effectiveConfig(), config) || authored(box) !== norm(command.payload.text)) fail('APP_SELECTION_UNCONFIRMED');
      // Keep the 12-second initial POST capture window, but give verified
      // browser sends time to receive delayed ChatGPT SSE headers. Never
      // exceed the existing one-shot command deadline.
      const receiptWindow = Number.isFinite(command.deadline)
        ? Math.max(1000, Math.min(70000, command.deadline - Date.now() - 3000))
        : 25000;
      const accepted = await N.send({
        acceptanceTimeoutMs: 25000, receiptTimeoutMs: receiptWindow, clearAcceptedDraft: false,
        stillCurrent: alive,
        observeEvidence: check => {
          // This polling exists only inside this one-shot Send receipt window.
          // It reads users, not a second assistant/tool/status transcript.
          let stopped=false,pending=false;
          const tick=async()=>{if(stopped||pending)return;pending=true;try{await refreshTranscript();if(!stopped)check();}finally{pending=false}};
          const timer=setInterval(tick,300);void tick();return()=>{stopped=true;clearInterval(timer)};
        },
        matchesUser: row => files.length>0 && !command.payload.text.trim()
          ? row?.role==='user' && nativeId(row.id) && row.text?.trim()===''
          : receiptTextMatch(row, command.payload.text) !== 'mismatch',
        // CoS native user ID sourced from one server-accepted POST whose exact
        // body hash was armed AFTER our durable one-shot authorization.
        sentRequest: clickedAt => networkProof?.since(clickedAt) ?? null,
        acceptUserReceipt: (row, conversationId) => {
          if (!clicked || !conversationId || !nativeId(row.id) || before.has(row.id)) return false;
          const latest = messages().filter(message => message.role === 'user').at(-1);
          if(row.sentRequest===true) {
            // An unrendered user bubble may be replaced after the actual Send.
            // Do not accept contradictory NEW page identity over HTTP proof.
            if(!networkProof || (latest && !before.has(latest.id) && latest.id!==row.id))return false;
            receipt={receipt:true,nativeMessageId:row.id,config,url:location.href,
              diagnostic:{stage:'receipt',nativeClicked:true,bodyMatch:'request'}};
            return true;
          }
          const bodyMatch = files.length>0 && !command.payload.text.trim() && row.text?.trim()==='' ? 'attachment' : receiptTextMatch(row, command.payload.text);
          if (latest?.id !== row.id || bodyMatch === 'mismatch') return false;
          receipt = { receipt: true, nativeMessageId: row.id, config, url: location.href,
            diagnostic: { stage: 'receipt', nativeClicked: true, bodyMatch } }; return true;
        },
        beforeSend: async stillReady => {
          try {
            guard(); if (!stillReady()) return false;
            await authorize(); guard();
            if (nativeMode) await refreshModelProof();
            // Optional proof; if ChatGPT's transport shape is unknown, the
            // existing exact-DOM receipt remains the only success path.
            try { networkProof=await globalThis.CIP_COS_SEND_RECEIPT?.arm(norm(command.payload.text),config.appIds)??null; }
            catch { networkProof=null; }
            return stillReady();
          } catch (e) { authorizationError = e; return false; }
        },
        beforeClick: () => {
          guard();
          if (userTouched || location.pathname !== startPath || !box.isConnected || composer() !== box)
            fail('PAGE_IDENTITY_CHANGED');
          // React may normalize/redecorate innerHTML without changing the
          // human message or selected app IDs. Those are the real invariants.
          if (authored(box) !== norm(command.payload.text)) fail('DRAFT_CHANGED');
          if (!sameConfig(effectiveConfig(), config)) fail('CONFIG_CHANGED');
          if(files.length){
            if(!upload?.proof())fail('ATTACHMENT_REMOVED');
          }else if (box.closest('form')?.querySelector('[data-composer-attachments]:not(:empty),[data-inline-file-uploading]'))
            fail('ATTACHMENT_UNSUPPORTED');
          if (messages().some(x=>!before.has(x.id)) || stopVisible()) fail('TURN_CHANGED');
          return true;
        },
        onDispatch: () => { guard(true); clicked = true; }, attachmentOnly: files.length>0 && !command.payload.text.trim(), explain: reason => { refusal = reason; }
      });
      if (!accepted || !receipt) {
        if (authorizationError) throw authorizationError;
        fail(clicked ? 'RECEIPT_UNCONFIRMED' : refusal === 'final-fence' ? 'DRAFT_OR_CONFIG_CHANGED' : 'SEND_NOT_READY');
      }
      // Confirm app selection from the actual outbound POST when available.
      // A DOM chip alone does not establish that the model can call the app.
      // This is evidence metadata, NOT permission to retry a sent message.
      const stage=networkProof?.status?.().stage??'unavailable';
      const appNetworkEvidence=!config.appIds.length?'none':
        stage==='apps'?'omitted':
        ['body','response','late','accepted'].includes(stage)?'included':'unverified';
      return {...receipt,appNetworkEvidence};
    } catch (e) {
      if (clicked) {
        // Public operational evidence only. Never log the authored message or app IDs.
        let users=[]; try { users=messages().filter(row=>row.role==='user'); } catch {}
        e.diagnostic={stage:'receipt',nativeClicked:true,guardCode,
          pathChanged:location.href!==startUrl,routeKnown:!!C.conversationId(),transcriptAvailable:users.length>0,
          rowCount:Math.min(128,users.length),matchingUserCount:Math.min(128,users.filter(row=>receiptTextMatch(row,command.payload.text)!=='mismatch').length),
          exactUserCount:Math.min(128,users.filter(row=>receiptTextMatch(row,command.payload.text)==='raw').length),
          escapedUserCount:Math.min(128,users.filter(row=>receiptTextMatch(row,command.payload.text)==='markdown').length),
          // User-only receipt diagnostics; no assistant collection coverage.
          networkStage:networkProof?.status?.().stage??'unavailable',
          networkRouteMoved:networkProof?.status?.().routeMoved??false,
          refusal:refusal==='chat-changed'?'chat-changed':refusal==='not-accepted'?'not-accepted':'other'};
      }
      if (clicked && !guardCode && C.conversationId() &&
          (!command.payload.conversationId ||
            C.conversationId()===command.payload.conversationId)) {
        // Exact route belongs to the already-authorized one-shot native click.
        // Preserve the durable link without treating this as delivery proof.
        e.bindingUrl=location.href;
        if(e.code==='RECEIPT_UNCONFIRMED'){
          pendingReceiptProbe={turnId:command.payload.turnId,text:command.payload.text,
            conversationId:C.conversationId(),before,mismatchKey:null,mismatchSince:null};
        }
      }
      if (!clicked) {
        e.notSent = true;
        // Known-unsent messages are discarded, not retained as retry drafts.
        // The @ marks reinserted by THIS attempt are ours too. Exact config,
        // document and edit fences still protect human changes and attachments.
        try {
          try { guard(); } catch (error) {
            // Cancellation/deadline revokes Send, not cleanup of our unchanged
            // draft. The guard checks document/route identity before these codes.
            if (!['COMMAND_CANCELLED','COMMAND_DEADLINE_EXCEEDED'].includes(error?.code)) throw error;
          }
          // Our own uploaded files go first; the text fence below refuses to
          // clear while ANY attachment remains in the composer.
          if (upload && !userTouched && location.pathname === startPath &&
              !stopVisible() && !messages().some(row => !before.has(row.id)))
            await upload.remove();
          if (owned && !userTouched && editorTouchEpoch === owned.editEpoch &&
              location.pathname === startPath && owned.box.isConnected && composer() === owned.box &&
              authored(owned.box) === norm(command.payload.text) && !stopVisible() &&
              !owned.box.closest('form')?.querySelector('[data-composer-attachments]:not(:empty),[data-inline-file-uploading]') &&
              sameConfig(effectiveConfig(), owned.config) &&
              !messages().some(row => !before.has(row.id))) {
            // A mark with conflicting identity attributes must not pass merely
            // because the display reader chose its first matching attribute.
            const marksUnchanged = chips().every(({node,id}) => id &&
              [node, ...node.querySelectorAll(S.chip)].every(mark =>
                ['data-app-id','data-prompt-link-href','app-mention-path','href'].every(field => {
                  const value = mark.getAttribute(field);
                  return !value || value === id || value === 'app://' + id;
                })));
            if (marksUnchanged && N.clearPromptExact(owned.box.textContent)) ownedApps = null;
          }
        } catch { /* Never replace the failure or erase a draft whose ownership is uncertain. */ }
      }
      throw e;
    } finally { networkProof?.close();for (const event of editEvents) document.removeEventListener(event, trustedEdit, true); }
  }
  // A soft receipt timeout never becomes a message receipt. Reconcile only a
  // previously authorized click, in the same document/conversation, against
  // the exact current user text and the native IDs observed before that click.
  async function probePendingReceipt(turnId) {
    const p=pendingReceiptProbe;
    if(!p||p.turnId!==turnId)return {available:false,active:false};
    if(!p.conversationId||C.conversationId()!==p.conversationId)return {conflict:true};
    const startUrl = location.href;
    await refreshTranscript();
    if (pendingReceiptProbe !== p || location.href !== startUrl || C.conversationId() !== p.conversationId)
      return {conflict:true};
    const users=messages().filter(row=>row.role==='user'&&!p.before.has(row.id));
    if(users.length>1)return {conflict:true};
    if(users.length===1){
      const row=users[0];
      if(receiptTextMatch(row,p.text)!=='mismatch')return {available:true,nativeMessageId:row.id};
      // A React redraw may briefly expose an incomplete user bubble.
      const mismatchKey=row.id+':'+row.text;
      if(p.mismatchKey!==mismatchKey){p.mismatchKey=mismatchKey;p.mismatchSince=Date.now();}
      if(Date.now()-p.mismatchSince>=10000)return {conflict:true};
    }
    return {available:true,active:stopVisible()};
  }
  function actionGuard(options, requireLease = false) {
    if (!options || typeof options.guard !== 'function') fail('CONTROL_GUARD_REQUIRED');
    if (typeof options.conversationId !== 'string' || !options.conversationId) fail('WRONG_CONVERSATION');
    const url = location.href, root = document.documentElement;
    const documentKey = globalThis.__CIP_CONTENT__?.documentKey;
    if (requireLease && (typeof options.observationLease !== 'string' || !options.observationLease))
      fail('OBSERVATION_LEASE_MISMATCH');
    if (requireLease && (typeof options.documentKey !== 'string' || !options.documentKey ||
        options.documentKey !== documentKey)) fail('DOCUMENT_CHANGED');
    return () => {
      if (options.guard() === false) fail('GUARD_FAILED');
      if (document.documentElement !== root || globalThis.__CIP_CONTENT__?.documentKey !== documentKey)
        fail('DOCUMENT_CHANGED');
      if (location.href !== url) fail('NAVIGATION_CHANGED');
      if (C.conversationId() !== options.conversationId) fail('WRONG_CONVERSATION');
    };
  }
  function actionable(button) {
    return button?.tagName === 'BUTTON' && button.isConnected && !button.disabled &&
      !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true' &&
      pageControls().visible(button);
  }
  async function stop(options) {
    const guard = actionGuard(options, true); guard();
    const controls = pageControls(), view = controls.read();
    const button = controls.button?.('stop');
    if (!view.controls?.stop?.visible || !view.controls.stop.enabled || !actionable(button))
      fail('STOP_UNCONFIRMED');
    guard();
    if (controls.button?.('stop') !== button || !stopVisible() || !actionable(button))
      fail('STOP_UNCONFIRMED');
    button.click(); // Exactly one native Stop. Never Deny.
    await until(() => {
      const current = controls.read();
      return current.state === 'standby' && current.controls.stop.visible === false &&
        (current.controls.send.visible || current.controls.voice.visible);
    }, 5000, 'STOP_UNCONFIRMED', guard);
    guard();
    return { stopped: true }; // Only the unified monitor reports page state.
  }
  async function answerApproval(options) {
    const guard = actionGuard(options); guard();
    const { key, choice } = options;
    if (typeof key !== 'string' || !key || !['allow-once', 'deny'].includes(choice))
      fail('APPROVAL_UNSUPPORTED');
    const content = globalThis.CIP_PAGE_CONTENT;
    if (typeof content?.resolveApproval !== 'function') fail('APPROVAL_UNAVAILABLE');
    const button = content.resolveApproval(key, choice);
    const card = button?.closest('[data-codex-approval-surface="true"]');
    if (!card || !actionable(button)) fail('APPROVAL_GONE');
    guard();
    if (content.resolveApproval(key, choice) !== button || !actionable(button)) fail('APPROVAL_GONE');
    const displayedRequest = card.innerText;
    button.click(); // Never called by read(), receipt reconciliation or Stop.
    await until(() => {
      if (!card.isConnected) return true;
      if (card.innerText !== displayedRequest) fail('APPROVAL_UNCONFIRMED');
      if (button.disabled || button.matches(':disabled') ||
          button.getAttribute('aria-disabled') === 'true') return true;
      if (content.resolveApproval(key, choice) !== button) fail('APPROVAL_UNCONFIRMED');
      return false;
    }, 5000, 'APPROVAL_UNCONFIRMED', guard);
    guard();
    return { answered: true, key, choice };
  }
  globalThis.CIP_DOM = { upstream: Object.freeze({ engine: 'CoS native send/picker/controls', commit: 'ccd23b66cecf2f684fa3e12ca190297be02842cf' }), conversationId: C.conversationId, refreshTranscript, probePendingReceipt, effectiveConfig, catalog, configure, send, stop, answerApproval, messages, composer, authored, norm };
})();
