import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';
import { fixture, selection, until, sourceItem } from './helpers.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Store } from '../server/store.mjs';

const connect = async f => {
  const connection = await createProvider({ ...f, status: () => ({ connected: true }) })
    .connect({ versions: [1], capabilities: CAPABILITIES });
  const events = [];
  connection.onEvent(event => events.push(event));
  return { connection, events, send: async (type, id, requestId) => {
    await connection.send({ type, requestId, persistence: { version: 1, data: { id } } });
    await until(() => events.find(e => e.requestId === requestId && (e.type === 'request.completed' || e.type === 'request.failed')));
    assert.equal(events.find(e => e.requestId === requestId)?.type, 'request.completed');
  } };
};
const lines = async (directory, date) =>
  (await readFile(path.join(directory, 'archive', date + '.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('ARCHIVE-RED: Paseo archive queues a one-shot close and preserves Conversation binding', async t => {
  const f = await fixture(t);
  const s = await f.ready();
  await f.store.transaction(d => { d.sessions[s.id].conversationId = 'durable-conversation'; });
  const connection = await createProvider({ ...f, status: () => ({ connected: true }) })
    .connect({ versions: [1], capabilities: CAPABILITIES });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent(event => events.push(event));
  assert.ok(CAPABILITIES.includes('session.archive'), 'Paseo must negotiate session.archive');
  await connection.send({ type: 'session.archive', requestId: 'archive-1', persistence: { version: 1, data: { id: s.id } } });
  await until(() => events.find(event => event.type === 'request.completed' && event.requestId === 'archive-1'));
  const command = f.broker.queued().find(row => row.kind === 'close-tab');
  assert.ok(command, 'archive must queue a browser close command');
  assert.equal(command.payload.documentKey, s.documentKey);
  const claim = await f.broker.claim(command.id, s.tabId, s.documentKey);
  assert.equal(f.broker.verifyTabClose(command.id, claim.lease).allowed, true);
  await f.broker.result(command.id, claim.lease, { closed: true });
  const date = f.store.read().archiveIndex[s.id];
  assert.ok(date, 'confirmed close can now compact an idle archive');
  assert.equal(f.store.read().sessions[s.id], undefined);
  const saved = (await lines(f.directory, date)).find(row => row.id === s.id);
  assert.equal(saved.session.tabId, null);
  assert.equal(saved.session.documentKey, null);
  assert.equal(saved.session.conversationId, 'durable-conversation');
});

test('ARCHIVE-SKIP: missing, busy, pending, unknown and malformed sessions all acknowledge without closing', async t => {
  const f = await fixture(t);
  const missingTab = await f.broker.create({ model:'m1', thinkingOption:'standard', appIds:['asdk_app_a'] });
  const busy = await f.ready();
  const pending = await f.ready();
  await f.store.transaction(d => { d.sessions[busy.id].status = 'running'; });
  await f.broker.enqueue('configure', pending.id, { config: pending.config });
  const connection = await createProvider({ ...f, status: () => ({ connected: true }) })
    .connect({ versions: [1], capabilities: CAPABILITIES });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent(e => events.push(e));
  const cases = [
    ['missing-tab', {version:1,data:{id:missingTab.id}}],
    ['busy', {version:1,data:{id:busy.id}}],
    ['pending', {version:1,data:{id:pending.id}}],
    ['unknown', {version:1,data:{id:'11111111-1111-4111-8111-111111111111'}}],
    ['malformed', {version:1,data:{id:'invalid'}}],
    ['wrong-version', {version:2,data:{id:missingTab.id}}]
  ];
  for (const [requestId,persistence] of cases) {
    await connection.send({type:'session.archive',requestId,persistence});
    await until(() => events.some(e=>e.type==='request.completed'&&e.requestId===requestId));
  }
  assert.equal(f.broker.queued().filter(c=>c.kind==='close-tab').length,0);
  assert.equal(events.some(e=>e.type==='request.failed'),false);
});

test('ARCHIVE-ONESHOT: attached idle Agent closes once, skip result cannot retry same document', async t => {
  const f = await fixture(t);
  const s = await f.ready();
  f.broker.owners.set(s.id,{});
  const connection = await createProvider({ ...f, status: () => ({ connected: true }) })
    .connect({ versions: [1], capabilities: CAPABILITIES });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent(e => events.push(e));
  const persistence={version:1,data:{id:s.id}};
  await connection.send({type:'session.archive',requestId:'once',persistence});
  await until(()=>events.some(e=>e.type==='request.completed'&&e.requestId==='once'));
  const c=f.broker.queued().find(c=>c.kind==='close-tab');
  assert.ok(c,'an attached but idle Agent must still be closable on archive');
  const claim=await f.broker.claim(c.id,s.tabId,s.documentKey);
  assert.equal(f.broker.verifyTabClose(c.id,claim.lease).allowed,true);
  await f.broker.result(c.id,claim.lease,{closed:false,skipped:'ACTIVE_TAB'});
  assert.equal(f.broker.snapshot(s.id).tabId,s.tabId);
  await connection.send({type:'session.archive',requestId:'again',persistence});
  await until(()=>events.some(e=>e.type==='request.completed'&&e.requestId==='again'));
  assert.equal(f.broker.queued().filter(c=>c.kind==='close-tab').length,0);
});

test('ARCHIVE-RACE: a newly queued Send blocks the final close permission', async t => {
  const f = await fixture(t);
  const s = await f.ready();
  await f.store.transaction(d => { d.sessions[s.id].archiveIntent = { id: 'intent-race', requestedAt: Date.now() }; });
  const command=await f.broker.enqueueTabClose(s.id);
  const claim=await f.broker.claim(command.id,s.tabId,s.documentKey);
  assert.equal(f.broker.verifyTabClose(command.id,claim.lease).allowed,true);
  await f.broker.enqueue('send',s.id,{turnId:'new-pending-turn'});
  assert.equal(f.broker.verifyTabClose(command.id,claim.lease).allowed,false);
});

test('ARCHIVE-MOVE: tabless idle session moves to durable daily JSONL with small index, across restart', async t => {
  const f = await fixture(t), s = await f.broker.create(selection);
  await f.store.transaction(d => {
    d.sessions[s.id].conversationId = 'retain-this-chat';
    d.sessions[s.id].history.push({ type: 'assistant_message', id: 'saved', text: 'original history' });
  });
  const client = await connect(f); t.after(() => client.connection.close());
  await client.send('session.archive', s.id, 'move');
  const after = f.store.read(), date = after.archiveIndex?.[s.id];
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(after.sessions[s.id], undefined);
  const saved = (await lines(f.directory, date)).filter(row => row.id === s.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].session.conversationId, 'retain-this-chat');
  assert.equal(saved[0].session.history[0].text, 'original history');
  const restarted = await new Store(f.directory).open();
  assert.equal(restarted.read().archiveIndex[s.id], date);
  assert.equal(restarted.read().sessions[s.id], undefined);
});

test('ARCHIVE-RESTORE: close result moves record, unarchive restores history and allows a new prompt', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.store.transaction(d => { d.sessions[s.id].conversationId = 'durable-chat'; });
  const client = await connect(f); t.after(() => client.connection.close());
  assert.ok(CAPABILITIES.includes('session.unarchive'));
  await client.send('session.archive', s.id, 'arch');
  assert.ok(f.store.read().sessions[s.id], 'a close command is not yet a browser result');
  const close = f.broker.queued().find(c => c.kind === 'close-tab');
  const claim = await f.broker.claim(close.id, s.tabId, s.documentKey);
  await f.broker.result(close.id, claim.lease, { closed: true });
  const date = f.store.read().archiveIndex?.[s.id];
  assert.ok(date);
  assert.equal(f.store.read().sessions[s.id], undefined);
  await client.send('session.unarchive', s.id, 'unarch');
  assert.equal(f.store.read().archiveIndex[s.id], undefined);
  const restored = f.broker.snapshot(s.id);
  assert.equal(restored.conversationId, 'durable-chat');
  assert.equal(restored.tabId, null);
  const configPromise = f.broker.configure(s.id, restored.config);
  const open = await until(() => f.broker.queued().find(c => c.kind === 'open' && c.sessionId === s.id));
  assert.equal(open.payload.conversationId, 'durable-chat');
  const opening = await f.broker.claim(open.id, 543, 'document-resumed');
  await f.broker.result(open.id, opening.lease, { config: restored.config, tabId: 543, url: 'https://chatgpt.com/c/durable-chat' });
  await configPromise;
  const prompt = await f.broker.prompt(s.id, 'after-unarchive', 'continue');
  assert.ok(prompt.turnId);
  assert.equal(f.broker.queued().some(c => c.kind === 'send' && c.sessionId === s.id), true);
});

test('ARCHIVE-PENDING: running sessions remain in main state and do not enqueue a close', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.store.transaction(d => { d.sessions[s.id].status = 'running'; });
  const client = await connect(f); t.after(() => client.connection.close());
  await client.send('session.archive', s.id, 'busy-archive');
  assert.ok(f.store.read().sessions[s.id]);
  assert.equal(f.store.read().archiveIndex?.[s.id], undefined);
  assert.equal(f.broker.queued().some(c => c.kind === 'close-tab'), false);
});

test('ARCHIVE-IDEMPOTENT: repeated archive writes only one row, repeated unarchive is safe', async t => {
  const f = await fixture(t), s = await f.broker.create(selection);
  const client = await connect(f); t.after(() => client.connection.close());
  await client.send('session.archive', s.id, 'once');
  const date = f.store.read().archiveIndex[s.id];
  await client.send('session.archive', s.id, 'twice');
  assert.equal((await lines(f.directory, date)).filter(row => row.id === s.id).length, 1);
  await client.send('session.unarchive', s.id, 'restore-once');
  await client.send('session.unarchive', s.id, 'restore-twice');
  assert.equal(Object.keys(f.store.read().sessions).includes(s.id), true);
  assert.equal(f.store.read().archiveIndex[s.id], undefined);
});

test('ARCHIVE-IOFAIL: failing archive destination leaves complete session in main state', async t => {
  const f = await fixture(t), s = await f.broker.create(selection);
  await writeFile(path.join(f.directory, 'archive'), 'not a directory');
  const client = await connect(f); t.after(() => client.connection.close());
  await client.send('session.archive', s.id, 'iofail');
  assert.ok(f.store.read().sessions[s.id]);
  assert.equal(f.store.read().archiveIndex?.[s.id], undefined);
});

test('ARCHIVE-CANCEL: unarchive before a pending close cancels the close authorization', async t => {
  const f = await fixture(t), s = await f.ready();
  const client = await connect(f); t.after(() => client.connection.close());
  await client.send('session.archive', s.id, 'pending-archive');
  const close = f.broker.queued().find(c => c.kind === 'close-tab');
  const claim = await f.broker.claim(close.id, s.tabId, s.documentKey);
  await client.send('session.unarchive', s.id, 'cancel-archive');
  assert.equal(f.broker.verifyTabClose(close.id, claim.lease).allowed, false);
  assert.equal(f.broker.snapshot(s.id).tabId, s.tabId);
  assert.equal(f.store.read().archiveIndex?.[s.id], undefined);
});

test('ARCHIVE-AFTER-TURN: archiving a running session waits, then closes the tab and moves the record', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.sending(s);
  const client = await connect(f); t.after(() => client.connection.close());
  await client.send('session.archive', s.id, 'archive-while-running');
  assert.ok(f.store.read().sessions[s.id]);
  assert.equal(f.broker.queued().some(c => c.kind === 'close-tab'), false);
  assert.ok(f.broker.observationBindings().some(binding=>binding.sessionId===s.id),'pending archive must keep observing');
  await f.view(s,{state:'running',items:[sourceItem('answer','done')]});
  assert.equal(f.broker.queued().some(c=>c.kind==='close-tab'),false,'body alone does not prove standby');
  await f.view(s,{state:'standby'});
  const close = await until(() => f.broker.queued().find(c => c.kind === 'close-tab'));
  const claim = await f.broker.claim(close.id, s.tabId, s.documentKey);
  await f.broker.result(close.id, claim.lease, { closed: true });
  const date = f.store.read().archiveIndex[s.id];
  assert.ok(date);
  assert.equal(f.store.read().sessions[s.id], undefined);
  assert.equal((await lines(f.directory, date)).filter(row => row.id === s.id).length, 1);
});

test('ARCHIVE-FSYNC-RETRY: a retry that finds the archive row still must fsync it before dropping the main record', async t => {
  const f = await fixture(t), s = await f.broker.create(selection);
  const realOpen = fsp.open;
  const fault = { fail: true, jsonlSyncs: 0 };
  fsp.open = async (p, ...rest) => {
    const handle = await realOpen.call(fsp, p, ...rest);
    if (String(p).endsWith('.jsonl')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (fault.fail) throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
        fault.jsonlSyncs++; return sync();
      };
    }
    return handle;
  };
  t.after(() => { fsp.open = realOpen; });
  const first = await f.broker.archiveSession(s.id);
  assert.equal(first.moved, false);
  assert.ok(f.store.read().sessions[s.id], 'first failure keeps the main record');
  const second = await f.broker.archiveSession(s.id);
  assert.equal(second.moved, false, 'fsync still failing: must not move');
  assert.ok(f.store.read().sessions[s.id], 'retry with failing fsync keeps the main record');
  assert.equal(f.store.read().archiveIndex[s.id], undefined);
  fault.fail = false;
  const third = await f.broker.archiveSession(s.id);
  assert.equal(third.moved, true);
  assert.ok(fault.jsonlSyncs >= 1, 'a successful archive-file fsync happened before the move');
  assert.equal(f.store.read().sessions[s.id], undefined);
  assert.equal((await lines(f.directory, f.store.read().archiveIndex[s.id])).filter(r => r.id === s.id).length, 1);
});

test('ARCHIVE-UNDO-RACE: unarchive racing an in-flight finishArchive never yields an approvable close', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.store.transaction(d => { d.sessions[s.id].archiveIntent = { id: 'intent-1', requestedAt: Date.now() }; });
  const undo = f.broker.unarchiveSession(s.id);
  const finish = f.broker.finishArchive(s.id);
  await Promise.all([undo, finish]);
  assert.equal(f.store.read().sessions[s.id].archiveIntent, undefined);
  assert.equal(f.broker.queued().some(c => c.kind === 'close-tab'), false, 'no close command after unarchive');
});

test('ARCHIVE-INTENT-BIND: a close command is bound to its archive intent at claim and at approval', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.store.transaction(d => { d.sessions[s.id].archiveIntent = { id: 'intent-A', requestedAt: Date.now() }; });
  const cmd = await f.broker.enqueueTabClose(s.id);
  assert.equal(cmd.payload.archiveId, 'intent-A');
  // Approval: intent replaced after claim -> old close request is refused.
  const claim = await f.broker.claim(cmd.id, s.tabId, s.documentKey);
  assert.equal(f.broker.verifyTabClose(cmd.id, claim.lease).allowed, true);
  await f.store.transaction(d => { d.sessions[s.id].archiveIntent = { id: 'intent-B', requestedAt: Date.now() }; });
  assert.equal(f.broker.verifyTabClose(cmd.id, claim.lease).allowed, false);
  await f.store.transaction(d => { delete d.sessions[s.id].archiveIntent; });
  assert.equal(f.broker.verifyTabClose(cmd.id, claim.lease).allowed, false);
  // Claim: a queued close whose intent vanished cannot be claimed.
  const g = await fixture(t), u = await g.ready();
  await g.store.transaction(d => { d.sessions[u.id].archiveIntent = { id: 'intent-C', requestedAt: Date.now() }; });
  const queued = await g.broker.enqueueTabClose(u.id);
  await g.store.transaction(d => { delete d.sessions[u.id].archiveIntent; });
  await assert.rejects(g.broker.claim(queued.id, u.tabId, u.documentKey), /TAB_CLOSE_UNAVAILABLE/);
  // Create: without an intent no close command is created.
  const h = await fixture(t), v = await h.ready();
  assert.equal(await h.broker.enqueueTabClose(v.id), null);
});
