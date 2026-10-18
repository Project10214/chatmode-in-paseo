const PROTOCOL = 8, DEFAULT_ENDPOINT = 'http://127.0.0.1:17843';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let pumpFlight = null, timer = null, loaded = null, lastOnlineAt = 0, pairingIntent = 0;
let config, ledger, tabs, catalogBrowserId, upgradeRecovery=null, updateEventPending=false, versionRecoveryInitiated=false;
let bindingWaits = {}; // Persist grace deadlines across service-worker suspension.
const BINDING_GRACE_MS = 15000;
const executions = new Map(), receipts = new Map(), monitors = new Map();
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
// A ChatGPT tab reloaded in the background can stay an empty shell (no
// conversation, no composer) until it is reloaded again (seen three times on
// 2026-10-17). Before preparing a Send nothing is typed or claimed yet, so
// such a tab is reloaded once; the normal identity checks then run as usual.
async function settleBlankTab(tabId) {
  const ready = async () => {
    try { const r = await tabRpc(tabId, { type: 'page-ready' }, 3000); return r?.ok === true && r.value?.composer === true; }
    catch { return false; }
  };
  for (const end = Date.now() + 8000; Date.now() < end; await delay(500)) if (await ready()) return false;
  try { await chrome.tabs.reload(tabId); } catch { return false; }
  for (const end = Date.now() + 30000; Date.now() < end; await delay(500)) if (await ready()) break;
  return true;
}
async function identity(tabId, expected = null) {
  const deadline = Date.now() + 25000;
  do {
    try {
      const tab = await chrome.tabs.get(tabId); const url = new URL(tab.url);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') throw codeError('WRONG_PAGE');
      const r = await tabRpc(tabId, { type: 'identity' });
      if (r?.ok && r.value?.documentKey) {
        if(r.value.engine !== 'cos-native-alpha4.3' || r.value.protocol !== PROTOCOL) throw codeError('PAGE_RELOAD_REQUIRED');
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
async function closeArchivedTab(command, claim, profile) {
  const { tabId, documentKey, conversationId: expectedConversation } = command.payload;
  const skip = skipped => ({ closed: false, skipped });
  const owned = () => tabs[tabId]?.sessionId === command.sessionId &&
    tabs[tabId]?.documentKey === documentKey;
  const sameConversation = url => conversation(url) === (expectedConversation ?? null);
  if (tabs[tabId]?.sessionId !== command.sessionId) return skip('TAB_NOT_OWNED');
  if (!owned()) return skip('DOCUMENT_CHANGED');
  let current;
  try { current = await chrome.tabs.get(tabId); }
  catch { return skip('TAB_MISSING'); }
  if (current.active) return skip('ACTIVE_TAB');
  if (!sameConversation(current.url)) return skip('WRONG_CONVERSATION');
  const probe = await tabRpc(tabId, { type: 'archive-idle' }).catch(() => null);
  if (probe?.ok !== true) return skip('PAGE_UNAVAILABLE');
  if (probe.value?.documentKey !== documentKey) return skip('DOCUMENT_CHANGED');
  if (!sameConversation(probe.value?.url)) return skip('WRONG_CONVERSATION');
  if (probe.value?.idle !== true) return skip('PAGE_BUSY');

  // A new Send may have started since the archive event. Recheck the Runtime
  // before any browser side effect, then recheck the page immediately before removal.
  const gate = await api('/verify-tab-close', { id: claim.id, lease: claim.lease }, true, profile);
  if (gate?.allowed !== true) return skip('SESSION_BUSY');
  const finalProbe = await tabRpc(tabId, { type: 'archive-idle' }).catch(() => null);
  if (finalProbe?.ok !== true) return skip('PAGE_UNAVAILABLE');
  if (finalProbe.value?.documentKey !== documentKey) return skip('DOCUMENT_CHANGED');
  if (!sameConversation(finalProbe.value?.url)) return skip('WRONG_CONVERSATION');
  if (finalProbe.value?.idle !== true) return skip('PAGE_BUSY');
  if (tabs[tabId]?.sessionId !== command.sessionId) return skip('TAB_NOT_OWNED');
  if (!owned()) return skip('DOCUMENT_CHANGED');
  try { current = await chrome.tabs.get(tabId); }
  catch { return skip('TAB_MISSING'); }
  if (current.active) return skip('ACTIVE_TAB');
  if (!sameConversation(current.url)) return skip('WRONG_CONVERSATION');
  await chrome.tabs.remove(tabId);
  delete tabs[tabId];
  await saveTabs();
  return { closed: true };
}
async function execute(command) {
  if (Object.hasOwn(ledger, command.id)) return;
  const profile = config;
  ledger[command.id] = { phase: 'reserved', command, endpoint: profile.endpoint, at: Date.now() }; await saveLedger();
  let claim, tabId, reopened = false; const temporary = command.kind === 'catalog';
  try {
    if(command.kind==='close-tab') {
      tabId=command.payload.tabId;
      // Claim exactly the saved document; the page is never trusted until
      // closeArchivedTab independently checks identity and idleness.
    } else if(command.kind==='ensure') {
      tabId=command.payload.tabId;
      let actual;
      try { actual=await chrome.tabs.get(tabId); }
      catch {
        // A failed lookup is not proof of closure. Confirm absence before
        // creating a replacement which may subsequently receive a new Send.
        let listed;try { listed=await chrome.tabs.query({}); } catch { throw codeError('CONTENT_UNAVAILABLE'); }
        if(!Array.isArray(listed)||listed.some(t=>t.id===tabId))throw codeError('CONTENT_UNAVAILABLE');
      }
      if(actual) {
        if(tabs[tabId] && tabs[tabId].sessionId!==command.sessionId) throw codeError('TAB_NOT_OWNED');
        if(!actual.url)throw codeError('CONTENT_UNAVAILABLE');
        if(conversation(actual.url)!==command.payload.conversationId ||
           (actual.pendingUrl && conversation(actual.pendingUrl)!==command.payload.conversationId))
          throw codeError('WRONG_CONVERSATION');
      } else {
        if(!command.payload.conversationId) throw codeError('WRONG_CONVERSATION');
        // Only a confirmed closed tab can be replaced for a fresh request.
        // A still-present foreign page is not permission to open a sending tab.
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
    if (['open','configure','ensure'].includes(command.kind) && !reopened) await settleBlankTab(tabId);
    const page = command.kind === 'close-tab'
      ? { documentKey: command.payload.documentKey }
      : await identity(tabId, command.kind==='ensure'?command.payload:null);
    if (config !== profile) throw codeError('CONNECTION_CHANGED');
    claim = await api('/claim', { id: command.id, tabId, documentKey: page.documentKey, ...(command.kind==='ensure'?{url:page.url,nativeMessageId:page.nativeMessageId,reopened}:{}) }, true, profile);
    ledger[command.id] = { ...ledger[command.id], phase: 'claimed', lease: claim.lease, documentKey: page.documentKey };
    await saveLedger();
    if (command.kind !== 'close-tab') {
      tabs[tabId] = { ...tabs[tabId], documentKey: page.documentKey };
      await saveTabs();
    }
    // The Runtime extends a file Send's deadline by its upload size (max ~5 minutes).
    const cap = claim.payload?.files?.length ? 300000 : 90000;
    const budget = Number.isFinite(claim.deadline) ? Math.min(cap, Math.max(1, claim.deadline - Date.now() - 1000)) : 60000;
    const reply = command.kind === 'close-tab'
      ? { ok: true, value: await closeArchivedTab(command, claim, profile) }
      : await tabRpc(tabId, { type: 'command', command: claim }, budget);
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
// Observation belongs to the bound conversation, not a native user or host run.
const bindingKey = s => s.sessionId;
const boundUrl = s => `https://chatgpt.com/c/${encodeURIComponent(s.conversationId)}`;
const descriptorValid = s => s && typeof s.sessionId === 'string' && s.sessionId.length > 0 &&
  typeof s.conversationId === 'string' && /^[A-Za-z0-9-]+$/.test(s.conversationId) &&
  Number.isInteger(s.tabId) && s.tabId >= 0 &&
  typeof s.documentKey === 'string' && s.documentKey.length > 0 &&
  typeof s.observationLease === 'string' && s.observationLease.length > 0 &&
  Number.isInteger(s.generation) && s.generation >= 0 &&
  (s.runId === null || typeof s.runId === 'string');
async function clearBindingWait(s) {
  const key = bindingKey(s);
  if (Object.hasOwn(bindingWaits, key)) { delete bindingWaits[key]; await persist('local', { bindingWaits }); }
}
async function deferBinding(s, profile, reason) {
  if (config !== profile) return;
  const key = bindingKey(s), time = Date.now();
  let wait = bindingWaits[key];
  if (!wait || wait.endpoint !== profile.endpoint || !Number.isFinite(wait.since) || wait.since > time) {
    bindingWaits[key] = wait = { since: time, endpoint: profile.endpoint };
    await persist('local', { bindingWaits });
  }
  // A missing read is a retryable gap, never a terminal or proof of page state.
  // Failed gap delivery remains retryable across worker suspension.
  if (config !== profile) return;
  if (time - wait.since >= BINDING_GRACE_MS && (!wait.notified || wait.reason !== reason)) {
    try {
      await api('/observation-gap', { ...s, reason, url: boundUrl(s) }, true, profile);
      if (config !== profile) return;
      wait.notified = true; wait.reason = reason;
      await persist('local', { bindingWaits });
    } catch {}
  }
}
async function revokeObservation(tabId, sessionId) {
  const owner = tabs[tabId];
  if (owner?.sessionId !== sessionId || owner.observationRevoked && !owner.observationLease) return;
  tabs[tabId] = { ...owner, observationRevoked: true };
  delete tabs[tabId].observationLease;
  await saveTabs();
}
async function watchPendingReceipt(s, profile) {
  // Receipt evidence retains its one-shot Send lease. It neither authorizes a
  // new Send nor replaces the conversation's continuous monitor.
  try {
    if (config !== profile) return 'connection_changed';
    const tab = await chrome.tabs.get(s.tabId);
    if (config !== profile) return 'connection_changed';
    if (conversation(tab.url) !== s.conversationId) {
      await revokeObservation(s.tabId, s.sessionId);
      return 'receipt_route_changed';
    }
    const reply = await tabRpc(s.tabId, { type: 'pending-receipt', session: s }, 3000);
    if (reply?.ok !== true)
      return reply?.error === 'PAGE_IDENTITY_CHANGED' ? 'receipt_document_reloaded' : 'receipt_observation_unavailable';
    if (config !== profile) return 'connection_changed';
    const current = await chrome.tabs.get(s.tabId), owner = tabs[s.tabId];
    if (config !== profile) return 'connection_changed';
    if (conversation(current.url) !== s.conversationId ||
        current.pendingUrl && conversation(current.pendingUrl) !== s.conversationId) {
      await revokeObservation(s.tabId, s.sessionId);
      return 'receipt_identity_changed';
    }
    if (owner?.sessionId !== s.sessionId || owner.documentKey !== s.documentKey ||
        owner.observationLease !== s.observationLease || owner.observationRevoked)
      return 'receipt_identity_changed';
    const found = reply.value;
    if (found?.conflict) return 'receipt_identity_conflict';
    if (typeof found?.nativeMessageId === 'string' && found.nativeMessageId.length > 0) {
      await api('/receipt-observation', { ...s, nativeMessageId: found.nativeMessageId, url: current.url }, true, profile);
      return null;
    }
    return found?.available === true ? null : 'receipt_observation_unavailable';
  } catch {
    return 'receipt_observation_unavailable';
  }
}
async function watchSession(s, profile) {
  let session = s;
  try {
    if (config !== profile) return;
    if (!descriptorValid(s)) return deferBinding(s, profile, 'descriptor_unavailable');
    let actual;
    try { actual = await chrome.tabs.get(s.tabId); } catch {}
    if (config !== profile) return;
    if (actual && tabs[s.tabId]?.sessionId && tabs[s.tabId].sessionId !== s.sessionId)
      return deferBinding(s, profile, 'tab_owned_elsewhere');
    if (actual?.pendingUrl && conversation(actual.pendingUrl) !== s.conversationId) {
      await revokeObservation(s.tabId, s.sessionId);
      return deferBinding(s, profile, 'route_changing');
    }
    if (actual && !actual.url && actual.status === 'loading')
      return deferBinding(s, profile, 'page_loading');
    if (!actual || conversation(actual.url) !== s.conversationId) {
      // A reused/foreign tab is never read, navigated or reclaimed.
      await revokeObservation(s.tabId, s.sessionId);
      actual = null;
      const matching = (await chrome.tabs.query({ url: 'https://chatgpt.com/*' }))
        .filter(t => conversation(t.url) === s.conversationId);
      if (config !== profile) return;
      if (matching.length > 1) return deferBinding(s, profile, 'multiple_tabs');
      if (matching.length === 1) {
        actual = matching[0];
        if (tabs[actual.id]?.sessionId && tabs[actual.id].sessionId !== s.sessionId)
          return deferBinding(s, profile, 'tab_owned_elsewhere');
        if (actual.pendingUrl && conversation(actual.pendingUrl) !== s.conversationId)
          return deferBinding(s, profile, 'route_changing');
      } else {
        // Persist pending replacement ownership before the next poll. A worker
        // restart must reuse it, not open a second copy or replay a Send.
        const pending = Object.entries(tabs).filter(([, owner]) =>
          owner.sessionId === s.sessionId && owner.restoringConversationId === s.conversationId);
        for (const [id] of pending) {
          let tab; try { tab = await chrome.tabs.get(Number(id)); } catch {}
          if (!tab) { delete tabs[id]; continue; }
          if (!tab.url || tab.status === 'loading') return deferBinding(s, profile, 'page_loading');
          if (conversation(tab.url) === s.conversationId) { actual = tab; break; }
          delete tabs[id];
        }
        if (!actual) {
          // A bound-but-idle conversation is not a reason to open a tab. Only an
          // active run (sending/running/stopping or pending receipt) may reopen
          // its page; idle/historical bindings wait for an existing tab.
          if (s.active !== true) return;
          if (config !== profile) return;
          const tab = await chrome.tabs.create({ url: boundUrl(s), active: false });
          tabs[tab.id] = { sessionId: s.sessionId, restoringConversationId: s.conversationId };
          await saveTabs();
          return deferBinding(s, profile, 'page_reopening');
        }
      }
    }
    const tabId = actual.id ?? s.tabId;
    const reply = await tabRpc(tabId, { type: 'identity' });
    if (reply?.ok !== true || !reply.value?.documentKey)
      return deferBinding(s, profile, 'identity_unavailable');
    const candidate = reply.value;
    if (candidate.engine !== 'cos-native-alpha4.3' || candidate.protocol !== PROTOCOL) return deferBinding(s, profile, 'unsupported_engine');
    const current = await chrome.tabs.get(tabId);
    if (conversation(candidate.url) !== s.conversationId || conversation(current.url) !== s.conversationId ||
        current.pendingUrl && conversation(current.pendingUrl) !== s.conversationId) {
      await revokeObservation(tabId, s.sessionId);
      return deferBinding(s, profile, 'route_changed');
    }
    if (tabs[tabId]?.sessionId && tabs[tabId].sessionId !== s.sessionId)
      return deferBinding(s, profile, 'tab_owned_elsewhere');
    if (config !== profile) return;
    // Neither last native user identity nor body/state readability is a read
    // gate. Same-document A -> B -> A also needs a fresh observation epoch.
    if (tabId !== s.tabId || candidate.documentKey !== s.documentKey ||
        candidate.observationRevoked === true || tabs[tabId]?.observationRevoked === true) {
      await revokeObservation(s.tabId, s.sessionId);
      if (config !== profile) return;
      session = await api('/rebind-observation', { ...s, previousDocumentKey: s.documentKey,
        tabId, documentKey: candidate.documentKey, url: current.url }, true, profile);
      if (!descriptorValid(session) || session.sessionId !== s.sessionId ||
          session.conversationId !== s.conversationId || session.tabId !== tabId ||
          session.documentKey !== candidate.documentKey || session.observationLease === s.observationLease)
        throw codeError('OBSERVATION_DESCRIPTOR_INVALID');
    }
    if (config !== profile) return;
    // Persist the independent observation lease; never overwrite the Send
    // authorization ledger or infer its result from a successful page read.
    const previous = tabs[session.tabId];
    if (previous?.sessionId && previous.sessionId !== session.sessionId)
      return deferBinding(session, profile, 'tab_owned_elsewhere');
    const owner = { ...previous, sessionId: session.sessionId, documentKey: session.documentKey,
      conversationId: session.conversationId, observationLease: session.observationLease,
      generation: session.generation };
    delete owner.restoringConversationId;
    delete owner.observationRevoked;
    if (JSON.stringify(previous) !== JSON.stringify(owner)) {
      tabs[session.tabId] = owner;
      if (s.tabId !== session.tabId && tabs[s.tabId]?.sessionId === s.sessionId) delete tabs[s.tabId];
      await saveTabs();
    }
    if (config !== profile) return;
    let monitorReason = null;
    try {
      const result = await tabRpc(session.tabId, { type: 'monitor', session });
      if (result?.ok !== true) monitorReason = 'monitor_unavailable';
    } catch { monitorReason = 'monitor_unavailable'; }
    // Always attempt the content monitor in this watch, even for an uncertain
    // receipt. A failed receipt probe must not block page/body observations.
    const receiptReason = session.receiptPending === true ? await watchPendingReceipt(session, profile) : null;
    if (config !== profile) return;
    if (monitorReason || receiptReason) await deferBinding(session, profile, monitorReason || receiptReason);
    else await clearBindingWait(session);
  } catch {
    if (config === profile) await deferBinding(session, profile, 'observation_unavailable');
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
      // Recovery inventory may be unavailable during an upgrade, but there is
      // only one observation protocol. Never fall back to state-split views.
      const response=await api('/observations',undefined,true,profile);
      records=response.sessions;
    }
    if(config!==profile)return;
    const seenTabs=new Set();
    job.targets=(Array.isArray(records)?records:[]).map(s=>{
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
      if(page?.engine==='cos-native-alpha4.3' && page.protocol===PROTOCOL && page.documentKey &&
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
      // The unified observer will then rebind the new document key.
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
      const key = ['stop','approval'].includes(command.kind) ? `${command.kind}:${command.sessionId}` : command.sessionId ?? command.id;
      if (!Object.hasOwn(ledger, command.id)) launch(executions, key, () => execute(command));
    }
    const { sessions } = await api('/observations', undefined, true, profile);
    if (config !== profile) return;
    if (!Array.isArray(sessions)) throw codeError('OBSERVATION_DESCRIPTORS_INVALID');
    lastOnlineAt = Date.now(); activeSessions = sessions;
    const live = new Set(sessions.map(bindingKey)); let pruned = false;
    for (const key of Object.keys(bindingWaits)) if (!live.has(key)) { delete bindingWaits[key]; pruned = true; }
    if (pruned) await persist('local', { bindingWaits });
    for (const s of sessions) if (!recovering.has(s.sessionId))
      launch(monitors, s.sessionId, () => watchSession(s, profile));
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
    const tabId = sender.tab?.id, managed = tabs[tabId];
    let senderUrl;
    try { senderUrl = new URL(sender.url); } catch {}
    if (sender.id !== chrome.runtime.id || !managed ||
        senderUrl?.protocol !== 'https:' || senderUrl?.hostname !== 'chatgpt.com' ||
        sender.frameId !== undefined && sender.frameId !== 0) throw codeError('UNMANAGED_PAGE');
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
    const artifactRoute=({'artifact-begin':'/artifact/begin','artifact-chunk':'/artifact/chunk',
      'artifact-commit':'/artifact/commit','artifact-unsupported':'/artifact/unsupported'})[message.type];
    if (message.type === 'page-view' || artifactRoute) {
      const event = artifactRoute ? message : message.event, profile = config;
      const matches = owner => owner && !owner.observationRevoked &&
        event && typeof event === 'object' && !Array.isArray(event) &&
        event.tabId === tabId && event.sessionId === owner.sessionId &&
        event.documentKey === owner.documentKey &&
        typeof event.observationLease === 'string' && event.observationLease.length > 0 &&
        event.observationLease === owner.observationLease;
      if (!profile.token) throw codeError('AUTH_REQUIRED');
      if (!matches(managed) || !artifactRoute && (!Number.isSafeInteger(event.sequence) || event.sequence <= 0))
        throw codeError('PAGE_IDENTITY_MISMATCH');
      // MessageSender.url may be the document's initial new-chat URL after SPA
      // navigation. Current Chrome URL + live content identity are authoritative;
      // neither page state nor visible message/user IDs decide read admission.
      const actual = await chrome.tabs.get(tabId);
      if (!managed.conversationId || conversation(actual.url) !== managed.conversationId ||
          actual.pendingUrl && conversation(actual.pendingUrl) !== managed.conversationId) {
        await revokeObservation(tabId, event.sessionId);
        throw codeError('PAGE_IDENTITY_MISMATCH');
      }
      if (conversation(event.url) !== managed.conversationId ||
          event.view?.conversationId !== undefined && event.view.conversationId !== managed.conversationId)
        throw codeError('PAGE_IDENTITY_MISMATCH');
      const reply = await tabRpc(tabId, { type: 'identity' });
      const page = reply?.ok === true && reply.value;
      if (!page || page.engine !== 'cos-native-alpha4.3' || page.protocol !== PROTOCOL || page.documentKey !== event.documentKey ||
          conversation(page.url) !== managed.conversationId || page.observationRevoked === true) {
        if (page?.observationRevoked === true || page?.documentKey && page.documentKey !== event.documentKey)
          await revokeObservation(tabId, event.sessionId);
        throw codeError('PAGE_IDENTITY_MISMATCH');
      }
      const current = await chrome.tabs.get(tabId), owner = tabs[tabId];
      if (config !== profile) throw codeError('CONNECTION_CHANGED');
      if (!matches(owner)) throw codeError('PAGE_IDENTITY_MISMATCH');
      if (conversation(current.url) !== owner.conversationId ||
          current.pendingUrl && conversation(current.pendingUrl) !== owner.conversationId) {
        await revokeObservation(tabId, event.sessionId);
        throw codeError('PAGE_IDENTITY_MISMATCH');
      }
      return api(artifactRoute || '/page-view', { ...event, tabId, url: current.url }, true, profile);
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
