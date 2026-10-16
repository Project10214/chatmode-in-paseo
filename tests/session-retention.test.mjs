import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, selection, until } from './helpers.mjs';
import { Store, MAX_STATE_BYTES, CONTROL_RESERVE_BYTES } from '../server/store.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';

async function retainedSessions(f) {
  const seed = await f.broker.create(selection);
  await f.store.transaction(d => {
    for (let i = 1; i < 100; i++) {
      const id = `retained-${i}`;
      d.sessions[id] = { ...structuredClone(seed), id,
        status: i % 3 === 0 ? 'blocked' : i % 3 === 1 ? 'abandoned' : 'idle',
        history: [{ type: 'user_message', id: `user-${i}`, text: 'retained history' }],
        prompts: { [`previous-${i}`]: { outcome: 'failed' } } };
    }
  });
  return f.store.read().sessions;
}

const config = { cwd: '/example/project', env: {}, settings: {}, mcpServers: {}, persist: true,
  model: 'm1', thinkingOption: 'standard', providerOptions: { appIds: ['asdk_app_a'] } };

test('100 retained sessions do not block a new Paseo session or erase history/identity', async t => {
  const f = await fixture(t);
  const before = await retainedSessions(f);
  const connection = await createProvider({ ...f, status: () => ({ connected: true }) })
    .connect({ versions: [1], capabilities: CAPABILITIES });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent(e => events.push(e));
  await connection.send({ type: 'session.open', sessionId: 'new-agent', requestId: 'open', config, history: 'skip' });
  await until(() => events.some(e => e.type === 'session.ready' || e.type === 'request.failed'));
  assert.equal(events.find(e => e.type === 'request.failed'), undefined);
  const opened = events.find(e => e.type === 'session.opened');
  assert.ok(opened);
  const id = opened.persistence.data.id;
  assert.equal(Object.keys(f.store.read().sessions).length, 101);
  assert.equal(f.broker.queued().length, 0, 'opening must not send or reopen old chats');
  for (const [key, value] of Object.entries(before)) assert.deepEqual(f.broker.snapshot(key), value);

  // A new explicit prompt still uses the normal one-send flow, even when the
  // host repeats delivery of the same clientMessageId.
  const prompt = { type: 'session.prompt', sessionId: 'new-agent', prompt: {
    clientMessageId: 'new-message', delivery: 'auto',
    input: { type: 'message', content: [{ type: 'text', text: 'new explicit message' }] }
  } };
  await connection.send(prompt);
  const open = await until(() => f.broker.queued().find(c => c.kind === 'open'));
  const claim = await f.broker.claim(open.id, 500, 'new-document');
  await f.broker.result(open.id, claim.lease, { config: selection, tabId: 500, url: 'https://chatgpt.com/' });
  const send = await until(() => f.broker.queued().find(c => c.kind === 'send'));
  assert.equal(send.sessionId, id);
  await connection.send(prompt);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Object.values(f.store.read().commands).filter(c => c.kind === 'send').length, 1);
  await f.broker.interrupt(id); // cancel the simulated, still unclaimed Send
  const onDisk = await new Store(f.directory).open();
  for (const [key, value] of Object.entries(before)) assert.deepEqual(onDisk.read().sessions[key], value);
});

test('concurrent session creation above 100 retains every distinct session', async t => {
  const f = await fixture(t);
  await retainedSessions(f);
  const sessions = await Promise.all(Array.from({ length: 5 }, () => f.broker.create(selection)));
  assert.equal(new Set(sessions.map(s => s.id)).size, 5);
  assert.equal(Object.keys(f.store.read().sessions).length, 105);
});

test('session creation still obeys the atomic storage capacity and control reserve', async t => {
  const f = await fixture(t);
  await retainedSessions(f);
  await f.store.transaction(d => {
    const bytes = Buffer.byteLength(JSON.stringify({ ...d, padding: '' }));
    d.padding = 'x'.repeat(MAX_STATE_BYTES - CONTROL_RESERVE_BYTES - bytes - 16);
  });
  await assert.rejects(f.broker.create(selection), { code: 'STATE_CAPACITY_RESERVED' });
  assert.equal(Object.keys(f.store.read().sessions).length, 100);
  const onDisk = await new Store(f.directory).open();
  assert.equal(Object.keys(onDisk.read().sessions).length, 100, 'failed allocation must not publish a partial session');
});
