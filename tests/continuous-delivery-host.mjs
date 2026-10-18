/** Opt-in ORIGINAL HOST gate. No daemon/account/browser/SDK socket is touched.
 * source ../logs/validation-env-012b2.sh; node --test tests/continuous-delivery-host.mjs
 * Runs original PluginAgentSession, AgentManager, timeline projection and DEFAULT
 * 60ms coalescer. Provider input and pre-provider pending failures are fixtures.
 * readHost goes through the original public SDK refetch request builder and
 * original Session timeline handler, with an in-process transport seam. No
 * socket/daemon/account connection. Provider production integration remains separate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHostTimelineReader } from '../server/host-timeline.mjs';
import { loadPaseoHost } from './fixtures/paseo-host-sources.mjs';
import { createNativeDelivery, normalizeProjectedView } from '../server/native-delivery.mjs';

const packageDir = process.env.CIP_PASEO_SERVER_PACKAGE;
const { AgentManager, PluginAgentClientRegistry, ProviderEventSchema, version } = await loadPaseoHost(packageDir);
assert.equal(version, '0.12.0-beta.2', 'This checkpoint gate is pinned specifically to beta.2');
for (const [file, digest] of Object.entries({
  'agent-stream-coalescer.js': 'b34e0a073ccab9158a83a7b6b7aa2cf4f2fe539cef1ec796cbae662f1adc86c9',
  'timeline-projection.js': 'a3f9ac78056038a6631fee7316beb84a5e16057131a64611cf3990f8e2fc01e3',
  'agent-timeline-store.js': '5473e829162d3256ab76b9b39d965158efbf5b4a29bb01e444626ac3a4bf52e3'
})) {
  assert.equal(createHash('sha256').update(await readFile(path.join(packageDir, 'dist/server/server/agent', file))).digest('hex'), digest, file);
}
assert.equal(createHash('sha256').update(await readFile(path.join(packageDir,'dist/server/server/session.js'))).digest('hex'),
  '2a22a6716bec6dd2c52ccdc96449a1fe9f33937a8bf4dff1097bfb52f736b752');
const load = relative => import(pathToFileURL(path.join(packageDir,relative)).href);
const {Session} = await load('dist/server/server/session.js');
const {createPaseoApi} = await load('node_modules/@getpaseo/client/dist/index.js');
const {DaemonClient} = await load('node_modules/@getpaseo/client/dist/daemon-client.js');
const {FetchAgentTimelineResponseMessageSchema} = await load('node_modules/@getpaseo/protocol/dist/messages.js');
console.log('# original beta.2 SDK request + Session response; in-process transport, default 60ms coalescer; no live connection');
const noop = () => {};
const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child() { return this; } };
const agentId = 'c011e670-0000-4000-8000-000000000021';
const capabilities = ['prompt.message', 'permission', 'session.interrupt', 'timeline.plugin'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await pause(2); }
  assert.fail('Host gate did not settle');
}
const source = text => ({ type: 'assistant_message', id: 'public-final-source', messageId: 'native-final-id', text });

async function world(t) {
  const listeners = new Set(), inputs = [], wire = [], saves = [];
  let sessionId, runId, runs = 0;
  const forward = value => {
    const event = ProviderEventSchema.parse({ sessionId, ...value });
    for (const fn of listeners) fn(event);
  };
  const registration = { id: 'chatmode', label: 'Checkpoint gate', icon: 'icon.svg', async connect(request) {
    const accepted = capabilities.filter(capability => request.capabilities.includes(capability));
    return { version: 1, capabilities: accepted, onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async send(input) {
        inputs.push(input);
        switch (input.type) {
          case 'catalog': forward({ type: 'catalog', requestId: input.requestId, catalog: { models: [{ id: 'fixture', label: 'Fixture' }], modes: [], thinkingOptions: [], defaultModel: 'fixture' } }); return;
          case 'session.open':
            sessionId = input.sessionId;
            forward({ type: 'session.opened', requestId: input.requestId, capabilities: accepted, restoration: 'core', cwd: input.config.cwd });
            forward({ type: 'session.config', config: { model: 'fixture', models: [{ id: 'fixture', label: 'Fixture' }], modes: [], thinkingOptions: [], settings: [] } });
            forward({ type: 'session.ready', requestId: input.requestId }); return;
          case 'session.prompt':
            runId = 'fixture-run-' + (++runs);
            forward({ type: 'session.prompt_result', clientMessageId: input.prompt.clientMessageId, result: { type: 'turn', turnId: runId } });
            forward({ type: 'session.turn', turnId: runId, state: 'started' }); return;
          case 'session.close': forward({ type: 'session.closed' }); forward({ type: 'request.completed', requestId: input.requestId }); return;
          default: throw Error('Unexpected host input ' + input.type);
        }
      }, async close() { listeners.clear(); }
    };
  } };
  const registry = new PluginAgentClientRegistry(logger); registry.replace([registration]);
  const client = registry.clients().chatmode;
  // Do not set agentStreamCoalesceWindowMs: this gate must use the original default.
  const manager = new AgentManager({ logger, clients: { chatmode: client }, providerDefinitions: registry.definitions() });
  assert.equal(manager.agentStreamCoalescer.windowMs, 60);
  const session = await client.createSession({ provider: 'chatmode', cwd: '/tmp', model: 'fixture' });
  assert.equal(session.constructor.name, 'PluginAgentSession');
  await manager.registerSession(session, { provider: 'chatmode', cwd: '/tmp' }, agentId, { historyPrimed: true });
  const epoch = manager.fetchTimeline(agentId, { limit: 0 }).epoch;
  const w = { manager, session, wire, saves, inputs, forward, ready: true, emitHook: null, readHook: null,
    async drain() { for (let n = 0; n < 3; n++) { await manager.drainSessionEvents(agentId); await new Promise(resolve => setImmediate(resolve)); } },
    async settled() { await w.drain(); await pause(80); await w.drain(); },
    fetch() { return manager.fetchTimeline(agentId, { direction: 'tail', limit: 0 }); },
    view() {
      const fetch = w.fetch();
      return { sessionId, bindingGeneration: 'binding-one', hostEpoch: fetch.epoch,
        coverage: { complete: !fetch.hasOlder && !fetch.hasNewer && !fetch.gap && !fetch.staleCursor,
          startSeq: fetch.startSeq, endSeq: fetch.endSeq, nextSeq: fetch.window.nextSeq }, rows: fetch.rows };
    },
    async emit(event) {
      const persisted = saves.at(-1);
      assert(persisted, 'attempt persistence must precede original Provider emit');
      if (event.item.type === 'assistant_message') assert(persisted.attempts.some(a => a.transportId === event.item.id && a.status === 'prepared'));
      else assert(persisted.checkpoints.some(c => c.item.data.probeId === event.item.data.probeId));
      await w.emitHook?.(event);
      wire.push(structuredClone(event)); forward(event); await w.drain();
    },
    bodies() { return wire.filter(event => event.item.type === 'assistant_message'); },
    markers() { return wire.filter(event => event.item.type === 'plugin'); },
    text() { return normalizeProjectedView(w.view()).rows.filter(row => row.item.type === 'assistant_message' && row.item.messageId === 'native-final-id').map(row => row.item.text).join(''); },
    async anchor() { await w.delivery.submit(source('')); await w.delivery.sync(); await w.delivery.sync(); },
    async pending(fail = true) {
      let entered = false, release;
      const gate = new Promise(resolve => { release = resolve; });
      const original = session.startTurn;
      // Fault injection is solely at the session invocation boundary, before
      // the unchanged original manager staging/flush/discard implementation.
      session.startTurn = async (...args) => { entered = true; await gate; if (fail) throw Error('TEST_PRE_PROVIDER_FAILURE'); return original.apply(session, args); };
      const previousRuns = runs;
      const outcome = (async () => { for await (const event of manager.streamAgent(agentId, 'fixture pending prompt', { clientMessageId: 'pending-' + Math.random() })) void event; })()
        .then(() => ({ ok: true }), error => ({ ok: false, error }));
      await until(() => entered);
      const pending = manager.runs.getPendingRun(agentId);
      assert.equal(pending.start.status, 'pending');
      let done = false;
      const finish = async () => {
        if (done) return; done = true; release();
        if (!fail) {
          await until(() => runs > previousRuns); await w.drain();
          forward({ type: 'session.turn', turnId: runId, state: 'completed' });
        }
        const result = await outcome; session.startTurn = original; await w.settled();
        if (fail) { assert.equal(result.ok, false); assert.match(result.error.message, /TEST_PRE_PROVIDER_FAILURE/); }
        else assert.equal(result.ok, true);
      };
      t.after(finish);
      return { finish, staged: () => pending.stagedEvents.length };
    },
    async startAndStandby() {
      const pending = await w.pending(false); await pending.finish();
      w.delivery.setPageState('standby');
      assert.equal(manager.getAgent(agentId).lifecycle, 'idle');
    }
  };
  // Transport seam only: requests, Session handler and response validation are
  // the pinned originals. The handler reads the real manager/projection above.
  let requests=0;
  const rpc={
    createRequestId:()=> 'timeline-read-'+(++requests),
    async sendRequest({message,select}) {
      assert.equal(message.type,'fetch_agent_timeline_request');
      assert.equal(message.agentId,agentId);
      let reply;
      await Session.prototype.handleFetchAgentTimelineRequest.call({
        agentManager:manager,agentStorage:null,sessionLogger:logger,
        buildAgentPayload:async()=>null,supportsTimelineItem:()=>true,supports:()=>true,
        emitForSource:value=>{reply=value;},emit:value=>{reply=value;}
      },message);
      const parsed=FetchAgentTimelineResponseMessageSchema.parse(reply);
      assert.equal(parsed.payload.error,null);
      return select(parsed);
    }
  };
  const api=createPaseoApi({fetchAgentTimeline:(...args)=>DaemonClient.prototype.fetchAgentTimeline.apply(rpc,args)});
  const readPublic=createHostTimelineReader({agent:api.agents.ref(agentId),sessionId,
    bindingGeneration:'binding-one',isCurrent:()=>true});
  t.after(()=>api.dispose());
  await readPublic(); // Surface adapter/SDK failures, rather than hide them behind sync's retry notice.
  w.delivery = createNativeDelivery({ sessionId, bindingGeneration: 'binding-one', hostEpoch: epoch,
    emit: event => w.emit(event), persist: async snapshot => { saves.push(structuredClone(snapshot)); },
    isReady: () => w.ready, readHost: async () => { await w.settled(); const view = await readPublic(); await w.readHook?.(); return view; } });
  t.after(async () => { await w.delivery.close(); await registry.shutdown(); });
  return w;
}

test('ND-HOST-1 normal body/checkpoint, same native messageId, actual full refetches never duplicated', async t => {
  const w = await world(t); await w.anchor();
  await w.delivery.submit(source('A')); await w.delivery.sync(); await w.delivery.sync();
  await w.delivery.submit(source('AB')); await w.delivery.sync(); await w.delivery.sync();
  assert.equal(w.text(), 'AB'); assert.equal(w.bodies().length, 2);
  assert(w.bodies().every(event => event.item.messageId === 'native-final-id'));
  assert.equal(w.bodies()[0].item.id, w.bodies()[1].item.id);
  assert.equal(w.fetch().rows.filter(row => row.item.kind === 'source-checkpoint').length, 1);
  await w.delivery.observeHost(w.view()); await w.delivery.observeHost(w.view());
  assert.equal(w.bodies().length, 2); assert.equal(w.text(), 'AB');
});

test('ND-HOST-2 body and marker staged then lost: only marker retries, followed by one fresh native segment', async t => {
  const w = await world(t); await w.anchor(); const pending = await w.pending();
  await w.delivery.submit(source('lost native body')); await w.delivery.sync();
  assert(pending.staged() >= 2);
  await w.delivery.sync(); // Same projected snapshot, another real marker emission.
  assert.equal(w.bodies().length, 1);
  assert(pending.staged() >= 3);
  await pending.finish();
  assert.equal(w.text(), '');
  // Characterize the original bug separately from coordinator behavior:
  // same provider id still hits PluginAgentSession's already-advanced cache.
  w.forward(w.bodies()[0]); await w.settled();
  assert.equal(w.text(), '', 'same-ID replay is swallowed by the real host cache');
  await w.delivery.sync(); assert.equal(w.bodies().length, 1, 'marker-only retry first');
  await w.delivery.sync(); await w.delivery.sync();
  assert.equal(w.text(), 'lost native body'); assert.equal(w.bodies().length, 2);
  assert.notEqual(w.bodies()[0].item.id, w.bodies()[1].item.id);
});

test('ND-HOST-3 body committed but marker discarded: positive body observation needs no replay', async t => {
  const w = await world(t); await w.anchor(); let pending;
  w.emitHook = async event => {
    if (event.item.type === 'plugin' && event.item.data.phase === 'after-body' && !pending) {
      await w.settled(); pending = await w.pending();
    }
  };
  await w.delivery.submit(source('body already committed')); await w.delivery.sync(); await pending.finish();
  w.emitHook = null; await w.delivery.sync();
  assert.equal(w.text(), 'body already committed'); assert.equal(w.bodies().length, 1);
  assert.equal(w.delivery.snapshot().durable.deliveries[0].pending, null);
});

test('ND-HOST-4 body discarded, marker arrives after failed pending: send missing suffix only', async t => {
  const w = await world(t); await w.anchor();
  await w.delivery.submit(source('prefix')); await w.delivery.sync(); await w.delivery.sync();
  const pending = await w.pending();
  w.emitHook = async event => { if (event.item.type === 'plugin' && event.item.data.phase === 'after-body') await pending.finish(); };
  await w.delivery.submit(source('prefix suffix')); await w.delivery.sync();
  w.emitHook = null; assert.equal(w.text(), 'prefix');
  await w.delivery.sync(); await w.delivery.sync();
  assert.equal(w.text(), 'prefix suffix'); assert.equal(w.bodies().at(-1).item.text, ' suffix');
  assert.notEqual(w.bodies().at(-1).item.id, w.bodies()[0].item.id);
});

test('ND-HOST-5 successful pending flush commits staged body/checkpoint exactly once', async t => {
  const w = await world(t); await w.anchor(); const pending = await w.pending(false);
  await w.delivery.submit(source('staged success')); await w.delivery.sync();
  assert(pending.staged() >= 2); await pending.finish(); await w.delivery.sync();
  assert.equal(w.text(), 'staged success'); assert.equal(w.bodies().length, 1);
});

test('ND-HOST-6 pending begins AFTER a host read; subsequent failure still repairs without duplicate body', async t => {
  const w = await world(t); await w.anchor(); let pending;
  w.readHook = async () => { w.readHook = null; pending = await w.pending(); };
  await w.delivery.submit(source('read-to-emit race')); await w.delivery.sync(); await pending.finish();
  await w.delivery.sync(); await w.delivery.sync(); await w.delivery.sync();
  assert.equal(w.text(), 'read-to-emit race'); assert.equal(w.bodies().length, 2);
});

test('ND-HOST-7 local held stream cannot forward a checkpoint ahead of an unforwarded body', async t => {
  const w = await world(t); w.ready = false;
  await w.delivery.submit(source('locally held')); await w.delivery.sync();
  assert.equal(w.wire.length, 0); assert.equal(w.fetch().rows.length, 0);
  w.ready = true; await w.delivery.sync(); await w.delivery.sync(); await w.delivery.sync();
  assert.equal(w.text(), 'locally held'); assert.equal(w.bodies().length, 1);
});

test('ND-HOST-8 stale binding/epoch views cannot drive a native retry', async t => {
  const w = await world(t); await w.anchor(); await w.delivery.submit(source('queued'));
  const count = w.wire.length;
  for (const field of ['bindingGeneration', 'hostEpoch']) {
    const result = await w.delivery.observeHost({ ...w.view(), [field]: 'old' });
    assert(result.issues.some(issue => issue.code === (field === 'hostEpoch' ? 'HOST_EPOCH_MISMATCH' : 'HOST_BINDING_MISMATCH')));
  }
  assert.equal(w.wire.length, count); assert.equal(w.bodies().length, 0);
});

test('ND-HOST-9 standby/foreground completion does not wait for ACK; native repair still works while idle', async t => {
  const w = await world(t); await w.anchor(); const pending = await w.pending();
  await w.delivery.submit(source('late after idle')); await w.delivery.sync(); await pending.finish();
  assert(w.delivery.snapshot().durable.deliveries[0].pending);
  await w.startAndStandby();
  assert.equal(w.delivery.snapshot().pageState, 'standby');
  assert(w.delivery.snapshot().durable.deliveries[0].pending, 'foreground ended independently of ACK');
  await w.delivery.sync(); await w.delivery.sync(); await w.delivery.sync();
  assert.equal(w.text(), 'late after idle'); assert.equal(w.manager.getAgent(agentId).lifecycle, 'idle');
});

test('ND-HOST-10 actual cold projection with only durable nextSeq never authorizes empty-history replay', async t => {
  const w = await world(t);
  // Original store cold initialization models a durable watermark whose body
  // rows have not been loaded. No source implementation or epoch is fabricated.
  const epoch = w.fetch().epoch;
  w.manager.timelineStore.initialize(agentId, { nextSeq: 100, epoch });
  const cold = w.fetch(); assert.equal(cold.rows.length, 0); assert.equal(cold.window.nextSeq, 100);
  await w.delivery.submit(source('cold body')); await w.delivery.sync(); await w.delivery.sync();
  assert.equal(w.bodies().length, 0);
  assert(w.delivery.snapshot().issues.some(issue => issue.code === 'HOST_COVERAGE_INCOMPLETE'));
});

test('ND-HOST-11 a lost bootstrap checkpoint never releases body before a real anchor observation', async t => {
  const w = await world(t), pending = await w.pending();
  await w.delivery.submit(source('must wait for anchor')); await w.delivery.sync(); await w.delivery.sync();
  assert.equal(w.bodies().length, 0); assert(pending.staged() >= 2);
  await pending.finish(); await w.delivery.sync();
  assert.equal(w.bodies().length, 0, 'resending an anchor is not observing it');
  await w.delivery.sync(); await w.delivery.sync();
  assert.equal(w.text(), 'must wait for anchor'); assert.equal(w.bodies().length, 1);
});

test('ND-HOST-12 real merged projected refetch carries full AB, not a B delta; adoption never resends it', async t => {
  const w = await world(t);
  // Synthetic baseline inputs through original ProviderRuntime/mapTimelineItem,
  // not writes into a mocked projected row or the timeline store.
  w.forward({ type: 'timeline.item', item: { type: 'assistant_message', id: 'baseline', messageId: 'native-final-id', text: 'A' } });
  w.forward({ type: 'timeline.item', item: { type: 'assistant_message', id: 'baseline', messageId: 'native-final-id', text: 'AB' } });
  await w.settled();
  const native = w.fetch().rows.filter(row => row.item.type === 'assistant_message');
  assert.equal(native.length, 1); assert.equal(native[0].item.text, 'AB');
  assert(native[0].sourceSeqRanges.length > 0);
  await w.delivery.submit(source('AB')); await w.delivery.sync(); await w.delivery.sync();
  await w.delivery.observeHost(w.view()); await w.delivery.observeHost(w.view());
  assert.equal(w.bodies().length, 0); assert.equal(w.text(), 'AB');
  await w.delivery.submit(source('ABC')); await w.delivery.sync(); await w.delivery.sync();
  assert.equal(w.bodies().length, 1); assert.equal(w.bodies()[0].item.text, 'C');
  assert.equal(w.text(), 'ABC', 'new binding must not resend an already observed baseline');
});
