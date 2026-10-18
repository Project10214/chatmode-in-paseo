import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { receiveMessage, messageEvent } from '../server/message-delivery.mjs';

// The pairing helpers from the MAIN-world transcript reader, run against stub pills.
const source = await readFile(new URL('../extension/upstream/cos-picker-main.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('  const CITATION='), source.indexOf('  function publicTranscript() {'));
const ctx = vm.createContext({ URL, OWN_SURFACES: '.clf-stream' });
vm.runInContext(helpers + '\nglobalThis.citeSection=citeSection;', ctx);
const pill = (label, href) => ({ innerText: label, href, closest: () => null });
const section = pills => ({ querySelectorAll: () => pills });

test('CITE-1 paired directives become source links in page order; tracking params are removed', () => {
  // Raw DIL keeps the directive escaped; the decoded form uses a single colon.
  const out = [{ id: 'a1', role: 'assistant', text: 'OT 能离线。\\:\\:chatgpt-content-reference\\{index=\\"0\\"\\}\n收敛 :chatgpt-content-reference{index="1"}' }];
  ctx.citeSection(section([pill('ShareDB', 'https://share.github.io/sharedb/?utm_source=chatgpt.com'),
    pill('docs.yjs.dev\n+2', 'https://docs.yjs.dev/api/document-updates?utm_source=chatgpt.com')]), out, ['a1']);
  assert.equal(out[0].text, 'OT 能离线。 [ShareDB](<https://share.github.io/sharedb/>)\n收敛 [docs.yjs.dev](<https://docs.yjs.dev/api/document-updates>)');
});

test('CITE-2 a count mismatch or unsafe link pairs nothing', () => {
  const text = 'a :chatgpt-content-reference{index="0"} b :chatgpt-content-reference{index="1"}';
  const out = [{ id: 'a1', role: 'assistant', text }];
  ctx.citeSection(section([pill('Only one', 'https://example.com/')]), out, ['a1']);
  assert.equal(out[0].text, text);
  ctx.citeSection(section([pill('x', 'javascript:alert(1)'), pill('y', 'https://example.com/')]), out, ['a1']);
  assert.equal(out[0].text, text);
});

const identity = { kind: 'message', sessionId: 's', turnId: 't', lease: 'l', nativeMessageId: 'u1', tabId: 1, documentKey: 'd', url: 'https://chatgpt.com/c/x' };
const session = () => ({ turn: { id: 't', nativeMessageId: 'u1' }, history: [] });

test('CITE-3 the receiver drops unpaired directives instead of showing them raw', () => {
  const s = session();
  const m = messageEvent({ ...identity, messageId: 'a1', text: '理由。:chatgpt-content-reference{index="0"} 结论', format: 'text', messageState: 'complete' });
  const r = receiveMessage(s, m, { at: 1 });
  assert.equal(r.receipt.disposition, 'stored');
  assert.equal(s.history[0].text, '理由。 结论');
});

test('CITE-4 a later version that only adds citation links is the same message, not a conflict', () => {
  const s = session();
  receiveMessage(s, messageEvent({ ...identity, messageId: 'a1', text: '理由。:chatgpt-content-reference{index="0"}', format: 'text', messageState: 'complete' }), { at: 1 });
  const r = receiveMessage(s, messageEvent({ ...identity, messageId: 'a1', text: '理由。 [ShareDB](<https://share.github.io/sharedb/>)', format: 'text', messageState: 'complete' }), { at: 2 });
  assert.equal(r.receipt.disposition, 'unchanged');
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].text, '理由。');
});
