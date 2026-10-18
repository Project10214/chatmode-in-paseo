/** Page button state under the continuous page-view contract.
 *
 * The old page_status/activity snapshot lane is not produced by the observation
 * path. The visible Stop/Send/Voice read is now a page-state card: one card per
 * session, updated in place, independent of readable prose, and never a
 * terminal. The bounded pageStatus validator stays because already-persisted
 * activity rows still carry that shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import { fixture, selection, until } from './helpers.mjs';
import { pageStatus } from '../server/observation.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';
import { activityCardSchema, activityCardSchemaV2 } from '../shared/activity.ts';

const config = { cwd: '/fixture', env: {}, settings: {}, mcpServers: {}, persist: true,
  model: selection.model, thinkingOption: selection.thinkingOption, providerOptions: { appIds: selection.appIds } };
const page = (patch = {}) => ({ observedAt: Date.now(), readable: true, nativeStatus: 'in_progress',
  controls: { stop: { visible: true, enabled: true }, approval: false },
  notices: [], issues: [], truncated: false, ...patch });
const errorNotice = { scope: 'turn', text: 'Something went wrong while generating the response.\nIf this issue persists please contact us.',
  buttons: [{ label: 'Retry', enabled: true }] };

test('PAGE-A1 validation is bounded, keeps unknown distinct from absent and never rewrites silently', () => {
  const ok = pageStatus(page({ notices: [errorNotice], issues: [{ messageId: 'native-a', code: 'ANSWER_RAW_DIVERGED' }] }));
  assert.equal(ok.notices[0].text, errorNotice.text, 'page original text, including line breaks');
  assert.deepEqual(ok.notices[0].buttons, [{ label: 'Retry', enabled: true }]);
  assert.equal(ok.notices[0].redacted, false);
  const unknown = pageStatus(page({ nativeStatus: null, controls: { stop: null, approval: null } }));
  const absent = pageStatus(page({ controls: { stop: { visible: false, enabled: false }, approval: false } }));
  assert.equal(unknown.controls.stop, null); assert.equal(unknown.nativeStatus, null);
  assert.deepEqual(absent.controls.stop, { visible: false, enabled: false });
  const unreadable = pageStatus(page({ readable: false, nativeStatus: null, controls: { stop: null, approval: null } }));
  assert.equal(unreadable.readable, false);
  const secret = pageStatus(page({ notices: [{ scope: 'page', text: 'Authorization: Bearer abc.def.ghi failed', buttons: [] }] }));
  assert.doesNotMatch(secret.notices[0].text, /abc\.def\.ghi/);
  assert.equal(secret.notices[0].redacted, true, 'redaction is explicitly marked');
  const long = pageStatus(page({ notices: [{ scope: 'page', text: 'x'.repeat(9000), buttons: [] }] }));
  assert.equal(long.notices[0].text.length, 8192); assert.equal(long.notices[0].clipped, true); assert.equal(long.truncated, true);
  for (const bad of [
    { ...page(), extra: 1 },
    page({ nativeStatus: 'error' }),
    page({ readable: 'yes' }),
    page({ observedAt: Date.now() + 3600000 }),
    page({ observedAt: -1 }),
    page({ controls: { stop: { visible: true }, approval: false } }),
    page({ controls: { stop: null, approval: null, extra: true } }),
    page({ notices: Array(17).fill(errorNotice) }),
    page({ notices: [{ ...errorNotice, scope: 'account' }] }),
    page({ notices: [{ ...errorNotice, text: '' }] }),
    page({ notices: [{ ...errorNotice, text: 'bad\u0000byte' }] }),
    page({ notices: [{ ...errorNotice, buttons: Array(9).fill({ label: 'x', enabled: true }) }] }),
    page({ notices: [{ ...errorNotice, buttons: [{ label: 'x'.repeat(161), enabled: true }] }] }),
    page({ issues: [{ messageId: 'fallback-turn-1', code: 'X' }] }),
    page({ issues: [{ messageId: null, code: 'lowercase' }] }),
    page({ issues: Array(65).fill({ messageId: null, code: 'X' }) }),
    page({ truncated: undefined })
  ]) assert.throws(() => pageStatus(bad), /PAGE_STATUS_INVALID|INVALID_ID|NATIVE_MESSAGE_ID_UNPROVEN/);
  const v2 = { turnId: 't', phase: 'observing', nativeStatus: null, steps: [],
    native: { phase: null, status: null, observedAt: null }, sync: { state: 'ok', issues: [] },
    outcome: null, error: null, recoveries: 0, page: ok };
  activityCardSchemaV2.parse(v2);
});

test('PAGE-A2/A4 buttons alone update one page-state card in place, without prose or a terminal', async t => {
 const f = await fixture(t), s = await f.ready(); await f.sending(s);
 const events = [];
 const provider = await createProvider({ ...f, status: () => ({ connected: true }) }, value => ProviderEventSchema.parse(value))
  .connect({ versions: [1], capabilities: CAPABILITIES });
 t.after(() => provider.close()); provider.onEvent(event => events.push(event));
 await provider.send({ type: 'session.open', requestId: 'open-page-state', sessionId: 'host',
  config, history: 'skip', persistence: { version: 1, data: { id: s.id } } });
 await until(() => events.some(event => event.type === 'session.ready'));
 await f.view(s, { state: 'running', items: [] });
 let state = f.broker.snapshot(s.id), cards = state.history.filter(row => row.kind === 'page-state');
 assert.equal(cards.length, 1); assert.equal(cards[0].data.state, 'running');
 const id = cards[0].id;
 // No readable prose, then an unreadable page: still exactly one card with the
 // same identity, whose data is replaced in place.
 const unreadable = { observedAt: Date.now(), readable: false, controls: {
  stop: { visible: false, enabled: false }, send: { visible: false, enabled: false }, voice: { visible: false, enabled: false } } };
 await f.view(s, { page: unreadable });
 state = f.broker.snapshot(s.id); cards = state.history.filter(row => row.kind === 'page-state');
 assert.equal(cards.length, 1); assert.equal(cards[0].id, id);
 assert.equal(cards[0].data.state, 'abnormal'); assert.equal(cards[0].data.readable, false);
 assert.equal(state.turn.outcome, null, 'a page state is never turn completion');
 assert.equal(state.observation.page.state, 'abnormal');
 // The Provider upserts the same item id and does not start or finish a turn.
 const items = events.filter(event => event.type === 'timeline.item' && event.item.kind === 'page-state');
 assert.ok(items.length >= 2);
 assert.equal(new Set(items.map(event => event.item.id)).size, 1);
 assert.equal(items.at(-1).item.data.state, 'abnormal');
 assert.equal(events.filter(event => event.type === 'session.turn' && event.state === 'completed').length, 0);
});

/* Retired assertions (mechanism removed):
 * PAGE-A3 page_status after a sync blockage / on a failed turn -> an unreadable
 *   or abnormal page is a page-state value (and issue), not a turn failure:
 *   CONTOBS-10, CPROV-07. Observation continues after gaps (CM-R9).
 * PAGE-A5 without timeline.plugin the page original text reaches the chat as a
 *   notice -> the page-state notice fallback is asserted in ui-copy COPY-13,
 *   and verbatim page notices are covered by COPY-6.
 */
