(() => {
  'use strict';
  if (globalThis.__CIP_CONTENT__) return;
  const documentKey = crypto.randomUUID(), commands = new Map();
  let monitor = null, disposed = false, navigationEpoch = 0, passiveEnabled = false;
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
  let pendingReceiptTurn = null, pendingReceiptPathEpoch = null;
  const cancelled = new Set();
  const moved = () => {
    navigationEpoch++;
    const currentRoute = conversationRoute();
    if (currentRoute !== lastRoute) { routeEpoch++; lastRoute = currentRoute; }
    const currentPathname = location.pathname;
    if (currentPathname !== lastPathname) { pathEpoch++; lastPathname = currentPathname; }
    // A -> B -> A must revoke observation even if it happens between polls.
    if (monitor && conversation() !== monitor.conversationId) monitor.routeRevoked = true;
  };
  globalThis.navigation?.addEventListener('navigate', moved);
  globalThis.navigation?.addEventListener('currententrychange', moved);
  addEventListener('popstate', moved); addEventListener('hashchange', moved);
  globalThis.__CIP_CONTENT__ = { documentKey };
  const D = globalThis.CIP_DOM;
  const conversation = () => D.conversationId();
  const pageIdentity = () => ({ engine: 'cos-native-alpha4.3', documentKey, url: location.href, nativeMessageId: D.messages().filter(x => x.role === 'user').at(-1)?.id ?? null, observationActive: Boolean(monitor), observationError: monitor?.lastError ?? null });
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  function check(expected) {
    if (disposed || location.hostname !== 'chatgpt.com') fail('PAGE_GONE');
    if (expected.documentKey !== documentKey) fail('DOCUMENT_CHANGED');
    if (expected.kind !== 'catalog' && (expected.payload?.conversationId ?? null) !== conversation()) fail('WRONG_CONVERSATION');
    if (expected.kind === 'catalog' && conversation() !== null) fail('WRONG_CONVERSATION');
  }
  const rpc = value => chrome.runtime.sendMessage(value).then(r => { if (!r?.ok) fail(r?.error ?? 'BRIDGE_UNAVAILABLE'); return r.value; });
  async function run(c) {
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
        if (preparing
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
        case 'open': case 'configure': return { config: await D.configure(c.payload.config, guard, c.deadline), url: location.href, tabId: c.tabId };
        case 'ensure': {
          const config=await D.configure(c.payload.config,guard,c.deadline);await D.refreshTranscript();guard();
          const nativeMessageId=D.messages().filter(row=>row.role==='user').at(-1)?.id??null;
          // This may be a later webpage-origin turn. Continuing a bound
          // Conversation must not depend on the old native user ID.
          return {config,url:location.href,tabId:c.tabId,nativeMessageId};
        }
        case 'send': {
          try {
            const result=await D.send(c, async () => { guard(); return rpc({ type: 'authorize', id: c.id, lease: c.lease, documentKey }); }, guard, request => rpc({...request,documentKey}));
            if(result?.receipt===true && typeof result.nativeMessageId==='string' &&
                conversation() && !revoked){
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
        case 'stop': { const result = await D.stop(c.payload.nativeMessageId); if (monitor?.nativeMessageId === c.payload.nativeMessageId) monitor = null; return result; }
        default: fail('UNKNOWN_COMMAND');
      }
    } finally {
      globalThis.navigation?.removeEventListener('currententrychange', committedRoute);
      removeEventListener('popstate', committedRoute); removeEventListener('hashchange', committedRoute);
    }
  }
  async function observe() {
    const m = monitor; if (!m || m.busy) return; m.busy = true;
    const event = extra => ({ ...extra, sessionId: m.sessionId, turnId: m.turnId, lease: m.lease, nativeMessageId: m.nativeMessageId,
      tabId: m.tabId, documentKey, url: location.href });
    try {
      if (m.routeRevoked || m.documentKey !== documentKey || conversation() !== m.conversationId) fail('PAGE_IDENTITY_CHANGED');
      await D.refreshTranscript();
      if (monitor !== m) return;
      const value = D.state(m.nativeMessageId);
      m.unavailableSince = null;
      if (value.error) fail(value.error);
      // Separate native Paseo reasoning/tool-call timeline from generic activity.
      // Only the same verified native user anchor may own these events.
      if(value.timeline){
        m.publicTimeline??=new Map();
        const items=[
          ...value.timeline.reasoning.map(x=>({type:'reasoning',id:x.id,text:x.text})),
          ...value.timeline.calls.map(x=>({type:'tool_call',...x}))
        ];
        for(const item of items){
          const key=item.type+':'+(item.callId??item.id);
          const fingerprint=JSON.stringify(item);
          if(m.publicTimeline.get(key)===fingerprint)continue;
          const ack=await rpc({type:'observation',event:event({kind:'native_timeline',item})});
          if(ack.active===false){if(monitor===m)monitor=null;return;}
          m.publicTimeline.set(key,fingerprint);
        }
      }
      // CoS public native turn state. A page with an exact user receipt may
      // legitimately be thinking, searching, calling tools or waiting for human
      // approval while it has NO final assistant text yet.
      const activity=value.waiting
        ? {phase:'approval',nativeStatus:'in_progress',steps:value.activity?.steps??[]}
        : value.activity;
      if(activity && Array.isArray(activity.steps)) {
        const view={phase:activity.phase,nativeStatus:activity.nativeStatus,steps:activity.steps};
        const fingerprint=JSON.stringify(view);
        if(m.activityFingerprint!==fingerprint) {
          const receipt=await rpc({type:'observation',event:event({kind:'activity',activity:view})});
          if(receipt.active===false){if(monitor===m)monitor=null;return;}
          m.activityFingerprint=fingerprint;m.lastError=null;
        }
      }
      if (value.waiting) {
        m.quietSince = null;
        if (!m.waiting) { await rpc({ type: 'observation', event: event({ kind: 'waiting' }) }); m.waiting = true; m.lastError = null; }
        return;
      }
      m.waiting = false;
      if (value.answer && (m.lastId !== value.answer.id || m.lastText !== value.answer.text)) {
        if (value.answer.text.length > 256000) fail('ANSWER_TOO_LARGE');
        const receipt = await rpc({ type: 'observation', event: event({ kind: 'snapshot', messageId: value.answer.id, text: value.answer.text }) });
        m.lastError = null;
        if (receipt.active === false) { if (monitor === m) monitor = null; return; }
        m.lastId = value.answer.id; m.lastText = value.answer.text; m.quietSince = null;
      }
      const imageKey = image => `${image.messageId}:${image.assetId}`;
      m.images ??= new Set(); m.imageWaits ??= new Map();
      if ((value.images?.length ?? 0) > 8) fail('IMAGE_COUNT_LIMIT');
      for (const image of value.images ?? []) {
        const key = imageKey(image);
        if (!image.completed || m.images.has(key)) continue;
        m.imageWaits.set(key, m.imageWaits.get(key) ?? Date.now());
        const guard = () => { if(monitor!==m || m.documentKey!==documentKey || conversation()!==m.conversationId)fail('PAGE_IDENTITY_CHANGED'); };
        const preview = await globalThis.CIP_MEDIA.capture(image, guard); guard();
        if(preview.previewStatus==='unavailable' && ['not_rendered','not_loaded'].includes(preview.previewError) && Date.now()-m.imageWaits.get(key)<15000)return;
        const receipt = await rpc({type:'observation',event:event({kind:'image',...image,...preview})});
        if(receipt.active===false){if(monitor===m)monitor=null;return;}
        m.images.add(key);m.quietSince=null;
      }
      const imageFinal = !!value.imageFinalId && value.images.length>0 && value.images.every(x=>x.completed&&m.images.has(imageKey(x)));
      const mediaPending = (value.images??[]).some(x=>!x.completed||!m.images.has(imageKey(x)));
      // A verified native terminal outranks a stale Stop button. The final
      // remains tied to this exact user ID and completed native turn.
      const nativeTerminal=value.activity?.nativeStatus==='complete' && (value.answer?.final||imageFinal);
      if ((value.busy && !nativeTerminal) || mediaPending || !(value.answer?.final || imageFinal)) {
        m.quietSince = null;
        if (!value.busy && value.answer && !m.unconfirmedNotice) {
          await rpc({ type: 'observation', event: event({ kind: 'waiting', reason: 'final-unconfirmed' }) }); m.unconfirmedNotice = true;
        }
        return;
      }
      m.quietSince ??= performance.now();
      if (performance.now() - m.quietSince >= (nativeTerminal ? 1000 : 4000)) {
        await rpc({ type: 'observation', event: event({ kind: 'completed', finalConfirmed: true,
          messageId: imageFinal ? value.imageFinalId : value.answer.id,
          ...(imageFinal ? {finalKind:'image',imageKeys:value.images.map(imageKey)} : {}) }) });
        if (monitor === m) monitor = null;
      }
    } catch (e) {
      m.lastError = typeof e.code === 'string' && /^[A-Z_]{1,80}$/.test(e.code) ? e.code : 'OBSERVATION_UNAVAILABLE';
      if (['TURN_INACTIVE', 'SESSION_UNKNOWN'].includes(e.code)) { if (monitor === m) monitor = null; return; }
      if(e.code==='TURN_CHANGED' && monitor===m && !m.routeRevoked){
        // User sent another message directly in the same ChatGPT page.
        // Settle the old turn only if its own visible native final is proven.
        try{
          const prior=D.priorFinal(m.nativeMessageId);
          if(prior){
            await rpc({type:'observation',event:event({kind:'snapshot',messageId:prior.messageId,text:prior.text})});
            await rpc({type:'observation',event:event({kind:'completed',finalConfirmed:true,messageId:prior.messageId})});
            if(monitor===m)monitor=null;
            return;
          }
        }catch{}
      }
      if (['TRANSCRIPT_PENDING','TRANSCRIPT_UNCONFIRMED'].includes(e.code)) {
        // React can temporarily unmount the user row during a long MCP tool
        // call. Retain the linked conversation and its confirmed turn.
        // Report waiting, never fabricate a final answer or repeat Send.
        m.quietSince=null;m.unavailableSince??=Date.now();
        if(!m.unavailableNotice){
          try{
            await rpc({type:'observation',event:event({kind:'waiting',reason:'transcript-unavailable'})});
            m.unavailableNotice=true;
          }catch{}
        }
        return;
      }
      if (['TURN_CHANGED', 'PAGE_IDENTITY_CHANGED', 'ANSWER_TOO_LARGE', 'NATIVE_ERROR', 'TURN_OUTPUT_LIMIT', 'TRANSCRIPT_UNCONFIRMED', 'TRANSCRIPT_PENDING', 'IMAGE_COUNT_LIMIT', 'IMAGE_IDENTITY_UNPROVEN', 'IMAGE_CAPTURE_FAILED', 'IMAGE_DATA_INVALID', 'IMAGE_DIMENSIONS_INVALID', 'MEDIA_STORAGE_FULL', 'MEDIA_INTEGRITY_FAILED', 'IMAGE_STORAGE_FAILED', 'IMAGE_NOT_COMPLETE', 'IMAGE_STATUS_INVALID', 'MEDIA_PATH_UNSAFE'].includes(e.code)) {
        try { await rpc({ type: 'observation', event: event({ kind: 'failed', error: e.code }) }); if (monitor === m) monitor = null; } catch {}
      }
      // Transport errors retry observation only, never the user message or native Send.
    } finally { m.busy = false; }
  }
  // A user can start the next native ChatGPT turn while Paseo is idle.
  // Send only a content-free wake hint; the worker performs all bound-session
  // checks before importing anything. Keep idle probes throttled per page.
  let idleNativeUser=null,idleProbeBusy=false,idleProbeAt=0;
  async function probeIdle(){
    if(disposed||monitor||!passiveEnabled||idleProbeBusy||!conversation())return;
    idleProbeBusy=true;
    try{
      await D.refreshTranscript();
      if(disposed||monitor)return;
      const last=D.messages().filter(m=>m.role==='user').at(-1)?.id??null;
      if(last&&idleNativeUser&&last!==idleNativeUser)
        void chrome.runtime.sendMessage({type:'idle-notice'}).catch(()=>{});
      if(last)idleNativeUser=last;
    }catch{}finally{idleProbeBusy=false;}
  }
  const timer = setInterval(()=>{
    const work=observe();
    if(!monitor && passiveEnabled && Date.now()-idleProbeAt>=5000){idleProbeAt=Date.now();void probeIdle();}
    return work;
  },750);
  addEventListener('pagehide', () => { disposed = true; monitor = null; clearInterval(timer); }, { once: true });
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
          controls.generating() === false && controls.approvalWaiting() === false &&
          monitor === null;
      } catch { /* Unknown native page state is not proof of idleness. */ }
      respond({ ok: true, value: { idle, documentKey, url: location.href } });
      return;
    }
    if (message.type === 'catalog-idle') { const box = globalThis.CIP_COS_CONTROLS.composer(); respond({ ok: true, value: { idle: !!box && D.authored(box) === '' && D.messages().length === 0, documentKey } }); return; }
    if (message.type === 'identity' && disposed) { respond({ ok: false, error: 'PAGE_GONE' }); return; }
    if (message.type === 'identity') {
      // Reloaded documents need current native message IDs before the background
      // worker decides whether it can resume observation of this exact turn.
      const path=location.pathname, epoch=pathEpoch;
      D.refreshTranscript().then(() => {
        if(disposed || location.pathname!==path || pathEpoch!==epoch) return respond({ok:false,error:'PAGE_IDENTITY_CHANGED'});
        respond({ok:true,value:pageIdentity()});
      }, () => respond({ok:false,error:'TRANSCRIPT_UNCONFIRMED'}));
      return true;
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
      D.probePendingReceipt(s.turnId).then(value=>respond({ok:true,value}),
        e=>respond({ok:false,error:e.code??'TRANSCRIPT_UNCONFIRMED'}));
      return true;
    }
    if (message.type === 'external-candidate') {
      passiveEnabled = true;
      // Passive observation only. This handler does not touch the composer,
      // authorize Send, or claim that an existing historical message is new.
      const s=message.session,path=location.pathname,epoch=pathEpoch;
      if(disposed||!s||s.conversationId!==conversation()){
        respond({ok:false,error:'PAGE_IDENTITY_CHANGED'});return;
      }
      D.refreshTranscript().then(()=>{
        if(disposed||path!==location.pathname||epoch!==pathEpoch ||
           s.conversationId!==conversation()){
          respond({ok:false,error:'PAGE_IDENTITY_CHANGED'});return;
        }
        const users=D.messages().filter(x=>x.role==='user');
        const at=users.findIndex(x=>x.id===s.previousNativeMessageId);
        if(at<0){respond({ok:true,value:{available:false,reason:'anchor_unavailable'}});return;}
        const newer=users.slice(at+1);
        if(newer.length!==1){
          respond({ok:true,value:{available:false,documentKey,
            previousNativeMessageId:s.previousNativeMessageId,
            reason:newer.length?'multiple_unobserved_turns':'no_new_user'}});return;
        }
        const row=newer[0];
        if(!row?.id || typeof row.text!=='string'||!row.text.trim()||row.text.length>64000){
          respond({ok:false,error:'EXTERNAL_MESSAGE_UNREADABLE'});return;
        }
        respond({ok:true,value:{available:true,documentKey,url:location.href,
          previousNativeMessageId:s.previousNativeMessageId,nativeMessageId:row.id,text:row.text}});
      },()=>respond({ok:false,error:'TRANSCRIPT_UNCONFIRMED'}));
      return true;
    }
    if (message.type === 'monitor') {
      passiveEnabled = true;
      const m = message.session;
      if (m.documentKey !== documentKey || m.conversationId !== conversation()) { respond({ ok: false, error: 'PAGE_IDENTITY_CHANGED' }); return; }
      if (monitor?.turnId !== m.turnId) monitor = { ...m, busy: false, quietSince: null, routeRevoked: false };
      if (monitor?.routeRevoked) { respond({ ok: false, error: 'PAGE_IDENTITY_CHANGED' }); return; }
      // A responsive tab alone is NOT proof that ChatGPT is still working.
      // Only a native activity observation tied to the original user ID can
      // renew Runtime liveness. Unreadable status remains retryable, not live.
      let active=false,nativeReadable=false;
      try{
        const v=D.state(m.nativeMessageId);
        nativeReadable=!v.error;
        active=nativeReadable && (v.busy===true||v.waiting===true);
      }catch{}
      // Backgrounded Chrome tabs can throttle the 750ms content timer for
      // many seconds. Wake the SAME observation path only when native state
      // was actually readable. Missing anchors retain the timer's retry
      // behavior, including the A -> B -> A navigation revocation fence.
      // This does not assert success or send a message. m.busy serializes runs.
      if(nativeReadable)void observe();
      respond({ ok: true, value:{ active } }); return;
    }
    if (message.type === 'command') {
      run(message.command).then(value => respond({ ok: true, value }), e => respond({
        ok:false,error:e.code??'ADAPTER_UNSUPPORTED',
        notSent:e.notSent===true,notApplied:e.notApplied===true,diagnostic:e.diagnostic,
        ...(e.bindingUrl?{bindingUrl:e.bindingUrl}:{})
      }));return true;
    }
  });
})();
