(() => {
  'use strict';
  if (globalThis.__CIP_CONTENT__) return;
  const documentKey = crypto.randomUUID(), commands = new Map();
  let monitor = null, disposed = false, navigationEpoch = 0;
  // A freshly restored Chrome page may fire benign navigate/currententrychange
  // while React mounts the editor without departing the same Conversation.
  // Track real route departures separately: A -> B -> A must still revoke
  // an Ensure, even if the final URL again looks correct.
  const conversationRoute = () => /^\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9-]+)(?:\/|$)/.exec(location.pathname)?.[1] ?? null;
  let lastRoute = conversationRoute(), routeEpoch = 0;
  // Non-conversation pages all have a null Conversation ID. Track pathname
  // departures independently so '/' -> '/search' -> '/' cannot be mistaken
  // for a harmless same-page navigation event during a first open.
  let lastPathname = location.pathname, pathEpoch = 0;
  // Proof obtained after the background RPC caller timed out stays inside
  // this exact document. It is never another Send authorization.
  const lateSendReceipts = new Map();
  let pendingReceiptTurn = null, pendingReceiptPathEpoch = null, sendAttempt = null;
  const cancelled = new Set();
  const moved = () => {
    navigationEpoch++;
    const currentRoute = conversationRoute();
    if (currentRoute !== lastRoute) { routeEpoch++; lastRoute = currentRoute; globalThis.CIP_DOM?.invalidateModelMatch?.(); }
    const currentPathname = location.pathname;
    if (currentPathname !== lastPathname) { pathEpoch++; lastPathname = currentPathname; globalThis.CIP_DOM?.invalidateModelMatch?.(); }
    // A -> B -> A must revoke observation even if it happens between polls.
    if (monitor && conversation() !== monitor.conversationId) revokeObservation(monitor);
  };
  globalThis.navigation?.addEventListener('navigate', moved);
  globalThis.navigation?.addEventListener('currententrychange', moved);
  addEventListener('popstate', moved); addEventListener('hashchange', moved);
  globalThis.__CIP_CONTENT__ = { documentKey };
  const D = globalThis.CIP_DOM;
  const conversation = conversationRoute;
  const pageIdentity = () => {
    if (monitor && conversation() !== monitor.conversationId) revokeObservation(monitor);
    return { engine: 'cos-native-alpha4.3', protocol: 9, documentKey, url: location.href,
      observationRevoked: monitor?.routeRevoked === true };
  };
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  function check(expected) {
    if (disposed || location.hostname !== 'chatgpt.com') fail('PAGE_GONE');
    if (expected.documentKey !== documentKey) fail('DOCUMENT_CHANGED');
    if (expected.kind !== 'catalog' && (expected.payload?.conversationId ?? null) !== conversation()) fail('WRONG_CONVERSATION');
    if (expected.kind === 'catalog' && conversation() !== null) fail('WRONG_CONVERSATION');
  }
  const rpc = value => chrome.runtime.sendMessage(value).then(r => { if (!r?.ok) fail(r?.error ?? 'BRIDGE_UNAVAILABLE'); return r.value; });
  function revokeObservation(m) {
    m.routeRevoked = true;
    void m.artifacts?.dispose();
    if (m.pending) m.pending.length = 0;
  }
  function checkObservation(m) {
    if (!m || monitor !== m || disposed || location.hostname !== 'chatgpt.com' || m.documentKey !== documentKey)
      fail('PAGE_IDENTITY_CHANGED');
    if (conversation() !== m.conversationId) revokeObservation(m);
    if (m.routeRevoked) fail('PAGE_IDENTITY_CHANGED');
  }
  async function run(c) {
    const controlCommand = ['stop', 'approval'].includes(c.kind), controlMonitor = controlCommand ? monitor : null;
    const epoch = navigationEpoch, initialRouteEpoch = routeEpoch,
      initialPathEpoch = pathEpoch;
    // CoS submittedSendLifetime: a fresh Send acquires its first concrete route;
    // a later departure revokes it. A route is not proof of message delivery.
    // The Send engine still requires the new native user ID and authored body.
    let dispatched=false,elected=c.payload?.conversationId??null,revoked=false,linkRequested=false;
    const committedRoute=()=>{
      if(!dispatched||revoked)return;
      const route=conversation();
      if(elected && route!==elected){revoked=true;return;}
      if(!elected&&route)elected=route;
      // The URL is durable conversation identity, NOT a user message receipt.
      // Only the first route created by this already-authorized Send is bound.
      if(route&&!c.payload?.conversationId&&!linkRequested){
        linkRequested=true;
        void rpc({type:'bind-conversation',id:c.id,lease:c.lease,
          documentKey,url:location.href}).catch(()=>{linkRequested=false;});
      }
    };
    if (c.kind === 'send') {
      // Observe commits, not only DOM changes; A -> B -> A must stay revoked.
      globalThis.navigation?.addEventListener('currententrychange', committedRoute);
      addEventListener('popstate', committedRoute); addEventListener('hashchange', committedRoute);
    }
    const guard = (afterDispatch = false) => {
      if (afterDispatch && c.kind === 'send') {
        if (disposed || location.hostname !== 'chatgpt.com' || c.documentKey !== documentKey) fail('PAGE_GONE');
        dispatched = true; committedRoute();
        sendAttempt={commandId:c.id,turnId:c.payload.turnId,lease:c.lease,documentKey};
        if (revoked) fail('SEND_LIFETIME_REVOKED');
      } else {
        check(c);
        // A native same-page navigation event does not mean the conversation
        // changed. Preparation/first-Send may proceed only while the actual
        // pathname and conversation have NEVER departed (A -> B -> A also
        // fails). After the one-shot native dispatch, Send has its separate
        // elected-Conversation lifetime fence above. Stop remains strict.
        const preparing = ['open','configure','catalog','ensure'].includes(c.kind)
          || (c.kind === 'send' && !dispatched);
        if (controlCommand) {
          checkObservation(controlMonitor);
          if (c.payload?.documentKey !== documentKey) fail('DOCUMENT_CHANGED');
          if (typeof c.payload?.observationLease !== 'string' ||
              c.payload.observationLease !== controlMonitor.observationLease) fail('OBSERVATION_LEASE_MISMATCH');
        } else if (preparing
          ? (routeEpoch !== initialRouteEpoch || pathEpoch !== initialPathEpoch)
          : navigationEpoch !== epoch) fail('NAVIGATION_CHANGED');
      }
      if (cancelled.has(c.id)) fail('COMMAND_CANCELLED');
      if (!afterDispatch && c.deadline && Date.now() >= c.deadline) fail('COMMAND_DEADLINE_EXCEEDED');
    };
    try {
      guard();
      if (commands.has(c.id)) fail('COMMAND_ALREADY_ATTEMPTED');
      if (commands.size > 500) fail('DOCUMENT_COMMAND_LIMIT');
      commands.set(c.id, true);
      switch (c.kind) {
        case 'catalog': return { catalog: await D.catalog(guard) };
        case 'open': {
          await D.preparePage(guard);
          return { url: location.href, tabId: c.tabId };
        }
        // Retain only for older in-flight control commands during upgrades.
        case 'configure': return { config: await D.configure(c.payload.config, guard, c.deadline), url: location.href, tabId: c.tabId };
        case 'ensure': {
          await D.preparePage(guard);await D.refreshTranscript();guard();
          const nativeMessageId=D.messages().filter(row=>row.role==='user').at(-1)?.id??null;
          // This may be a later webpage-origin turn. Continuing a bound
          // Conversation must not depend on the old native user ID.
          return {url:location.href,tabId:c.tabId,nativeMessageId};
        }
        case 'send': {
          try {
            const result=await D.send(c, async () => { guard(); return rpc({ type: 'authorize', id: c.id, lease: c.lease, documentKey }); }, guard, request => rpc({...request,documentKey}));
            if(result?.receipt===true && typeof result.nativeMessageId==='string' &&
                conversation() && !revoked){
              // First Send may change '/' into '/c/<id>' within this document.
              // Keep its confirmed model on the new route for the next turn.
              D.rememberModelMatch?.(c.payload.config);
              lateSendReceipts.set(c.payload.turnId,{
                nativeMessageId:result.nativeMessageId,conversationId:conversation(),
                documentKey,pathEpoch
              });
            }
            return result;
          } catch(e) {
            if(e.code==='RECEIPT_UNCONFIRMED' && e.bindingUrl && !revoked &&
                conversation() && e.bindingUrl===location.href){
              pendingReceiptTurn=c.payload.turnId;
              pendingReceiptPathEpoch=pathEpoch;
            }
            throw e;
          }
        }
        case 'stop': {
          const result = await D.stop({ ...c.payload, guard });
          guard();
          await observe();
          return result;
        }
        case 'approval': {
          const result = await D.answerApproval({ key: c.payload.key, choice: c.payload.choice,
            conversationId: c.payload.conversationId, guard,
            authorizeClick: () => rpc({type:'approval-gate',id:c.id,lease:c.lease,documentKey}) });
          guard();
          await observe();
          return result;
        }
        default: fail('UNKNOWN_COMMAND');
      }
    } finally {
      globalThis.navigation?.removeEventListener('currententrychange', committedRoute);
      removeEventListener('popstate', committedRoute); removeEventListener('hashchange', committedRoute);
    }
  }
  const MAX_FRAME_BYTES = 384 * 1024, REFRESH_MS = 15000;
  const encode = value => new TextEncoder().encode(value).length;
  const fingerprint = view => JSON.stringify(view, (key, value) => key === 'observedAt' ? undefined : value);
  const emptyControls = () => ({ observedAt: Date.now(), state: 'abnormal', readable: false,
    controls: { stop: { visible: false, enabled: false }, send: { visible: false, enabled: false }, voice: { visible: false, enabled: false } } });
  function readControls() {
    let page, error = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        page = globalThis.CIP_PAGE_CONTROLS.read();
        if (!page || !['running', 'standby', 'abnormal'].includes(page.state) || !page.controls)
          throw new Error('invalid controls');
        error = false;
        if (page.state !== 'abnormal') break;
      } catch { page = emptyControls(); error = true; }
    }
    return { page, issues: error ? [{ code: 'CONTROLS_READ_FAILED' }] : [] };
  }
  function readSource(m) {
    try {
      const source = globalThis.CIP_PAGE_CONTENT.read();
      if (!source || typeof source !== 'object' || Array.isArray(source))
        throw new Error('invalid source');
      // Never forward another conversation's body under the bound identity.
      if (source.conversationId !== m.conversationId)
        return { conversationId: m.conversationId, items: [], approvals: [], closedApprovals: [],
          issues: [{ code: 'CONTENT_CONVERSATION_UNCONFIRMED' }] };
      const view = { ...source }, issues = [];
      for (const key of ['items', 'approvals', 'closedApprovals', 'issues']) {
        if (source[key] === undefined && key === 'closedApprovals') view[key] = [];
        else if (Array.isArray(source[key])) view[key] = [...source[key]];
        else { view[key] = []; issues.push({ code: 'CONTENT_COLLECTION_INVALID', collection: key }); }
      }
      view.issues.push(...issues);
      return view;
    } catch {
      return { conversationId: m.conversationId, items: [], approvals: [], closedApprovals: [],
        issues: [{ code: 'CONTENT_READ_FAILED' }] };
    }
  }
  const formal = item => item?.role === 'assistant' && item.lane === 'output' && item.kind === 'message';
  function supplement(m, source, refresh) {
    const items = source.items.filter(formal);
    const selected = item => ({...item,prose:m.prose.get(item.id) ??
      {status:globalThis.CIP_PUBLIC_MESSAGES ? 'pending' : 'unavailable',
        ...(!globalThis.CIP_PUBLIC_MESSAGES ? {code:'PUBLIC_MESSAGE_SUPPLEMENT_UNAVAILABLE'} : {})}});
    // A successful asynchronous read is still captured if its DOM node was
    // collapsed/virtualized meanwhile. Never overwrite a newer DOM snapshot.
    const current = new Set(source.items.map(item=>item.id));
    for (const item of m.proseArrivals.splice(0)) if (!current.has(item.id)) source.items.push(item);
    source.items = source.items.map(item=>formal(item) ? selected(item) : item);
    if (!refresh || m.proseFlight || !items.length || !globalThis.CIP_PUBLIC_MESSAGES) return;
    const work = (async()=>{
      let result;
      try {
        result=await globalThis.CIP_PUBLIC_MESSAGES.read(items,()=>checkObservation(m));
        if(!Array.isArray(result?.messages)||!Array.isArray(result?.issues))throw Error('RAW_RESULT_INVALID');
      }
      catch { result={messages:[],issues:[{code:'PUBLIC_MESSAGE_SUPPLEMENT_UNAVAILABLE'}]}; }
      try { checkObservation(m); } catch { return; }
      const messages = new Map((result.messages??[]).map(value=>[value.nativeMessageId,value]));
      const issues = Array.isArray(result.issues) ? result.issues : [];
      for (const item of items) {
        const value=messages.get(item.nativeMessageId);
        const code=issues.find(issue=>issue.nativeMessageId===item.nativeMessageId || issue.id===item.id ||
          !issue.nativeMessageId&&!issue.id)?.code ?? 'PUBLIC_MESSAGE_RAW_UNAVAILABLE';
        const prose=value ? {status:'available',...value} : {status:'unavailable',code};
        m.prose.set(item.id,prose);
        m.proseArrivals.push({...item,prose});
      }
      // Re-capture controls and other sources, without recursively starting a
      // second raw request. Normal ticks refresh the supplement independently.
      void observe(true);
    })();
    m.proseFlight=work;
    void work.finally(()=>{if(m.proseFlight===work)m.proseFlight=null;});
  }
  function envelope(m, view, sequence, readFinal = true) {
    return { type: 'page-view', event: { sessionId: m.sessionId, observationLease: m.observationLease,
      documentKey, tabId: m.tabId, url: location.href, sequence, readFinal, view } };
  }
  // The selected recovery turn is a property of the whole page capture, not of
  // one transport frame. Copy the proven boundary into every frame so a split
  // before the anchor or answer cannot be mistaken for a disappearing anchor.
  function recoveryScope(m, view) {
    const recovery=m.recovery;
    if(!recovery||typeof recovery.userMessageId!=='string')return null;
    const users=(Array.isArray(view.items)?view.items:[]).filter(item=>item?.role==='user');
    const index=users.findIndex(item=>item.nativeMessageId===recovery.userMessageId ||
      item.userMessageId===recovery.userMessageId || item.id===recovery.userMessageId);
    if(index<0)return null;
    const next=users[index+1];
    const nextUserMessageId=typeof next?.nativeMessageId==='string'&&next.nativeMessageId
      ? next.nativeMessageId : null;
    if(!nextUserMessageId&&view.transcriptComplete!==true)return null;
    return {userMessageId:recovery.userMessageId,anchorPresent:true,
      nextUserMessageId,transcriptComplete:view.transcriptComplete===true};
  }
  function framesOf(m, view) {
    const collections = ['items', 'approvals', 'closedApprovals', 'issues'];
    const scope = recoveryScope(m, view);
    let base = { ...view, ...(scope?{recoveryScope:scope}:{}), items: [], approvals: [], closedApprovals: [], issues: [] };
    // Reserve the maximum sequence width so crossing 9 -> 10 cannot overflow.
    const sizeOfBase = value => encode(JSON.stringify(envelope(m, value, Number.MAX_SAFE_INTEGER)));
    if (sizeOfBase(base) > MAX_FRAME_BYTES) {
      base = { conversationId: m.conversationId, page: view.page, ...(scope?{recoveryScope:scope}:{}),
        items: [], approvals: [], closedApprovals: [],
        issues: [{ code: 'PAGE_VIEW_METADATA_TOO_LARGE' }] };
    }
    if (sizeOfBase(base) > MAX_FRAME_BYTES) {
      base.page = emptyControls();
      base.issues.push({ code: 'CONTROLS_METADATA_TOO_LARGE' });
    }
    const empty = () => ({ ...base, items: [], approvals: [], closedApprovals: [], issues: [...base.issues] });
    let current = empty(), bytes = sizeOfBase(current), count = 0;
    const frames = [];
    const flush = () => {
      // Snapshot every payload. A later source read or changed epoch must never
      // mutate the body attached to an already allocated sequence.
      const message = JSON.parse(JSON.stringify(envelope(m, current, ++m.sequence)));
      frames.push(message); current = empty(); bytes = sizeOfBase(current); count = 0;
    };
    const append = (collection, value, index, replacement = false) => {
      let json;
      try { json = JSON.stringify(value); } catch {}
      const length = json === undefined ? null : encode(json);
      const fresh = empty();
      if (length === null || sizeOfBase(fresh) + length + (fresh[collection].length ? 1 : 0) > MAX_FRAME_BYTES) {
        if (replacement) return;
        if (collection === 'items' && formal(value) && value.prose?.status === 'available' && length !== null) {
          const dom = {...value,prose:{status:'unavailable',code:'PUBLIC_MESSAGE_RAW_TOO_LARGE'}};
          if (sizeOfBase(fresh) + encode(JSON.stringify(dom)) <= MAX_FRAME_BYTES) {
            append(collection,dom,index,true);
            append('issues',{code:'PAGE_ENTRY_TOO_LARGE',collection:'items.prose',index,
              id:typeof value.id==='string'&&encode(value.id)<=1024?value.id:null,bytes:length},index,true);
            return; // Explicit raw refusal, not truncation or a stuck pending DOM source.
          }
        }
        const id = value?.id ?? value?.key;
        append('issues', { code: length === null ? 'PAGE_ENTRY_UNSERIALIZABLE' : 'PAGE_ENTRY_TOO_LARGE',
          collection, index, id: typeof id === 'string' && encode(id) <= 1024 ? id : null, bytes: length }, index, true);
        return;
      }
      const addition = length + (current[collection].length ? 1 : 0);
      if (bytes + addition > MAX_FRAME_BYTES) flush();
      current[collection].push(JSON.parse(json));
      bytes += length + (current[collection].length > 1 ? 1 : 0); count++;
    };
    for (const collection of collections)
      for (const [index, value] of view[collection].entries()) append(collection, value, index);
    if (count || !frames.length) flush();
    // Only the LAST frame of one page read is the closing evidence of that
    // read. A read split by the transport must not end the host turn before
    // its remaining content has been received and projected: the server waits
    // for the final frame before it treats a standby page as "finished".
    for (let i = 0; i < frames.length; i++) frames[i].event.readFinal = i === frames.length - 1;
    return frames;
  }
  function drain(m) {
    if (m.deliveryFlight) return m.deliveryFlight;
    const work = (async () => {
      try {
        while (m.pending.length) {
          checkObservation(m);
          const message = m.pending[0], stored = await rpc(message);
          checkObservation(m);
          // accepted is local persistence only, not a Paseo display/host ACK.
          if (stored?.accepted !== true) fail('PAGE_VIEW_PERSISTENCE_UNCONFIRMED');
          m.pending.shift(); m.lastError = null;
        }
      } catch (error) {
        m.lastError = error?.code ?? 'PAGE_VIEW_DELIVERY_FAILED';
        // Preserve the exact first pending frame and its sequence for retry.
        // No server/native turn outcome ends this conversation observer.
      }
    })();
    m.deliveryFlight = work;
    void work.finally(() => { if (m.deliveryFlight === work) m.deliveryFlight = null; });
    return work;
  }
  async function observe(rawReady = false) {
    const m = monitor;
    if (!m) return;
    try { checkObservation(m); } catch { return; }
    // Both APIs are read on every tick in every button state, even while an
    // earlier page-view RPC is pending or retrying. Neither lane gates the other.
    const source = readSource(m), controls = readControls();
    supplement(m,source,!rawReady);
    const view = { ...source, page: controls.page, issues: [...source.issues, ...controls.issues],
      ...(sendAttempt?{sendAttempt:{...sendAttempt}}:{}) };
    m.artifacts?.observe(source.items);
    try {
      checkObservation(m);
      const semantic = fingerprint(view), now = Date.now();
      if (semantic !== m.lastQueuedFingerprint || !m.pending.length && now - m.lastQueuedAt >= REFRESH_MS) {
        m.pending.push(...framesOf(m, view));
        m.lastQueuedFingerprint = semantic; m.lastQueuedAt = now;
      }
      void drain(m);
    } catch (error) { m.lastError = error?.code ?? 'PAGE_VIEW_CAPTURE_FAILED'; }
  }
  const timer = setInterval(() => { return observe(); }, 750);
  addEventListener('pagehide', () => { disposed = true; if (monitor) revokeObservation(monitor); monitor = null; clearInterval(timer); }, { once: true });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'cancel-command') { cancelled.add(message.id); respond({ ok: true }); return; }
    if (message.type === 'archive-idle') {
      // This is a read-only probe. Never close a page with a draft, generation,
      // pending approval or active turn observer, even if Paseo says it is idle.
      let idle = false;
      try {
        const controls = globalThis.CIP_COS_CONTROLS, box = controls?.composer?.();
        idle = !disposed && !!box && D.authored(box) === '' &&
          controls.generating() === false && controls.approvalWaiting() === false && D.approvalPending?.() !== true &&
          (!monitor || !monitor.routeRevoked) && readControls().page.state === 'standby';
      } catch { /* Unknown native page state is not proof of idleness. */ }
      respond({ ok: true, value: { idle, documentKey, url: location.href } });
      return;
    }
    if (message.type === 'page-ready') { respond({ ok: true, value: { composer: !!globalThis.CIP_COS_CONTROLS.composer(), documentKey } }); return; }
    if (message.type === 'catalog-idle') { const box = globalThis.CIP_COS_CONTROLS.composer(); respond({ ok: true, value: { idle: !!box && D.authored(box) === '' && D.messages().length === 0, documentKey } }); return; }
    if (message.type === 'identity' && disposed) { respond({ ok: false, error: 'PAGE_GONE' }); return; }
    if (message.type === 'identity') {
      // URL/document identity is always available independently of transcript,
      // body, approval or button-read failures.
      respond({ ok: true, value: pageIdentity() }); return;
    }
    if (message.type === 'pending-receipt') {
      const s=message.session;
      if(s.documentKey!==documentKey||!s.receiptPending||s.conversationId!==conversation()) {
        respond({ok:false,error:'PAGE_IDENTITY_CHANGED'});return;
      }
      const late=lateSendReceipts.get(s.turnId);
      if(late){
        if(late.documentKey!==documentKey || late.conversationId!==conversation() ||
           late.pathEpoch!==pathEpoch){
          respond({ok:false,error:'PAGE_IDENTITY_CHANGED'});return true;
        }
        respond({ok:true,value:{available:true,nativeMessageId:late.nativeMessageId}});
        return true;
      }
      if(pendingReceiptTurn!==s.turnId || pendingReceiptPathEpoch!==pathEpoch){
        respond({ok:false,error:'TRANSCRIPT_UNCONFIRMED'});return true;
      }
      const receiptEpoch = pathEpoch;
      D.probePendingReceipt(s.turnId).then(value => {
        if (disposed || receiptEpoch !== pathEpoch || s.conversationId !== conversation())
          return respond({ ok: false, error: 'PAGE_IDENTITY_CHANGED' });
        respond({ ok: true, value });
      }, e=>respond({ok:false,error:e.code??'TRANSCRIPT_UNCONFIRMED'}));
      return true;
    }
    if (message.type === 'recovery-candidates') {
      const cid = conversation();
      if (!cid) { respond({ ok: false, error: 'WRONG_CONVERSATION' }); return; }
      const source = readSource({ conversationId: cid });
      if (source.conversationId !== cid) { respond({ ok: false, error: 'WRONG_CONVERSATION' }); return; }
      const users = source.items.filter(item => item?.role === 'user');
      const candidates = users.map((item, index) => {
        const next = users[index + 1] ?? null;
        const nextUserMessageId = typeof next?.nativeMessageId === 'string' && next.nativeMessageId
          ? next.nativeMessageId : null;
        return {
          userMessageId: typeof item.nativeMessageId === 'string' && item.nativeMessageId
            ? item.nativeMessageId : null,
          text: typeof item.text === 'string' ? item.text.slice(0, 500) : '',
          recoverable: typeof item.nativeMessageId === 'string' && item.nativeMessageId.length > 0,
          // A next user item without a stable native ID is not a usable server
          // boundary. Only page-end proof can make that last turn selectable.
          boundaryKnown: Boolean(nextUserMessageId) || source.transcriptComplete === true,
          transcriptComplete: source.transcriptComplete === true,
          ...(nextUserMessageId ? { nextUserMessageId } : {}),
        };
      });
      respond({ ok: true, value: { conversationId: cid, documentKey, url: location.href,
        transcriptComplete: source.transcriptComplete === true, candidates } });
      return;
    }
    if (message.type === 'monitor') {
      const s = message.session;
      if (disposed || !s || s.documentKey !== documentKey || s.conversationId !== conversation() ||
          typeof s.observationLease !== 'string' || !s.observationLease ||
          typeof s.sessionId !== 'string' || !s.sessionId || !Number.isInteger(s.tabId) || s.tabId < 0) {
        respond({ ok: false, error: 'PAGE_IDENTITY_CHANGED' }); return;
      }
      if (monitor?.observationLease === s.observationLease) {
        if (monitor.routeRevoked || monitor.sessionId !== s.sessionId || monitor.tabId !== s.tabId ||
            monitor.conversationId !== s.conversationId) {
          respond({ ok: false, error: 'PAGE_IDENTITY_CHANGED' }); return;
        }
        // The same document can enter/leave recovery without a new lease.
        // Refresh only boundary metadata; pending frames keep their original
        // capture-wide scope.
        monitor.recovery = s.recovery;
        monitor.runId = s.runId;
        monitor.active = s.active;
      } else {
        if (monitor) revokeObservation(monitor);
        monitor = { ...s, routeRevoked: false, sequence: 0, pending: [], deliveryFlight: null,
          lastQueuedFingerprint: null, lastQueuedAt: 0, prose:new Map(), proseArrivals:[], proseFlight:null };
        const owner=monitor;
        if(globalThis.CIP_ARTIFACT_TRANSFER)owner.artifacts=globalThis.CIP_ARTIFACT_TRANSFER.create({
          rpc,guard:()=>checkObservation(owner),binding:()=>({sessionId:owner.sessionId,
            observationLease:owner.observationLease,tabId:owner.tabId,documentKey,url:location.href,
            conversationId:owner.conversationId})});
      }
      void observe();
      respond({ ok: true, value: { observing: true } }); return;
    }
    if (message.type === 'command') {
      run(message.command).then(value => respond({ ok: true, value }), e => respond({
        ok:false,error:e.code??'ADAPTER_UNSUPPORTED',
        notSent:e.notSent===true,notApplied:e.notApplied===true,diagnostic:e.diagnostic,
        ...(e.bindingUrl?{bindingUrl:e.bindingUrl}:{})
      }));return true;
    }
    respond({ ok: false, error: 'UNKNOWN_MESSAGE' });
  });
})();
