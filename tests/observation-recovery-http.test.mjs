/** HTTP observation endpoints: listing, rebind fencing, page-view identity and
 * observation gaps. Temporary runtime only; no Chrome, account or Send.
 *
 * The old /active and /recover-observation inventory is gone: a bound session
 * is always observable and recovery is a lease-preserving rebind plus the next
 * real page frame, never a prompt or a replay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageView, sourceItem } from './helpers.mjs';
import { httpHarness } from './fixtures/runtime-http.mjs';

const url = s => `https://chatgpt.com/c/${s.conversationId}`;

test('OBS-HTTP1 /observations lists the bound observation; rebind fences identity and rotates the lease; gaps are recorded', async t => {
  const h = await httpHarness(t);
  const { session, snapshot, tabId } = await h.bound();
  assert.equal((await h.request('/observations')).status, 403, 'unauthenticated inventory is refused');
  assert.equal((await h.request('/rebind-observation', {})).status, 403);
  const listed = await (await h.signed('/observations')).json();
  const binding = listed.sessions.find(value => value.sessionId === session.id);
  assert.ok(binding, 'the bound session is exposed for observation');
  assert.equal(binding.observationLease, snapshot.observation.lease);
  assert.equal(binding.conversationId, snapshot.conversationId);
  assert.equal(binding.generation, snapshot.observation.generation);
  assert.equal(binding.runId, snapshot.observation.run?.id ?? null);
  const base = { sessionId: session.id, observationLease: snapshot.observation.lease,
    previousDocumentKey: snapshot.documentKey, documentKey: 'replacement', tabId, url: url(snapshot) };
  for (const [patch, code] of [
    [{ observationLease: 'stale' }, 'OBSERVATION_LEASE_MISMATCH'],
    [{ previousDocumentKey: 'other-document' }, 'PAGE_IDENTITY_MISMATCH'],
    [{ url: 'https://chatgpt.com/c/foreign' }, 'PAGE_IDENTITY_MISMATCH']
  ]) {
    const response = await h.signed('/rebind-observation', { ...base, ...patch });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, code);
  }
  const rebound = await (await h.signed('/rebind-observation', base)).json();
  assert.notEqual(rebound.observationLease, snapshot.observation.lease);
  assert.equal(rebound.generation, snapshot.observation.generation + 1);
  // The old lease cannot write; the fresh lease can.
  const after = h.runtime.broker.snapshot(session.id);
  const oldLease = await h.signed('/page-view', { ...pageView(after), observationLease: snapshot.observation.lease });
  assert.equal(oldLease.status, 400);
  assert.equal((await oldLease.json()).error, 'OBSERVATION_LEASE_MISMATCH');
  const accepted = await (await h.signed('/page-view',
    pageView(after, { items: [sourceItem('answer', '新文档正文', { nativeMessageId: 'native-answer' })] }))).json();
  assert.equal(accepted.accepted, true);
  // A gap is recorded without pretending the native task stopped.
  const gap = await h.signed('/observation-gap', { ...pageView(h.runtime.broker.snapshot(session.id)),
    reason: 'SOURCE_TEMPORARILY_UNREADABLE' });
  assert.equal(gap.status, 200);
  const state = h.runtime.broker.snapshot(session.id);
  assert.equal(state.observation.gap.reason, 'SOURCE_TEMPORARILY_UNREADABLE');
  assert.equal(state.turn.outcome, null);
  assert.equal(Object.values(h.runtime.store.read().commands).filter(c => c.kind === 'stop').length, 0);
});
