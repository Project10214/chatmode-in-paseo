import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const script = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const ENGINE = 'cos-native-alpha4.3', EXTENSION = 'a'.repeat(32), VERSION = 'offline-test-8';
const URL_A = 'https://chatgpt.com/c/chat-a';
const descriptor = (extra = {}) => ({
  sessionId: 'session-a', conversationId: 'chat-a', tabId: 71, documentKey: 'document-a',
  observationLease: 'observation-1', generation: 0, runId: null, ...extra,
});
const sender = (extra = {}) => ({ id: EXTENSION, tab: { id: 71 }, frameId: 0, url: URL_A, ...extra });
const frame = (s = descriptor(), extra = {}) => ({
  sessionId: s.sessionId, observationLease: s.observationLease,
  documentKey: s.documentKey, tabId: s.tabId,
  url: `https://chatgpt.com/c/${s.conversationId}`, sequence: 1,
  view: { conversationId: s.conversationId, page: { state: 'abnormal' }, items: [], approvals: [], issues: [] },
  ...extra,
});
const forbiddenRoutes = ['/active', '/bindings', '/event', '/recover-observation', '/external-turn', '/external-gap'];

async function worker(t, options = {}) {
  const local = structuredClone(options.local ?? {
    config: { endpoint: 'http://127.0.0.1:17843', token: 'offline-only' },
    tabs: { 71: { sessionId: 'session-a', documentKey: 'document-a' } }, loadedChromeVersion: VERSION,
  });
  const ephemeral = {}, calls = [], messages = [], events = {}, created = [], reloads = [];
  const state = {
    observations: [], commands: [], targets: [], helloProtocol: 9,
    tabs: new Map((options.pageTabs ?? [{ id: 71, url: URL_A }]).map(tab => [tab.id, structuredClone(tab)])),
    identities: new Map(), pageState: 'standby', monitorOk: true,
    receipt: { ok: false, error: 'TRANSCRIPT_UNCONFIRMED' },
    queryFails: false, getFails: new Set(), gapFailures: 0, resumeFailures: 0,
    noRecoveryInventory: false, clock: { now: 100000 }, ...options.state,
  };
  for (const [id, tab] of state.tabs) state.identities.set(id, {
    engine: ENGINE, protocol: 9, documentKey: id === 71 ? 'document-a' : `document-${id}`, url: tab.url,
  });
  for (const id of options.missingIdentities ?? []) state.identities.delete(id);
  let listener, nextTabId = 72, epoch = 1;
  const response = (value, ok = true) => ({ ok, text: async () => JSON.stringify(value) });
  const context = vm.createContext({
    URL, AbortSignal, structuredClone, crypto: webcrypto, console,
    Date: class extends Date { static now() { return state.clock.now; } },
    // Keep bounded real RPC timeouts, but do not start a perpetual pump timer.
    setTimeout: (fn, ms) => ms === 1000 ? 0 : setTimeout(fn, ms),
    clearTimeout: handle => { if (handle) clearTimeout(handle); },
    fetch: async (input, init) => {
      assert.equal(new URL(input).origin, 'http://127.0.0.1:17843', 'mock API must never reach a real daemon');
      const route = new URL(input).pathname, body = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ route, body, method: init.method, headers: structuredClone(init.headers) });
      assert.ok(!forbiddenRoutes.includes(route), `removed observer route was called: ${route}`);
      if (state.onApi) {
        const result = await state.onApi(route, body);
        if (result !== undefined) return result;
      }
      if (route === '/hello') return response({ protocol: state.helloProtocol, product: 'chatmode-in-paseo' });
      if (route === '/commands') return response({ commands: state.commands });
      if (route === '/observations') return response({ sessions: state.observations });
      if (route === '/rebind-observation') {
        const { previousDocumentKey, url, ...prior } = body;
        const rebound = { ...prior, observationLease: `observation-rebound-${++epoch}`, generation: prior.generation + 1 };
        state.observations = state.observations.map(s => s.sessionId === rebound.sessionId ? rebound : s);
        return response(rebound);
      }
      if (route === '/observation-gap') {
        if (state.gapFailures-- > 0) return response({ error: 'OFFLINE_TEST_RETRY' }, false);
        return response({ accepted: true });
      }
      if (route === '/page-view' || route === '/receipt-observation') return response({ accepted: true });
      if (route === '/recovery-targets')
        return state.noRecoveryInventory ? response({ error: 'ROUTE_NOT_FOUND' }, false) : response({ sessions: state.targets });
      if (route === '/resume-agent') {
        if (state.resumeFailures-- > 0) return response({ error: 'OFFLINE_TEST_RETRY' }, false);
        return response({ queued: true });
      }
      if (route === '/claim') {
        const command = state.commands.find(c => c.id === body.id);
        assert.ok(command, 'only a mock queued command may be claimed');
        return response({ ...command, tabId: body.tabId, documentKey: body.documentKey,
          lease: 'send-command-lease', deadline: state.clock.now + 60000 });
      }
      if (['/result', '/authorize', '/fail-unclaimed', '/bind-conversation', '/input-chunk'].includes(route))
        return response({ accepted: true, allowed: true });
      throw new Error(`Unmocked API route: ${route}`);
    },
    chrome: {
      runtime: {
        id: EXTENSION, getURL: p => `chrome-extension://${EXTENSION}/${p}`, getManifest: () => ({ version: VERSION }),
        onMessage: { addListener: fn => { listener = fn; } },
        onInstalled: { addListener: fn => { events.installed = fn; } },
        onStartup: { addListener: fn => { events.startup = fn; } },
        sendNativeMessage: async () => { throw new Error('must never launch a real app'); },
      },
      storage: {
        local: { setAccessLevel: async () => {}, get: async () => structuredClone(local),
          set: async patch => Object.assign(local, structuredClone(patch)) },
        session: { get: async () => structuredClone(ephemeral), set: async patch => Object.assign(ephemeral, structuredClone(patch)) },
      },
      alarms: { create: () => {}, onAlarm: { addListener: fn => { events.alarm = fn; } } },
      tabs: {
        get: async id => {
          if (state.getFails.has(id) || !state.tabs.has(id)) throw new Error('offline missing/unavailable tab');
          return structuredClone(state.tabs.get(id));
        },
        query: async () => {
          if (state.queryFails) throw new Error('offline tab enumeration failure');
          return [...state.tabs.values()].map(tab => structuredClone(tab));
        },
        create: async ({ url, active }) => {
          while (state.tabs.has(nextTabId)) nextTabId++;
          const tab = { id: nextTabId++, url, active, status: 'complete' };
          created.push(structuredClone(tab)); state.tabs.set(tab.id, tab);
          state.identities.set(tab.id, { engine: ENGINE, protocol: 9, documentKey: `new-document-${tab.id}`, url });
          return structuredClone(tab);
        },
        reload: async id => {
          reloads.push(id);
          const identity = state.identities.get(id);
          if (identity) identity.documentKey = `reloaded-${id}`;
        },
        remove: async id => { state.tabs.delete(id); },
        onRemoved: { addListener: fn => { events.removed = fn; } },
        sendMessage: async (id, message) => {
          messages.push({ tabId: id, message: structuredClone(message) });
          if (state.onRpc) {
            const result = await state.onRpc(id, message);
            if (result !== undefined) return result;
          }
          if (message.type === 'identity') {
            const value = state.identities.get(id);
            return value ? { ok: true, value: structuredClone(value) } : { ok: false, error: 'CONTENT_UNAVAILABLE' };
          }
          if (message.type === 'monitor') {
            if (state.monitorOk && state.identities.has(id)) state.identities.get(id).observationRevoked = false;
            return { ok: state.monitorOk, value: { observing: true, state: state.pageState } };
          }
          if (message.type === 'pending-receipt') return structuredClone(state.receipt);
          if (message.type === 'page-ready') return { ok: true, value: { composer: true } };
          if (message.type === 'cancel-command') return { ok: true };
          if (message.type === 'command') return { ok: true, value: { receipt: true, url: state.tabs.get(id).url, nativeMessageId: 'actual-send-user' } };
          if (message.type === 'catalog-idle') return { ok: true, value: { idle: false } };
          throw new Error(`Unmocked content RPC: ${message.type}`);
        },
      },
    },
  });
  // Run the real source, including its startup pump, without replacing any
  // production branch. The appended hooks expose existing functions only.
  vm.runInContext(script + `\nglobalThis.offlineWorker = {
    pump, watch: s => watchSession(s, config), execute,
    snapshot: () => structuredClone({ tabs, ledger, bindingWaits, upgradeRecovery }),
    async drain() {
      if (pumpFlight) await pumpFlight;
      await Promise.allSettled([...executions.values(), ...receipts.values(), ...monitors.values()]);
      await storageTail;
    },
  };`, context);
  const api = context.offlineWorker;
  await api.drain();
  calls.length = 0; messages.length = 0;
  t.after(async () => { await api.drain(); });
  return {
    state, local, ephemeral, calls, messages, events, created, reloads,
    watch: async s => { await api.watch(s ?? descriptor()); await api.drain(); },
    pump: async () => { await api.pump(); await api.drain(); },
    run: async command => { await api.execute(command); await api.drain(); },
    snapshot: () => structuredClone(api.snapshot()),
    message: (message, from = sender()) => new Promise(resolve => listener(message, from, value => resolve(structuredClone(value)))),
    byRoute: route => calls.filter(call => call.route === route),
    byMessage: type => messages.filter(call => call.message.type === type),
  };
}

function assertReadOnly(f) {
  assert.equal(f.calls.some(call => ['/claim', '/authorize', '/result', '/fail-unclaimed'].includes(call.route)), false);
  assert.equal(f.byMessage('command').length, 0);
  assert.equal(f.calls.some(call => forbiddenRoutes.includes(call.route)), false);
}

test('CONT-01 one /observations pump monitors running, standby and abnormal bindings without native-user/body/state gates', async t => {
  const pageTabs = [71, 72, 73].map((id, i) => ({ id, url: `https://chatgpt.com/c/chat-${i}` }));
  const f = await worker(t, { pageTabs, local: {
    config: { endpoint: 'http://127.0.0.1:17843', token: 'offline-only' }, loadedChromeVersion: VERSION, tabs: {},
  } });
  const sessions = pageTabs.map((tab, i) => descriptor({
    sessionId: `session-${i}`, conversationId: `chat-${i}`, tabId: tab.id,
    documentKey: i === 0 ? 'document-a' : `document-${tab.id}`,
    observationLease: `observation-${i}`, runId: i === 0 ? null : `host-run-${i}`,
  }));
  f.state.observations = sessions;
  for (const state of ['running', 'standby', 'abnormal']) {
    f.state.pageState = state;
    for (const identity of f.state.identities.values()) {
      identity.nativeMessageId = 'a-later-native-user';
      identity.observationError = 'NATIVE_MESSAGE_ID_UNPROVEN';
    }
    await f.pump();
  }
  assert.equal(f.byRoute('/observations').length, 3);
  assert.equal(f.byMessage('monitor').length, 9);
  for (const s of sessions) {
    const monitors = f.byMessage('monitor').filter(call => call.message.session.sessionId === s.sessionId);
    assert.equal(monitors.length, 3);
    assert.deepEqual(monitors[0].message.session, s);
    assert.equal(f.local.tabs[s.tabId].observationLease, s.observationLease);
  }
  assert.equal(f.byRoute('/rebind-observation').length, 0);
  assertReadOnly(f);
});

test('CONT-02 a missing or newer native user never blocks same-document observation', async t => {
  const f = await worker(t);
  for (const nativeMessageId of [undefined, null, 'another-user', 'fallback-turn-layout:user']) {
    f.state.identities.get(71).nativeMessageId = nativeMessageId;
    await f.watch(descriptor({ nativeMessageId: 'old-user' }));
  }
  assert.equal(f.byMessage('monitor').length, 4);
  assert.equal(f.byRoute('/rebind-observation').length, 0);
  assert.deepEqual(f.local.bindingWaits ?? {}, {});
  assertReadOnly(f);
});

test('CONT-03 document replacement rebinds exact conversation with a fresh observation lease, not the Send lease', async t => {
  const local = { config: { endpoint: 'http://127.0.0.1:17843', token: 'offline-only' }, loadedChromeVersion: VERSION,
    tabs: { 71: { sessionId: 'session-a', documentKey: 'document-a' } },
    ledger: { sent: { phase: 'authorized', lease: 'one-shot-send', command: { id: 'sent', kind: 'send' } } } };
  const f = await worker(t, { local }), s = descriptor({ turnId: 'send-turn', lease: 'one-shot-send', nativeMessageId: 'old-user' });
  f.state.identities.get(71).documentKey = 'reloaded-document';
  f.state.identities.get(71).nativeMessageId = undefined;
  await f.watch(s);
  const body = f.byRoute('/rebind-observation')[0].body;
  assert.deepEqual(body, { ...s, previousDocumentKey: 'document-a', tabId: 71, documentKey: 'reloaded-document', url: URL_A });
  const next = f.byMessage('monitor')[0].message.session;
  assert.notEqual(next.observationLease, s.observationLease);
  assert.equal(next.generation, 1);
  assert.equal(next.lease, 'one-shot-send');
  assert.equal(next.turnId, s.turnId);
  assert.deepEqual(f.local.ledger, local.ledger);
  assert.equal(f.local.tabs[71].observationLease, next.observationLease);
  assertReadOnly(f);
});

test('CONT-04 same-document A -> B -> A revocation rejects queued old frames and rotates only observation custody', async t => {
  const f = await worker(t), s = descriptor({ lease: 'send-unchanged', turnId: 'send-turn' });
  await f.watch(s);
  f.state.identities.get(71).observationRevoked = true;
  assert.equal((await f.message({ type: 'page-view', event: frame(s) })).ok, false);
  assert.equal(f.byRoute('/page-view').length, 0);
  await f.watch(s);
  const next = f.byMessage('monitor').at(-1).message.session;
  assert.equal(f.byRoute('/rebind-observation').length, 1);
  assert.equal(next.documentKey, s.documentKey);
  assert.notEqual(next.observationLease, s.observationLease);
  assert.equal(next.lease, s.lease);
  assert.equal((await f.message({ type: 'page-view', event: frame(s) })).ok, false);
  assert.equal((await f.message({ type: 'page-view', event: frame(next) })).ok, true);
  await f.watch(next);
  assert.equal(f.byRoute('/rebind-observation').length, 1, 'new epoch must not rebind repeatedly');
  assertReadOnly(f);
});

test('CONT-05 foreign current routes are never read; recovery uses only the exact bound URL', async t => {
  const f = await worker(t), active = descriptor({ active: true });
  await f.watch(active);
  f.messages.length = 0;
  f.state.tabs.get(71).url = 'https://chatgpt.com/c/unrelated';
  f.state.identities.get(71).url = f.state.tabs.get(71).url;
  await f.watch(active);
  assert.equal(f.messages.some(call => call.tabId === 71), false);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].url, URL_A);
  assert.equal(f.state.tabs.get(71).url, 'https://chatgpt.com/c/unrelated');
  assert.equal(f.local.tabs[71].observationRevoked, true);
  assert.equal((await f.message({ type: 'page-view', event: frame() })).ok, false);
  assertReadOnly(f);
});

for (const mode of ['same-tab-foreign-owner', 'replacement-foreign-owner', 'ambiguous-tabs', 'query-failure', 'pending-foreign-route']) {
  test(`CONT-SAFE ${mode}: no foreign identity read/monitor or observation takeover`, async t => {
    const f = await worker(t, { local: {
      config: { endpoint: 'http://127.0.0.1:17843', token: 'offline-only' }, loadedChromeVersion: VERSION,
      tabs: mode === 'same-tab-foreign-owner' ? { 71: { sessionId: 'foreign' } }
        : mode === 'replacement-foreign-owner' ? { 72: { sessionId: 'foreign' } } : {},
    } });
    if (mode === 'replacement-foreign-owner') {
      f.state.tabs.delete(71); f.state.tabs.set(72, { id: 72, url: URL_A });
    }
    if (mode === 'ambiguous-tabs') {
      f.state.tabs.delete(71);
      f.state.tabs.set(72, { id: 72, url: URL_A }); f.state.tabs.set(73, { id: 73, url: URL_A });
    }
    if (mode === 'query-failure') { f.state.tabs.delete(71); f.state.queryFails = true; }
    if (mode === 'pending-foreign-route') f.state.tabs.get(71).pendingUrl = 'https://chatgpt.com/c/foreign';
    await f.watch();
    assert.equal(f.byMessage('identity').length, 0);
    assert.equal(f.byMessage('monitor').length, 0);
    assert.equal(f.byRoute('/rebind-observation').length, 0);
    assert.equal(f.created.length, 0);
    assertReadOnly(f);
  });
}

test('CONT-06 Chrome restart reuses a persisted replacement and rebinds without the old native user', async t => {
  const first = await worker(t, { pageTabs: [] });
  await first.watch(descriptor({ active: true }));
  assert.equal(first.created.length, 1);
  const replacement = first.created[0];
  const restarted = await worker(t, { local: first.local, pageTabs: [replacement] });
  restarted.state.identities.get(replacement.id).nativeMessageId = 'newer-external-user';
  await restarted.watch(descriptor({ active: true }));
  assert.equal(restarted.created.length, 0);
  assert.equal(restarted.byRoute('/rebind-observation').length, 1);
  assert.equal(restarted.byMessage('monitor')[0].tabId, replacement.id);
  assert.equal(restarted.local.tabs[71], undefined);
  assertReadOnly(first); assertReadOnly(restarted);
});

test('CONT-07 tab removal does not recreate Chrome windows in the close/Quit callback', async t => {
  const f = await worker(t);
  f.state.tabs.delete(71);
  await f.events.removed(71);
  assert.equal(f.created.length, 0);
  await f.watch(descriptor({ active: true }));
  assert.equal(f.created.length, 1);
  assertReadOnly(f);
});

test('CONT-08 pending receipt never blocks monitoring; recovered evidence uses its separate endpoint and original Send lease', async t => {
  const f = await worker(t), s = descriptor({ receiptPending: true, turnId: 'original-turn', lease: 'original-send-lease' });
  await f.watch(s);
  assert.equal(f.byMessage('monitor').length, 1);
  assert.equal(f.byMessage('pending-receipt').length, 1);
  f.state.receipt = { ok: true, value: { available: true, nativeMessageId: 'recovered-native-user' } };
  await f.watch(s);
  assert.equal(f.byMessage('monitor').length, 2);
  const body = f.byRoute('/receipt-observation')[0].body;
  assert.deepEqual(body, { ...s, nativeMessageId: 'recovered-native-user', url: URL_A });
  assert.equal('kind' in body, false);
  assert.equal(body.observationLease, 'observation-1');
  assert.equal(body.lease, 'original-send-lease');
  assertReadOnly(f);
});

test('CONT-09 receipt read/conflict gaps retry without ending observation or suppressing page frames', async t => {
  const f = await worker(t), s = descriptor({ receiptPending: true, turnId: 'turn', lease: 'send-lease' });
  f.state.receipt = { ok: true, value: { conflict: true } };
  await f.watch(s); f.state.clock.now += 16000; await f.watch(s);
  assert.equal(f.byMessage('monitor').length, 2);
  const gap = f.byRoute('/observation-gap')[0].body;
  assert.deepEqual(gap, { ...s, reason: 'receipt_identity_conflict', url: URL_A });
  const result = await f.message({ type: 'page-view', event: frame(s) });
  assert.equal(result.ok, true);
  assert.equal(f.byRoute('/page-view').length, 1);
  assert.equal(f.byRoute('/receipt-observation').length, 0);
  assertReadOnly(f);
});

test('CONT-10 monitor RPC failure does not suppress independent receipt recovery', async t => {
  const f = await worker(t), s = descriptor({ receiptPending: true, turnId: 'turn', lease: 'send' });
  f.state.monitorOk = false;
  f.state.receipt = { ok: true, value: { available: true, nativeMessageId: 'late-user' } };
  await f.watch(s);
  assert.equal(f.byMessage('monitor').length, 1);
  assert.equal(f.byRoute('/receipt-observation').length, 1);
  assertReadOnly(f);
});

test('CONT-11 unreadable identity gap survives worker restart, gap delivery retries, and later observation resumes', async t => {
  const first = await worker(t);
  first.state.identities.delete(71); await first.watch();
  const restarted = await worker(t, { local: first.local, missingIdentities: [71], state: { observations: [descriptor()] } });
  restarted.state.clock.now += 16000;
  restarted.state.gapFailures = 1;
  await restarted.watch(); await restarted.watch();
  assert.equal(restarted.byRoute('/observation-gap').length, 2);
  assert.equal(restarted.byRoute('/observation-gap')[1].body.reason, 'identity_unavailable');
  restarted.state.identities.set(71, { engine: ENGINE, protocol: 9, documentKey: 'document-a', url: URL_A, observationError: 'BODY_UNREADABLE' });
  await restarted.watch();
  assert.equal(restarted.byMessage('monitor').length, 1);
  assert.deepEqual(restarted.local.bindingWaits, {});
  assertReadOnly(first); assertReadOnly(restarted);
});

test('CONT-12 valid abnormal/no-composer frames forward every raw field, including approvals and unknown items', async t => {
  const f = await worker(t);
  await f.watch();
  f.state.identities.get(71).observationError = 'BODY_UNREADABLE';
  const view = {
    conversationId: 'chat-a', page: { state: 'abnormal', raw: 'Whole page error\nRetry', observedAt: 123 },
    items: [{ id: 'visible-output', text: '公开原文\n'.repeat(1000), kind: 'future_kind' }],
    approvals: [{ id: 'approval-1', title: 'Allow?', actions: ['Allow once', 'Deny'] }],
    closedApprovals: ['approval-old'], issues: [{ code: 'BODY_PARTIAL', text: '原文提示' }],
  };
  const event = frame(descriptor(), { sequence: 42, view });
  // Chrome may retain the document's initial new-chat URL in MessageSender.
  const result = await f.message({ type: 'page-view', event }, sender({ url: 'https://chatgpt.com/' }));
  assert.equal(result.ok, true);
  assert.deepEqual(f.byRoute('/page-view')[0].body, event);
  assert.equal(f.byRoute('/page-view')[0].headers['X-CIP-Engine'], ENGINE);
  assertReadOnly(f);
});

for (const fault of ['foreign-extension', 'subframe', 'http-sender', 'foreign-sender', 'wrong-tab', 'wrong-session',
  'wrong-document', 'wrong-observation-lease', 'send-lease-only', 'event-url', 'view-conversation',
  'actual-url', 'live-document', 'live-revoked', 'bad-sequence']) {
  test(`CONT-FRAME ${fault}: reject before /page-view`, async t => {
    const f = await worker(t), event = frame(), from = sender();
    await f.watch();
    if (fault === 'foreign-extension') from.id = 'b'.repeat(32);
    if (fault === 'subframe') from.frameId = 1;
    if (fault === 'http-sender') from.url = 'http://chatgpt.com/c/chat-a';
    if (fault === 'foreign-sender') from.url = 'https://chatgpt.com.evil.test/c/chat-a';
    if (fault === 'wrong-tab') event.tabId = 72;
    if (fault === 'wrong-session') event.sessionId = 'other';
    if (fault === 'wrong-document') event.documentKey = 'other';
    if (fault === 'wrong-observation-lease') event.observationLease = 'old-epoch';
    if (fault === 'send-lease-only') { delete event.observationLease; event.lease = 'send-lease'; }
    if (fault === 'event-url') event.url = 'https://chatgpt.com/c/other';
    if (fault === 'view-conversation') event.view.conversationId = 'other';
    if (fault === 'actual-url') f.state.tabs.get(71).url = 'https://chatgpt.com/c/other';
    if (fault === 'live-document') f.state.identities.get(71).documentKey = 'reloaded-doc';
    if (fault === 'live-revoked') f.state.identities.get(71).observationRevoked = true;
    if (fault === 'bad-sequence') event.sequence = NaN;
    assert.equal((await f.message({ type: 'page-view', event }, from)).ok, false);
    assert.equal(f.byRoute('/page-view').length, 0);
    assertReadOnly(f);
  });
}

test('CONT-13 navigation during frame identity verification is checked again before forwarding', async t => {
  const f = await worker(t); await f.watch();
  f.state.onRpc = (id, message) => {
    if (message.type === 'identity') {
      const value = structuredClone(f.state.identities.get(id));
      f.state.tabs.get(id).url = 'https://chatgpt.com/c/other';
      return { ok: true, value };
    }
  };
  assert.equal((await f.message({ type: 'page-view', event: frame() })).ok, false);
  assert.equal(f.byRoute('/page-view').length, 0);
  assert.equal(f.local.tabs[71].observationRevoked, true);
  f.state.onRpc = undefined;
  f.state.tabs.get(71).url = URL_A;
  await f.watch();
  assert.equal(f.byRoute('/rebind-observation').length, 1, 'an observed foreign route requires a new epoch even after returning');
  assertReadOnly(f);
});

test('CONT-14 legacy idle/turn observation messages have no compatibility forwarding path', async t => {
  const f = await worker(t); await f.watch();
  f.calls.length = 0;
  for (const type of ['idle-notice', 'observation', 'observation-recover']) {
    const result = await f.message({ type, event: frame() });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'UNKNOWN_MESSAGE');
  }
  assert.equal(f.calls.length, 0);
  assertReadOnly(f);
});

test('CONT-15 missing observation protocol fields do not fall back to turn/native-message leases', async t => {
  const f = await worker(t);
  for (const extra of [{ observationLease: undefined }, { generation: undefined }, { runId: undefined }])
    await f.watch(descriptor({ turnId: 'old-turn', lease: 'send', nativeMessageId: 'old-user', ...extra }));
  assert.equal(f.byMessage('monitor').length, 0);
  assert.equal(f.byRoute('/rebind-observation').length, 0);
  assertReadOnly(f);
});

test('CONT-16 protocol 7 is refused before observing or consuming a pairing code', async t => {
  const f = await worker(t); f.state.helloProtocol = 7;
  await f.pump();
  assert.equal(f.byRoute('/observations').length, 0);
  assert.equal(f.byRoute('/commands').length, 0);
  const result = await f.message({ type: 'pair', code: 'must-not-consume' },
    { id: EXTENSION, url: `chrome-extension://${EXTENSION}/popup.html` });
  assert.equal(result.error, 'PROTOCOL_MISMATCH');
  assert.equal(f.byRoute('/pair').length, 0);
});

test('CONT-17 one-shot Send authorization and file-chunk gates remain separate from observation ownership', async t => {
  const f = await worker(t);
  const command = { id: 'send-once', sessionId: 'session-a', kind: 'send', payload: {
    tabId: 71, text: 'synthetic outbound fixture', files: [{ id: 'file-fixture' }],
  } };
  f.state.commands = [command];
  let clicks = 0;
  f.state.onRpc = async (id, message) => {
    if (message.type !== 'command') return;
    const claim = message.command, proof = { id: claim.id, lease: claim.lease, documentKey: claim.documentKey };
    const chunk = await f.message({ type: 'input-chunk', ...proof, index: 0, offset: 0 });
    assert.equal(chunk.ok, true);
    assert.equal((await f.message({ type: 'authorize', ...proof })).ok, true);
    assert.equal((await f.message({ type: 'authorize', ...proof })).ok, false, 'authorization is one-shot');
    assert.equal((await f.message({ type: 'input-chunk', ...proof, index: 0, offset: 0 })).ok, false, 'post-authorization file reads stay closed');
    clicks++;
    return { ok: true, value: { receipt: true, nativeMessageId: 'sent-user', url: URL_A } };
  };
  await f.run(command); await f.run(command);
  assert.equal(clicks, 1);
  assert.equal(f.byRoute('/claim').length, 1);
  assert.equal(f.byRoute('/authorize').length, 1);
  assert.equal(f.byRoute('/input-chunk').length, 1);
  assert.equal(f.byRoute('/result').length, 1);
  assert.equal(f.local.ledger['send-once'].phase, 'acked');
  assert.equal(f.local.ledger['send-once'].lease, 'send-command-lease');
});

test('CONT-18 upgrade recovery reuses persisted ready work without duplicate reload or Send', async t => {
  const f = await worker(t);
  f.state.targets = [descriptor(), descriptor()];
  f.state.resumeFailures = 1;
  f.events.installed({ reason: 'update' }); await f.pump();
  assert.deepEqual(f.reloads, [71]);
  assert.equal(f.local.upgradeRecovery.targets[0].phase, 'ready');
  const restarted = await worker(t, { local: f.local });
  // The actual startup pump already finishes the persisted activation job.
  assert.equal(restarted.reloads.length, 0);
  assert.equal(restarted.local.upgradeRecovery, null);
  assertReadOnly(f); assertReadOnly(restarted);
});

test('CONT-19 recovery inventory fallback uses only /observations, never active/idle views', async t => {
  const f = await worker(t);
  f.state.noRecoveryInventory = true;
  f.state.observations = [descriptor()];
  f.events.installed({ reason: 'update' }); await f.pump();
  assert.deepEqual(f.reloads, [71]);
  assert.ok(f.byRoute('/observations').length >= 1);
  assert.equal(f.byRoute('/resume-agent').length, 1);
  assertReadOnly(f);
});

test('CONT-20 disconnect during frame identity verification cannot publish using the previous connection', async t => {
  const f = await worker(t); await f.watch();
  f.state.onRpc = async (id, message) => {
    if (message.type !== 'identity') return;
    const value = structuredClone(f.state.identities.get(id));
    const disconnected = await f.message({ type: 'disconnect' },
      { id: EXTENSION, url: `chrome-extension://${EXTENSION}/popup.html` });
    assert.equal(disconnected.ok, true);
    return { ok: true, value };
  };
  const result = await f.message({ type: 'page-view', event: frame() });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'CONNECTION_CHANGED');
  assert.equal(f.byRoute('/page-view').length, 0);
  assertReadOnly(f);
});

test('CONT-21 an invalid rebind response cannot reinstall an old observation lease', async t => {
  const f = await worker(t), s = descriptor();
  f.state.identities.get(71).documentKey = 'new-document';
  f.state.onApi = route => route === '/rebind-observation' ? {
    ok: true, text: async () => JSON.stringify({ ...s, documentKey: 'new-document' }),
  } : undefined;
  await f.watch(s);
  assert.equal(f.byRoute('/rebind-observation').length, 1);
  assert.equal(f.byMessage('monitor').length, 0);
  assert.equal(f.local.tabs[71].observationLease, undefined);
  assert.equal(f.local.tabs[71].observationRevoked, true);
  assertReadOnly(f);
});

test('CONT-22 view conversation identity is optional, and button state never prevents frame forwarding', async t => {
  const f = await worker(t); await f.watch();
  for (const [sequence, state] of ['running', 'standby', 'abnormal'].entries()) {
    const event = frame(descriptor(), { sequence: sequence+1, view: { page: { state }, items: [], approvals: [], issues: [] } });
    assert.equal((await f.message({ type: 'page-view', event })).ok, true);
  }
  assert.equal(f.byRoute('/page-view').length, 3);
  assertReadOnly(f);
});

test('CONT-23 navigation during a pending receipt probe cannot post stale receipt evidence or retain the old epoch', async t => {
  const f = await worker(t), s = descriptor({ receiptPending: true, turnId: 'original-turn', lease: 'send-lease' });
  f.state.onRpc = (id, message) => {
    if (message.type !== 'pending-receipt') return;
    f.state.tabs.get(id).url = 'https://chatgpt.com/c/other';
    return { ok: true, value: { available: true, nativeMessageId: 'late-user' } };
  };
  await f.watch(s);
  assert.equal(f.byMessage('monitor').length, 1);
  assert.equal(f.byRoute('/receipt-observation').length, 0);
  assert.equal(f.local.tabs[71].observationRevoked, true);
  assert.equal(f.local.tabs[71].observationLease, undefined);
  assertReadOnly(f);
});

test('CONT-24 an idle bound conversation without a tab is never auto-opened', async t => {
  const f = await worker(t, { state: { observations: [descriptor({
    sessionId: 'idle-session', conversationId: 'chat-idle', tabId: 998, active: false })] } });
  await f.pump();
  assert.equal(f.created.length, 0, 'historical/idle bindings must not open tabs');
  assert.equal(f.messages.filter(m => m.message.type === 'monitor').length, 0);
});

test('CONT-25 an active run without its page reopens exactly one tab', async t => {
  const f = await worker(t, { state: { observations: [descriptor({
    sessionId: 'run-session', conversationId: 'chat-run', tabId: 997, active: true })] } });
  await f.pump();
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].url, 'https://chatgpt.com/c/chat-run');
});
