import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../server/protocol.mjs';
import { fixture, selection } from './helpers.mjs';

const fill = (f, make) => f.store.transaction(d => {
  for (let i = Object.keys(d.sessions).length; i < LIMITS.sessions; i++) {
    const id = `old-${String(i).padStart(3, '0')}`;
    d.sessions[id] = { id, status: 'idle', createdAt: 1000 + i, turn: null, ...make(i) };
  }
});

test('EVICT1 at the session cap, create evicts the least recently active settled sessions', async t => {
  const f = await fixture(t);
  await fill(f, i => (i === 0 ? { turn: { createdAt: 9e12 } } : {}));
  const s = await f.broker.create(selection);
  const ids = Object.keys(f.store.read().sessions);
  assert.equal(ids.length, LIMITS.sessions);
  assert.ok(ids.includes(s.id));
  assert.ok(ids.includes('old-000'), 'recently active session is kept');
  assert.ok(!ids.includes('old-001'), 'oldest inactive session is evicted');
});

test('EVICT2 busy, attached and pending sessions are never evicted', async t => {
  const f = await fixture(t);
  await fill(f, i => (i === 0 ? { status: 'sending' } : {}));
  await f.store.transaction(d => {
    d.commands['c-1'] = { id: 'c-1', sessionId: 'old-001', kind: 'send', phase: 'queued', createdAt: 1 };
  });
  f.broker.owners.set('old-002', {});
  await f.broker.create(selection);
  const ids = Object.keys(f.store.read().sessions);
  for (const kept of ['old-000', 'old-001', 'old-002']) assert.ok(ids.includes(kept), kept);
  assert.ok(!ids.includes('old-003'));
});

test('EVICT3 still refuses with SESSION_LIMIT when nothing can be evicted', async t => {
  const f = await fixture(t);
  await fill(f, () => ({ status: 'sending' }));
  await assert.rejects(f.broker.create(selection), /SESSION_LIMIT/);
});
