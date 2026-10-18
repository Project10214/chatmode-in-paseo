/** HTTP page-view entry: persistence, idempotency, sequence conflicts,
 * malformed frames, authentication and restart. Temporary runtime only.
 *
 * The old /event completed-message receipts no longer exist; the continuous
 * frame is the persisted observation unit. Local acceptance is still not a
 * host ACK (no receipt is returned).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageView, sourceItem } from './helpers.mjs';
import { httpHarness } from './fixtures/runtime-http.mjs';

const item = (id, text) => sourceItem(id, text, { nativeMessageId: 'native-' + id, order: [1] });

test('CM-HTTP1 page views over HTTP: stored once, duplicate unchanged, conflict/malformed/unauthenticated rejected, restart survives', async t => {
  const h = await httpHarness(t);
  const { session, snapshot } = await h.bound();
  const frame = pageView(snapshot, { items: [item('answer', '保存的正文')] });
  const unauth = await h.request('/page-view', frame);
  assert.equal(unauth.status, 403);
  const first = await h.signed('/page-view', frame);
  assert.equal(first.status, 200);
  const stored = await first.json();
  assert.equal(stored.accepted, true);
  assert.equal(stored.receipt, undefined, 'local persistence is not a host receipt');
  assert.equal(h.runtime.broker.snapshot(session.id).sources[0].text, '保存的正文');
  const again = await (await h.signed('/page-view', frame)).json();
  assert.equal(again.duplicate, true);
  const changed = pageView(snapshot, { items: [item('answer', '不同的正文')] });
  const conflict = await h.signed('/page-view', changed);
  assert.equal(conflict.status, 400);
  assert.equal((await conflict.json()).error, 'OBSERVATION_SEQUENCE_CONFLICT');
  const malformed = await h.signed('/page-view', { ...frame, sequence: 0 });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'PAGE_VIEW_INVALID');
  // Restart on the same directory: the frame is still the stored one, not a
  // fresh body, and the source survived.
  await h.restart();
  assert.equal(h.runtime.broker.snapshot(session.id).sources[0].text, '保存的正文');
  const after = await (await h.signed('/page-view', frame)).json();
  assert.equal(after.duplicate, true);
  assert.equal(h.runtime.store.read().sessions[session.id].status, 'running');
});
