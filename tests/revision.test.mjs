import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, selection, until } from './helpers.mjs';
import { createProvider, hostMcpNotice, wireModels, CAPABILITIES } from '../server/provider.mjs';
import { MAX_STATE_BYTES, CONTROL_RESERVE_BYTES } from '../server/store.mjs';
import { LIMITS, identifier } from '../server/protocol.mjs';

test('R01: duplicate Stop shares one command and final observation settles both waiters', async t => {
  const f = await fixture(t), s = await f.ready(), { event } = await f.sending(s);
  const a = f.broker.interrupt(s.id), b = f.broker.interrupt(s.id);
  a.catch(() => {}); b.catch(() => {});
  await until(() => f.broker.queued().some(c => c.kind === 'stop'));
  assert.equal(f.broker.queued().filter(c => c.kind === 'stop').length, 1);
  await f.broker.observe({ ...event, kind: 'snapshot', messageId: 'answer', text: 'done' });
  await f.broker.observe({ ...event, kind: 'completed', messageId: 'answer', finalConfirmed: true });
  assert.equal((await a).stopped, true); assert.equal((await b).stopped, true);
  assert.equal(f.broker.snapshot(s.id).status, 'idle'); assert.equal(f.broker.queued().length, 0);
});
test('R02: late old-turn failure cannot terminate the next admitted turn', async t => {
  const f = await fixture(t), s = await f.ready(), { event } = await f.sending(s);
  await f.broker.observe({ ...event, kind: 'snapshot', messageId: 'answer', text: 'done' });
  await f.broker.observe({ ...event, kind: 'completed', messageId: 'answer', finalConfirmed: true });
  const next = await f.broker.prompt(s.id, 'next', 'next task');
  await f.broker.failTurn(s.id, 'STOP_UNCONFIRMED', true, event.turnId);
  assert.equal(f.broker.snapshot(s.id).turn.id, next.turnId); assert.equal(f.broker.snapshot(s.id).turn.outcome, null);
});
test('R03: busy rejection is durable and cannot be resubmitted after another connection opens', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.broker.prompt(s.id, 'first', 'first');
  await assert.rejects(f.broker.prompt(s.id, 'rejected-id', 'later'), /SESSION_BUSY/);
  await f.broker.interrupt(s.id);
  await assert.rejects(f.broker.prompt(s.id, 'rejected-id', 'later'), /SESSION_BUSY/);
  assert.equal(f.broker.queued().length, 0);
  const next = await f.broker.prompt(s.id, 'explicit-new-id', 'later'); assert.equal(next.replay, false);
});
test('R04: reserved prototype-like message identifiers are rejected', () => {
  for (const id of ['__proto__', 'constructor', 'prototype']) assert.throws(() => identifier(id), /INVALID_ID/);
});
test('R05: final-slot admission reserves all supported response fragments', async t => {
  const f = await fixture(t), s = await f.ready();
  const count = LIMITS.history - LIMITS.turnFragments - 1;
  await f.store.transaction(d => { d.sessions[s.id].history = Array.from({ length: count }, (_, i) => ({ type: 'assistant_message', id: `past:${i}`, text: 'past' })); });
  const { event } = await f.sending(s);
  for (let i = 0; i < LIMITS.turnFragments; i++) await f.broker.observe({ ...event, kind: 'snapshot', messageId: `fragment-${i}`, text: `part ${i}` });
  await f.broker.observe({ ...event, kind: 'completed', finalConfirmed: true, messageId: `fragment-${LIMITS.turnFragments - 1}` });
  assert.equal(f.broker.snapshot(s.id).status, 'idle'); assert.equal(f.broker.snapshot(s.id).history.length, LIMITS.history);
});
test('R06: excessive response fragmentation terminates with a recorded limit, never a running loop', async t => {
  const f = await fixture(t), s = await f.ready(), { event } = await f.sending(s);
  for (let i = 0; i <= LIMITS.turnFragments; i++) await f.broker.observe({ ...event, kind: 'snapshot', messageId: `fragment-${i}`, text: 'part' });
  const after = f.broker.snapshot(s.id); assert.equal(after.status, 'blocked'); assert.equal(after.turn.outcome, 'failed'); assert.equal(after.error, 'TURN_OUTPUT_LIMIT');
});
test('R07: whole-state byte reservation rejects before any Send intent or native authorization', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.store.transaction(d => { d.testPadding = 'x'.repeat(MAX_STATE_BYTES - CONTROL_RESERVE_BYTES - 100000); });
  await assert.rejects(f.broker.prompt(s.id, 'too-full', 'do not send'), /STATE_CAPACITY_RESERVED/);
  assert.equal(f.broker.snapshot(s.id).status, 'idle'); assert.equal(f.broker.queued().length, 0);
});
test('R08: aggregate answer cap preserves history and a terminal failure', async t => {
  const f = await fixture(t), s = await f.ready(), { event } = await f.sending(s);
  await f.broker.observe({ ...event, kind: 'snapshot', messageId: 'a1', text: 'x'.repeat(200000) });
  const result = await f.broker.observe({ ...event, kind: 'snapshot', messageId: 'a2', text: 'y'.repeat(100000) });
  assert.equal(result.active, false); assert.equal(f.broker.snapshot(s.id).error, 'TURN_OUTPUT_LIMIT');
  assert.equal(f.broker.snapshot(s.id).history.at(-1).text.length, 200000);
});
test('R09: proven document reload only rebinds observation, without another Send', async t => {
  const f = await fixture(t), s = await f.ready(), { event } = await f.sending(s);
  const updated = await f.broker.rebindObservation({ ...event, previousDocumentKey: event.documentKey, documentKey: 'replacement-document', tabId: s.tabId + 10 });
  assert.equal(updated.documentKey, 'replacement-document'); assert.equal(f.broker.queued().length, 0);
  await assert.rejects(f.broker.observe({ ...event, kind: 'snapshot', messageId: 'old', text: 'old' }), /PAGE_IDENTITY_MISMATCH/);
  await f.broker.observe({ ...event, ...updated, kind: 'snapshot', messageId: 'current', text: 'recovered' });
});
test('R10: another native anchor or conversation cannot claim observation custody', async t => {
  const f = await fixture(t), s = await f.ready(), { event } = await f.sending(s);
  const proof = { ...event, previousDocumentKey: event.documentKey, documentKey: 'new', tabId: s.tabId + 10 };
  for (const patch of [{ nativeMessageId: 'other' }, { url: 'https://chatgpt.com/c/not-owned' }, { previousDocumentKey: 'stale' }, { lease: 'wrong' }]) await assert.rejects(f.broker.rebindObservation({ ...proof, ...patch }));
  assert.equal(f.broker.snapshot(s.id).documentKey, event.documentKey);
});
test('R11: a missing browser binding blocks exactly its own turn, without a fictitious live URL', async t => {
  const f = await fixture(t), a = await f.ready(), b = await f.ready();
  const x = await f.sending(a, 'a'), y = await f.sending(b, 'b');
  await f.broker.observe({ ...x.event, kind: 'binding_lost', url: undefined });
  assert.equal(f.broker.snapshot(a.id).error, 'BROWSER_BINDING_LOST'); assert.equal(f.broker.snapshot(b.id).status, 'running');
  assert.equal(f.broker.snapshot(b.id).turn.id, y.event.turnId);
});
test('R12: known not-clicked result after authorization is distinct from an unconfirmed Send', async t => {
  const f = await fixture(t), s = await f.ready(), { claim } = await f.sending(s, 'notsent', 'notsent', false);
  await f.broker.result(claim.id, claim.lease, { error: 'DRAFT_CHANGED', notSent: true });
  assert.equal(f.broker.snapshot(s.id).status, 'idle'); assert.equal(f.broker.snapshot(s.id).turn.outcome, 'failed');
});
test('R13: late configuration after timeout cannot publish a new effective model', async t => {
  const f = await fixture(t), s = await f.ready();
  const changing = f.broker.configure(s.id, { model: 'm2', thinkingOption: null, appIds: [] }); changing.catch(() => {});
  const c = await until(() => f.broker.queued().find(c => c.kind === 'configure'));
  const claim = await f.broker.claim(c.id, s.tabId, s.documentKey);
  await f.broker.tick(c.deadline + 1); await changing.catch(() => {});
  await f.broker.result(c.id, claim.lease, { config: c.payload.config, tabId: s.tabId, url: 'https://chatgpt.com/' });
  assert.equal(f.broker.snapshot(s.id).config.model, 'm1'); assert.equal(f.broker.snapshot(s.id).status, 'blocked');
});
test('R14: startup fences a previously claimed configuration even when its session was idle', async t => {
  const f = await fixture(t), s = await f.ready();
  const c = await f.broker.enqueue('configure', s.id, { config: selection });
  await f.broker.claim(c.id, s.tabId, s.documentKey); await f.broker.recover();
  assert.equal(f.broker.snapshot(s.id).status, 'blocked'); assert.equal(f.broker.queued().length, 0);
});
test('R15: updated context is sent as explicit user-level text on the next existing conversation turn', async t => {
  const f = await fixture(t), s = await f.ready(), { event } = await f.sending(s);
  await f.broker.observe({ ...event, kind: 'snapshot', messageId: 'a', text: 'done' });
  await f.broker.observe({ ...event, kind: 'completed', messageId: 'a', finalConfirmed: true });
  await f.broker.updateContext(s.id, { cwd: '/new-place', systemPrompt: 'New user-level instruction' });
  await f.broker.prompt(s.id, 'context-update', 'next');
  const command = f.broker.queued().find(c => c.kind === 'send');
  assert.match(command.payload.text, /user-level instructions/); assert.match(command.payload.text, /\/new-place/); assert.match(command.payload.text, /New user-level instruction/);
});
test('R16: the host-shaped MCP exception is narrow and emits an explicit limitation notice', () => {
  assert.equal(hostMcpNotice({}), null);
  assert.match(hostMcpNotice({ paseo: { type: 'http', url: 'http://127.0.0.1:1234/mcp/agents' } }).title, /未导入/);
  for (const entry of [{ paseo: { type: 'http', url: 'https://example.com/mcp/agents' } }, { paseo: { type: 'stdio', command: 'anything' } }, { other: { type: 'http', url: 'http://127.0.0.1:1234/mcp/agents' } }]) assert.throws(() => hostMcpNotice(entry), /MCP/);
});
test('R17: saved thinking default updates both the model descriptor and catalog cache identity', async t => {
  const f = await fixture(t), provider = createProvider({ ...f, status: () => ({ connected: true }) });
  const before = await provider.getCatalogCacheKey({ scope: 'global' });
  await f.broker.defaults({ model: 'm1', thinkingOption: 'extended', appIds: [] });
  assert.notEqual(await provider.getCatalogCacheKey({ scope: 'global' }), before);
  assert.equal(wireModels(f.store.read().catalog, f.store.read().defaults)[0].defaultThinkingOptionId, 'extended');
  assert.equal(Object.hasOwn(wireModels(f.store.read().catalog)[1], 'defaultThinkingOptionId'), false);
});
test('R18: explicit abandonment never creates a Send, erases history or claims to stop the website', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.sending(s,'uncertain','message',false);
  await f.broker.failTurn(s.id,'RECEIPT_UNCONFIRMED',true);
  assert.equal(f.broker.snapshot(s.id).status,'blocked');
  const history = f.broker.snapshot(s.id).history;
  const result = await f.broker.abandon(s.id);
  assert.deepEqual(result, { abandoned: true }); assert.equal(f.broker.snapshot(s.id).status, 'abandoned'); assert.deepEqual(f.broker.snapshot(s.id).history, history);
  assert.equal(f.broker.queued().length, 0);
});
test('R19: permission and unknown-final notices stay distinct', async t => {
  const f = await fixture(t), s = await f.ready(), { event } = await f.sending(s), observed = [];
  f.broker.subscribe(s.id, x => observed.push(x));
  await f.broker.observe({ ...event, kind: 'waiting', reason: 'final-unconfirmed' });
  assert.equal(observed[0].reason, 'final-unconfirmed'); assert.equal(f.broker.snapshot(s.id).status, 'running');
});
