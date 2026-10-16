/* Paseo-specific adapter over transplanted CoS native controls, picker and Send engine.
 * Generic @ catalog, exact per-session configuration and bounded message projection remain CIP code.
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

  // Narrow IPC adapter around the copied CoS public-message/terminal readers.
  // Page evidence is untrusted. Only exact native ids, public prose and a final boolean enter this cache.
  let transcript=null, transcriptRequest=null;
  // Only one Send may belong to this document at a time. Retain the exact
  // pre-click user IDs and text after a soft receipt deadline, not a new Send.
  let pendingReceiptProbe=null;
  async function refreshTranscript() {
    // Restored documents have not configured a model yet. They still need the
    // native reader to prove the current user message before reattaching observation.
    if(!nativeMode && !nativeShape())return;
    nativeMode=true;
    if(transcriptRequest)return transcriptRequest;
    const path=location.pathname;
    transcriptRequest=new Promise(resolve=>{
      const nonce=crypto.randomUUID();let done=false;
      const finish=value=>{if(done)return;done=true;clearTimeout(timer);window.removeEventListener('message',receive);
        if(location.pathname===path)transcript=value;resolve();};
      const receive=event=>{
        const d=event.data;
        if(event.source!==window||event.origin!==location.origin||d?.source!=='cip-cos-transcript-reply'||d.nonce!==nonce||d.v!==1)return;
        const value=d.transcript;
        if(value?.path!==path||!Array.isArray(value.messages)||value.messages.length>1000||typeof value.available!=='boolean')return finish(null);
        if(value.error)return finish({path,error:'TRANSCRIPT_UNCONFIRMED',available:false,messages:[]});
        let chars=0;const seen=new Set(),messages=[];
        for(const row of value.messages){
          if(!row||typeof row.id!=='string'||!row.id||row.id.length>200||seen.has(row.id)||!['user','assistant'].includes(row.role)||typeof row.text!=='string'||typeof row.final!=='boolean')return finish(null);
          chars+=row.text.length;if(chars>512000||row.text.length>256000)return finish(null);
          seen.add(row.id);messages.push({id:row.id,role:row.role,text:row.text,final:row.final});
        }
        // MAIN-world public activity is treated as untrusted input. The native
        // message identity must already appear in this same transcript.
        const source=value.activity;let activity=null;
        if(source && typeof source==='object' && !Array.isArray(source) &&
           messages.some(m=>m.role==='user'&&m.id===source.userMessageId) &&
           ['working','thinking','tool','search','exec','image','approval','finalizing','completed'].includes(source.phase) &&
           ['complete','in_progress',null].includes(source.nativeStatus) &&
           Array.isArray(source.steps)&&source.steps.length<=12) {
          const steps=[];let valid=true;
          for(const item of source.steps) {
            if(!item || !['tool','search','exec','image'].includes(item.kind) ||
               typeof item.label!=='string'||item.label.length>160 ||
               !/^[\p{L}\p{N}_.: ·-]{1,160}$/u.test(item.label) ||
               typeof item.done!=='boolean') { valid=false; break; }
            steps.push({kind:item.kind,label:item.label,done:item.done});
          }
          if(valid)activity={userMessageId:source.userMessageId,phase:source.phase,
            nativeStatus:source.nativeStatus,steps};
        }
        // Native thinking recaps and tool-call lifecycle. The native reader
        // already excludes hidden/private groups; validate every field AGAIN
        // before crossing into the isolated extension world.
        let timeline=null;
        const sourceTimeline=value.timeline;
        if(sourceTimeline && messages.some(m=>m.role==='user'&&m.id===sourceTimeline.userMessageId) &&
           Array.isArray(sourceTimeline.reasoning)&&sourceTimeline.reasoning.length<=8 &&
           Array.isArray(sourceTimeline.calls)&&sourceTimeline.calls.length<=32){
          const seenCalls=new Set(),seenReason=new Set(),reasoning=[],calls=[];
          let valid=true;
          for(const r of sourceTimeline.reasoning){
            if(!r||!nativeId(r.id)||seenReason.has(r.id)||typeof r.text!=='string'||
               !r.text.trim()||r.text.length>4096){valid=false;break;}
            seenReason.add(r.id);reasoning.push({id:r.id,text:r.text});
          }
          if(valid)for(const c of sourceTimeline.calls){
            if(!c||!nativeId(c.callId)||seenCalls.has(c.callId)||
               !['tool','search','exec','image'].includes(c.kind)||
               !['running','completed','failed'].includes(c.status)||
               typeof c.name!=='string'||c.name.length>160||
               !/^[\p{L}\p{N}_.: ·-]{1,160}$/u.test(c.name)){valid=false;break;}
            seenCalls.add(c.callId);
            let details=null;
             if(c.details && typeof c.details==='object' && !Array.isArray(c.details) &&
                Object.keys(c.details).every(k=>['input','output'].includes(k)) &&
                ['input','output'].every(k=>c.details[k]===undefined||
                   typeof c.details[k]==='string'&&c.details[k].length<=2048)){
               details={...('input' in c.details?{input:c.details.input}:{}),
                 ...('output' in c.details?{output:c.details.output}:{})};
             }
             calls.push({callId:c.callId,name:c.name,kind:c.kind,status:c.status,
               ...(details?{details}:{})});
          }
          if(valid)timeline={userMessageId:sourceTimeline.userMessageId,reasoning,calls};
        }
        // Bounded operational counters only; no content, prompts or IDs in logs.
        const rawCoverage=value.coverage??{};
        const coverage={};
        for(const field of ['sourceSections','sourceMatches','sourceUsers'])
          if(Number.isInteger(rawCoverage[field])&&rawCoverage[field]>=0&&rawCoverage[field]<=128)
            coverage[field]=rawCoverage[field];
        try { finish({path,available:value.available,messages,activity,timeline,coverage,...globalThis.CIP_MEDIA?.project(value)}); }
        catch { finish({path,error:'TRANSCRIPT_UNCONFIRMED',available:false,messages:[]}); }
      };
      const timer=setTimeout(()=>finish(null),1500);window.addEventListener('message',receive);
      window.postMessage({source:'cip-cos-transcript-ask',nonce},location.origin);
    }).finally(()=>{transcriptRequest=null;});
    return transcriptRequest;
  }
  const S = {
    composer: '#prompt-textarea',
    send: 'button[data-testid="send-button"], form button[aria-label^="Send" i], form[data-chatgpt-composer] button[type="submit"]',
    stop: 'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="Stop answering"]',
    chip: '[data-prompt-link-href^="app://"], [app-mention-path]',
    model: 'button[data-testid="model-switcher-dropdown-button"], button[data-testid="composer-model-selector"], button[data-testid="composer-intelligence-picker-trigger"]',
    modelMenu: '[data-testid="composer-intelligence-picker-content"], [data-model-picker-view], [role="menu"], [role="listbox"]',
    thinking: 'button[data-testid="thinking-effort-dropdown-button"], button[data-testid="thinking-time-button"], button[data-testid="composer-thinking-effort"]',
    option: '[role="option"], [role="menuitem"], [role="menuitemradio"]',
    approval: '[data-codex-approval-surface="true"]',
    messages: '[data-message-author-role], [data-chatgpt-search-unit-key]',
    copy: 'button[data-testid="copy-turn-action-button"]'
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
  // Same deterministic body serialization for editor validation, receipts and answers.
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
  async function setApps(ids, guard = () => {}) {
    guard(); const box = composer();
    if (authored(box)) fail('DRAFT_CONFLICT');
    // Selected apps require THIS document's complete native evidence. Selecting
    // zero apps grants nothing and must not depend on an unrelated hint request.
    const available = ids.length ? await appChoices(guard) : []; guard();
    if (composer() !== box || !box.isConnected || authored(box)) fail('DRAFT_CONFLICT');
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
    try {
      await atStage('composer', () => waitForComposer(guard)); guard();
      if (C.generating()) {
        // Chrome has reopened the bound page while an earlier ChatGPT turn
        // is still generating. Wait for confirmed native idle; do not click
        // Stop, clear its draft or dispatch a competing Send. Reserve time
        // for the one-shot Send receipt and respect the command deadline.
        const budget = Number.isFinite(deadline)
          ? Math.max(0, Math.min(30000, deadline - Date.now() - 35000))
          : 30000;
        if (budget < 600) fail('NATIVE_BUSY');
        let idleSince = 0;
        await atStage('native-idle', () => until(() => {
          if (C.generating()) { idleSince = 0; return false; }
          idleSince ||= Date.now();
          return Date.now() - idleSince >= 500;
        }, budget, 'NATIVE_BUSY', guard));
        guard();
        if (C.generating()) fail('NATIVE_BUSY');
      }
      if (authored(composer())) fail('DRAFT_CONFLICT');
    } catch (e) { e.notApplied = true; throw e; }
    const stillCurrent = () => { try { guard(); return true; } catch { return false; } };
    if (!await atStage('chat-surface', () => C.prepareChatModelSurface(stillCurrent))) throw errorStage(Object.assign(new Error('CHAT_SURFACE_UNCONFIRMED'), {code:'CHAT_SURFACE_UNCONFIRMED'}), 'chat-surface');
    if (nativeShape()) {
      nativeMode = true;
      if (!await M.selectModelSettings(config.model, config.thinkingOption, stillCurrent)) fail('MODEL_OR_THINKING_UNAVAILABLE');
      await refreshModelProof();
    } else { await select('model', config.model); await select('thinking', config.thinkingOption); }
    guard();
    await atStage('apps', () => setApps(config.appIds, guard)); guard();
    const effective = effectiveConfig();
    // A null request means use the observed native default; report it rather than invent one.
    if (config.thinkingOption === null && effective.thinkingOption !== null) fail('THINKING_DEFAULT_UNSPECIFIED');
    if (effective.model !== config.model || effective.thinkingOption !== config.thinkingOption) fail('CONFIG_NOT_CONFIRMED');
    return effective;
  }
  async function catalog(guard = () => {}) {
    await atStage('composer', () => waitForComposer(guard));
    if (nativeShape()) {
      nativeMode = true;
      if (authored(composer()) || chips().length || C.generating()) fail('CATALOG_TAB_NOT_EMPTY');
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
    if (authored(composer()) || chips().length || C.generating()) fail('CATALOG_TAB_NOT_EMPTY');
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
      try { guard(); if (C.composer() && !authored(composer()) && !chips().length && !C.generating()) { await select('model', current); guard(); await select('thinking', currentThinking); } } catch { /* Never restore another document. */ }
    }
  }
  function roleOf(n) { return n.getAttribute('data-message-author-role') || /:(user|assistant)$/.exec(n.getAttribute('data-chatgpt-search-unit-key') || '')?.[1]; }
  // Search/layout keys identify a rendered slot, not a ChatGPT message.
  const nativeId = id => typeof id === 'string' && /^[a-zA-Z0-9:._-]{1,200}$/.test(id) &&
    !/^fallback-turn-/i.test(id) && !/:(?:user|assistant)$/.test(id);
  function messages() {
    if(transcript?.path===location.pathname && transcript.error)return [];
    if(transcript?.path===location.pathname && transcript.available)
      return transcript.messages.filter(row=>nativeId(row.id)).map(row=>({...row,node:row}));
    const result = [], seen = new Set();
    for (const n of document.querySelectorAll(S.messages)) {
      const role = roleOf(n); if (!['user', 'assistant'].includes(role) || C.onKeptPage(n) || !C.composerCssVisible(n) || n.closest('.clf-stream,.clf-stage,.clf-boot')) continue;
      const id = n.getAttribute('data-message-id');
      if (!nativeId(id) || seen.has(id)) continue; seen.add(id);
      const section = n.closest('section[data-testid^="conversation-turn"], [data-turn-key]') || n;
      // Only a dedicated TURN action, not a generic code-block Copy button.
      const assistantNodes = [...section.querySelectorAll(S.messages)].filter(x => roleOf(x) === 'assistant');
      const exactLast = !assistantNodes.length || assistantNodes.at(-1) === n;
      const copy = [...section.querySelectorAll(S.copy)].some(x => visible(x) && !x.closest('pre,code,[data-code-block]'));
      const interrupted = n.closest('[data-interrupted="true"],[data-is-streaming="true"]');
      const final = !interrupted && (n.getAttribute('data-is-final') === 'true' || (copy && exactLast));
      result.push({ id, role, text: authored(n), final, node: n });
    }
    return result;
  }
  function receiptTextMatch(row, expected) {
    if (row?.role !== 'user' || !nativeId(row.id)) return 'mismatch';
    // Decode only our current, exact-ID native source, never a visible DOM label.
    const native = transcript?.path === location.pathname && transcript.available === true &&
      transcript.messages.some(source => source.role === 'user' && source.id === row.id && source.text === row.text);
    return receiptText.classify(row.text, expected, native === true);
  }
  function priorFinal(anchorId) {
    // A new user message can arrive before the prior native turn's final
    // snapshot reaches Paseo. Only a terminal assistant item between the two
    // verified user IDs may settle that older turn.
    if(transcript?.path===location.pathname && transcript.error)return null;
    const rows=messages(),start=rows.findIndex(row=>row.role==='user'&&row.id===anchorId);
    if(start<0)return null;
    const next=rows.findIndex((row,i)=>i>start&&row.role==='user');
    if(next<0)return null;
    const assistant=rows.slice(start+1,next).filter(row=>row.role==='assistant').at(-1);
    return assistant?.final===true?{messageId:assistant.id,text:assistant.text}:null;
  }
  function state(anchorId) {
    if(transcript?.path===location.pathname && transcript.error)fail(transcript.error);
    const all = messages(); const user = all.filter(x => x.role === 'user').at(-1);
    if (!user) fail('TRANSCRIPT_PENDING');
    if (user.id !== anchorId) fail('TURN_CHANGED');
    const at = all.findIndex(x => x.id === anchorId); const after = all.slice(at + 1).filter(x => x.role === 'assistant');
    const answer = after.at(-1) ?? null;
    // A quoted error phrase is normal assistant prose, not a transport failure.
    // Nor may a stale banner in another turn fail this exact native user turn.
    const ownerIds=new Set([anchorId,answer?.id].filter(Boolean));
    const alerts=[...document.querySelectorAll('[data-testid="conversation-error"],[data-testid="error-message"]')]
      .filter(n=>visible(n)&&!C.onKeptPage(n) && (() => {
        const owner=n.closest('[data-message-id]');
        if(owner&&ownerIds.has(owner.getAttribute('data-message-id')))return true;
        const section=n.closest('[data-turn-key],section[data-testid^="conversation-turn"]');
        return !!section&&[...section.querySelectorAll('[data-message-id]')]
          .some(row=>ownerIds.has(row.getAttribute('data-message-id')));
      })());
    const images = (transcript?.path===location.pathname ? transcript.images : [])?.filter(x=>x.userMessageId===anchorId) ?? [];
    const imageFinalId = images.some(x=>x.messageId===transcript?.imageFinalId) ? transcript.imageFinalId : null;
    const activity=transcript?.activity?.userMessageId===anchorId ? transcript.activity : null;
    const timeline=transcript?.timeline?.userMessageId===anchorId ? transcript.timeline : null;
    // A native in-progress turn remains active when the Stop control flickers
    // or vanishes during tools. Only this same user's mounted native turn counts.
    return { busy: C.generating() || activity?.nativeStatus==='in_progress',
      waiting: C.approvalWaiting(), answer, images, imageFinalId, activity, timeline,
      error: transcript?.mediaError || (alerts.length ? 'NATIVE_ERROR' : null) };
  }
  const N = globalThis.CIP_createCoSNative({ composer, messages, conversationId: C.conversationId,
    generating: C.generating, stopButton: C.stopButton, sendButton: C.sendButton, sendButtonEnabled: C.sendButtonEnabled });
  async function send(command, authorize, guard = () => {}, readFile = null) {
    const files=command.payload.files??[];
    let fileProof=()=>true;
    let clicked = false, owned = null, receipt = null, refusal = null, authorizationError = null;
    let before = new Set();
    pendingReceiptProbe=null;
    let networkProof = null;
    let userTouched = false;
    // Only a *trusted composer edit* can revoke draft ownership. Clicks,
    // keystrokes or scroll actions elsewhere on ChatGPT must not fail Send.
    // Keep the pre-click human-edit fence, including edit-and-undo; after the
    // native click, never reinterpret a new draft as a failed old Send.
    const editEvents = ['beforeinput','input','paste','drop','compositionstart','keydown','pointerdown'];
    const trustedEdit = event => {
      if (clicked || !event.isTrusted) return;
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
      if (authored(box)) fail('DRAFT_CONFLICT');
      if (box.closest('form')?.querySelector('[data-composer-attachments]:not(:empty),[data-inline-file-uploading]')) fail('ATTACHMENT_UNSUPPORTED');
      // Capture the identities actually selected through @ before replacing only our own chips.
      const mentions = chips().map(({node,id}) => {
        const copy = node.cloneNode(true); copy.querySelectorAll('button').forEach(n=>n.remove());
        return { path: 'app://' + id, name: node.getAttribute('app-mention-display-name') || copy.textContent.trim() };
      });
      if (userTouched) fail('DRAFT_CHANGED');
      if(command.payload.text.trim() &&
         !N.insertPrompt(command.payload.text, true, reason => { refusal = reason; }))
        fail('NATIVE_INPUT_UNAVAILABLE');
      if(!command.payload.text.trim() && !files.length)fail('NATIVE_INPUT_UNAVAILABLE');
      owned = { box };
      if (authored(box) !== norm(command.payload.text)) fail('INPUT_NOT_CONFIRMED');
      for (const mention of mentions) {
        guard(); if (!N.addAppMention(box, mention)) fail('APP_SELECTION_UNCONFIRMED');
      }
      // CoS waits for the native editor's next task to adopt the mention mark.
      await delay(0); guard();
      if (!sameConfig(effectiveConfig(), config) || authored(box) !== norm(command.payload.text)) fail('APP_SELECTION_UNCONFIRMED');
      // CoS native insertPrompt and addAppMention themselves fire trusted
      // editor input events. Observe HUMAN edits only after those synchronous
      // writes are finished, while waiting for the actual Send click.
      for (const event of editEvents) document.addEventListener(event, trustedEdit, true);
      if(files.length) {
        if(!globalThis.CIP_UPLOAD?.attach || typeof readFile!=='function')
          fail('ATTACHMENT_BRIDGE_UNAVAILABLE');
        fileProof=await globalThis.CIP_UPLOAD.attach(command,box,readFile,()=>{
          guard();if(userTouched)fail('DRAFT_CHANGED');
        },command.deadline);
        guard();if(userTouched)fail('DRAFT_CHANGED');
      }
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
          if(!nativeMode)return ()=>{};
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
            if(!fileProof())fail('ATTACHMENT_REMOVED');
          }else if (box.closest('form')?.querySelector('[data-composer-attachments]:not(:empty),[data-inline-file-uploading]'))
            fail('ATTACHMENT_UNSUPPORTED');
          if (messages().some(x=>!before.has(x.id)) || C.generating()) fail('TURN_CHANGED');
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
          pathChanged:location.href!==startUrl,routeKnown:!!C.conversationId(),transcriptAvailable:transcript?.path===location.pathname&&transcript.available===true,
          rowCount:Math.min(128,users.length),matchingUserCount:Math.min(128,users.filter(row=>receiptTextMatch(row,command.payload.text)!=='mismatch').length),
          exactUserCount:Math.min(128,users.filter(row=>receiptTextMatch(row,command.payload.text)==='raw').length),
          escapedUserCount:Math.min(128,users.filter(row=>receiptTextMatch(row,command.payload.text)==='markdown').length),
          ...((transcript?.path===location.pathname&&transcript.coverage)||{}),
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
        // A failed, unclicked command must not strand its own untouched draft
        // merely because React re-rendered a decorative span. Never delete a
        // human edit, attachment or any existing native @ app mark; those are
        // user-owned and must remain visible for an explicit next action.
        if (owned && !userTouched && location.pathname === startPath &&
            owned.box.isConnected && composer() === owned.box &&
            authored(owned.box) === norm(command.payload.text) &&
            chips().length === 0 && !C.generating() &&
            !owned.box.closest('form')?.querySelector('[data-composer-attachments]:not(:empty),[data-inline-file-uploading]') &&
            sameConfig(effectiveConfig(), command.payload.config) &&
            !messages().some(row => !before.has(row.id)))
          N.clearPromptExact(owned.box.textContent);
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
    await refreshTranscript();
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
    return {available:true,active:Boolean(C.generating()||C.approvalWaiting())};
  }
  async function stop(nativeMessageId) {
    const current = state(nativeMessageId);
    if (!current.busy) fail('STOP_UNCONFIRMED');
    if (!C.stopGeneration(() => { try { return state(nativeMessageId).busy; } catch { return false; } })) fail('STOP_UNCONFIRMED');
    await until(() => !C.generating());
    await delay(1000); if (C.generating()) fail('STOP_UNCONFIRMED');
    state(nativeMessageId); return { stopped: true, nativeMessageId };
  }
  globalThis.CIP_DOM = { upstream: Object.freeze({ engine: 'CoS native send/picker/controls', commit: 'ccd23b66cecf2f684fa3e12ca190297be02842cf' }), conversationId: C.conversationId, refreshTranscript, probePendingReceipt, effectiveConfig, catalog, configure, send, stop, state, priorFinal, messages, composer, authored, norm };
})();
