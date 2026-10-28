import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.mjs';

async function lines(directory, date) {
  const text = await readFile(path.join(directory, 'archive', `${date}.jsonl`), 'utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function archivingTab(t) {
  const f = await fixture(t);
  const s = await f.ready();
  await f.store.transaction(d => { d.sessions[s.id].conversationId = 'durable-conversation'; });
  await f.broker.archiveSession(s.id);
  const close = f.broker.queued().find(row => row.kind === 'close-tab');
  assert.ok(close, 'archive must queue a browser close command');
  const claim = await f.broker.claim(close.id, s.tabId, s.documentKey);
  return { f, s, close, claim };
}

for (const skipped of ['TAB_NOT_OWNED', 'TAB_MISSING', 'PAGE_UNAVAILABLE']) {
  test(`a tab the browser no longer owns (${skipped}) stops blocking the archive`, async t => {
    const { f, s, close, claim } = await archivingTab(t);
    await f.broker.result(close.id, claim.lease, { closed: false, skipped });
    assert.equal(f.store.read().sessions[s.id], undefined, 'archive must finish once the tab is gone');
    const date = f.store.read().archiveIndex[s.id];
    assert.ok(date, 'archive index keeps the row reachable');
    const saved = (await lines(f.directory, date)).find(row => row.id === s.id);
    assert.equal(saved.session.tabId, null);
    assert.equal(saved.session.documentKey, null);
    assert.equal(saved.session.conversationId, 'durable-conversation', 'binding survives so a later Send can reopen');
  });
}

for (const skipped of ['ACTIVE_TAB', 'DOCUMENT_CHANGED', 'PAGE_BUSY', 'WRONG_CONVERSATION']) {
  test(`a tab that may still be ours (${skipped}) keeps the session and its binding`, async t => {
    const { f, s, close, claim } = await archivingTab(t);
    await f.broker.result(close.id, claim.lease, { closed: false, skipped });
    const current = f.store.read().sessions[s.id];
    assert.ok(current, 'session must stay in the live store');
    assert.equal(current.tabId, s.tabId);
    assert.equal(current.documentKey, s.documentKey);
    assert.ok(current.archiveIntent, 'archive intent is kept for a later attempt');
    assert.equal(f.broker.queued().filter(c => c.kind === 'close-tab').length, 0, 'no immediate retry loop');
  });
}

test('a settled skip is probed once more after a runtime restart, not forever', async t => {
  const { f, s, close, claim } = await archivingTab(t);
  await f.broker.result(close.id, claim.lease, { closed: false, skipped: 'ACTIVE_TAB' });
  assert.equal(f.broker.queued().some(c => c.kind === 'close-tab'), false, 'same runtime does not retry');
  const { Broker } = await import('../server/broker.mjs');
  const restarted = new Broker(f.store, {});
  await restarted.recover();
  const retry = restarted.queued().find(c => c.kind === 'close-tab' && c.sessionId === s.id);
  assert.ok(retry, 'restart re-probes the tab once');
  const second = new Broker(f.store, {});
  await second.recover();
  assert.equal(second.queued().filter(c => c.kind === 'close-tab' && c.sessionId === s.id).length, 1,
    'the probe is not multiplied by further restarts');
  await second.close(); await restarted.close();
});
