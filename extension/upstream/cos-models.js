/* Direct CoS chatgpt-dom.js picker function transplant (MIT), pinned ccd23b66cecf2f684fa3e12ca190297be02842cf.
 * Changes: CIP message/stamp namespace, dependency injection, strict no-nearest-effort selection,
 * stricter choice validation, missing-original-choice guard and native-control opening before model proof. No private model API.
 */
(() => {
  'use strict';
  globalThis.CIP_createCoSModels = function createCoSModels({ composer, prepareChatModelSurface }) {
    const OWN_SURFACES = '.clf-stream, .clf-stage, .clf-composer, .clf-boot';
    const PICKER = '[data-testid="composer-intelligence-picker-content"], [data-model-picker-view]';
    const observedPairs = new Map();
    let observedPath = null;
  function readPickerState() {
    return new Promise(resolve => {
      const nonce = crypto.randomUUID();
      const finish = value => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(value); };
      const receive = event => {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || data?.source !== 'cip-cos-picker-reply' || data.nonce !== nonce || data.v !== 1) return;
        const state = data.picker;
        const groupId = value => typeof value === 'string' && value.length <= 80 && /^[\p{L}\p{N}._ -]+$/u.test(value) && value.trim() === value && value.trim();
        const valid = state && typeof state.version === 'string' && Number.isInteger(state.currentBucket) &&
          Array.isArray(state.versions) && state.versions.length > 0 && state.versions.length <= 20 &&
          state.versions.every(v => groupId(v.id) && typeof v.label === 'string' && v.label.length > 0 && v.label.length <= 80) &&
          Array.isArray(state.choices) && state.choices.length > 0 && state.choices.length <= 12 &&
          state.choices.every(c => Number.isInteger(c.bucket) && typeof c.id === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(c.id) && typeof c.label === 'string' && c.label.length > 0 && c.label.length <= 80 &&
            groupId(c.familyId) && typeof c.familyLabel === 'string' && c.familyLabel.length > 0 && c.familyLabel.length <= 80 &&
            ['none','minimal','low','medium','high','xhigh','max','ultra','pro'].includes(c.effort) && typeof c.available === 'boolean') &&
          new Set(state.versions.map(v => v.id)).size === state.versions.length && new Set(state.choices.map(c => c.bucket)).size === state.choices.length &&
          state.versions.some(v => v.id === state.version) && state.choices.some(c => c.bucket === state.currentBucket);
        if (observedPath !== location.pathname) { observedPairs.clear(); observedPath = location.pathname; }
        if (valid) for (const c of state.choices) if (c.available) {
          const key = `${c.id}\u0000${c.effort}`;
          const old = observedPairs.get(key);
          // Conflicting family evidence is never resolved by last-writer-wins.
          observedPairs.set(key, observedPairs.has(key) && old !== c.familyId ? null : c.familyId);
        }
        // Copy a small allowlist, never forward the page's object or its extra fields.
        finish(valid ? { version: state.version, currentBucket: state.currentBucket,
          versions: state.versions.map(({id,label})=>({id,label})),
          choices: state.choices.map(({bucket,id,label,familyId,familyLabel,effort,available})=>({bucket,id,label,familyId,familyLabel,effort,available})) } : null);
      };
      const timer = setTimeout(() => finish(null), 1500);
      window.addEventListener('message', receive);
      window.postMessage({ source: 'cip-cos-picker-ask', nonce }, location.origin);
    });
  }
  function modelPickerTrigger() {
    const reported = '[data-codex-intelligence-trigger],[data-composer-navigation-target="reasoning"]';
    const candidates = [...new Set([...(composer()?.closest('form')?.querySelectorAll('button[aria-haspopup="menu"]') || []), ...document.querySelectorAll(reported)])]
      .filter(node => node.matches('button,[role="button"]') && !node.closest(`${OWN_SURFACES},[data-testid^="conversation-turn"],[data-message-author-role],.markdown,[contenteditable],[hidden],[aria-hidden="true"],[inert]`) && node.getClientRects().length > 0 &&
        node.id !== 'composer-plus-btn' && node.getAttribute('data-testid') !== 'composer-plus-btn');
    const observed = candidates.filter(node => node.getAttribute('data-cip-cos-picker-route') === location.pathname);
    if (observed.length) return observed.length === 1 ? observed[0] : null;
    // Native controls can expose their model metadata only after opening.
    // Recognizing the control permits opening, not accepting its selection:
    // selectModelSettings still requires the exact model/effort from state().
    const native = candidates.filter(node => node.matches(reported));
    return native.length === 1 ? native[0] : candidates.length === 1 ? candidates[0] : null;
  }
  function pickerVersionNamed(row, expected) {
    const text = node => String(node.textContent || '').replace(/\s+/g, ' ').trim();
    const name = expected.replace(/\s+/g, ' ').trim();
    for (let node = row, depth = 0; node && depth < 8; depth++) {
      if (text(node) === name) return true;
      node = [...node.childNodes].find(child => text(child) &&
        (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.ELEMENT_NODE && !child.matches('svg,[hidden],[aria-hidden="true"],[inert]')));
    }
    return false;
  }
  function modelPickerAccess(stillCurrent) {
    const shown = node => node && !node.closest('[hidden],[aria-hidden="true"],[inert]') && node.getClientRects().length > 0;
    const picker = () => document.querySelector(PICKER);
    const trigger = modelPickerTrigger;
    let motion = null;
    const openPicker = () => {
      const panel = picker();
      return panel && panel.closest('[role="menu"],[role="dialog"]')?.getAttribute('data-state') !== 'closed' ? panel : null;
    };
    const wait = (read, timeout = 3000) => new Promise(resolve => {
      let reading = false, dirty = false, done = false;
      const finish = value => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(value); };
      const check = async () => {
        if (done) return;
        if (!stillCurrent()) return finish(null);
        if (reading) { dirty = true; return; }
        reading = true;
        try { let value = read(); if (value?.then) value = await value; if (stillCurrent() && value) finish(value); }
        catch { finish(null); }
        finally { reading = false; if (dirty && !done) { dirty = false; void check(); } }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(null), timeout); void check();
    });
    const state = predicate => wait(async () => { const value = await readPickerState(); return value && (!predicate || predicate(value)) ? value : null; });
    const readyTrigger = () => wait(async () => { await readPickerState(); return trigger(); }, 15000);
    const key = (node, value) => { if (!node || !stillCurrent()) return false; node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: value, code: value, bubbles: true, cancelable: true })); return true; };
    return {
      state,
      async open() {
        if (!stillCurrent()) return null;
        motion = document.createElement('style');
        motion.textContent = '[role="menu"]:has(> [data-testid="composer-intelligence-picker-content"]),[role="dialog"]:has([data-testid="composer-intelligence-picker-content"]),[role="menu"]:has([data-model-picker-view]),[role="menu"][data-model-picker-view]{animation:none!important}';
        document.head.append(motion);
        if (!await readyTrigger() || !await prepareChatModelSurface(stillCurrent)) return null;
        if (!openPicker()) { const button = await readyTrigger(); if (!key(button, 'Enter') || !await wait(openPicker)) return null; }
        return state();
      },
      async close() {
        try {
          if (!stillCurrent()) return false;
          const panel = picker();
          if (!panel) return true;
          const dialog = panel.closest('[role="dialog"]'), active = document.activeElement;
          if (!shown(panel) && !shown(dialog)) return true;
          if (!key(panel.contains(active) || dialog?.contains(active) ? active : panel, 'Escape')) return false;
          const closed = Boolean(await wait(() => !shown(picker()) && (!dialog?.isConnected || !shown(dialog))));
          if (closed && stillCurrent()) await readPickerState();
          return closed && stillCurrent();
        } finally { motion?.remove(); motion = null; }
      },
      async version(version) {
        const before = await state(); if (!before) return null;
        const versionRows = () => [...(picker()?.querySelectorAll('[role="menuitemradio"]') || [])].filter(shown);
        if (before.version === version && !versionRows().length) return before;
        const label = before.versions.find(v => v.id === version)?.label;
        if (!label) return null;
        if (!versionRows().length) {
          const toggle = [...picker().querySelectorAll('[role="menuitem"][aria-expanded], [role="menuitem"][data-model-picker-view-toggle]')].filter(shown);
          if (toggle.length !== 1) return null;
          toggle[0].click();
        }
        const option = await wait(() => {
          const rows = versionRows().filter(node => pickerVersionNamed(node, label) && node.getAttribute('aria-disabled') !== 'true');
          return rows.length === 1 ? rows[0] : null;
        });
        if (!key(option, 'Enter')) return null;
        return state(next => next.version === version && !versionRows().length);
      },
      async bucket(bucket) {
        let current = await state();
        for (let count = 0; current && count < 12; count++) {
          if (current.currentBucket === bucket) return current;
          const from = current.choices.findIndex(c => c.bucket === current.currentBucket), to = current.choices.findIndex(c => c.bucket === bucket);
          if (from < 0 || to < 0) return null;
          const expected = current.choices[from + (to > from ? 1 : -1)].bucket;
          const controls = [...picker().querySelectorAll('[role="menuitem"][aria-keyshortcuts]')].filter(node => shown(node) && node.getAttribute('aria-keyshortcuts').includes('ArrowRight'));
          if (controls.length !== 1 || !key(controls[0], to > from ? 'ArrowRight' : 'ArrowLeft')) return null;
          const version = current.version;
          current = await state(next => next.version === version && next.currentBucket === expected);
        }
        return null;
      }
    };
  }
  function visibleModelSelection() {
    const node = document.querySelector(PICKER) || modelPickerTrigger();
    if (node?.getAttribute('data-cip-cos-selected-route') !== location.pathname) return null;
    const model = node?.getAttribute('data-cip-cos-selected-model'), reasoningEffort = node?.getAttribute('data-cip-cos-selected-effort');
    return model && /^[a-zA-Z0-9._-]{1,80}$/.test(model) && ['none','minimal','low','medium','high','xhigh','max','ultra','pro'].includes(reasoningEffort)
      ? { model, reasoningEffort } : null;
  }
  function collectModelChoices(result, state) {
    for (const choice of state.choices.filter(c => c.available)) {
      const entry = result.get(choice.familyId) || { id: choice.familyId, label: choice.familyLabel, efforts: [], aliases: [] };
      if (!entry.efforts.includes(choice.effort)) entry.efforts.push(choice.effort);
      if (!entry.aliases.includes(choice.id)) entry.aliases.push(choice.id);
      result.set(choice.familyId, entry);
    }
  }
  async function inspectModelSettings(stillCurrent = () => true, failure = () => {}) {
    const ui = modelPickerAccess(stillCurrent), original = await ui.open();
    if (!original) { await ui.close(); failure('picker_unavailable'); return null; }
    const result = new Map();
    let restored = false, closed = false;
    try {
      for (const version of original.versions) {
        const state = await ui.version(version.id);
        if (!state) throw new Error('model_unconfirmed');
        collectModelChoices(result, state);
      }
    } catch { failure('model_unconfirmed'); result.clear(); }
    finally {
      if (stillCurrent() && await ui.version(original.version)) {
        const state = await ui.bucket(original.currentBucket);
        const previous = original.choices.find(c => c.bucket === original.currentBucket);
        const selected = state?.choices.find(c => c.bucket === state.currentBucket);
        restored = !!previous && selected?.id === previous.id && selected?.effort === previous.effort;
      }
      closed = await ui.close();
    }
    if (!restored) failure('restore_failed');
    if (!closed) failure('picker_close_failed');
    return restored && closed && stillCurrent() && result.size ? [...result.values()] : null;
  }
  async function selectModelSettings(model, effort, stillCurrent = () => true) {
    if (!model && !effort) return true;
    const ui = modelPickerAccess(stillCurrent), original = await ui.open();
    if (!original) { await ui.close(); return false; }
    const current = original.choices.find(choice => choice.bucket === original.currentBucket);
    if (current?.available && (current.id === model || current.familyId === model) && (!effort || current.effort === effort)) {
      const closed = await ui.close(); return closed && stillCurrent();
    }
    let selected = false, closed = false;
    try {
      // CIP strict identity: no display-caption aliases and no nearest-effort substitution.
      const modelRank = choice => !model || choice.familyId === model || choice.id === model ? 2 : 0;
      const offered = [];
      for (const version of [original.versions.find(v => v.id === original.version), ...original.versions.filter(v => v.id !== original.version)]) {
        const state = await ui.version(version.id); if (!state) return false;
        for (const choice of state.choices) { const rank = choice.available ? modelRank(choice) : 0; if (rank) offered.push({ version: version.id, choice, rank }); }
      }
      const wantedEffort = effort;
      const candidates = offered.filter(entry => !wantedEffort || entry.choice.effort === wantedEffort);
      const rank = Math.max(0, ...candidates.map(candidate => candidate.rank));
      const matches = candidates.filter(candidate => candidate.rank === rank);
      if (!matches.length || (model && new Set(matches.map(candidate => candidate.choice.familyId)).size !== 1) ||
          (model && wantedEffort && new Set(matches.map(candidate => `${candidate.choice.id}\u0000${candidate.choice.effort}`)).size !== 1)) return false;
      const wanted = matches.find(candidate => candidate.version === original.version && candidate.choice.bucket === original.currentBucket) || matches[0];
      const state = await ui.version(wanted.version), choice = wanted.choice;
      if (!state?.choices.some(next => next.bucket === choice.bucket && next.available && next.id === choice.id && next.effort === choice.effort)) return false;
      const after = await ui.bucket(choice.bucket);
      const confirmed = after?.choices.find(c => c.bucket === after.currentBucket);
      selected = stillCurrent() && confirmed?.available === true && confirmed.id === choice.id && confirmed.effort === choice.effort;
    } finally {
      if (!selected && stillCurrent() && await ui.version(original.version)) await ui.bucket(original.currentBucket);
      closed = await ui.close();
    }
    return selected && closed && stillCurrent();
  }
    function visibleSelection() {
      const v = visibleModelSelection();
      if (!v || observedPath !== location.pathname) return null;
      const model = observedPairs.get(`${v.model}\u0000${v.reasoningEffort}`);
      return model ? { model, thinkingOption: v.reasoningEffort } : null;
    }
    return { readPickerState, modelPickerTrigger, visibleModelSelection, visibleSelection, inspectModelSettings, selectModelSettings };
  };
})();
