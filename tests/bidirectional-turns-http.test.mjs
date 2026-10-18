/** HTTP browser-origin wake: one wake per newly accepted page frame, no Send.
 * Temporary runtime only; a user message typed in the webpage is an observed
 * source/page run, never an imported Paseo Send turn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageView, sourceItem } from './helpers.mjs';
import { httpHarness } from './fixtures/runtime-http.mjs';

test('TURN-HTTP: authenticated page observation wakes once per new frame and never enqueues a Send', async t => {
  const h = await httpHarness(t);
  const { session, snapshot } = await h.bound();
  const frame = pageView(snapshot, { state: 'running', items: [
    sourceItem('web-user', 'typed in the webpage', { role: 'user', kind: 'message', nativeMessageId: 'native-web-user' }),
    sourceItem('web-answer', 'browser reply', { nativeMessageId: 'native-web-answer', order: [2] })
  ] });
  assert.equal((await h.request('/page-view', frame)).status, 403, 'unauthenticated observation cannot wake');
  assert.equal(h.wake.length, 0);
  const before = Object.values(h.runtime.store.read().commands).filter(c => c.kind === 'send').length;
  const accepted = await h.signed('/page-view', frame);
  assert.equal(accepted.status, 200);
  const stored = h.runtime.broker.snapshot(session.id);
  assert.ok(stored.sources.find(source => source.id === 'web-user'));
  assert.equal(stored.turn.origin ?? 'paseo', 'paseo', 'browser content is not imported as a Paseo Send turn');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(h.wake, [session.id], 'a new frame wakes the bound Agent once');
  const duplicate = await (await h.signed('/page-view', frame)).json();
  assert.equal(duplicate.duplicate, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.wake.length, 1, 'a duplicate frame is not a second wake');
  // The removed external-turn inventory/import endpoints are not available.
  assert.equal((await h.request('/bindings', undefined, h.auth)).status, 404);
  assert.equal((await h.request('/external-turn', {}, h.auth)).status, 404);
  assert.equal(Object.values(h.runtime.store.read().commands).filter(c => c.kind === 'send').length, before);
});
