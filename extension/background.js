const PROTOCOL = 5, DEFAULT_ENDPOINT = 'http://127.0.0.1:17843';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let pumpFlight = null, timer = null, loaded = null, lastOnlineAt = 0, pairingIntent = 0;
let config, ledger, tabs, catalogBrowserId, upgradeRecovery=null, updateEventPending=false, versionRecoveryInitiated=false;
let bindingWaits = {}; // Persist grace deadlines across service-worker suspension.
const BINDING_GRACE_MS = 15000;
const executions = new Map(), receipts = new Map(), monitors = new Map(), heartbeatAt = new Map();
const idleScannedAt = new Map(), idleHints = new Map();
let lastIdleNoticeAt=0;
let activeSessions = [], lastNativeWakeAt = 0;
const NATIVE_WAKE_HOST = 'com.foolwork.chatmode_in_paseo_wake';
const codeError = code => Object.assign(new Error(code), { code });
async function load() {
  if (!loaded) loaded = (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const local = await chrome.storage.local.get(['config', 'ledger', 'tabs', 'bindingWaits', 'upgradeRecovery', 'loadedChromeVersion']);
    upgradeRecovery = local.upgradeRecovery && typeof local.upgradeRecovery==='object'
      ? local.upgradeRecovery : null;
    bindingWaits = local.bindingWaits && typeof local.bindingWaits === 'object' && !Array.isArray(local.bindingWaits) ? local.bindingWaits : {};
    const session = await chrome.storage.session.get(['tabs', 'catalogBrowserId', 'lastNativeWakeAt']);
    lastNativeWakeAt = Number.isFinite(session.lastNativeWakeAt) ? session.lastNativeWakeAt : 0;
    catalogBrowserId = typeof session.catalogBrowserId === 'string' ? session.catalogBrowserId : crypto.randomUUID();
    if (!session.catalogBrowserId) await chrome.storage.session.set({ catalogBrowserId });
    config = local.config ?? { endpoint: DEFAULT_ENDPOINT, token: null };
    ledger = local.ledger ?? {}; tabs = session.tabs ?? local.tabs ?? {};
    // Developer-mode "Reload" and Extensions.loadUnpacked can change the
    // manifest version without dispatching onInstalled(reason='update').
    // Persist version + recovery job together BEFORE touching any tabs, so
    // an MV3 worker crash cannot lose a pending refresh or replay a Send.
    const chromeVersion=chrome.runtime.getManifest?.().version;
    if(typeof chromeVersion==='string' && chromeVersion &&
       local.loadedChromeVersion!==chromeVersion){
      const hasBoundTabs=Boolean(config.token) && Object.keys(tabs).length>0;
      if(hasBoundTabs){
        versionRecoveryInitiated=true;
        upgradeRecovery={engine:'cos-native-alpha4.3',phase:'discover',
          targets:[],createdAt:Date.now()};
      }
      await persist('local',{loadedChromeVersion:chromeVersion,
        ...(hasBoundTabs?{upgradeRecovery}:{})});
    }
  })();
  return loaded;
}
function endpointOf(value) {
  const endpoint = new URL(value);
  if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:' || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw codeError('INVALID_ENDPOINT');
  return endpoint;
}
async function api(route, value, authenticated = true, profile = config) {
  const endpoint = endpointOf(profile.endpoint);
  const response = await fetch(`${endpoint.origin}${route}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-CIP-Extension': chrome.runtime.id, 'X-CIP-Features': 'files-v2',
      ...(authenticated ? { Authorization: `Bearer ${profile.token}`, 'X-CIP-Engine': 'cos-native-alpha4.3', 'X-CIP-Browser': catalogBrowserId } : {}) },
    body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(15000), cache: 'no-store', redirect: 'error'
  });
  const text = await response.text(); if (text.length > 1000000) throw codeError('RESPONSE_TOO_LARGE');
  const result = JSON.parse(text);
  if (!response.ok) throw codeError(result.error ?? 'BRIDGE_ERROR'); return result;
}
// Publication is serialized so an older save cannot overwrite a newer token/tab/receipt.
let storageTail = Promise.resolve();
function persist(area, value) {
  const snapshot = structuredClone(value);
  const work = storageTail.then(() => chrome.storage[area].set(snapshot));
  storageTail = work.catch(() => {}); return work;
}
const saveLedger = () => persist('local', { ledger });
const saveTabs = async () => { await persist('local', { tabs }); await persist('session', { tabs }); };
function bounded(promise, ms, onTimeout) {
  let timeout;
  return Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => { onTimeout?.(); reject(codeError('CONTENT_TIMEOUT')); }, ms); })])
    .finally(() => clearTimeout(timeout));
}
const tabRpc = (tabId, message, ms = 2500) => bounded(chrome.tabs.sendMessage(tabId, message), ms,
  // Cancel a timed-out *preparation* RPC. A claimed Send may already have
  // clicked; canceling its browser guard destroys late receipt evidence.
  message.type === 'command' && message.command?.kind !== 'send'
    ? () => { void chrome.tabs.sendMessage(tabId, { type: 'cancel-command', id: message.command.id }).catch(() => {}); }
    : undefined);
function conversation(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'chatgpt.com' ? /^\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9-]+)(?:\/|$)/.exec(u.pathname)?.[1] ?? null : null; }
  catch { return null; }
}
async function identity(tabId, expected = null) {
  const deadline = Date.now() + 25000;
  do {
    try {
      const tab = await chrome.tabs.get(tabId); const url = new URL(tab.url);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') throw codeError('WRONG_PAGE');
      const r = await tabRpc(tabId, { type: 'identity' });
      if (r?.ok && r.value?.documentKey) {
        if(r.value.engine !== 'cos-native-alpha4.3') throw codeError('PAGE_RELOAD_REQUIRED');
        if(expected && conversation(r.value.url)!==expected.conversationId) throw codeError('WRONG_CONVERSATION');
        // Reopening is about the Conversation URL. A later native user ID
        // is allowed here; the upcoming Send owns its separate idempotency key.
        return r.value;
      }
    } catch (e) { if (['WRONG_PAGE','PAGE_RELOAD_REQUIRED','WRONG_CONVERSATION','TURN_CHANGED'].includes(e.code)) throw e; }
    await delay(250);
  } while (Date.now() < deadline);
  throw codeError('CONTENT_UNAVAILABLE');
}
async function postReceipt(id, row, profile = config) {
  if (row.endpoint && row.endpoint !== profile.endpoint) return;
  await api('/result', { id, lease: row.lease, result: row.result }, true, profile);
  row.phase = 'acked';
  if (row.command?.kind === 'send' && row.result?.notSent === true) {
    // Keep the command ID/lease/result tombstone, never a retryable failed body.
    delete row.command.payload.text;
    delete row.command.payload.files;
    row.discarded = true;
  }
  await saveLedger();
}
async function execute(command) {
  if (Object.hasOwn(ledger, command.id)) return;
  const profile = config;
  ledger[command.id] = { phase: 'reserved', command, endpoint: profile.endpoint, at: Date.now() }; await saveLedger();
  let claim, tabId, reopened = false; const temporary = command.kind === 'catalog';
  try {
    if(command.kind==='ensure') {
      tabId=command.payload.tabId;
      let actual; try { actual=await chrome.tabs.get(tabId); } catch {}
      if(actual && conversation(actual.url)===command.payload.conversationId) {
        if(tabs[tabId] && tabs[tabId].sessionId!==command.sessionId) throw codeError('TAB_NOT_OWNED');
      } else {
        if(!command.payload.conversationId) throw codeError('WRONG_CONVERSATION');
        // The saved tab is missing or navigated elsewhere: never hijack it.
        // Reopen the bound URL, not an old Send and not a new conversation.
        const tab=await chrome.tabs.create({url:`https://chatgpt.com/c/${encodeURIComponent(command.payload.conversationId)}`,active:false});
        tabId=tab.id; reopened=true;
      }
      tabs[tabId]={...(tabs[tabId]??{}),sessionId:command.sessionId,createdBy:command.id};await saveTabs();
    } else if (command.kind === 'open' || temporary) {
      const url = command.payload.conversationId ? `https://chatgpt.com/c/${encodeURIComponent(command.payload.conversationId)}` : 'https://chatgpt.com/';
      const tab = await chrome.tabs.create({ url, active: false }); tabId = tab.id;
      tabs[tabId] = { sessionId: command.sessionId, createdBy: command.id }; await saveTabs();
    } else {
      tabId = command.payload.tabId;
      if (!tabs[tabId] || tabs[tabId].sessionId !== command.sessionId) throw codeError('TAB_NOT_OWNED');
    }
    ledger[command.id].tabId = tabId; await saveLedger();
    const page = await identity(tabId, command.kind==='ensure'?command.payload:null);
    if (config !== profile) throw codeError('CONNECTION_CHANGED');
    claim = await api('/claim', { id: command.id, tabId, documentKey: page.documentKey, ...(command.kind==='ensure'?{url:page.url,nativeMessageId:page.nativeMessageId,reopened}:{}) }, true, profile);
    ledger[command.id] = { ...ledger[command.id], phase: 'claimed', lease: claim.lease, documentKey: page.documentKey };
    tabs[tabId] = { ...tabs[tabId], documentKey: page.documentKey }; await saveLedger(); await saveTabs();
    // The Runtime extends a file Send's deadline by its upload size (max ~5 minutes).
    const cap = claim.payload?.files?.length ? 300000 : 90000;
    const budget = Number.isFinite(claim.deadline) ? Math.min(cap, Math.max(1, claim.deadline - Date.now() - 1000)) : 60000;
    const reply = await tabRpc(tabId, { type: 'command', command: claim }, budget);
    const result = reply?.ok ? reply.value : { error: reply?.error ?? 'CONTENT_UNAVAILABLE', notSent: reply?.notSent === true, notApplied: reply?.notApplied === true, diagnostic: reply?.diagnostic };
    // A failed message may still have created its OWN conversation URL.
    // Verify the currently owned Chrome tab rather than trusting a page string.
    if(command.kind==='send' && !reply?.ok && !reply?.notSent && reply?.bindingUrl) {
      const boundId=conversation(reply.bindingUrl);
      if(boundId)try{
        const current=await chrome.tabs.get(tabId);
        if(conversation(current.url)===boundId && tabs[tabId]?.documentKey===page.documentKey &&
          tabs[tabId]?.sessionId===command.sessionId)result.bindingUrl=current.url;
      }catch{}
    }
    const row = ledger[command.id]; row.phase = 'receipt'; row.result = result; await saveLedger();
    await postReceipt(command.id, row, profile);
    if(command.kind==='ensure' && reopened && command.payload.tabId!==tabId &&
       tabs[command.payload.tabId]?.sessionId===command.sessionId){
      delete tabs[command.payload.tabId];
      await saveTabs();
    }
  } catch (e) {
    if (claim) {
      const row = ledger[command.id]; row.result ??= { error: e.code ?? 'COMMAND_UNCONFIRMED' }; row.phase = 'receipt'; await saveLedger();
      try { await postReceipt(command.id, row, profile); } catch {}
    } else {
      // Nothing was claimed or clicked. Report preparation failure immediately,
      // rather than strand the host for 90 seconds. A raced claim is refused.
      const allowed=['TAB_NOT_OWNED','PAGE_CLOSED','WRONG_PAGE','WRONG_CONVERSATION','TURN_CHANGED','REOPEN_IDENTITY_UNPROVEN','CONTENT_UNAVAILABLE','PAGE_RELOAD_REQUIRED','CONNECTION_CHANGED'];
      const error=allowed.includes(e.code)?e.code:'BROWSER_PREPARE_FAILED';
      try { await api('/fail-unclaimed',{id:command.id,error},true,profile);ledger[command.id].phase='acked';await saveLedger(); } catch {}
    }
    // An opening/Send without a receipt is NOT replayed, including after worker suspension.
  } finally {
    if (temporary && tabId !== undefined && tabs[tabId]?.createdBy === command.id) {
      try {
        const current = await chrome.tabs.get(tabId), probe = await tabRpc(tabId, { type: 'catalog-idle' });
        if (!current.active && new URL(current.url).pathname === '/' && probe?.ok && probe.value.idle && probe.value.documentKey === tabs[tabId].documentKey) await chrome.tabs.remove(tabId);
      } catch {}
      delete tabs[tabId]; await saveTabs();
    }
  }
}
function launch(map, key, action) {
  if (map.has(key)) return;
  // Set ownership synchronously, before the first await in action.
  const task = Promise.resolve().then(action).catch(() => {}).finally(() => map.delete(key));
  map.set(key, task);
}
const bindingKey = s => `${s.sessionId}:${s.turnId}`;
async function clearBindingWait(s) {
  const key = bindingKey(s);
  if (Object.hasOwn(bindingWaits, key)) { delete bindingWaits[key]; await persist('local', { bindingWaits }); }
}
async function reportLost(s, profile, reason = 'identity_unavailable') {
  if (config !== profile) return;
  await api('/event', { ...s, kind: 'binding_lost', diagnostic: { stage: 'binding', reason } }, true, profile);
  await clearBindingWait(s);
}
async function deferBinding(s, profile, reason) {
  if (config !== profile) return;
  const key = bindingKey(s), time = Date.now();
  let wait = bindingWaits[key];
  if (!wait || wait.endpoint !== profile.endpoint || !Number.isFinite(wait.since) || wait.since > time) {
    if (Object.keys(bindingWaits).length >= 100) return reportLost(s, profile, 'wait_capacity');
    bindingWaits[key] = wait = { since: time, endpoint: profile.endpoint };
    await persist('local', { bindingWaits });
  }
  // After the grace period, show a degraded-observation notice, not a false
  // terminal failure. The inactivity watchdog applies only without verified
  // activity; a recovered browser can resume hours later.
  if (!wait.notified && time - wait.since >= BINDING_GRACE_MS) {
    wait.notified=true;await persist('local',{bindingWaits});
    try { await api('/event',{...s,kind:'observation_gap',
      url:`https://chatgpt.com/c/${encodeURIComponent(s.conversationId)}`},true,profile); } catch {}
  }
  // Retry OBSERVATION on the next pump; never queue a message or invent an ID.
}
async function watchPendingReceipt(s, profile) {
  // A receipt deadline hands off observation; it must never dispatch Send.
  try {
    if(config!==profile)return;
    let tab;
    try{tab=await chrome.tabs.get(s.tabId);}catch{}
    // Chrome may have exited after the authorized Send. Losing the old tab
    // never proves non-delivery or termination: retain its one-shot receipt
    // state until the original evidence can be recovered.
    if(!tab)return deferBinding(s,profile,'page_closed');
    if(conversation(tab.url)!==s.conversationId)return deferBinding(s,profile,'route_changed');
    const reply=await tabRpc(s.tabId,{type:'pending-receipt',session:s},3000);
    if(reply?.ok!==true){
      // A Chrome reload replaces documentKey and loses its local pending-
      // receipt probe, but does NOT prove the original authorized Send
      // failed or landed elsewhere. Keep it unconfirmed and never replay.
      if(reply?.error==='PAGE_IDENTITY_CHANGED')
        return deferBinding(s,profile,'receipt_document_reloaded');
      return deferBinding(s,profile,'receipt_observation_unavailable');
    }
    const found=reply.value;
    if(found?.conflict)return reportLost(s,profile,'receipt_identity_conflict');
    if(found?.nativeMessageId){
      const ack=await api('/event',{...s,kind:'receipt_recovered',
        nativeMessageId:found.nativeMessageId,url:tab.url},true,profile);
      await clearBindingWait(s);
      if(ack.active===false)heartbeatAt.delete(bindingKey(s));
      return;
    }
    if(found?.available!==true)return deferBinding(s,profile,'receipt_observation_unavailable');
    await clearBindingWait(s);
    // Only a same-document, native page activity probe may renew the watchdog.
    // A tab existing or a server polling interval is NOT proof of activity.
    if(found.active===true && (!heartbeatAt.has(bindingKey(s)) || Date.now()-heartbeatAt.get(bindingKey(s))>=60000)){
      const ack=await api('/event',{...s,kind:'heartbeat',url:tab.url},true,profile);
      heartbeatAt.set(bindingKey(s),Date.now());
      if(ack.active===false)heartbeatAt.delete(bindingKey(s));
    }
  }catch(e){
    if(config!==profile)return;
    if(['TURN_INACTIVE','SESSION_UNKNOWN'].includes(e.code))return clearBindingWait(s);
    if(['PAGE_IDENTITY_MISMATCH','TURN_IDENTITY_MISMATCH'].includes(e.code))
      return reportLost(s,profile,'ownership_conflict');
    return deferBinding(s,profile,'receipt_observation_unavailable');
  }
}
async function watchSession(s, profile) {
  let session = s;
  if(s.receiptPending===true)return watchPendingReceipt(s,profile);
  try {
    if (config !== profile) return;
    if (!s.nativeMessageId || /^fallback-turn-/i.test(s.nativeMessageId) || /:(?:user|assistant)$/.test(s.nativeMessageId))
      return reportLost(s, profile, 'invalid_message_id');
    let actual;
    try { actual = await chrome.tabs.get(s.tabId); } catch {}
    if (actual && conversation(actual.url) !== s.conversationId &&
        !actual.url && actual.status === 'loading')
      return deferBinding(s, profile, 'page_loading');
    if (!actual || conversation(actual.url) !== s.conversationId) {
      // Never let a stale/foreign tab fall through to identity/monitor.
      // This is also essential when the old numeric tab ID was reused.
      actual = null;
      // Chrome restart can invalidate every old tab ID. Use only the exact
      // durable Conversation, never navigate/reclaim a foreign page.
      const matching = chrome.tabs.query ? (await chrome.tabs.query({ url: 'https://chatgpt.com/*' }))
        .filter(t => conversation(t.url) === s.conversationId) : [];
      if (matching.length > 1) return deferBinding(s, profile, 'multiple_tabs');
      if (matching.length === 1) {
        actual = matching[0];
        if (tabs[actual.id]?.sessionId && tabs[actual.id].sessionId !== s.sessionId)
          return deferBinding(s, profile, 'tab_owned_elsewhere');
      } else {
        // A just-created page may not have its URL yet. Persist the pending
        // tab ID to avoid opening duplicates across MV3 worker restarts.
        const pending = Object.entries(tabs).filter(([,owner]) =>
          owner.sessionId === s.sessionId && owner.restoringConversationId === s.conversationId);
        for (const [id] of pending) {
          let tab; try { tab = await chrome.tabs.get(Number(id)); } catch {}
          if (!tab) { delete tabs[id]; continue; }
          if (!tab.url || tab.status === 'loading')
            return deferBinding(s, profile, 'page_loading');
          if (conversation(tab.url) === s.conversationId) { actual = tab; break; }
          delete tabs[id];
        }
        if (!actual) {
          // Read-only recovery: opening this exact URL is not a native Send.
          // The next polling cycle must independently prove document/user ID.
          const tab = await chrome.tabs.create({
            url: `https://chatgpt.com/c/${encodeURIComponent(s.conversationId)}`, active: false
          });
          tabs[tab.id] = { sessionId:s.sessionId, restoringConversationId:s.conversationId };
          await saveTabs();
          return deferBinding(s, profile, 'page_reopening');
        }
      }
    }
    const reply = await tabRpc(actual.id ?? s.tabId, { type: 'identity' });
    if (reply?.ok !== true || !reply.value?.documentKey) return deferBinding(s, profile, 'identity_unavailable');
    const candidate = { ...reply.value, tabId: actual.id ?? s.tabId };
    if (candidate.engine !== 'cos-native-alpha4.3') return deferBinding(s, profile, 'unsupported_engine');
    if (conversation(candidate.url) !== s.conversationId) return deferBinding(s, profile, 'route_changed');
    if (!candidate.nativeMessageId) {
      // A tool/search render may temporarily unmount the native user row.
      // A one-shot Send was already accepted and persisted with this UUID.
      // Only the same TAB and the same DOCUMENT may retain that anchor;
      // a refreshed/replaced document must prove the user ID again.
      if (candidate.tabId !== s.tabId || candidate.documentKey !== s.documentKey)
        return deferBinding(s, profile, 'message_unavailable');
    } else if (candidate.nativeMessageId !== s.nativeMessageId) {
      // A newer native user message may be a direct ChatGPT input. Give the
      // current content monitor a chance to prove its older final, instead of
      // treating every same-document change as a lost conversation binding.
      if(candidate.tabId===s.tabId && candidate.documentKey===s.documentKey){
        // Restore the old native turn monitor even after an MV3 worker restart.
        // It may prove the old final before the browser-origin turn is imported.
        await tabRpc(s.tabId,{type:'monitor',session:s}).catch(()=>{});
        return deferBinding(s,profile,'new_native_user');
      }
      // A newly restored document might display a later web-origin turn.
      // Never adopt it as the old turn, but also never declare the original
      // bound Conversation irrecoverably lost just because its last ID moved.
      return deferBinding(s,profile,'message_changed');
    }
    if (['PAGE_IDENTITY_MISMATCH','TURN_IDENTITY_MISMATCH','UNMANAGED_PAGE','NATIVE_MESSAGE_ID_UNPROVEN'].includes(candidate.observationError))
      return deferBinding(s, profile, 'observation_rejected');
    if (config !== profile) return;
    if (candidate.tabId !== s.tabId || candidate.documentKey !== s.documentKey) {
      session = await api('/rebind-observation', { ...s, previousDocumentKey: s.documentKey, tabId: candidate.tabId,
        documentKey: candidate.documentKey, url: candidate.url }, true, profile);
    }
    if (config !== profile) return;
    const previous = tabs[session.tabId];
    if (previous?.sessionId !== s.sessionId || previous?.documentKey !== session.documentKey ||
        previous?.restoringConversationId) {
      tabs[session.tabId] = { sessionId:s.sessionId, documentKey:session.documentKey };
      // Do not leave a stale ownership entry on a tab now used for a
      // different ChatGPT conversation after an observed rebind.
      if (s.tabId !== session.tabId && tabs[s.tabId]?.sessionId === s.sessionId)
        delete tabs[s.tabId];
      await saveTabs();
    }
    const result = await tabRpc(session.tabId, { type: 'monitor', session });
    if (result?.ok !== true) {
      if (['PAGE_IDENTITY_CHANGED', 'TURN_CHANGED'].includes(result?.error))
        return deferBinding(session, profile, 'monitor_identity_pending');
      if (result?.error === 'TURN_IDENTITY_MISMATCH')
        return reportLost(session, profile, 'ownership_conflict');
      return deferBinding(session, profile, 'monitor_unavailable');
    }
    await clearBindingWait(session);
    // A healthy managed tab/document/turn can remain active for many hours.
    // One authenticated, ownership-bound heartbeat per minute renews the
    // Runtime watchdog; this does NOT imply a final answer was received.
    const key=bindingKey(session);
    if(result.value?.active===true && (!heartbeatAt.has(key) || Date.now()-heartbeatAt.get(key)>=60000)){
      const ack=await api('/event',{...session,kind:'heartbeat',url:candidate.url},true,profile);
      heartbeatAt.set(key,Date.now());
      if(ack.active===false)heartbeatAt.delete(key);
    }
  } catch (e) {
    if (config !== profile) return;
    if (['TURN_INACTIVE', 'SESSION_UNKNOWN'].includes(e.code)) { await clearBindingWait(session); return; }
    if (['PAGE_IDENTITY_MISMATCH', 'TURN_IDENTITY_MISMATCH', 'TAB_ALREADY_OWNED'].includes(e.code))
      await reportLost(session, profile, 'ownership_conflict');
    else await deferBinding(session, profile, 'identity_unavailable');
  }
}
async function watchIdle(s, profile) {
  const current=Date.now();
  if(current-(idleScannedAt.get(s.sessionId)??0)<3000)return;
  idleScannedAt.set(s.sessionId,current);
  // The bound conversation remains ours even after its prior turn completed.
  // Passive discovery is read-only until the Runtime accepts a NEW native user
  // message ID; never synthesize a Send or migrate a conversation by title.
  try {
    if(config!==profile || !s.conversationId || !s.previousNativeMessageId) return;
    let tab=null;
    const hinted=idleHints.get(s.conversationId);
    if(hinted && Date.now()-hinted.at<=15000)try{
      const current=await chrome.tabs.get(hinted.tabId);
      if(conversation(current.url)===s.conversationId)tab=current;
    }catch{}
    if(!tab)try{
      const current=await chrome.tabs.get(s.tabId);
      if(conversation(current.url)===s.conversationId)tab=current;
    }catch{}
    if(!tab){
      const matching=(await chrome.tabs.query({url:'https://chatgpt.com/*'}))
        .filter(t=>conversation(t.url)===s.conversationId);
      if(matching.length!==1)return;
      tab=matching[0];
    }
    if(tabs[tab.id] && tabs[tab.id].sessionId!==s.sessionId)return;
    let reopened=false;
    if(tab.id!==s.tabId){
      // Moving a binding is allowed only after the old tab is truly gone and
      // there is exactly one possible replacement with the same conversation.
      try{await chrome.tabs.get(s.tabId);return;}catch{}
      const matches=(await chrome.tabs.query({url:'https://chatgpt.com/*'}))
        .filter(t=>conversation(t.url)===s.conversationId);
      if(matches.length!==1||matches[0].id!==tab.id)return;
      reopened=true;
    }
    const reply=await tabRpc(tab.id,{type:'external-candidate',session:s},3500);
    if(reply?.ok!==true)return;
    if(reply.value?.available!==true){
      if(reply.value?.reason==='multiple_unobserved_turns')
        await api('/external-gap',{sessionId:s.sessionId,conversationId:s.conversationId,
          tabId:tab.id,documentKey:reply.value.documentKey,
          previousNativeMessageId:reply.value.previousNativeMessageId,
          reason:reply.value.reason,url:tab.url},true,profile);
      return;
    }
    const observation=reply.value;
    const actual=await chrome.tabs.get(tab.id);
    if(conversation(actual.url)!==s.conversationId ||
       conversation(observation.url)!==s.conversationId ||
       !observation.documentKey || tabs[tab.id]?.sessionId && tabs[tab.id].sessionId!==s.sessionId)return;
    const imported=await api('/external-turn',{sessionId:s.sessionId,
      conversationId:s.conversationId,tabId:tab.id,documentKey:observation.documentKey,
      previousNativeMessageId:observation.previousNativeMessageId,
      nativeMessageId:observation.nativeMessageId,text:observation.text,
      reopened,url:actual.url},true,profile);
    if(imported.settled || (!imported.imported&&!imported.duplicate))return;
    if(s.tabId!==tab.id && tabs[s.tabId]?.sessionId===s.sessionId)delete tabs[s.tabId];
    tabs[tab.id]={...(tabs[tab.id]??{}),sessionId:s.sessionId,
      documentKey:observation.documentKey};
    await saveTabs();
    await tabRpc(tab.id,{type:'monitor',session:imported},3500).catch(()=>{});
  }catch{
    // A failed observation is not a failed user turn. Later polls retry only
    // the read, never a native Send. Persistent import is idempotent.
  }
}
async function wakePaseoIfOffline(error) {
  // Only an unreachable local Runtime is a wake signal. A 403, invalid
  // token, protocol mismatch or other explicit error must not launch apps.
  if(error?.code || !config?.token ||
     typeof chrome.runtime.sendNativeMessage !== 'function' ||
     Date.now()-lastNativeWakeAt < 60000)return;
  lastNativeWakeAt=Date.now();
  await chrome.storage.session.set({lastNativeWakeAt});
  try {
    // Chrome validates the host's allowed_origins. The host accepts only
    // this fixed 'wake' action and no user-supplied commands or URLs.
    await chrome.runtime.sendNativeMessage(NATIVE_WAKE_HOST,{v:1,action:'wake'});
  }catch{ /* Host not installed or OS refused startup; next pump retries later. */ }
}
// Chrome unloads the previous content scripts when the extension is updated.
// A durable update plan survives MV3 worker suspension. It never replays Send.
const saveUpgradeRecovery=()=>persist('local',{upgradeRecovery});
async function recoverAfterUpdate(profile) {
  const job=upgradeRecovery;
  if(!job || config!==profile)return;
  if(job.phase==='discover'){
    // Query the authoritative Runtime: a stale tabId in Chrome storage is
    // not sufficient to refresh a user's unrelated ChatGPT conversation.
    let records;
    try{
      const response=await api('/recovery-targets',undefined,true,profile);
      records=response.sessions;
    }catch(e){
      if(e.code!=='ROUTE_NOT_FOUND')throw e;
      // In a staged upgrade the older Runtime lacks the new inventory.
      // Its existing authenticated active/idle views still let us refresh
      // known bindings. Agent wake waits until the new Runtime is loaded.
      const active=await api('/active',undefined,true,profile);
      const idle=await api('/bindings',undefined,true,profile);
      records=[...(active.sessions??[]),...(idle.sessions??[])];
    }
    if(config!==profile)return;
    const seenTabs=new Set();
    job.targets=(Array.isArray(records)?records:[]).slice(0,100).map(s=>{
      const owned=Number.isInteger(s.tabId)&&s.tabId>=0 &&
        tabs[s.tabId]?.sessionId===s.sessionId &&
        typeof s.conversationId==='string' && s.conversationId.length>0 &&
        !seenTabs.has(s.tabId);
      if(owned)seenTabs.add(s.tabId);
      return {sessionId:s.sessionId,conversationId:s.conversationId,tabId:s.tabId,
        phase:owned?'pending':'skipped',attempts:0};
    });
    job.phase='refresh';await saveUpgradeRecovery();
  }
  if(job.phase!=='refresh')return;
  for(const target of job.targets){
    if(config!==profile)return;
    if(['done','skipped'].includes(target.phase))continue;
    let current;
    try{current=await chrome.tabs.get(target.tabId);}catch{}
    if(!current || conversation(current.url)!==target.conversationId ||
       tabs[target.tabId]?.sessionId!==target.sessionId){
      target.phase='skipped';await saveUpgradeRecovery();continue;
    }
    if(target.phase==='pending'){
      // Persist BEFORE the browser side effect: a suspended service worker
      // may restart and should not blindly refresh this tab repeatedly.
      target.phase='reload_requested';target.attempts++;
      target.requestedAt=Date.now();await saveUpgradeRecovery();
      try{await chrome.tabs.reload(target.tabId);}
      catch{target.phase='skipped';await saveUpgradeRecovery();continue;}
    }
    if(target.phase==='reload_requested'){
      let reply;
      try{reply=await tabRpc(target.tabId,{type:'identity'},3000);}catch{}
      const page=reply?.ok&&reply.value;
      if(page?.engine==='cos-native-alpha4.3' && page.documentKey &&
         conversation(page.url)===target.conversationId){
        target.phase='ready';await saveUpgradeRecovery();
      }else{
        // Give Chrome time to reload the script. One bounded second attempt
        // tolerates an interrupted reload without a refresh loop.
        if(Date.now()-(target.requestedAt??0)>45000){
          target.phase=target.attempts<2?'pending':'skipped';
          await saveUpgradeRecovery();
        }
        continue;
      }
    }
    if(target.phase==='ready'){
      // Wake the ORIGINAL Paseo Agent/pipeline, never create a new turn.
      // The normal /active observer will then rebind the new document key.
      try{
        await api('/resume-agent',{sessionId:target.sessionId,
          conversationId:target.conversationId},true,profile);
        target.phase='done';await saveUpgradeRecovery();
      }catch{
        // Retry only this Agent activation on the next pump. Other independent
        // Agent conversations must continue their existing pipelines.
      }
    }
  }
  if(job.targets.every(t=>['done','skipped'].includes(t.phase))){
    upgradeRecovery=null;await saveUpgradeRecovery();
  }
}
async function pump() {
  if (pumpFlight) return pumpFlight;
  pumpFlight = (async () => {
    await load();
    if(updateEventPending){
      updateEventPending=false;
      // A second version update supersedes an older recovery inventory.
      // Re-discover from the authoritative Runtime, never replay old Send.
      // A NEW update event always supersedes the old recovery plan, even if
      // only the extension's patch version changed while the engine stayed
      // cos-native-alpha4.3. An MV3 worker restart WITHOUT a new update event
      // still resumes the persisted plan instead of refreshing twice.
      upgradeRecovery={engine:'cos-native-alpha4.3',phase:'discover',
        targets:[],createdAt:Date.now()};
      await saveUpgradeRecovery();
    }
    if (!config.token) return;
    const profile = config;
    const hello = await api('/hello', undefined, false, profile);
    if (hello.protocol !== PROTOCOL || hello.product !== 'chatmode-in-paseo') throw codeError('PROTOCOL_MISMATCH');
    if(upgradeRecovery)await recoverAfterUpdate(profile);
    if(updateEventPending)return; // Update arrived during an already running pump.
    const recovering=new Set(upgradeRecovery?.targets?.filter(t=>!['done','skipped'].includes(t.phase))
      .map(t=>t.sessionId)??[]);
    // An unbuilt inventory must finish before any command can be delivered.
    if(upgradeRecovery?.phase==='discover')return;
    for (const [id, row] of Object.entries(ledger)) {
      if (row.phase === 'receipt') launch(receipts, id, () => postReceipt(id, row, profile));
      if (row.phase === 'acked' && Date.now() - row.at > 86400000) { delete ledger[id]; await saveLedger(); }
    }
    const { commands } = await api('/commands', undefined, true, profile);
    if (config !== profile) return;
    for (const command of commands) {
      // A single old/stuck tab must not block independent Agent sessions.
      // Its own unsent commands wait until the updated content script is ready.
      if(command.sessionId && recovering.has(command.sessionId))continue;
      const key = command.kind === 'stop' ? `stop:${command.sessionId}` : command.sessionId ?? command.id;
      if (!Object.hasOwn(ledger, command.id)) launch(executions, key, () => execute(command));
    }
    const { sessions } = await api('/active', undefined, true, profile);
    if (config !== profile) return;
    lastOnlineAt = Date.now(); activeSessions = sessions;
    const live = new Set(sessions.map(bindingKey)); let pruned = false;
    for (const key of Object.keys(bindingWaits)) if (!live.has(key)) { delete bindingWaits[key]; pruned = true; }
    if (pruned) await persist('local', { bindingWaits });
    for(const key of heartbeatAt.keys())if(!live.has(key))heartbeatAt.delete(key);
    for (const s of sessions)if(!recovering.has(s.sessionId))
      launch(monitors, s.sessionId, () => watchSession(s, profile));
    // Separate, passive lane for completed turns. This does not acquire the
    // command queue and cannot send ChatGPT messages.
    try {
      const bindings=await api('/bindings',undefined,true,profile);
      if(config===profile && Array.isArray(bindings.sessions))
        for(const s of bindings.sessions)if(!recovering.has(s.sessionId))
          launch(monitors,'idle:'+s.sessionId,()=>watchIdle(s,profile));
    }catch{}
  })().catch(e => wakePaseoIfOffline(e)).catch(() => {}).finally(() => { pumpFlight = null; clearTimeout(timer); timer = setTimeout(pump, 1000); });
  return pumpFlight;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    await load();
    // Trust only our exact extension UI, whether Chrome opens it as a popup or a tab.
    const popup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
    if (popup && message.type === 'status') return { paired: Boolean(config.token), connected: Boolean(config.token) && Date.now() - lastOnlineAt < 15000, endpoint: config.endpoint, activeSessions: activeSessions.length };
    if (popup && message.type === 'pair') {
      const candidate = { endpoint: endpointOf(message.endpoint || DEFAULT_ENDPOINT).origin, token: null };
      if (executions.size || activeSessions.length) throw codeError('BRIDGE_BUSY');
      const intent = ++pairingIntent;
      // Do not consume a code or replace credentials on an incompatible old runtime.
      const hello = await api('/hello', undefined, false, candidate);
      if (hello.protocol !== PROTOCOL || hello.product !== 'chatmode-in-paseo') throw codeError('PROTOCOL_MISMATCH');
      if (intent !== pairingIntent) throw codeError('PAIRING_CANCELLED');
      const r = await api('/pair', { code: message.code, extensionId: chrome.runtime.id }, false, candidate);
      if (r.protocol !== PROTOCOL || !/^[a-f0-9]{64}$/.test(r.token)) throw codeError('PROTOCOL_MISMATCH');
      if (intent !== pairingIntent) throw codeError('PAIRING_CANCELLED');
      candidate.token = r.token;
      await persist('local', { config: candidate });
      if (intent !== pairingIntent) throw codeError('PAIRING_CANCELLED');
      config = candidate; lastOnlineAt = 0; void pump(); return { paired: true };
    }
    if (popup && message.type === 'disconnect') {
      pairingIntent++; const disconnected = { ...config, token: null }; config = disconnected; lastOnlineAt = 0;
      await persist('local', { config: disconnected }); return { paired: false };
    }
    if (message.type === 'idle-notice' && sender.tab && sender.frameId===0 &&
        sender.url && new URL(sender.url).hostname==='chatgpt.com' && config.token) {
      // Wake an MV3-suspended worker promptly. Notification carries no message
      // body and has no authority to send or bind a session by itself.
      try{
        const current=await chrome.tabs.get(sender.tab.id);
        const id=conversation(current.url);
        if(id)idleHints.set(id,{tabId:current.id,at:Date.now()});
      }catch{}
      if(Date.now()-lastIdleNoticeAt>=2000){lastIdleNoticeAt=Date.now();void pump();}
      return {observing:true};
    }
    const tabId = sender.tab?.id, managed = tabs[tabId];
    if (!managed || !sender.url || new URL(sender.url).hostname !== 'chatgpt.com' || sender.frameId !== undefined && sender.frameId !== 0) throw codeError('UNMANAGED_PAGE');
    if (message.type === 'bind-conversation') {
      const row=ledger[message.id];
      if(!row||row.tabId!==tabId||row.documentKey!==message.documentKey||
         row.lease!==message.lease||row.phase!=='authorized'||
         row.command?.kind!=='send'||row.endpoint!==config.endpoint)
        throw codeError('CLAIM_MISMATCH');
      const boundId=conversation(message.url);
      const actual=await chrome.tabs.get(tabId);
      if(!boundId||conversation(actual.url)!==boundId||
         tabs[tabId]?.documentKey!==message.documentKey||
         tabs[tabId]?.sessionId!==row.command.sessionId)
        throw codeError('PAGE_IDENTITY_MISMATCH');
      return api('/bind-conversation',{id:message.id,lease:message.lease,
        tabId,documentKey:message.documentKey,url:actual.url});
    }
    if (message.type === 'input-chunk') {
      const row=ledger[message.id];
      if(!row || row.phase!=='claimed' || row.tabId!==tabId ||
         row.documentKey!==message.documentKey || row.lease!==message.lease ||
         row.endpoint!==config.endpoint || row.command?.kind!=='send' ||
         !Array.isArray(row.command.payload?.files) ||
         tabs[tabId]?.documentKey!==message.documentKey ||
         tabs[tabId]?.sessionId!==row.command.sessionId)
        throw codeError('CLAIM_MISMATCH');
      const actual=await chrome.tabs.get(tabId);
      if(new URL(actual.url).hostname!=='chatgpt.com' ||
         (row.command.payload.conversationId &&
           conversation(actual.url)!==row.command.payload.conversationId))
        throw codeError('PAGE_IDENTITY_MISMATCH');
      return api('/input-chunk',{id:message.id,lease:message.lease,
        documentKey:message.documentKey,index:message.index,offset:message.offset},
        true,config);
    }
    if (message.type === 'authorize') {
      const row = ledger[message.id];
      if (!row || row.tabId !== tabId || row.documentKey !== message.documentKey || row.lease !== message.lease || row.phase !== 'claimed' || row.endpoint !== config.endpoint) throw codeError('CLAIM_MISMATCH');
      const result = await api('/authorize', { id: message.id, lease: message.lease });
      row.phase = 'authorized'; await saveLedger(); return result;
    }
    if (message.type === 'observation') {
      const event = message.event;
      if (event.tabId !== tabId || event.documentKey !== managed.documentKey || event.sessionId !== managed.sessionId) throw codeError('PAGE_IDENTITY_MISMATCH');
      // Chrome MessageSender.url can describe the document's original URL after
      // an SPA history change. Verify the CURRENT tab against the content event;
      // never overwrite its new /c/<id> route with the old new-chat URL.
      const actual = await chrome.tabs.get(tabId);
      const currentConversation = conversation(actual.url);
      if (!currentConversation || currentConversation !== conversation(event.url) ||
          tabs[tabId]?.documentKey !== event.documentKey || tabs[tabId]?.sessionId !== event.sessionId)
        throw codeError('PAGE_IDENTITY_MISMATCH');
      return api('/event', { ...event, tabId, url: actual.url });
    }
    throw codeError('UNKNOWN_MESSAGE');
  })().then(value => respond({ ok: true, value }), e => respond({ ok: false, error: e.code ?? 'BRIDGE_UNAVAILABLE' }));
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId => {
  await load(); delete tabs[tabId]; await saveTabs();
  // Do NOT immediately reopen a page in an onRemoved callback: macOS Chrome
  // Quit closes every tab and such a pump could recreate a window while the
  // user is trying to exit. Normal alarms and onStartup resume the binding.
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'cip-pump') void pump(); });
chrome.runtime.onInstalled.addListener(details => {
  chrome.alarms.create('cip-pump', { periodInMinutes: 0.5 });
  // A delayed native update event must not double-refresh the same version
  // after the manifest-version fallback has already scheduled recovery.
  if(details?.reason==='update'&&!versionRecoveryInitiated)updateEventPending=true;
  void pump();
});
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('cip-pump', { periodInMinutes: 0.5 }); void pump(); });
void pump();
