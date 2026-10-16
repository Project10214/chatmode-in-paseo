import { safeDiagnostic } from './diagnostics.mjs';
import { nativeActivity, settleActivity } from './activity.mjs';
import { nativeTimelineItem, recordNativeTimeline, settleNativeTimeline } from './native-timeline.mjs';
import { SlotQueue, concurrencyValue } from './slots.mjs';
import path from 'node:path';
import { MediaStore, IMAGE_LIMITS } from './media.mjs';
import { InputFileStore, uploadAllowance } from './input-files.mjs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BridgeError, invariant, identifier, nativeMessageId as verifyNativeId, text, object, LIMITS, validateCatalog, validateSelection, sameSelection, conversationId } from './protocol.mjs';

const pending = c => ['queued', 'claimed', 'authorized'].includes(c.phase);
const busy = s => ['sending', 'running', 'stopping'].includes(s.status);
const now = () => Date.now();
const token = () => randomBytes(24).toString('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finishTurn = (session, outcome) => {
  session.turn.outcome = outcome;
  const id = session.turn.clientMessageId;
  if (id && session.prompts[id]) session.prompts[id].outcome = outcome;
  session.turn.nativeTerminalItems = settleNativeTimeline(session);
};
// Discard only a proven-unsent attempt. Keep IDs/fingerprints/outcomes as
// tombstones so deleting content can NEVER make an old message executable again.
function discardUnsent(session, command) {
  if (command?.kind !== 'send') return;
  command.discarded = true;
  delete command.payload.text;
  delete command.payload.files;
  if (!session) return;
  const turnId = command.payload.turnId;
  session.history = session.history.filter(item => item.id !== `user:${turnId}`);
  if (session.turn?.id === turnId) {
    session.turn.notSent = true; session.turn.discarded = true;
    delete session.turn.text;
  }
}
// A bound conversation can outlive a Send receipt deadline. This only preserves
// the one authorized attempt; it never confirms delivery or authorizes replay.
function pendingReceipt(c, s, url) {
  if (c?.kind !== 'send' || c.phase !== 'authorized' || !c.lease ||
      !s?.turn || s.turn.id !== c.payload.turnId || s.turn.outcome ||
      !s.turn.authorized || s.tabId !== c.tabId || s.documentKey !== c.documentKey)
    return false;
  const route = conversationId(url) ?? s.conversationId;
  if (!route || (s.conversationId && s.conversationId !== route)) return false;
  s.conversationId = route;
  s.boundAt ??= now();
  s.turn.receiptPending = true;
  s.turn.nativeMessageId = null;
  s.turn.lease = c.lease;
  s.turn.lastObservedAt = now();
  s.status = 'sending';
  s.error = null;
  c.phase = 'done';
  c.result = { receiptPending: true, conversationId: route };
  return true;
}
export class Broker {
  constructor(store, { maxConcurrent = 2, commandTimeout = 90000, turnTimeout = 3 * 60 * 60 * 1000 } = {}) {
    this.store = store; this.defaultConcurrency = concurrencyValue(maxConcurrent); this.commandTimeout = commandTimeout; this.turnTimeout = turnTimeout;
    this.media = new MediaStore(path.join(store.directory, 'media'));
    this.inputFiles = new InputFileStore(path.join(store.directory, 'input-files'));
    this.locks = new Set(); this.owners = new Map(); this.events = new EventEmitter(); this.events.setMaxListeners(200); this.waiters = new Map(); this.closed = false;
    this.slots = new SlotQueue(this); concurrencyValue(this.maxConcurrent);
  }
  get maxConcurrent() { return this.store.read().runtimeSettings?.maxConcurrent ?? this.defaultConcurrency; }
  async setConcurrency(value) {
    concurrencyValue(value); invariant(!this.closed, 'RUNTIME_CLOSED');
    await this.store.transaction(d => { d.runtimeSettings = { ...(d.runtimeSettings ?? {}), maxConcurrent: value }; });
    this.slots.pump(); return { maxConcurrent: this.maxConcurrent };
  }
  lastNativeMessage(s) {
    if (s.lastNativeMessageId) return s.lastNativeMessageId;
    if (s.turn?.nativeMessageId) return s.turn.nativeMessageId;
    const last = Object.values(this.store.read().commands).filter(c=>c.sessionId===s.id&&c.kind==='send'&&c.phase==='done'&&c.result?.nativeMessageId).sort((a,b)=>b.createdAt-a.createdAt)[0];
    return last?.result.nativeMessageId ?? null;
  }
  // Conversation identity survives a turn. Idle conversations are still
  // observed for new messages submitted directly from the bound webpage.
  idleBindings() {
    return Object.values(this.store.read().sessions)
      .filter(s => s.status === 'idle' && s.conversationId && this.lastNativeMessage(s))
      .map(s => ({ sessionId:s.id, conversationId:s.conversationId, tabId:s.tabId,
        documentKey:s.documentKey, previousNativeMessageId:this.lastNativeMessage(s) }));
  }
  // Reconnect inventory for extension upgrades. Only durable, bound sessions;
  // no chat text, credentials, or user message IDs are required to reload a tab.
  // An unbound temporary catalog/new-chat tab is never an update target.
  recoveryTargets() {
    return Object.values(this.store.read().sessions)
      .filter(s => s.conversationId && Number.isInteger(s.tabId) && s.tabId >= 0 &&
        s.status !== 'abandoned')
      .map(s => ({ sessionId:s.id, conversationId:s.conversationId, tabId:s.tabId }));
  }
  // Queue configuration while a browser turn is in progress. The effective
  // settings used by its Send are never changed mid-turn.
  async stageConfiguration(id, selection) {
    const config=validateSelection(selection,this.store.read().catalog);
    return this.store.transaction(d=>{
      const s=d.sessions[id];invariant(s,'SESSION_UNKNOWN');
      invariant(['sending','running','stopping'].includes(s.status),'SESSION_NOT_RUNNING');
      if(sameSelection(config,s.config))delete s.pendingConfig;
      else s.pendingConfig=config;
      return {pending:Boolean(s.pendingConfig),config};
    },{control:true});
  }
  // If several native turns were missed, do not guess their order or
  // silently call a stale item "current". Preserve a visible reconciliation
  // warning; the user can inspect the original ChatGPT thread.
  async noteExternalGap({sessionId,conversationId:route,url,reason,
    tabId,documentKey,previousNativeMessageId}) {
    invariant(reason==='multiple_unobserved_turns','INVALID_GAP');
    invariant(conversationId(url)===route,'WRONG_CONVERSATION');
    identifier(documentKey);verifyNativeId(previousNativeMessageId);
    const result=await this.store.transaction(d=>{
      const s=d.sessions[sessionId];invariant(s&&s.conversationId===route,'SESSION_UNKNOWN');
      invariant(s.tabId===tabId&&this.lastNativeMessage(s)===previousNativeMessageId,'PAGE_IDENTITY_MISMATCH');
      invariant(!Object.values(d.sessions).some(other=>other.id!==s.id&&other.tabId===tabId),'TAB_ALREADY_OWNED');
      invariant(s.status==='idle','SESSION_BUSY');
      if(s.externalGap===reason)return {notified:false};
      s.externalGap=reason;
      return {notified:true,id:s.id};
    },{control:true});
    if(result.notified)this.emit(result.id,{id:result.id,state:'external-gap',reason});
    return result;
  }
  // Browser-initiated turns have no Paseo clientMessageId and MUST NOT enqueue
  // a second Send. The native user ID is the durable idempotency key.
  async importExternalTurn({sessionId,conversationId:route,tabId,documentKey,
    previousNativeMessageId,nativeMessageId:messageId,text:body,url,reopened=false}) {
    identifier(sessionId);identifier(documentKey);
    invariant(Number.isInteger(tabId)&&tabId>=0,'INVALID_TAB');
    verifyNativeId(previousNativeMessageId);verifyNativeId(messageId);
    text(body,LIMITS.text);
    invariant(conversationId(url)===route,'WRONG_CONVERSATION');
    const result=await this.store.transaction(d=>{
      const s=d.sessions[sessionId];invariant(s&&s.conversationId===route,'SESSION_UNKNOWN');
      invariant(!Object.values(d.sessions).some(other=>other.id!==s.id&&other.conversationId===route),
        'CONVERSATION_AMBIGUOUS');
      invariant(!Object.values(d.sessions).some(other=>other.id!==s.id&&other.tabId===tabId),
        'TAB_ALREADY_OWNED');
      if((s.turn?.origin==='browser'&&s.turn.nativeMessageId===messageId)||
        (s.status==='idle'&&s.lastNativeMessageId===messageId&&s.turn?.origin==='browser')){
        const stored=s.history.find(row=>row.type==='user_message'&&row.messageId===messageId);
        invariant(stored?.text===body,'EXTERNAL_MESSAGE_CONFLICT');
        invariant(s.tabId===tabId&&s.documentKey===documentKey,'PAGE_IDENTITY_MISMATCH');
        invariant(s.turn.previousNativeMessageId===previousNativeMessageId,'EXTERNAL_ANCHOR_MISMATCH');
        if(!s.turn.outcome)return {duplicate:true,sessionId:s.id,turnId:s.turn.id,lease:s.turn.lease,
          tabId:s.tabId,documentKey:s.documentKey,conversationId:route,nativeMessageId:messageId};
        return {duplicate:true,settled:true,sessionId:s.id};
      }
      invariant(s.status==='idle',s.status==='blocked'?'DELIVERY_UNCONFIRMED':'SESSION_BUSY');
      invariant(s.tabId===tabId||(reopened===true&&s.tabId!==null),'PAGE_IDENTITY_MISMATCH');
      invariant(this.lastNativeMessage(s)===previousNativeMessageId,'EXTERNAL_ANCHOR_MISMATCH');
      invariant(messageId!==previousNativeMessageId,'NATIVE_MESSAGE_NOT_NEW');
      invariant(s.history.length+1+LIMITS.turnFragments<=LIMITS.history,'HISTORY_LIMIT');
      const turnId=randomUUID(),lease=token();
      s.tabId=tabId;s.documentKey=documentKey;s.status='running';s.error=null;
      delete s.externalGap;
      s.turn={id:turnId,origin:'browser',createdAt:now(),authorized:false,
        nativeMessageId:messageId,previousNativeMessageId,lease,outcome:null,lastObservedAt:now(),
        historyStart:s.history.length+1};
      s.lastNativeMessageId=messageId;
      const item={type:'user_message',id:`user:${turnId}`,text:body,messageId};
      s.history.push(item);
      return {sessionId:s.id,turnId,lease,tabId,documentKey,conversationId:route,
        nativeMessageId:messageId,item,imported:true};
    });
    if(result.imported)this.emit(result.sessionId,{id:result.sessionId,turnId:result.turnId,
      state:'external-started',item:result.item});
    return result;
  }
  async ensurePage(id, { signal } = {}) {
    invariant(!this.locks.has(id), 'CONFIGURATION_BUSY'); this.locks.add(id);
    try {
      const s=this.snapshot(id); invariant(s.status==='idle'&&s.tabId!==null,'SESSION_BUSY');
      // Only a bound Conversation is needed to reopen. An old native user ID
      // is optional reconciliation context, NEVER an admission requirement.
      // A failed unknown Send may have created a newer native turn, so do not
      // advertise a stale ID. A confirmed Stop failure keeps its own ID.
      const lastVerifiedNativeMessageId=this.lastNativeMessage(s);
      const confirmedStopAnchor=s.error==='STOP_UNCONFIRMED'&&
        s.turn?.nativeMessageId===lastVerifiedNativeMessageId&&
        (s.turn.receivedAt||s.turn.origin==='browser');
      const previousNativeMessageId=s.turn?.outcome==='failed'&&!s.turn?.notSent&&!confirmedStopAnchor
        ?null:lastVerifiedNativeMessageId;
      await this.call('ensure',id,{config:s.config,conversationId:s.conversationId,tabId:s.tabId,previousDocumentKey:s.documentKey,previousNativeMessageId},{signal});
      return this.snapshot(id);
    } finally { this.locks.delete(id); }
  }
  // Bind a conversation route separately from a message receipt. The exact
  // authorized Send, tab and document must already be held by this broker.
  async bindConversation(id, lease, {tabId, documentKey, url} = {}) {
    const bound=await this.store.transaction(d=>{
      const c=d.commands[id],s=c?.sessionId&&d.sessions[c.sessionId];
      invariant(c?.kind==='send'&&c.phase==='authorized'&&c.lease===lease&&
        s?.turn?.id===c.payload.turnId&&s.turn.authorized&&!s.turn.outcome,
        'BINDING_NOT_AUTHORIZED');
      invariant(c.tabId===tabId&&c.documentKey===documentKey&&
        s.tabId===tabId&&s.documentKey===documentKey,'PAGE_IDENTITY_MISMATCH');
      const current=conversationId(url);
      invariant(current,'WRONG_CONVERSATION');
      invariant(!s.conversationId||s.conversationId===current,'WRONG_CONVERSATION');
      // This does not claim the user message was sent or the answer finished.
      const newlyBound=!s.conversationId;
      s.conversationId=current;
      s.boundAt??=now();
      return {conversationId:current,bound:true,newlyBound,sessionId:s.id,turnId:s.turn.id};
    },{control:true});
    if(bound.newlyBound)this.emit(bound.sessionId,{id:bound.sessionId,turnId:bound.turnId,
      state:'bound',conversationId:bound.conversationId});
    return {conversationId:bound.conversationId,bound:true};
  }
  // An explicitly NEW user prompt may continue a verified link after the
  // preceding turn failed. The old clientMessageId stays spent and terminal.
  async prepareContinuation(id) {
    return this.store.transaction(d=>{
      const s=d.sessions[id];invariant(s,'SESSION_UNKNOWN');
      if(s.status!=='blocked')return {ready:s.status==='idle'};
      invariant(s.conversationId&&s.tabId!==null&&s.documentKey&&
        s.turn?.outcome,'DELIVERY_UNCONFIRMED');
      s.status='idle';
      s.previousWarning=s.error;
      return {ready:true,conversationId:s.conversationId};
    },{control:true});
  }
  async failUnclaimed(id, error) {
    const allowed=['TAB_NOT_OWNED','PAGE_CLOSED','WRONG_PAGE','WRONG_CONVERSATION','TURN_CHANGED','REOPEN_IDENTITY_UNPROVEN','CONTENT_UNAVAILABLE','PAGE_RELOAD_REQUIRED','CONNECTION_CHANGED','BROWSER_PREPARE_FAILED'];
    invariant(allowed.includes(error),'INVALID_PREPARE_ERROR');
    const result=await this.store.transaction(d=>{
      const c=d.commands[id];invariant(c&&c.phase==='queued'&&!c.lease,'COMMAND_NOT_CLAIMABLE');
      invariant(['catalog','open','configure','ensure','send','stop'].includes(c.kind),'CONTROL_ONLY');
      c.phase='failed';c.error=error;const s=c.sessionId&&d.sessions[c.sessionId];
      discardUnsent(s,c);
      if(c.kind==='send'&&s?.turn?.id===c.payload.turnId&&!s.turn.authorized&&!s.turn.outcome){
        s.status='idle';s.error=error;finishTurn(s,'failed');s.turn.notSent=true;
        return {id:s.id,turnId:s.turn.id,state:'failed',error,activityItem:settleActivity(s,'failed')};
      }
      return null;
    });
    if (this.store.read().commands[id]?.discarded) await this.inputFiles.remove(id);
    this.settle(id,error);if(result)this.emit(result.id,result);return {accepted:true,notSent:true};
  }
  async recover() {
    // Never replay Send on restart. Resume observation of already bound turns.
    await this.store.transaction(data => {
      for (const c of Object.values(data.commands)) if (pending(c)) {
        const s = c.sessionId && data.sessions[c.sessionId];
        if (c.kind === 'send' && c.phase === 'authorized' && pendingReceipt(c, s, s?.conversationId)) continue;
        if (c.phase !== 'authorized') discardUnsent(s,c);
        c.phase = 'failed'; c.error = 'RUNTIME_RESTARTED';
      }
      for (const c of Object.values(data.commands)) if (['open', 'configure', 'ensure'].includes(c.kind) && c.error === 'RUNTIME_RESTARTED' && c.lease) {
        const s = data.sessions[c.sessionId]; if (s && s.status === 'idle') { s.status = 'blocked'; s.error = 'CONTROL_UNCONFIRMED'; }
      }
      for (const s of Object.values(data.sessions)) if (busy(s)) {
        const retained = s.conversationId && s.tabId !== null && s.documentKey &&
          s.turn?.lease && !s.turn.outcome &&
          (s.turn.receiptPending === true || (s.turn.nativeMessageId && ['running','stopping'].includes(s.status)));
        if (retained) continue;
        s.status = s.turn?.notSent === true ? 'idle' : 'blocked'; s.error = 'RUNTIME_RESTARTED';
        if (s.turn && !s.turn.outcome) s.turn.outcome = 'failed';
        if (s.turn && s.prompts[s.turn.clientMessageId]) s.prompts[s.turn.clientMessageId].outcome = 'failed';
        settleActivity(s,'failed');
      }
    });
    await Promise.all(Object.values(this.store.read().commands).filter(c => c.discarded)
      .map(c => this.inputFiles.remove(c.id)));
    // Resume an interrupted archive after a restart; this is a single
    // recovery pass over persisted intents, not a periodic Agent scan.
    for (const session of Object.values(this.store.read().sessions))
      if (session.archiveIntent) await this.finishArchive(session.id);
  }
  subscribe(id, fn) { this.events.on(id, fn); return () => this.events.off(id, fn); }
  emit(id, event) { for (const fn of this.events.listeners(id)) { try { fn(structuredClone(event)); } catch {} } this.slots.pump(); }
  snapshot(id) { const s = this.store.read().sessions[id]; invariant(s, 'SESSION_UNKNOWN'); return s; }
  // A failed first-page configuration is not a delivered or attempted Send.
  // Recover it only on explicit new user intent, and never touch a bound chat,
  // authorized/uncertain turn, or an outstanding command.
  async recoverUnboundControl(id) {
    invariant(!this.locks.has(id), 'CONFIGURATION_BUSY');
    return this.store.transaction(d => {
      const s = d.sessions[id];
      invariant(s && s.status === 'blocked' && s.error === 'CONTROL_UNCONFIRMED' &&
        s.tabId === null && !s.conversationId && !s.turn &&
        !Object.values(d.commands).some(c => c.sessionId === id &&
          (c.kind === 'send' || pending(c))), 'SESSION_REQUIRES_INSPECTION');
      s.status = 'idle'; s.error = null; s.documentKey = null;
      return { id, status: 'idle' };
    }, { control: true });
  }
  async create(selection, { cwd = '', systemPrompt = '' } = {}) {
    const id = randomUUID();
    await this.store.transaction(d => {
      // Retained sessions are durable history, not concurrent browser work.
      // Store.transaction bounds bytes (including turn/control reservations);
      // a lifetime count cap would permanently disable new chats after 100 opens.
      // Never evict old identities or deduplication records to admit a new chat.
      const config = validateSelection(selection, d.catalog);
      d.sessions[id] = { id, config, cwd: text(cwd, 8000, true), systemPrompt: text(systemPrompt, 16000, true), conversationId: null, tabId: null,
        status: 'idle', contextRevision: 1, contextPending: true, turn: null, prompts: {}, history: [], sequence: 0, createdAt: now() };
    });
    return this.snapshot(id);
  }
  async updateContext(id, { cwd = '', systemPrompt = '' }) {
    text(cwd, 8000, true); text(systemPrompt, 16000, true);
    await this.store.transaction(d => {
      const s = d.sessions[id]; invariant(s && (s.status === 'idle' ||
        (s.status==='blocked'&&s.conversationId&&s.turn?.outcome)), 'SESSION_BUSY');
      if (s.cwd !== cwd || s.systemPrompt !== systemPrompt) {
        s.cwd = cwd; s.systemPrompt = systemPrompt;
        s.contextRevision = (s.contextRevision ?? 0) + 1; s.contextPending = true;
      }
    });
  }
  async defaults(selection) {
    await this.store.transaction(d => { d.defaults = validateSelection(selection, d.catalog); });
    return this.store.read().defaults;
  }
  async enqueue(kind, sessionId, payload = {}) {
    invariant(!this.closed, 'RUNTIME_CLOSED');
    const id = randomUUID();
    const command = await this.store.transaction(d => {
      invariant(Object.values(d.commands).filter(pending).length < LIMITS.commands, 'QUEUE_FULL');
      // Only settled commands are pruned. An expired send is never eligible for replay.
      for (const [key, c] of Object.entries(d.commands)) if (!pending(c) && now() - c.createdAt > 3600000) delete d.commands[key];
      return d.commands[id] = { id, kind, sessionId, payload, phase: 'queued', createdAt: now(), deadline: now() + this.commandTimeout };
    });
    return command;
  }
  // One close attempt per tab/document. A skipped, timed-out or unknown result
  // must never trigger repeated attempts against the same browser document.
  async enqueueTabClose(id) {
    invariant(!this.closed, 'RUNTIME_CLOSED');
    return this.store.transaction(d => {
      const s = d.sessions[id];
      if (!s || !s.archiveIntent?.id || s.status !== 'idle' || !Number.isInteger(s.tabId) || s.tabId < 0 ||
          typeof s.documentKey !== 'string' || this.locks.has(id) ||
          Object.values(d.commands).some(c => c.sessionId === id && pending(c)) ||
          (s.tabCloseAttempt?.tabId === s.tabId && s.tabCloseAttempt?.documentKey === s.documentKey) ||
          Object.values(d.commands).filter(pending).length >= LIMITS.commands) return null;
      const attempt = {tabId:s.tabId,documentKey:s.documentKey,createdAt:now()};
      const c = {id:randomUUID(),kind:'close-tab',sessionId:id,
        payload:{tabId:s.tabId,documentKey:s.documentKey,conversationId:s.conversationId,archiveId:s.archiveIntent.id},
        phase:'queued',createdAt:attempt.createdAt,deadline:attempt.createdAt+this.commandTimeout};
      s.tabCloseAttempt = attempt;
      d.commands[c.id] = c;
      return c;
    }, {control:true});
  }
  // Paseo archives can arrive while no Provider session is attached. Keep
  // the intent durable; final compaction waits for a settled, tabless session.
  async archiveSession(id) {
    if (!id || this.closed) return { moved: false };
    const state = this.store.read();
    if (state.archiveIndex?.[id] || !state.sessions[id]) return { moved: false };
    await this.store.transaction(d => {
      const s = d.sessions[id];
      if (s && !s.archiveIntent) s.archiveIntent = { id: randomUUID(), requestedAt: now() };
    }, { control: true });
    return this.finishArchive(id);
  }
  async unarchiveSession(id) {
    if (!id || this.closed) return { restored: false };
    return this.store.unarchiveSession(id);
  }
  // Drive one archived session toward its final state: close an idle tab once,
  // then move the record out of state.json when it is settled and tabless.
  // Anything not ready yet is left in place; later events call this again.
  async finishArchive(id) {
    if (!id || this.closed) return { moved: false };
    const s = this.store.read().sessions[id];
    if (!s?.archiveIntent) return { moved: false };
    if (s.status === 'idle' && Number.isInteger(s.tabId)) {
      try { await this.enqueueTabClose(id); } catch { /* retried by a later event */ }
    }
    return this.maybeArchive(id);
  }
  // Archive I/O must never turn a completed close into a failed browser
  // receipt. If a disk write fails, state.json retains the entire session.
  async maybeArchive(id) {
    if (!id || !this.store.read().sessions[id]?.archiveIntent) return { moved: false };
    try {
      return await this.store.archiveSession(id, (s, data) =>
        ['idle', 'abandoned'].includes(s.status) &&
        s.tabId === null && s.documentKey == null &&
        !this.locks.has(id) &&
        !Object.values(data.commands).some(c => c.sessionId === id && pending(c)));
    } catch {
      return { moved: false, error: 'ARCHIVE_WRITE_FAILED' };
    }
  }
  verifyTabClose(id, lease) {
    const d = this.store.read(), c = d.commands[id], s = c?.sessionId && d.sessions[c.sessionId];
    return {allowed:Boolean(c?.kind === 'close-tab' && c.phase === 'claimed' && c.lease === lease &&
      c.deadline > now() && s?.status === 'idle' &&
      s.archiveIntent?.id === c.payload?.archiveId &&
      s.tabId === c.tabId && s.documentKey === c.documentKey &&
      !this.locks.has(s.id) &&
      !Object.values(d.commands).some(other => other.id !== id && other.sessionId === s.id && pending(other)))};
  }
  async cancelControl(id) {
    const result = await this.store.transaction(d => {
      const c = d.commands[id];
      if (!c || !pending(c)) return null;
      invariant(['catalog', 'open', 'configure', 'ensure'].includes(c.kind), 'CONTROL_ONLY');
      const ambiguous = c.phase === 'claimed';
      c.phase = 'failed'; c.error = ambiguous ? 'CONTROL_UNCONFIRMED' : 'CONNECTION_CLOSED';
      const s = c.sessionId && d.sessions[c.sessionId];
      if (ambiguous && s?.status === 'idle') { s.status = 'blocked'; s.error = c.error; }
      return c.error;
    });
    if (result) this.settle(id, result);
  }
  async call(kind, sessionId, payload = {}, { signal } = {}) {
    invariant(!signal?.aborted, 'CONNECTION_CLOSED');
    const c = await this.enqueue(kind, sessionId, payload);
    const abort = () => { void this.cancelControl(c.id).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // Closing may have happened while the command was being published to disk.
      if (signal?.aborted) await this.cancelControl(c.id);
      return await this.wait(c.id);
    } finally { signal?.removeEventListener('abort', abort); }
  }
  wait(id) {
    const c = this.store.read().commands[id]; invariant(c, 'COMMAND_UNKNOWN');
    if (c.phase === 'done') return Promise.resolve(c.result);
    if (c.phase === 'failed') return Promise.reject(new BridgeError(c.error));
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(id) ?? []; list.push({ resolve, reject }); this.waiters.set(id, list);
    });
  }
  settle(id, error, result) { const list = this.waiters.get(id) ?? []; this.waiters.delete(id); for (const w of list) error ? w.reject(new BridgeError(error)) : w.resolve(result); }
  queued() { return Object.values(this.store.read().commands).filter(c => c.phase === 'queued').sort((a, b) => Number(b.kind === 'stop') - Number(a.kind === 'stop') || a.createdAt - b.createdAt).slice(0, 8); }
  async claim(id, tabId, documentKey, proof = {}) {
    identifier(id); identifier(documentKey); invariant(Number.isInteger(tabId) && tabId >= 0, 'INVALID_TAB');
    return this.store.transaction(d => {
      const c = d.commands[id]; invariant(c && c.phase === 'queued' && c.deadline > now(), 'COMMAND_NOT_CLAIMABLE');
      const s = c.sessionId && d.sessions[c.sessionId];
      if(c.kind==='close-tab') {
        invariant(s && s.archiveIntent?.id === c.payload.archiveId && s.status==='idle' && s.tabId===c.payload.tabId &&
          s.documentKey===c.payload.documentKey && tabId===s.tabId &&
          documentKey===s.documentKey && !this.locks.has(s.id) &&
          !Object.values(d.commands).some(other=>other.id!==id&&other.sessionId===s.id&&pending(other)),
          'TAB_CLOSE_UNAVAILABLE');
      } else if(c.kind==='ensure') {
        invariant(s && s.status==='idle' && s.tabId===c.payload.tabId && s.documentKey===c.payload.previousDocumentKey,'PAGE_IDENTITY_MISMATCH');
        invariant(conversationId(proof.url)===s.conversationId,'WRONG_CONVERSATION');
        // The page can contain a newer user turn after reconnecting. It is
        // still the same bound chat; Send will independently fence an active
        // draft/turn and persist its own one-shot command ID.
        invariant(s.tabId===tabId || (proof.reopened===true && s.conversationId),'WRONG_TAB');
      } else invariant(!s || s.tabId === null || s.tabId === tabId, 'WRONG_TAB');
      invariant(!s || !Object.values(d.commands).some(other=>other.id!==c.id&&other.sessionId&&other.sessionId!==s.id&&pending(other)&&other.tabId===tabId),'TAB_ALREADY_OWNED');
      invariant(!s || !Object.values(d.sessions).some(other => other.id !== s.id && other.tabId === tabId), 'TAB_ALREADY_OWNED');
      c.phase = 'claimed'; c.lease = token(); c.tabId = tabId; c.documentKey = documentKey;
      return { ...c };
    });
  }
  async authorize(id, lease) {
    return this.store.transaction(d => {
      const c = d.commands[id]; invariant(c && c.lease === lease && c.kind === 'send' && c.phase === 'claimed', 'SEND_NOT_AUTHORIZED');
      const s = d.sessions[c.sessionId];
      invariant(c.deadline > now() && s.turn?.id === c.payload.turnId && !s.turn.cancelRequested, 'SEND_CANCELLED');
      c.phase = 'authorized'; s.turn.authorized = true; return { authorized: true };
    });
  }
  async result(id, lease, result) {
    invariant(object(result), 'INVALID_RESULT');
    let affected;
    const output = await this.store.transaction(d => {
      const c = d.commands[id]; invariant(c && c.lease === lease, 'LEASE_MISMATCH');
      const s = c.sessionId && d.sessions[c.sessionId];
      // A slow browser may return its genuine native receipt after the 90s
      // command deadline became a soft handoff. Never discard that late proof.
      if(c.phase==='done' && c.result?.receiptPending && result.receipt===true &&
         s?.turn?.receiptPending && !s.turn.outcome && s.turn.id===c.payload.turnId &&
         s.turn.lease===lease && s.tabId===c.tabId && s.documentKey===c.documentKey){
        invariant(sameSelection(result.config,s.config),'RECEIPT_UNCONFIRMED');
        invariant(conversationId(result.url)===s.conversationId,'WRONG_CONVERSATION');
        const nativeId=verifyNativeId(result.nativeMessageId);
        s.turn.receiptPending=false;s.turn.nativeMessageId=nativeId;s.lastNativeMessageId=nativeId;
        s.turn.receivedAt=now();s.turn.lastObservedAt=now();s.status='running';
        c.result={receipt:true,conversationId:s.conversationId,nativeMessageId:nativeId};
        affected={id:s.id,turnId:s.turn.id,state:'receipt'};
        return {value:c.result};
      }
      if (c.phase === 'done' || c.phase === 'failed') return { replay: true, error: c.error, value: c.result };
      invariant(c.phase !== 'queued', 'NOT_CLAIMED');
      const diagnostic = safeDiagnostic(result.diagnostic);
      if (diagnostic) c.diagnostic = diagnostic;
      if (result.error) {
        const code = text(result.error, 160);
        const wasAuthorized=c.phase==='authorized';
        // A browser IPC deadline may expire after the original click but
        // before the native receipt reaches the Runtime. Treat it like a
        // soft receipt handoff only if the exact conversation was bound by
        // that authorized Send. This does not assert that a click happened.
        const recoverable = code === 'RECEIPT_UNCONFIRMED'
          ? diagnostic?.nativeClicked === true
          : ['CONTENT_TIMEOUT','CONTENT_UNAVAILABLE','COMMAND_UNCONFIRMED'].includes(code);
        if (recoverable && wasAuthorized && !diagnostic?.guardCode &&
            result.notSent !== true && pendingReceipt(c, s, result.bindingUrl))
          return { value: c.result, pending: { id:s.id, turnId:s.turn.id, state:'receipt-pending' } };
        c.phase = 'failed'; c.error = code;
        if (result.notSent === true || !wasAuthorized) discardUnsent(s,c);
        if (c.kind === 'send' && s?.turn?.id === c.payload.turnId && !s.turn.outcome) {
          // A failed receipt may still carry this authorized document's exact
          // conversation URL. Bind it without ever accepting it as a receipt.
          if(wasAuthorized&&s.turn.authorized&&result.notSent!==true &&
            c.tabId===s.tabId&&c.documentKey===s.documentKey) {
            const route=conversationId(result.bindingUrl);
            if(route&&(!s.conversationId||s.conversationId===route)){
              s.conversationId=route;s.boundAt??=now();
            }
          }
          if(result.notSent===true)s.turn.notSent=true;
          const uncertain=s.turn.authorized&&result.notSent!==true;
          s.status=uncertain&&!s.conversationId?'blocked':'idle';
          s.error = code; finishTurn(s, 'failed');
          affected = { id: s.id, turnId: s.turn.id, state: 'failed', error: code, activityItem:settleActivity(s,'failed') };
        }
        if (['open', 'configure', 'ensure'].includes(c.kind) && s && result.notApplied !== true && s.status === 'idle') {
          // APP_SELECTION_CHANGED is a pre-Send editor ownership refusal.
          // Preserve the original error and let a fresh user request recheck
          // the page instead of permanently blocking this idle session.
          if (code === 'APP_SELECTION_CHANGED') s.error = code;
          else { s.status = 'blocked'; s.error = 'CONTROL_UNCONFIRMED'; }
        }
        return { error: code };
      }
      if (c.kind === 'catalog') {
        d.catalog = validateCatalog(result.catalog);
        c.result = { catalog: d.catalog };
      } else if (c.kind === 'open' || c.kind === 'configure' || c.kind === 'ensure') {
        invariant(s && sameSelection(result.config, c.payload.config), 'CONFIG_NOT_CONFIRMED');
        invariant(result.tabId === c.tabId, 'WRONG_TAB');
        if(c.kind==='ensure') {
          // Ensure confirms the Conversation and configuration, not the
          // identity of the previous user turn. Keep the last verified ID for
          // independent reconciliation rather than adopting unobserved turns.
        }
        s.tabId = c.tabId; s.documentKey = c.documentKey; s.config = result.config;
        if (s.pendingConfig && sameSelection(s.pendingConfig,s.config)) delete s.pendingConfig;
        if (s.conversationId) invariant(conversationId(result.url) === s.conversationId, 'WRONG_CONVERSATION');
        c.result = { config: s.config, tabId: s.tabId };
      } else if (c.kind === 'send') {
        invariant(c.phase === 'authorized' && s && s.turn.id === c.payload.turnId && !s.turn.outcome, 'SEND_NOT_AUTHORIZED');
        const conversation = conversationId(result.url);
        invariant(conversation && (!s.conversationId || s.conversationId === conversation), 'WRONG_CONVERSATION');
        invariant(result.receipt === true && sameSelection(result.config, s.config), 'RECEIPT_UNCONFIRMED');
        const nativeMessageId = verifyNativeId(result.nativeMessageId);
        s.conversationId = conversation; s.tabId = c.tabId; s.documentKey = c.documentKey; s.lastNativeMessageId = nativeMessageId;
        if (c.payload.contextRevision === s.contextRevision) s.contextPending = false;
        s.status = 'running'; s.turn.nativeMessageId = nativeMessageId; s.turn.lease = lease; s.turn.receivedAt = now();
        // The page can prove its text receipt independently from whether
        // the selected @ app was serialized in the exact ChatGPT POST.
        // Never treat a DOM-only chip or unknown transport as tool access.
        const appNetworkEvidence=!s.config.appIds.length?'none':
          ['included','omitted'].includes(result.appNetworkEvidence)
            ?result.appNetworkEvidence:'unverified';
        c.result = { receipt: true, conversationId: conversation, nativeMessageId, appNetworkEvidence };
        affected = { id: s.id, state: 'receipt', turnId: s.turn.id, appNetworkEvidence };
      } else if (c.kind === 'stop') {
        invariant(s && s.turn?.id === c.payload.turnId && result.stopped === true && result.nativeMessageId === s.turn?.nativeMessageId, 'STOP_UNCONFIRMED');
        if (!s.turn.outcome) { finishTurn(s, 'canceled'); s.status = 'idle'; affected = { id: s.id, turnId: s.turn.id, state: 'canceled', activityItem:settleActivity(s,'canceled') }; }
        c.result = { stopped: true };
      } else if (c.kind === 'close-tab') {
        const skipReasons = ['ACTIVE_TAB','DOCUMENT_CHANGED','PAGE_BUSY','PAGE_UNAVAILABLE',
          'TAB_MISSING','TAB_NOT_OWNED','WRONG_CONVERSATION','SESSION_BUSY'];
        invariant(result.closed === true || (result.closed === false && skipReasons.includes(result.skipped)), 'TAB_CLOSE_UNCONFIRMED');
        if (result.closed === true) {
          invariant(s && s.status === 'idle' && s.tabId === c.tabId && s.documentKey === c.documentKey,
            'PAGE_IDENTITY_MISMATCH');
          s.tabId = null;
          s.documentKey = null;
          // Conversation binding is durable and is used when a new Send reopens the tab.
        }
        c.result = result.closed ? { closed: true } : { closed: false, skipped: result.skipped };
      } else throw new BridgeError('UNKNOWN_COMMAND');
      c.phase = 'done'; return { value: c.result };
    });
    if (this.store.read().commands[id]?.discarded) await this.inputFiles.remove(id);
    this.settle(id, output.error, output.value);
    if (affected) this.emit(affected.id, affected);
    if (output.pending) this.emit(output.pending.id, output.pending);
    const finished = this.store.read().commands[id];
    if (finished && ['close-tab', 'stop'].includes(finished.kind))
      await this.finishArchive(finished.sessionId);
    return { accepted: true };
  }
  /** Save desired settings before a browser has been attached. Not a native application receipt. */
  async deferConfigure(id, selection) {
    invariant(!this.closed && !this.locks.has(id), 'CONFIGURATION_BUSY');
    return this.store.transaction(d => {
      const s = d.sessions[id]; invariant(s && (s.status==='idle' ||
        (s.status==='blocked'&&s.conversationId&&s.turn?.outcome)) && !this.locks.has(id), 'SESSION_BUSY');
      s.config = validateSelection(selection, d.catalog);
      if (s.pendingConfig && sameSelection(s.pendingConfig,s.config)) delete s.pendingConfig;
      return s;
    });
  }
  async configure(id, selection, options = {}) {
    invariant(!this.locks.has(id), 'CONFIGURATION_BUSY'); this.locks.add(id);
    try {
      const s = this.snapshot(id); invariant(s.status === 'idle', 'SESSION_BUSY');
      const config = validateSelection(selection, this.store.read().catalog);
      await this.call(s.tabId === null ? 'open' : 'configure', id, { config, conversationId: s.conversationId, tabId: s.tabId }, options);
      return this.snapshot(id);
    } finally { this.locks.delete(id); }
  }
  async prompt(id, clientMessageId, value, { signal, attachments = [] } = {}) {
    identifier(clientMessageId); text(value, LIMITS.text, attachments.length > 0);
    invariant(!this.closed, 'RUNTIME_CLOSED');
    const turnId = randomUUID(), commandId = randomUUID();
    const files = attachments.length ? await this.inputFiles.stage(commandId, attachments) : [];
    let result;
    try {
      result = await this.store.transaction(d => {
      const s = d.sessions[id]; invariant(s, 'SESSION_UNKNOWN');
      const fingerprint = digest({ value, config: s.config, files });
      const prior = Object.hasOwn(s.prompts, clientMessageId) ? s.prompts[clientMessageId] : null;
      if (prior) { invariant(prior.fingerprint === fingerprint, 'MESSAGE_ID_CONFLICT'); if (prior.rejected) return { rejected: prior.rejected }; return { turnId: prior.turnId, replay: true, outcome: prior.outcome }; }
      try {
      invariant(!signal?.aborted, 'SEND_CANCELLED');
      invariant(!this.locks.has(id), 'CONFIGURATION_BUSY');
      invariant(s.status === 'idle' && s.tabId !== null, s.status === 'blocked' ? 'DELIVERY_UNCONFIRMED' : 'SESSION_BUSY');
      invariant(!s.pendingConfig,'CONFIGURATION_PENDING');
      invariant(this.slots.has(id) || this.slots.activeIds().size < this.maxConcurrent, 'CONCURRENCY_LIMIT');
      invariant(Object.keys(s.prompts).length < 2000 && s.history.length + 1 + LIMITS.turnFragments <= LIMITS.history, 'PROMPT_HISTORY_LIMIT');
      invariant(Object.values(d.commands).filter(pending).length < LIMITS.commands, 'QUEUE_FULL');
      const context = [s.systemPrompt, s.cwd ? `Working-directory hint (not a permission grant): ${s.cwd}` : ''].filter(Boolean).join('\n');
      const prefix = (!s.conversationId || s.contextPending) && context ? `[Paseo context — user-level instructions]\n${context}\n[/Paseo context]\n\n` : '';
      const fullText = text(prefix + value, LIMITS.text, files.length>0);
      s.error = null;
      s.status = 'sending'; s.turn = { id: turnId, clientMessageId, commandId, createdAt: now(), text: value, authorized: false, outcome: null, historyStart: s.history.length + 1 };
      s.prompts[clientMessageId] = { fingerprint, turnId, outcome: null };
      s.history.push({ type: 'user_message', id: `user:${turnId}`, text: value, clientMessageId });
      d.commands[commandId] = { id: commandId, kind: 'send', sessionId: id, payload: { turnId, text: fullText, ...(files.length?{files}:{}), contextRevision: s.contextRevision, config: s.config, conversationId: s.conversationId, tabId: s.tabId }, phase: 'queued', createdAt: now(), deadline: now() + this.commandTimeout + (files.length ? uploadAllowance(files) : 0) };
      return { turnId, replay: false };
      } catch (e) {
        // Preserve failed admission identity too; retrying requires a NEW clientMessageId.
        if (Object.keys(s.prompts).length < 2000) s.prompts[clientMessageId] = { fingerprint, rejected: e.code ?? 'ADMISSION_FAILED', outcome: 'failed' };
        return { rejected: e.code ?? 'ADMISSION_FAILED' };
      }
    });
    } catch(error) {
      if(files.length) await this.inputFiles.remove(commandId);
      throw error;
    }
    if((result.rejected || result.replay) && files.length) await this.inputFiles.remove(commandId);
    if (result.rejected) throw new BridgeError(result.rejected);
    if (!result.replay) this.wait(commandId).catch(() => {});
    return result;
  }
  async readInputChunk({id,lease,documentKey,index,offset}) {
    const c=this.store.read().commands[id];
    invariant(c && c.kind==='send' && c.lease===lease && c.documentKey===documentKey &&
      ['claimed','authorized'].includes(c.phase) && c.deadline>Date.now() &&
      Array.isArray(c.payload.files) && Number.isInteger(index) &&
      index>=0 && index<c.payload.files.length, 'ATTACHMENT_NOT_AUTHORIZED');
    return this.inputFiles.read(id,index,offset,c.payload.files[index]);
  }
  async failTurn(id, error, uncertain, expectedTurnId) {
    if (this.closed) return;
    let discardedId = null;
    const result = await this.store.transaction(d => {
      const s = d.sessions[id]; if (!s?.turn || s.turn.outcome || (expectedTurnId && s.turn.id !== expectedTurnId)) return null;
      finishTurn(s, 'failed'); s.status = uncertain&&!s.conversationId ? 'blocked' : 'idle'; s.error = error;
      const command = d.commands[s.turn.commandId];
      if (!uncertain && !s.turn.authorized && command?.kind === 'send') {
        command.phase = 'failed'; command.error ??= error;
        discardUnsent(s,command); discardedId = command.id;
      }
      return { id, turnId: s.turn.id, state: 'failed', error, activityItem:settleActivity(s,'failed') };
    }, { control: true });
    if (discardedId) await this.inputFiles.remove(discardedId);
    if (result) this.emit(id, result);
    if (result) await this.finishArchive(id);
  }
  async observe(event) {
    invariant(object(event), 'INVALID_EVENT');
    let image = null;
    const activity=event.kind==='activity'?nativeActivity(event.activity):null;
    const nativeItem=event.kind==='native_timeline'?nativeTimelineItem(event.item,event.turnId):null;
    if (event.kind === 'image') {
      const s = this.snapshot(event.sessionId);
      invariant(s.turn && !s.turn.outcome && s.turn.id===event.turnId && s.turn.lease===event.lease && s.turn.nativeMessageId===event.nativeMessageId, 'TURN_IDENTITY_MISMATCH');
      invariant(s.tabId===event.tabId && s.documentKey===event.documentKey && conversationId(event.url)===s.conversationId, 'PAGE_IDENTITY_MISMATCH');
      const rows=s.history.filter(x=>x.type==='plugin'&&x.kind==='generated-image'&&x.data.turnId===event.turnId);
      invariant(rows.some(x=>x.data.messageId===event.messageId&&x.data.assetId===event.assetId)||rows.length<IMAGE_LIMITS.count,'IMAGE_COUNT_LIMIT');
      try { image = await this.media.put(event); } catch(e) { if(e instanceof BridgeError)throw e;throw new BridgeError('IMAGE_STORAGE_FAILED'); }
    }
    const settledStops = [];
    const notification = await this.store.transaction(d => {
      const s = d.sessions[event.sessionId]; invariant(s && s.turn, 'TURN_INACTIVE');
      if (event.kind === 'receipt_recovered') {
        invariant(s.turn.receiptPending === true && s.status === 'sending' &&
          !s.turn.outcome && s.turn.lease === event.lease &&
          event.turnId === s.turn.id && s.turn.authorized, 'TURN_IDENTITY_MISMATCH');
        invariant(event.tabId === s.tabId && event.documentKey === s.documentKey &&
          conversationId(event.url) === s.conversationId, 'PAGE_IDENTITY_MISMATCH');
        const nativeId = verifyNativeId(event.nativeMessageId);
        s.turn.receiptPending = false;
        s.turn.nativeMessageId = nativeId;
        s.lastNativeMessageId = nativeId;
        s.turn.receivedAt = now();
        s.turn.lastObservedAt = now();
        s.status = 'running';
        if (d.commands[s.turn.commandId]?.result?.receiptPending)
          d.commands[s.turn.commandId].result = {receipt:true,conversationId:s.conversationId,nativeMessageId:nativeId};
        return { id:s.id, turnId:s.turn.id, state:'receipt' };
      }
      invariant(event.turnId === s.turn.id && event.lease === s.turn.lease && event.nativeMessageId === s.turn.nativeMessageId,
        'TURN_IDENTITY_MISMATCH');
      if (event.kind === 'observation_gap') {
        // A browser-worker reporting a temporary gap cannot renew the
        // watchdog, establish identity, or settle a native turn.
        invariant(event.tabId === s.tabId && event.documentKey === s.documentKey &&
          conversationId(event.url) === s.conversationId, 'PAGE_IDENTITY_MISMATCH');
        if (s.turn.outcome) return null;
        return {id:s.id,turnId:s.turn.id,state:'waiting',reason:'transcript-unavailable'};
      }
      if (event.kind === 'binding_lost') {
        if (s.turn.outcome) return null;
        invariant(event.documentKey === s.documentKey && event.tabId === s.tabId, 'PAGE_IDENTITY_MISMATCH');
        s.turn.bindingDiagnostic = safeDiagnostic(event.diagnostic);
        finishTurn(s, 'failed'); s.status = s.conversationId?'idle':'blocked'; s.error = 'BROWSER_BINDING_LOST';
        return { id: s.id, turnId: s.turn.id, state: 'failed', error: s.error, activityItem:settleActivity(s,'failed') };
      }
      invariant(event.tabId === s.tabId && event.documentKey === s.documentKey && conversationId(event.url) === s.conversationId, 'PAGE_IDENTITY_MISMATCH');
      invariant(['snapshot','image','activity','native_timeline','completed','failed','waiting','heartbeat'].includes(event.kind),'UNKNOWN_EVENT');
      if(event.kind==='heartbeat'){
        // A verified same-tab/document/turn browser monitor is alive.
        // It renews the watchdog without inventing a generated answer.
        if(!s.turn.outcome)s.turn.lastObservedAt=now();
        return null;
      }
      if (s.turn.outcome) {
        invariant(s.turn.outcome === event.kind && (event.kind !== 'completed' || event.messageId === (s.turn.finalMessageId ?? s.turn.lastMessageId)), 'TURN_INACTIVE');
        return null;
      }
      if (event.kind === 'native_timeline') {
        const existing=s.history.find(row=>row.id===nativeItem.id);
        invariant(existing||s.history.length<LIMITS.history,'HISTORY_LIMIT');
        const item=recordNativeTimeline(s,nativeItem);
        if(!item)return null;
        s.turn.lastObservedAt=now();
        return {id:s.id,turnId:s.turn.id,state:'native-timeline',item};
      }
      if (event.kind === 'image') {
        const key=`${event.messageId}:${event.assetId}`, rowId=`image:${s.turn.id}:${key}`;
        const row={type:'plugin',id:rowId,pluginId:'chatmode-in-paseo',kind:'generated-image',version:1,data:image};
        const old=s.history.findIndex(x=>x.id===rowId);
        if(old>=0 && JSON.stringify(s.history[old])===JSON.stringify(row))return null;
        s.turn.imageKeys??=[];
        invariant(s.turn.imageKeys.includes(key)||s.turn.imageKeys.length<IMAGE_LIMITS.count,'IMAGE_COUNT_LIMIT');
        if(!s.turn.imageKeys.includes(key))s.turn.imageKeys.push(key);
        if(old>=0)s.history[old]=row;else s.history.push(row);
        invariant(s.history.length<=LIMITS.history,'HISTORY_LIMIT');
        s.turn.lastObservedAt=now(); // Newly captured, verified native image.
        return {id:s.id,turnId:s.turn.id,state:'image',item:row};
      }
      if (event.kind === 'activity') {
        const rowId=`activity:${s.turn.id}`;
        const row={type:'plugin',id:rowId,pluginId:'chatmode-in-paseo',kind:'native-activity',version:1,
          data:{turnId:s.turn.id,...activity}};
        const index=s.history.findIndex(x=>x.id===rowId);
        if(index>=0 && JSON.stringify(s.history[index])===JSON.stringify(row))return null;
        if(index>=0)s.history[index]=row;else s.history.push(row);
        invariant(s.history.length<=LIMITS.history,'HISTORY_LIMIT');
        s.turn.lastObservedAt=now(); // Changed native activity is actual progress.
        return {id:s.id,turnId:s.turn.id,state:'activity',item:row};
      }
      if (event.kind === 'snapshot') {
        verifyNativeId(event.messageId); text(event.text, LIMITS.answer, true);
        if (s.turn.lastMessageId === event.messageId && s.turn.lastText === event.text) return null;
        const turnPrefix = `assistant:${s.turn.id}:`;
        const parts = s.history.filter(x => x.id.startsWith(turnPrefix) && x.id !== `${turnPrefix}${event.messageId}`);
        if (parts.length >= LIMITS.turnFragments || parts.reduce((n, x) => n + x.text.length, event.text.length) > LIMITS.answer) {
          finishTurn(s, 'failed'); s.status = 'blocked'; s.error = 'TURN_OUTPUT_LIMIT';
          return { id: s.id, turnId: s.turn.id, state: 'failed', error: s.error, activityItem:settleActivity(s,'failed') };
        }
        s.turn.lastMessageId = event.messageId; s.turn.lastText = event.text;
        const row = { type: 'assistant_message', id: `assistant:${s.turn.id}:${event.messageId}`, text: event.text };
        const old = s.history.findIndex(x => x.id === row.id); if (old >= 0) s.history[old] = row; else s.history.push(row);
        invariant(s.history.length <= LIMITS.history, 'HISTORY_LIMIT');
        s.turn.lastObservedAt=now(); // Changed assistant output, not idle UI.
        return { id: s.id, turnId: s.turn.id, state: 'snapshot', item: row };
      }
      if (event.kind === 'waiting') {
        s.turn.lastObservedAt=now();
        return {id:s.id,turnId:s.turn.id,state:'waiting',
          ...(['final-unconfirmed','transcript-unavailable'].includes(event.reason)?{reason:event.reason}:{})};
      }
      if (event.kind === 'completed') {
        if(event.finalKind==='image') {
          const keys=s.turn.imageKeys??[];
          invariant(event.finalConfirmed===true && keys.length>0 && Array.isArray(event.imageKeys) && new Set(event.imageKeys).size===event.imageKeys.length &&
            JSON.stringify([...keys].sort())===JSON.stringify([...event.imageKeys].sort()) && keys.some(k=>k.startsWith(event.messageId+':')),'FINAL_UNCONFIRMED');
        } else invariant(event.finalConfirmed === true && event.messageId === s.turn.lastMessageId && typeof s.turn.lastText === 'string', 'FINAL_UNCONFIRMED');
        s.turn.finalMessageId = event.messageId;
        finishTurn(s, 'completed'); s.status = 'idle';
        for (const c of Object.values(d.commands)) if (c.kind === 'stop' && c.sessionId === s.id && c.payload.turnId === s.turn.id && pending(c)) {
          c.phase = 'done'; c.result = { stopped: true, reason: 'already-completed' }; settledStops.push(c.id);
        }
      } else {
        finishTurn(s, 'failed'); s.status = s.conversationId?'idle':'blocked'; s.error = text(event.error, 160);
      }
      const activityItem=settleActivity(s,s.turn.outcome);
      return { id: s.id, turnId: s.turn.id, state: s.turn.outcome, error: s.error, activityItem };
    });
    for (const id of settledStops) this.settle(id, null, { stopped: true, reason: 'already-completed' });
    if (notification) this.emit(notification.id, notification);
    if (notification) await this.finishArchive(event.sessionId);
    return { accepted: true, active: !this.snapshot(event.sessionId).turn?.outcome };
  }
  async interrupt(id) {
    invariant(!this.closed, 'RUNTIME_CLOSED');
    const expected = this.snapshot(id).turn?.id;
    const decision = await this.store.transaction(d => {
      const s = d.sessions[id]; invariant(s, 'SESSION_UNKNOWN');
      if (!busy(s) || !s.turn || s.turn.outcome || s.turn.id !== expected) return { settled: true, stopped: s.status === 'idle' };
      s.turn.cancelRequested = true;
      const c = d.commands[s.turn.commandId];
      if (!s.turn.authorized && s.turn.origin!=='browser') {
        if (c && pending(c)) { c.phase = 'failed'; c.error = 'CANCELLED_BEFORE_SEND'; }
        finishTurn(s, 'canceled'); s.status = 'idle'; discardUnsent(s,c);
        return { before: true, commandId: c?.id, turnId: s.turn.id, activityItem:settleActivity(s,'canceled') };
      }
      if (!s.turn.nativeMessageId) return { uncertain: true, turnId: s.turn.id };
      const old = Object.values(d.commands).find(c => c.kind === 'stop' && c.sessionId === id && c.payload.turnId === s.turn.id && pending(c));
      if (old) return { commandId: old.id, turnId: s.turn.id };
      invariant(Object.values(d.commands).filter(pending).length < LIMITS.commands, 'QUEUE_FULL');
      const commandId = randomUUID(); s.status = 'stopping';
      d.commands[commandId] = { id: commandId, kind: 'stop', sessionId: id, payload: { turnId: s.turn.id,
        tabId: s.tabId, conversationId: s.conversationId, nativeMessageId: s.turn.nativeMessageId }, phase: 'queued', createdAt: now(), deadline: now() + this.commandTimeout };
      return { commandId, turnId: s.turn.id };
    }, { control: true });
    if (decision.settled) return { stopped: decision.stopped };
    if (decision.before) {
      if (decision.commandId) {
        await this.inputFiles.remove(decision.commandId);
        this.settle(decision.commandId, 'CANCELLED_BEFORE_SEND');
      }
      this.emit(id, { id, turnId: decision.turnId, state: 'canceled', activityItem:decision.activityItem }); return { stopped: true };
    }
    if (decision.uncertain) { await this.failTurn(id, 'STOP_UNCONFIRMED', true, decision.turnId); throw new BridgeError('STOP_UNCONFIRMED'); }
    try { return await this.wait(decision.commandId); }
    catch (e) { await this.failTurn(id, 'STOP_UNCONFIRMED', true, decision.turnId); throw e; }
  }
  async rebindObservation(proof) {
    return this.store.transaction(d => {
      const s = d.sessions[proof.sessionId];
      invariant(s && ['running','stopping'].includes(s.status) && s.turn && !s.turn.outcome, 'TURN_INACTIVE');
      invariant(s.turn.id === proof.turnId && s.turn.lease === proof.lease && s.turn.nativeMessageId === proof.nativeMessageId, 'TURN_IDENTITY_MISMATCH');
      invariant(proof.previousDocumentKey === s.documentKey && conversationId(proof.url) === s.conversationId, 'PAGE_IDENTITY_MISMATCH');
      invariant(Number.isInteger(proof.tabId) && proof.tabId >= 0 && typeof proof.documentKey === 'string', 'INVALID_TAB');
      identifier(proof.documentKey);
      invariant(!Object.values(d.sessions).some(other => other.id !== s.id && other.tabId === proof.tabId), 'TAB_ALREADY_OWNED');
      s.tabId = proof.tabId; s.documentKey = proof.documentKey;
      return { sessionId: s.id, turnId: s.turn.id, lease: s.turn.lease, nativeMessageId: s.turn.nativeMessageId,
        tabId: s.tabId, documentKey: s.documentKey, conversationId: s.conversationId };
    }, { control: true });
  }
  async abandon(id) {
    await this.store.transaction(d => {
      const s = d.sessions[id]; invariant(s && s.status === 'blocked', 'SESSION_NOT_BLOCKED');
      invariant(!this.owners.has(id), 'SESSION_ATTACHED', 'Close this Agent in Paseo first.');
      s.status = 'abandoned'; s.abandonedAt = now();
      // This only ends local tracking; it does NOT claim the website or MCP stopped.
    }, { control: true });
    await this.finishArchive(id);
    return { abandoned: true };
  }
  async tick(time = now()) {
    const peek = this.store.read();
    if (!Object.values(peek.commands).some(c => pending(c) && c.deadline < time) &&
      !Object.values(peek.sessions).some(s=>busy(s)&&time-(s.turn.lastObservedAt??s.turn.createdAt)>this.turnTimeout))return;
    const expired = await this.store.transaction(d => {
      const out = [];
      for (const c of Object.values(d.commands)) if (pending(c) && c.deadline < time) {
        const s=c.sessionId&&d.sessions[c.sessionId];
        if (c.kind === 'send' && c.phase === 'authorized' && pendingReceipt(c, s, s?.conversationId)) {
          out.push({ ...c, pendingReceipt:true, sessionId:s.id, turnId:s.turn.id });
          continue;
        }
        const uncertain = c.phase === 'authorized';
        if (c.phase === 'claimed' && ['open', 'configure', 'ensure'].includes(c.kind)) {
          const s = d.sessions[c.sessionId]; if (s && s.status === 'idle') { s.status = 'blocked'; s.error = 'CONTROL_UNCONFIRMED'; }
        }
        c.phase = 'failed'; c.error = uncertain ? 'DELIVERY_UNCONFIRMED' : 'BRIDGE_TIMEOUT';
        out.push({ ...c, uncertain });
      }
      return out;
    });
    for (const c of expired) {
      if(c.pendingReceipt){
        this.settle(c.id,null,c.result);
        this.emit(c.sessionId,{id:c.sessionId,turnId:c.turnId,state:'receipt-pending'});
        continue;
      }
      this.settle(c.id, c.error);
      if (c.kind === 'send' || c.kind === 'stop') await this.failTurn(c.sessionId, c.error, c.uncertain || c.kind === 'stop', c.payload.turnId);
    }
    for (const s of Object.values(this.store.read().sessions))
      if(busy(s)&&time-(s.turn.lastObservedAt??s.turn.createdAt)>this.turnTimeout)
        await this.failTurn(s.id,'TURN_TIMEOUT',true);
    for (const id of new Set(expired.map(command => command.sessionId)))
      await this.finishArchive(id);
  }
  async close() {
    this.slots.close(); this.closed = true;
    for (const id of this.waiters.keys()) this.settle(id, 'RUNTIME_CLOSED');
    await this.recover(); await this.store.flush(); this.events.removeAllListeners();
  }
}
