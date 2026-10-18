import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, pageView, selection, until } from './helpers.mjs';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import { createProvider, hostMcpNotice, wireModels, CAPABILITIES } from '../server/provider.mjs';
import { MAX_STATE_BYTES, CONTROL_RESERVE_BYTES } from '../server/store.mjs';
import { LIMITS, identifier } from '../server/protocol.mjs';

test('R01: duplicate Stop shares one command; the result settles both waiters', async t => {
  const f = await fixture(t), s = await f.ready(); await f.sending(s);
  await f.view(s, { state: 'running' });
  const a = f.broker.interrupt(s.id), b = f.broker.interrupt(s.id);
  a.catch(() => {}); b.catch(() => {});
  const command = await until(() => f.broker.queued().find(c => c.kind === 'stop'));
  assert.equal(f.broker.queued().filter(c => c.kind === 'stop').length, 1);
  const claim = await f.broker.claim(command.id, s.tabId, s.documentKey);
  await f.broker.result(command.id, claim.lease, { stopped: true });
  assert.deepEqual(await a, { stopped: true });
  assert.deepEqual(await b, { stopped: true });
  assert.equal(f.broker.queued().length, 0);
  // A click receipt is not the page ending; the visible standby frame is.
  await f.view(s, { state: 'standby' });
  assert.equal(f.broker.snapshot(s.id).status, 'idle');
});
test('R02: late old-turn failure cannot terminate the next admitted turn', async t => {
  const f = await fixture(t), s = await f.ready(), { event } = await f.sending(s);
  await f.view(f.broker.snapshot(s.id), { state: 'standby' });
  const next = await f.broker.prompt(s.id, 'next', 'next task');
  await f.broker.failTurn(s.id, 'STOP_UNCONFIRMED', true, event.turnId);
  assert.equal(f.broker.snapshot(s.id).turn.id, next.turnId);
  assert.equal(f.broker.snapshot(s.id).turn.outcome, null);
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
test('R07: whole-state byte reservation rejects before any Send intent or native authorization', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.store.transaction(d => { d.testPadding = 'x'.repeat(MAX_STATE_BYTES - CONTROL_RESERVE_BYTES - 100000); });
  await assert.rejects(f.broker.prompt(s.id, 'too-full', 'do not send'), /STATE_CAPACITY_RESERVED/);
  assert.equal(f.broker.snapshot(s.id).status, 'idle'); assert.equal(f.broker.queued().length, 0);
});
test('R09: proven document reload only rebinds observation, without another Send', async t => {
  const f = await fixture(t), s = await f.ready(); await f.sending(s);
  const before = f.broker.snapshot(s.id);
  const updated = await f.broker.rebindObservation({ sessionId: s.id,
    observationLease: before.observation.lease, previousDocumentKey: before.documentKey,
    documentKey: 'replacement-document', tabId: before.tabId,
    url: 'https://chatgpt.com/c/' + before.conversationId });
  const after = f.broker.snapshot(s.id);
  assert.equal(after.documentKey, 'replacement-document');
  assert.notEqual(updated.observationLease, before.observation.lease);
  assert.equal(Object.values(f.store.read().commands).filter(c => c.kind === 'send').length, 1);
  await assert.rejects(f.broker.observeView({ ...pageView(after), observationLease: before.observation.lease }),
    /OBSERVATION_LEASE_MISMATCH/);
  const accepted = await f.broker.observeView(pageView(after, { items: [{
    id: 'current', userMessageId: null, role: 'assistant', lane: 'output', kind: 'message',
    text: 'recovered', format: 'text', order: [1], nativeMessageId: 'native-current' }] }));
  assert.equal(accepted.accepted, true);
});
test('R10: another native anchor or conversation cannot claim observation custody', async t => {
  const f = await fixture(t), s = await f.ready(), { event } = await f.sending(s);
  const proof = { ...event, previousDocumentKey: event.documentKey, documentKey: 'new', tabId: s.tabId + 10 };
  for (const patch of [{ nativeMessageId: 'other' }, { url: 'https://chatgpt.com/c/not-owned' }, { previousDocumentKey: 'stale' }, { lease: 'wrong' }]) await assert.rejects(f.broker.rebindObservation({ ...proof, ...patch }));
  assert.equal(f.broker.snapshot(s.id).documentKey, event.documentKey);
});
test('R11: a lost observation affects only its own session, without a fictitious live URL or Stop', async t => {
  const f = await fixture(t), a = await f.ready(), b = await f.ready();
  await f.sending(a, 'a');
  const y = await f.sending(b, 'b');
  await f.broker.observeGap({ ...pageView(f.broker.snapshot(a.id)), reason: 'PAGE_CLOSED' });
  const lost = f.broker.snapshot(a.id);
  assert.equal(lost.observation.gap.reason, 'PAGE_CLOSED');
  assert.equal(lost.turn.outcome, null, 'a gap is not a failed native turn');
  const other = f.broker.snapshot(b.id);
  assert.equal(other.turn.id, y.event.turnId);
  assert.equal(other.status, 'running');
  assert.equal(Object.values(f.store.read().commands).some(c => c.kind === 'stop'), false);
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
test('R15: updated context is sent as explicit user-level text on the next turn', async t => {
  const f = await fixture(t), s = await f.ready(); await f.sending(s);
  await f.view(f.broker.snapshot(s.id), { state: 'standby' });
  await f.broker.updateContext(s.id, { cwd: '/new-place', systemPrompt: 'New user-level instruction' });
  await f.broker.prompt(s.id, 'context-update', 'next');
  const command = f.broker.queued().find(c => c.kind === 'send');
  assert.match(command.payload.text, /user-level instructions/);
  assert.match(command.payload.text, /\/new-place/);
  assert.match(command.payload.text, /New user-level instruction/);
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
test('R19: an open approval and an externally closed card produce distinct notices', async t => {
  const f = await fixture(t), events = [];
  // A client without permission UI receives notices instead of a request.
  const provider = await createProvider({ ...f, status: () => ({ connected: true }) },
    value => ProviderEventSchema.parse(value))
    .connect({ versions: [1], capabilities: CAPABILITIES.filter(c => c !== 'permission') });
  t.after(() => provider.close()); provider.onEvent(e => events.push(e));
  const s = await f.ready(); await f.sending(s);
  await provider.send({ type: 'session.open', requestId: 'notice-open', sessionId: 'notice-host',
    history: 'skip', config: { cwd: '/fixture', env: {}, settings: {}, mcpServers: {}, persist: true,
      model: s.config.model, thinkingOption: s.config.thinkingOption,
      providerOptions: { appIds: s.config.appIds } }, persistence: { version: 1, data: { id: s.id } } });
  await until(() => events.some(e => e.type === 'session.ready'));
  const card = { state: 'open', key: '6f1c2d3e-0000-4000-8000-000000000001', app: 'mymac',
    tool: 'run_shell_command', input: JSON.stringify({ args: { command: 'node --version' } }) };
  await f.view(s, { state: 'standby', approvals: [card] });
  await until(() => events.some(e => e.notice?.title === '请在网页处理授权'));
  await f.view(s, { state: 'standby', approvals: [], closedApprovals: [card.key] });
  const closed = await until(() => events.find(e => e.notice?.title === '网页授权框已关闭'));
  const open = events.find(e => e.notice?.title === '请在网页处理授权');
  assert.notEqual(open.notice.id, closed.notice.id);
  assert.doesNotMatch(closed.notice.title, /批准|已处理/);
  assert.equal(f.broker.snapshot(s.id).approvals[card.key].answered, undefined,
    'closing externally is not a recorded allow/deny');
});

/* Retired assertions (mechanism removed):
 * R05/R06/R08 per-turn response-fragment admission and aggregate answer caps ->
 *   there is no per-turn fragment counter any more. Capacity is the bounded
 *   frame size and explicit PAGE_ENTRY_TOO_LARGE (MON-09/MON-10), no 16-message
 *   or 300k per-turn cutoff (CM-R10), plus the whole-state byte reservation
 *   still asserted by R07.
 */
