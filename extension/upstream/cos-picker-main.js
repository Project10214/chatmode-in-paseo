/* Direct CoS fiber.js function transplant (MIT), pinned ccd23b66cecf2f684fa3e12ca190297be02842cf.
 * Only committed React-path and picker metadata readers are retained. No conversation history,
 * cookies, credentials, setters, tool arguments or model API are read or invoked here.
 * Changes: independent CIP namespace, bounded request gate, readShellPickerSnapshot panel fallback.
 */
(() => {
  'use strict';
  if (globalThis.__CIP_COS_PICKER__) return;
  globalThis.__CIP_COS_PICKER__ = true;
  const MAX_ROOT_DEPTH = 2048, MAX_CLIMB = 80;
  const OWN_SURFACES = '.clf-stream, .clf-stage, .clf-composer, .clf-boot';
  const post = window.postMessage.bind(window);
  let currentPaths = null;
  function committedPath(fiber) {
    const path = [], seen = new Set();
    let at = fiber, base = null, paired = false;
    const view = (node, parent) => ({ memoizedProps: node.memoizedProps,
      memoizedState: node.memoizedState, updateQueue: node.updateQueue, return: parent });
    const remember = (node, value) => {
      currentPaths?.set(node, value);
      if (node.alternate) currentPaths?.set(node.alternate, value);
    };
    while (at && path.length < MAX_ROOT_DEPTH) {
      if (seen.has(at)) return null;
      seen.add(at);
      const cached = currentPaths?.get(at);
      if (cached && cached.root.current === cached.current) { base = cached; break; }
      paired ||= !!at.alternate;
      if (at.tag === 3) {
        const root = at.stateNode, current = root?.current;
        if (!current || (current !== at && current !== at.alternate)) return null;
        base = { root, current, node: current, view: view(current, null) };
        remember(at, base);
        break;
      }
      path.push(at); at = at.return;
    }
    if (!base) return !paired && !at && path.every(node => typeof node.tag !== 'number') ? fiber : null;
    let budget = 4096;
    for (let index = path.length - 1; index >= 0; index--) {
      const wanted = path[index];
      let selected = null;
      for (let child = base.node.child; child; child = child.sibling) {
        if (--budget < 0) return null;
        if (child !== wanted && child !== wanted.alternate) continue;
        if (selected) return null;
        selected = child;
      }
      if (!selected || base.root.current !== base.current) return null;
      base = { root: base.root, current: base.current, node: selected, view: view(selected, base.view) };
      remember(wanted, base);
    }
    return base.view;
  }
  function fiberOf(node) {
    for (const key in node) {
      if (key.charCodeAt(0) === 95 && key.indexOf('__reactFiber$') === 0) return committedPath(node[key]);
    }
    return null;
  }
  function shellProExecutionModel(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^(?:pro|(?:gpt-?)?\d+(?:[.-]\d+)?-pro)$/.test(normalized);
  }
  function shellLaneTransportEffort(value) {
    return ({ none:'none', minimal:'minimal', low:'low', medium:'medium', high:'high', xhigh:'xhigh', max:'xhigh' })[value] ?? null;
  }
  function closedPickerSelection(node) {
    const machine = node.getAttribute('data-selected-reasoning-effort');
    const captionEffort = ({ instant: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high',
      'extra high': 'xhigh', max: 'max', ultra: 'ultra', pro: 'pro' })[String(node.textContent || '').trim().toLowerCase()];
    let model = null, lane = null;
    for (let fiber = fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      const sel = fiber.memoizedProps?.selectedPowerSelection ?? fiber.memoizedProps?.selectedLabelCandidate;
      if (lane === null && sel) {
        const caption = String(sel.labels?.effort ?? sel.sliderLabel ?? '').trim().toLowerCase();
        lane = { model: sel.model,
          effort: ({ instant:'none', minimal:'minimal', low:'low', medium:'medium', high:'high',
            'extra high':'xhigh', max:'max', ultra:'ultra', pro:'pro' })[caption] ?? (caption ? shellLaneTransportEffort(sel.reasoningEffort) : null) };
      }
      const current = fiber.memoizedProps?.currentModelId;
      if (current === undefined) continue;
      if (typeof current !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(current) || (model && model !== current)) return null;
      model = current;
    }
    const effort = shellProExecutionModel(model) ? 'pro' : (lane && lane.model === model && lane.effort) ||
      (machine !== null ? (['none','minimal','low','medium','high','xhigh','max','ultra','pro'].includes(machine) ? machine : null) : captionEffort);
    if (!effort) return null;
    return model ? { id: model, effort } : null;
  }
  function readPickerSnapshot(node) {
    let fiber = node && fiberOf(node);
    for (let up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      const owner = fiber.memoizedProps;
      const props = owner?.composerIntelligencePickerState ? owner : owner?.dropdownContent?.props;
      const state = props?.composerIntelligencePickerState, data = props?.modelsData;
      if (!state || !Array.isArray(data?.versions)) continue;
      if (data.versions.length > 20 || !Array.isArray(state.bucketSelections) || state.bucketSelections.length > 12) return null;
      const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
      const groupId = value => typeof value === 'string' && value.length <= 80 && /^[\p{L}\p{N}._ -]+$/u.test(value) && value.trim() === value && value.trim() ? value : null;
      const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 80 ? value.trim() : null;
      const effortOf = choice => choice.category?.modelLane === 'pro' ? 'pro'
        : ['auto', 'instant'].includes(choice.category?.modelLane) ? 'none'
        : choice.thinkingEffort === 'max' && choice.modelConfig?.isWorkModeModel === true ? 'max'
        : ({ min: 'low', standard: 'medium', extended: 'high', max: 'xhigh', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', ultra: 'ultra' })[choice.thinkingEffort] || null;
      const choices = state.bucketSelections.map(choice => {
        const name = label(choice.category?.shortLabel);
        const familyId = id(choice.category?.modelVersion) || id(choice.modelSlug);
        const family = data.versions.find(version => version.id === choice.category?.modelVersion);
        return { bucket: choice.bucket, id: id(choice.modelSlug),
          label: name && (/^\d/.test(name) ? `GPT-${name}` : name), effort: effortOf(choice),
          familyId, familyLabel: label(family?.displayTextForIntelligence) || label(choice.modelConfig?.title) || (name && (/^\d/.test(name) ? `GPT-${name}` : name)),
          available: choice.availability?.status === 'available' && !props.modelSwitcherDenialsBySlug?.[choice.modelSlug] };
      });
      const versions = data.versions.filter(version => version.enabled === true).map(version => ({ id: groupId(version.id), label: label(version.displayTextForIntelligence) }));
      if (!versions.length || versions.some(v => !v.id || !v.label) || choices.some(c => !Number.isInteger(c.bucket) || !c.id || !c.label || !c.effort) ||
          new Set(versions.map(v => v.id)).size !== versions.length || new Set(choices.map(c => c.bucket)).size !== choices.length) return null;
      const version = groupId(state.selectedVersionEntry?.id), currentBucket = state.currentBucket;
      if (!versions.some(v => v.id === version) || !choices.some(c => c.bucket === currentBucket)) return null;
      const selected = state.currentSelection;
      const chosen = choices.find(c => c.bucket === currentBucket);
      if (selected?.modelSlug !== chosen.id || effortOf(selected) !== chosen.effort) return null;
      return { version, currentBucket, versions, choices };
    }
    return null;
  }
  function readShellPickerSnapshot(node) {
    for (let fiber = node && fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (!Array.isArray(p?.powerSelections)) continue;
      const selected = p.selectedPowerSelection ?? p.selectedLabelCandidate, options = p.modelListConfig?.options;
      if (!selected || !Array.isArray(options) || options.length > 20 || p.powerSelections.length > 12) return null;
      const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
      const group = value => typeof value === 'string' && /^[\p{L}\p{N}._ -]{1,80}$/u.test(value) && value.trim() === value ? value : null;
      const label = value => typeof value === 'string' && value.trim() && value.length <= 80 ? value.trim() : null;
      const effort = value => ({ none:'none', instant:'none', minimal:'minimal', min:'low', low:'low', standard:'medium', medium:'medium', extended:'high', high:'high', xhigh:'xhigh', 'extra high':'xhigh', max:'max', ultra:'ultra', pro:'pro' })[value] || null;
      const laneEffort = c => shellProExecutionModel(c?.model) ? 'pro' :
        effort(String(c?.labels?.effort ?? c?.sliderLabel ?? '').trim().toLowerCase()) ??
        ((c?.labels?.effort ?? c?.sliderLabel) ? shellLaneTransportEffort(c?.reasoningEffort) : effort(c?.reasoningEffort));
      const current = options.filter(o => o?.selected === true);
      if (current.length !== 1) return null;
      const version = group(current[0].id);
      const versions = options.filter(o => o && o.disabled !== true).map(o => ({ id: group(o.id), label: label(o.label) }));
      const modelName = value => { const name = label(value); return name && /^\d/.test(name) ? `GPT-${name}` : name; };
      const choices = p.powerSelections.map(c => ({ bucket: c?.powerSettingIndex, id: id(c?.model),
        label: modelName(c?.modelLabel), familyId: id(c?.model), familyLabel: modelName(c?.modelLabel), effort: laneEffort(c),
        available: p.modelSelectionDisabled !== true && c?.disabled !== true &&
          (!c?.availability || c.availability.status === 'available') && !p.modelSwitcherDenialsBySlug?.[c?.model] }));
      if (!version || !versions.length || versions.some(v => !v.id || !v.label) || !choices.length ||
          choices.some(c => !Number.isInteger(c.bucket) || !c.id || !c.label || !c.effort) ||
          new Set(versions.map(v => v.id)).size !== versions.length || new Set(choices.map(c => c.bucket)).size !== choices.length || !versions.some(v => v.id === version)) return null;
      for (const name of new Set(choices.map(c => c.label))) {
        const lanes = choices.filter(c => c.label === name);
        if (lanes.length < 2 || new Set(lanes.map(c => c.effort)).size !== lanes.length) continue;
        const shared = lanes.map(c => c.id).reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); }).replace(/[-._]+$/, '');
        const family = id(shared) && /\d/.test(shared) ? shared : lanes[0].id;
        for (const lane of lanes) lane.familyId = family;
      }
      const matches = choices.filter(c => c.id === id(selected.model) && c.effort === laneEffort(selected));
      if (matches.length !== 1 || (selected.powerSettingIndex !== undefined && selected.powerSettingIndex !== matches[0].bucket)) return null;
      return { version, currentBucket: matches[0].bucket, versions, choices };
    }
    return null;
  }
  function pickerSnapshot() {
    const form = document.querySelector('#prompt-textarea, form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]')?.closest('form');
    const reported = '[data-codex-intelligence-trigger],[data-composer-navigation-target="reasoning"]';
    const triggers = [...new Set([...(form?.querySelectorAll('button[aria-haspopup="menu"]') || []), ...document.querySelectorAll(reported)])]
      .filter(node => node.matches('button,[role="button"]') && !node.closest(`${OWN_SURFACES},[data-testid^="conversation-turn"],[data-message-author-role],.markdown,[contenteditable],[hidden],[aria-hidden="true"],[inert]`) && node.getClientRects().length > 0 &&
        node.id !== 'composer-plus-btn' && node.getAttribute('data-testid') !== 'composer-plus-btn');
    const candidates = [];
    if (triggers.length <= 8) for (const trigger of triggers) {
      try { const picker = readPickerSnapshot(trigger) || readShellPickerSnapshot(trigger); if (picker) candidates.push({ node: trigger, picker }); }
      catch { /* Unrelated menus are not picker evidence. */ }
    }
    const specific = candidates.filter(candidate => candidate.node.matches(reported));
    const identified = specific.length === 1 ? specific[0] : candidates.length === 1 ? candidates[0] : null;
    const native = triggers.filter(trigger => trigger.matches(reported));
    const fallback = native.length === 1 ? native[0] : triggers.length === 1 ? triggers[0] : null;
    const node = document.querySelector('[data-testid="composer-intelligence-picker-content"], [data-model-picker-view]') || identified?.node || fallback;
    let state = null;
    try { state = identified?.picker || readPickerSnapshot(node) || readShellPickerSnapshot(node); } catch { /* Invalidate unknown proof. */ }
    const selected = state ? state.choices.find(choice => choice.bucket === state.currentBucket && choice.available)
      : (node && node === fallback ? closedPickerSelection(node) : null);
    const provenTrigger = identified?.node || (selected && node === fallback ? fallback : null);
    for (const trigger of triggers) {
      if (trigger !== provenTrigger) trigger.removeAttribute('data-cip-cos-picker-route');
      else if (trigger.getAttribute('data-cip-cos-picker-route') !== location.pathname) trigger.setAttribute('data-cip-cos-picker-route', location.pathname);
      if (trigger !== node) for (const attribute of ['data-cip-cos-selected-model', 'data-cip-cos-selected-effort', 'data-cip-cos-selected-route']) trigger.removeAttribute(attribute);
    }
    for (const [attribute, value] of [['data-cip-cos-selected-model', selected?.id], ['data-cip-cos-selected-effort', selected?.effort], ['data-cip-cos-selected-route', selected && location.pathname]]) {
      if (!value) node?.removeAttribute(attribute);
      else if (node.getAttribute(attribute) !== value) node.setAttribute(attribute, value);
    }
    return state;
  }
  // CIP projection adapter. Source readers above and in cos-transcript-core.js are upstream;
  // this exact-id, bounded wire projection is deliberately not the entire CoS recorder.
  const imageReader = globalThis.CIP_createCoSImages?.({fiberOf, core:globalThis.CIP_COS_PUBLIC_CORE});
  // CIP addition: a user turn can carry only files. Its string parts (none for
  // a file-only turn) become its text, so an attachment-only Send still has an
  // exact native user identity. Asset pointers, file names and file metadata
  // never cross the projection.
  function attachedFiles(message) {
    const files=message?.metadata?.attachments;
    if(Array.isArray(files)&&files.length>0&&files.length<=64)return true;
    const content=message?.content;
    const parts=content?.content_type==='multimodal_text'&&Array.isArray(content.parts)?content.parts:[];
    return parts.length<=64&&parts.some(part=>part&&typeof part==='object'&&!Array.isArray(part));
  }
  function stringParts(content) {
    const parts=Array.isArray(content?.parts)?content.parts:[];
    return parts.filter(part=>typeof part==='string').join('\n').slice(0,256000);
  }
  function publicTranscript() {
    imageReader?.begin();
    const core=globalThis.CIP_COS_PUBLIC_CORE;
    const conversationId=/^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(location.pathname)?.[1];
    if(!core||!conversationId)return {path:location.pathname,available:false,messages:[]};
    // CoS TURN_SECTION includes SEARCH_TURN_ANCHOR. Its layout key is not a
    // message identity; climb this anchor's committed Fiber for the native ID.
    const selector='section[data-testid^="conversation-turn"], [data-turn-key], [data-chatgpt-search-unit-key$=":user"]';
    const sections=[...document.querySelectorAll(selector)].filter(n=>
      !n.closest(`${OWN_SURFACES},.markdown,[contenteditable],[hidden],[aria-hidden="true"],[inert]`) &&
      ![...function*(n){for(let p=n;p;p=p.parentElement)yield p}(n)].some(p=>getComputedStyle(p).display==='none')).slice(-12);
    const out=[],seen=new Map();let total=0,available=false,lastTerminal=null,latestActivity=null,latestTimeline=null;
    const coverage={sourceSections:Math.min(128,sections.length),sourceMatches:0,sourceUsers:0};
    for(const section of sections){
      const fiber=fiberOf(section);if(!fiber)continue;
      const evidence=core.conversationEvidenceOf(fiber);
      // CoS's typed shell/view paths are essential: native Sends may have no
      // legacy data-message-id or turn.messages at all on the current webpage.
      const typed=globalThis.CIP_COS_SHELL_PUBLIC?.sourceFor(fiber,section,evidence);
      const scope=typed?.recognized?typed.scope:evidence;
      if(scope.conflict)return {path:location.pathname,available:false,messages:[],error:'TRANSCRIPT_CONFLICT'};
      if(scope.conversationId!==conversationId)continue;
      coverage.sourceMatches=Math.min(128,coverage.sourceMatches+1);
      const messages=typed?.recognized?typed.messages:core.turnMessagesOf(fiber);
      if(!messages||messages.length>500)continue;
      imageReader?.add({fiber,section,messages,scope});
      available=true;const terminal=typed?.recognized?typed.terminal:core.turnEndMessageId(messages);lastTerminal=terminal;
      for(const message of messages){
        const role=message?.author?.role,id=message?.id;
        if(!['user','assistant'].includes(role)||typeof id!=='string'||!id||id.length>200)continue;
        if(/^fallback-/i.test(id)||/:\d+:(?:user|assistant)$/.test(id))
          return {path:location.pathname,available:false,messages:[],error:'TRANSCRIPT_ID_UNPROVEN'};
        if(core.hiddenMessage(message)||core.channelOf(message)==='analysis'||(message.recipient&&message.recipient!=='all'))continue;
        const content=message.content;
        if(content?.content_type==='text'){
          const parts=Array.isArray(content.parts)?content.parts:[content.text];
          if(parts.length>1000||parts.reduce((n,v)=>n+(typeof v==='string'?v.length:0),0)>256000)
            return{path:location.pathname,available:false,messages:[],error:'TRANSCRIPT_LIMIT'};
        }
        let raw=core.authoredText(message);
        if(raw==null&&role==='user'&&attachedFiles(message))raw=stringParts(content);
        if(raw==null && id!==terminal)continue;
        const text=role==='user'?core.withoutAppMentions(raw??''):(raw??'');
        if(seen.has(id)){if(seen.get(id)!==text)return{path:location.pathname,available:false,messages:[],error:'TRANSCRIPT_CONFLICT'};continue;}
        total+=text.length;if(total>512000)return{path:location.pathname,available:false,messages:[],error:'TRANSCRIPT_LIMIT'};
        seen.set(id,text);out.push({id,role,text,final:role==='assistant'&&id===terminal});
        if(role==='user')coverage.sourceUsers=Math.min(128,coverage.sourceUsers+1);
      }
      const owner=messages.filter(m=>m?.author?.role==='user').at(-1)?.id;
      // Only the same exact native user identity may own public work status.
      if(typed?.activity && typeof owner==='string' && seen.has(owner))
        latestActivity={userMessageId:owner,...typed.activity};
      if(typed?.timeline && typeof owner==='string' && seen.has(owner))
        latestTimeline={userMessageId:owner,...typed.timeline};
    }
    for(const row of out)row.final=row.role==='assistant'&&row.id===lastTerminal;
    // Source mounted != confirmed user. A shell placeholder can return zero
    // user rows; allow only the existing explicit data-message-id DOM reader
    // to act as fallback (never accept a layout/search key as identity).
    const identified=out.some(row=>row.role==='user');
    return {path:location.pathname,available:available&&identified,messages:out,coverage,...imageReader?.project(),activity:identified?latestActivity:null,timeline:identified?latestTimeline:null};
  }
  // CIP addition, not an upstream app catalog: resolve only rows in an owned @ portal.
  // Only own data properties are read; callbacks/getters, account stores and credentials are excluded.
  function appMenuSnapshot(nonce) {
    const roots=[...document.querySelectorAll('[data-cip-app-scan]')].filter(n=>n.getAttribute('data-cip-app-scan')===nonce&&n.getClientRects().length>0);
    if(roots.length!==1)return null;
    const root=roots[0];
    const selector='[role="option"],[role="menuitem"],[role="menuitemradio"],[cmdk-item],button,[role="button"],a[href^="app://"],[data-app-id]';
    const all=[...root.querySelectorAll(selector)].filter(n=>n.getClientRects().length>0&&!n.closest('[hidden],[inert],[aria-hidden="true"]'));
    const nodes=all.filter(n=>!all.some(p=>p!==n&&p.contains(n)));if(nodes.length>128)return null;
    const value=(o,k)=>o&&typeof o==='object'?Object.getOwnPropertyDescriptor(o,k)?.value:undefined;
    const idOf=o=>{const id=value(o,'id')??value(o,'app_id');return typeof id==='string'&&/^asdk_app_[A-Za-z0-9_-]{1,160}$/.test(id)?id:null;};
    const rows=[];let unresolved=0;
    for(const [index,node] of nodes.entries()){
      const ids=new Map();
      const domId=node.getAttribute('data-app-id');
      if(domId&&/^asdk_app_[A-Za-z0-9_-]{1,160}$/.test(domId))ids.set(domId,null);
      for(const chip of [node,...node.querySelectorAll('[app-mention-path],[data-prompt-link-href],[href]')])for(const key of ['app-mention-path','data-prompt-link-href','href']){
        const match=/^app:\/\/(asdk_app_[A-Za-z0-9_-]{1,160})$/.exec(chip.getAttribute(key)||'');if(match)ids.set(match[1],null);
      }
      for(let f=fiberOf(node),up=0;f&&up<16;up++,f=f.return){
        const p=f.memoizedProps;
        for(const key of ['app','connector','item']){
          const item=value(p,key),id=idOf(item);if(!id)continue;
          const name=value(item,'name')??value(item,'display_name')??value(item,'title');
          if(typeof name==='string'&&name.trim()&&name.length<=200)ids.set(id,name.trim());
        }
        if(f.memoizedProps?.role==='listbox'||f.memoizedProps?.role==='menu'||f.memoizedProps?.role==='dialog')break;
      }
      if(ids.size!==1){unresolved++;continue;}
      const [id,name]=[...ids][0];
      const visible=(node.getAttribute('aria-label')||node.textContent||'').replace(/\s+/g,' ').trim();
      if(!visible||visible.length>200||(name&&!visible.includes(name))){unresolved++;continue;}
      const stamp=`${nonce}:${index}`;if(node.getAttribute('data-cip-app-proof')!==stamp)node.setAttribute('data-cip-app-proof',stamp);
      rows.push({index,id,label:name||visible});
    }
    return {path:location.pathname,rows,unresolved};
  }
  // CIP transport only: a read-only, nonce-bound projection. Never accepts an action.
  let reading = false;
  let capturing = false;
  addEventListener('message', event => {
    const d=event.data;
    if(event.source!==window||event.origin!==location.origin||d?.source!=='cip-cos-image-ask'||
       typeof d.nonce!=='string'||!/^[a-zA-Z0-9-]{16,64}$/.test(d.nonce)||capturing||!imageReader)return;
    capturing=true;
    Promise.resolve().then(()=>{
      const t=publicTranscript();
      if(!t.available||t.error||!t.images?.some(x=>x.userMessageId===d.image?.userMessageId&&x.messageId===d.image?.messageId&&x.assetId===d.image?.assetId))return {error:'IMAGE_IDENTITY_UNPROVEN'};
      return imageReader.captureNativeImage(d.image);
    }).then(value=>post({source:'cip-cos-image-reply',nonce:d.nonce,v:1,value},location.origin),()=>post({source:'cip-cos-image-reply',nonce:d.nonce,v:1,value:{error:'IMAGE_CAPTURE_FAILED'}},location.origin))
      .finally(()=>{capturing=false});
  });
  addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || !['cip-cos-picker-ask','cip-cos-transcript-ask','cip-cos-apps-ask'].includes(data?.source) ||
        typeof data.nonce !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(data.nonce) || reading) return;
    reading = true;
    const transcript=data.source==='cip-cos-transcript-ask',apps=data.source==='cip-cos-apps-ask';let value=null;
    try { currentPaths=new WeakMap();value=apps?appMenuSnapshot(data.nonce):transcript?publicTranscript():pickerSnapshot(); }
    catch { if(transcript)value={path:location.pathname,available:false,messages:[],error:'TRANSCRIPT_UNCONFIRMED'}; }
    finally { currentPaths=null;reading=false; }
    post({source:apps?'cip-cos-apps-reply':transcript?'cip-cos-transcript-reply':'cip-cos-picker-reply',nonce:data.nonce,v:1,[apps?'apps':transcript?'transcript':'picker']:value},location.origin);
  });
})();
