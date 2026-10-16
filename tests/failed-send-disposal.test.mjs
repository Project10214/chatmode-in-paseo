import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fixture, selection } from './helpers.mjs';

const body = 'UNSENT_BODY_MUST_BE_DISCARDED';
const image = { type: 'image', mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YkCvYoAAAAASUVORK5CYII=' };
function discarded(f, id, commandId) {
  const s = f.broker.snapshot(id), c = f.store.read().commands[commandId];
  assert.equal(c.phase, 'failed');
  assert.equal(c.discarded, true);
  assert.equal(s.turn.notSent, true);
  assert.equal(s.turn.discarded, true);
  assert(!Object.hasOwn(c.payload, 'text'));
  assert(!Object.hasOwn(c.payload, 'files'));
  assert(!Object.hasOwn(s.turn, 'text'));
  assert(!s.history.some(x => x.id === `user:${s.turn.id}`));
  assert(!JSON.stringify(f.store.read()).includes(body));
}

test('known-unsent failure destroys payload but retains the spent message ID and prior history', async t => {
  const f = await fixture(t), s = await f.ready();
  const prior = { type: 'assistant_message', id: 'prior-history', text: 'KEEP_PRIOR_HISTORY' };
  await f.store.transaction(d => { d.sessions[s.id].history.push(prior); });
  const { claim } = await f.sending(s, 'spent-id', body, false);
  await f.broker.result(claim.id, claim.lease, { error: 'SEND_NOT_READY', notSent: true });
  discarded(f, s.id, claim.id);
  assert.deepEqual(f.broker.snapshot(s.id).history, [prior]);
  assert.equal(f.broker.snapshot(s.id).prompts['spent-id'].outcome, 'failed');
  assert.equal(f.broker.queued().length, 0);
  const replay = await f.broker.prompt(s.id, 'spent-id', body);
  assert.equal(replay.replay, true);
  assert.equal(replay.outcome, 'failed');
  assert.equal(f.broker.queued().length, 0);
  await assert.rejects(f.broker.prompt(s.id, 'spent-id', 'changed body'), e => e.code === 'MESSAGE_ID_CONFLICT');
  await f.broker.prompt(s.id, 'new-id', 'NEW_MESSAGE');
  assert.equal(f.broker.queued().filter(c => c.kind === 'send').length, 1);
  assert.equal(f.broker.snapshot(s.id).history.at(-1).text, 'NEW_MESSAGE');
});

test('failure before authorization discards only that command temporary files', async t => {
  const f = await fixture(t), s = await f.ready();
  await f.broker.prompt(s.id, 'file-failure', body);
  const c = f.broker.queued().find(c => c.kind === 'send');
  // Model a command staged by an older Runtime; current admission stays disabled.
  const files = await f.broker.inputFiles.stage(c.id, [image]);
  const otherId = randomUUID(), other = await f.broker.inputFiles.stage(otherId, [image]);
  await f.store.transaction(d => { d.commands[c.id].payload.files = files; });
  const claim = await f.broker.claim(c.id, s.tabId, s.documentKey);
  await f.broker.result(c.id, claim.lease, { error: 'ATTACHMENT_INPUT_AMBIGUOUS', notSent: true });
  discarded(f, s.id, c.id);
  await assert.rejects(f.broker.inputFiles.read(c.id, 0, 0, files[0]), e => e.code === 'ATTACHMENT_EXPIRED');
  assert.equal((await f.broker.inputFiles.read(otherId, 0, 0, other[0])).data, image.data);
});

for (const kind of ['unclaimed', 'canceled', 'timeout', 'restart']) {
  test(`known-unsent ${kind} operation is discarded and never requeued`, async t => {
    const f = await fixture(t), s = await f.ready();
    await f.broker.prompt(s.id, 'spent-id', body);
    const c = f.broker.queued().find(c => c.kind === 'send');
    if (kind === 'unclaimed') await f.broker.failUnclaimed(c.id, 'CONTENT_UNAVAILABLE');
    if (kind === 'canceled') await f.broker.interrupt(s.id);
    if (kind === 'timeout') await f.broker.tick(c.deadline + 1);
    if (kind === 'restart') await f.broker.recover();
    discarded(f, s.id, c.id);
    assert.equal(f.broker.queued().length, 0);
    const replay = await f.broker.prompt(s.id, 'spent-id', body);
    assert.equal(replay.replay, true);
    assert.equal(f.broker.queued().length, 0);
  });
}

test('authorized send with unknown receipt keeps reconciliation evidence, not treated as unsent', async t => {
  const f = await fixture(t), s = await f.ready(), { claim } = await f.sending(s, 'unknown', body, false);
  await f.broker.result(claim.id, claim.lease, { error: 'CONTENT_TIMEOUT' });
  const command = f.store.read().commands[claim.id], session = f.broker.snapshot(s.id);
  assert.equal(session.status, 'blocked');
  assert.notEqual(command.discarded, true);
  assert.notEqual(session.turn.notSent, true);
  assert(command.payload.text.includes(body));
  assert.equal(session.turn.text, body);
  assert(session.history.some(x => x.text === body));
});

test('acknowledged Chrome failures retain a tombstone, not a replayable body; uncertain results stay intact', async () => {
  const source = await fs.readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function postReceipt('), end = source.indexOf('async function execute(', start);
  assert(start >= 0 && end > start);
  const context = vm.createContext({ config: { endpoint: 'http://127.0.0.1:17843' },
    api: async () => ({ accepted: true }), saveLedger: async () => {}, structuredClone });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.postReceipt=postReceipt;', context);
  for (const notSent of [true, false]) {
    const row = { phase: 'receipt', lease: 'lease', command: { kind: 'send', payload: { text: body, files: [{}], turnId: 'turn' } },
      result: { error: 'SEND_NOT_READY', notSent } };
    await context.postReceipt('command', row);
    assert.equal(row.phase, 'acked');
    if (notSent) {
      assert.equal(row.discarded, true);
      assert(!Object.hasOwn(row.command.payload, 'text'));
      assert(!Object.hasOwn(row.command.payload, 'files'));
    } else {
      assert.equal(row.command.payload.text, body);
      assert.equal(row.command.payload.files.length, 1);
    }
  }
});
