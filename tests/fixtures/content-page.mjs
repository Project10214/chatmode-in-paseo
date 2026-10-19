// Shared offline content.js harness for the continuous page-view contract.
// The real IIFE runs unchanged; tests drive its listener and interval callback.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const script = await readFile(new URL('../../extension/content.js', import.meta.url), 'utf8');
export { EXTENSION, URL_A, LIMIT, clone, item, withoutRaw, controlView, deferred, flush, page, assertObserverOnly };
const EXTENSION = 'offline-extension', URL_A = 'https://chatgpt.com/c/chat-a', LIMIT = 384 * 1024;
const clone = value => structuredClone(value);
const item = (id, text = id, extra = {}) => ({ id, userMessageId: 'user-a', role: 'assistant', lane: 'output',
  kind: 'message', text, format: 'text', order: [1], ...extra });
const withoutRaw = value => ({...value,prose:{status:'unavailable',code:'PUBLIC_MESSAGE_SUPPLEMENT_UNAVAILABLE'}});
const controlView = (state, observedAt = 0) => ({ observedAt, state, readable: true, controls: {
  stop: { visible: state === 'running', enabled: true }, send: { visible: state === 'standby', enabled: false },
  voice: { visible: false, enabled: false },
} });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };

function page(t) {
  const state = { now: 100000, state: 'running', sourceReads: 0, controlReads: 0, transcriptReads: 0,
    messagesReads: 0, sends: 0, stops: 0, approvals: 0, configured: 0, catalogued: 0,
    rpcFailures: 0, persistenceAccepted: true, transcriptThrows: true, draft: '', nativeBusy: false, pendingApproval: false,
    source: { conversationId: 'chat-a', items: [item('answer-a', '原始回答')], approvals: [], closedApprovals: [], issues: [] } };
  const requests = [], accepted = [], events = new Map(), intervals = new Map();
  let listener, nextTimer = 0, commandSequence = 0;
  const location = { hostname: 'chatgpt.com', protocol: 'https:', pathname: '/c/chat-a', href: URL_A };
  const on = (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); };
  const off = (name, fn) => { events.get(name)?.delete(fn); };
  const emit = name => { for (const fn of [...events.get(name) ?? []]) fn(); };
  const D = {
    conversationId: () => location.pathname.split('/')[2] ?? null,
    state: () => { throw new Error('legacy native state must not be sampled'); },
    refreshTranscript: async () => { state.transcriptReads++; if (state.transcriptThrows) throw new Error('transcript unavailable'); },
    messages: () => { state.messagesReads++; if (state.transcriptThrows) throw new Error('native messages unavailable'); return []; },
    preparePage: async guard => { state.transcriptReads++; guard(); },
    configure: async (config, guard) => { state.configured++; guard(); return config; },
    catalog: async guard => { state.catalogued++; guard(); return { models: [] }; },
    authored: () => state.draft, approvalPending: () => state.pendingApproval,
    send: async (command, authorize, guard, readFile) => {
      state.sends++; guard();
      if (command.payload.files?.length) await readFile({ type: 'input-chunk', id: command.id, lease: command.lease, index: 0, offset: 0 });
      await authorize(); guard(true);
      if (state.sendBehavior) return state.sendBehavior(command, guard);
      return { receipt: true, nativeMessageId: 'real-send-user', url: location.href };
    },
    probePendingReceipt: async turnId => state.probeReceipt ? state.probeReceipt(turnId)
      : { available: true, nativeMessageId: 'late-real-user' },
    stop: async args => {
      state.stops++; state.stopArgs = args; args.guard();
      if (state.stopBehavior) await state.stopBehavior(args);
      args.guard(); state.state = 'standby'; return { stopped: true };
    },
    answerApproval: async args => {
      state.approvals++; state.approvalArgs = args; args.guard();
      if (state.approvalBehavior) await state.approvalBehavior(args);
      args.guard(); return { answered: true };
    },
  };
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, URL, console, location,
    Date: class extends Date { static now() { return state.now; } },
    addEventListener: on, removeEventListener: off,
    navigation: { addEventListener: on, removeEventListener: off },
    setInterval: (fn, ms) => { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => { intervals.delete(id); },
    CIP_DOM: D,
    CIP_COS_CONTROLS: { composer: () => ({}), generating: () => state.nativeBusy, approvalWaiting: () => state.pendingApproval },
    CIP_PAGE_CONTENT: { read: () => {
      state.sourceReads++;
      if (state.readSource) return state.readSource();
      return { ...clone(state.source), observedAt: state.now };
    } },
    CIP_PAGE_CONTROLS: { read: () => {
      state.controlReads++;
      if (state.readControls) return state.readControls();
      return controlView(state.state, state.now);
    } },
    chrome: { runtime: { id: EXTENSION,
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async message => {
        const request = clone(message); requests.push(request);
        let response;
        if (state.rpc) response = await state.rpc(request);
        if (response === undefined) {
          if (request.type === 'page-view') {
            if (state.rpcFailures-- > 0) return { ok: false, error: 'OFFLINE_TEST_DELIVERY_FAILED' };
            response = { ok: true, value: { accepted: state.persistenceAccepted, active: false, host: 'unconfirmed' } };
          } else response = { ok: true, value: { authorized: true, accepted: true } };
        }
        if (request.type === 'page-view' && response?.ok && response.value?.accepted === true) accepted.push(request);
        return response;
      },
    } },
  });
  // The entire real IIFE runs unchanged. No replacement collectors or test-only
  // exports are injected; tests drive its public listener and interval callback.
  vm.runInContext(script, context);
  const documentKey = context.__CIP_CONTENT__.documentKey;
  const session = (extra = {}) => ({ sessionId: 'session-a', conversationId: 'chat-a', tabId: 71,
    documentKey, observationLease: 'observation-a', generation: 0, runId: null, ...extra });
  const message = (value, sender = { id: EXTENSION }) => new Promise(resolve => listener(value, sender, result => resolve(clone(result))));
  const tick = async (ms = 750) => { state.now += ms; for (const { fn } of [...intervals.values()]) await fn(); await flush(); };
  const navigate = conversationId => {
    location.pathname = conversationId === null ? '/' : '/c/' + conversationId;
    location.href = 'https://chatgpt.com' + location.pathname;
    emit('currententrychange');
  };
  const command = (kind, payload = {}, extra = {}) => ({ id: `command-${++commandSequence}`, kind, documentKey, tabId: 71,
    lease: 'one-shot-command-lease', deadline: state.now + 30000,
    payload: { conversationId: 'chat-a', observationLease: 'observation-a', turnId: 'send-turn', config: {},
      ...(['stop', 'approval'].includes(kind) ? { documentKey } : {}), ...payload }, ...extra });
  t.after(() => { emit('pagehide'); });
  return { state, requests, accepted, intervals, session, command, message, tick, navigate, emit,
    identity: () => message({ type: 'identity' }),
    monitor: async s => { const reply = await message({ type: 'monitor', session: s ?? session() }); await flush(); return reply; },
    send: async c => { const result = await message({ type: 'command', command: c }); await flush(); return result; },
    attempts: () => requests.filter(request => request.type === 'page-view'),
    rawMessage: (value, sender, respond) => listener(value, sender, respond),
    rawReader: read => { context.CIP_PUBLIC_MESSAGES = {read}; },
  };
}

function assertObserverOnly(f) {
  assert.equal(f.state.sends, 0); assert.equal(f.state.approvals, 0); assert.equal(f.state.stops, 0);
  assert.equal(f.state.transcriptReads, 0); assert.equal(f.state.messagesReads, 0);
  assert.ok(f.requests.every(request => request.type === 'page-view'));
}

