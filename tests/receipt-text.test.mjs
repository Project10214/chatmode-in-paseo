import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { safeDiagnostic } from '../server/diagnostics.mjs';
const source = await readFile(new URL('../extension/upstream/cos-receipt-text.js', import.meta.url), 'utf8');
const context = vm.createContext({}); vm.runInContext(source, context);
const normalize = value => value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
const { classify } = context.CIP_createCoSReceiptText({ normalize });

test('TEXT1 exact authored bytes win before any decoding, including literal escapes', () => {
  for (const text of ['hi', '中文 😀', String.raw`C:\tmp\files\*`, String.raw`literal \[not markup\]`, 'a  b\n\n  c'])
    assert.equal(classify(text, text, true), 'raw');
});
test('TEXT2 native inserted context accepts one punctuation-escape layer', () => {
  assert.equal(classify(String.raw`\[Paseo context — user\-level instructions\]`, '[Paseo context — user-level instructions]', true), 'markdown');
});
test('TEXT3 native hard breaks decode once and preserve separate paragraphs', () => {
  assert.equal(classify('first\\\n\\\nsecond', 'first\n\nsecond', true), 'markdown');
  assert.equal(classify('first\\\r\nsecond', 'first\nsecond', true), 'markdown');
  assert.equal(classify('first\\\nsecond', 'first\n\nsecond', true), 'mismatch');
});
test('TEXT4 DOM captions and unproven sources never get decoded comparison', () => {
  assert.equal(classify(String.raw`\[x\]`, '[x]', false), 'mismatch');
  assert.equal(classify(String.raw`\[x\]`, '[x]'), 'mismatch');
  assert.equal(classify(String.raw`\[x\]`, '[x]', 'true'), 'mismatch');
});
test('TEXT5 no whitespace-stripping, substring, case-insensitive or Markdown-rendered matching', () => {
  for (const [actual, expected] of [['a b','ab'], ['a  b','a b'], ['x\ny','xy'], ['Hi','hi'], ['**hi**','hi'], ['prefix hi','hi'], ['x\n c','x\n  c']])
    assert.equal(classify(actual, expected, true), 'mismatch', JSON.stringify([actual, expected]));
});
test('TEXT6 double-encoded data is not repeatedly decoded until it matches', () => {
  assert.equal(classify(String.raw`\\\[x\\\]`, '[x]', true), 'mismatch');
});
test('TEXT7 literal backslash paths/globs survive raw-first or a single encoded layer', () => {
  const expected = String.raw`C:\tmp\files\*`;
  assert.equal(classify(expected, expected, true), 'raw');
  assert.equal(classify(String.raw`C\:\\tmp\\files\\\*`, expected, true), 'markdown');
  assert.equal(classify(String.raw`C:\tmp\files*`, expected, true), 'mismatch');
});
test('TEXT8 source code indentation and fences are not removed by comparison', () => {
  const expected = '```js\n  a_b();\n```';
  assert.equal(classify('\\`\\`\\`js\\\n  a\\_b\\(\\)\\;\\\n\\`\\`\\`', expected, true), 'markdown');
  assert.equal(classify('\\`\\`\\`js\\\n a\\_b\\(\\)\\;\\\n\\`\\`\\`', expected, true), 'mismatch');
});
test('TEXT9 upstream leading-space marker only; no generic HTML entity decoding', () => {
  assert.equal(classify('a\\\n&#x20;b', 'a\n b', true), 'markdown');
  assert.equal(classify('a &amp; b', 'a & b', true), 'mismatch');
  assert.equal(classify('a&#x20;b', 'a b', true), 'mismatch');
});
test('TEXT10 absent, blank and oversized data cannot confirm an inserted message', () => {
  for (const value of [null, undefined, {}, [], 1, '', '   ']) assert.equal(classify(value, 'hi', true), 'mismatch');
  assert.equal(classify('x'.repeat(256001), 'hi', true), 'mismatch');
  assert.equal(classify('x'.repeat(240001), 'x'.repeat(240001), true), 'mismatch');
});
test('TEXT11 diagnostic records keep match class and bounded counts, never text', () => {
  assert.deepEqual(safeDiagnostic({stage:'receipt',bodyMatch:'markdown',exactUserCount:0,escapedUserCount:1,text:'SECRET',expected:'SECRET'}),
    {stage:'receipt',exactUserCount:0,escapedUserCount:1,bodyMatch:'markdown'});
  assert.deepEqual(safeDiagnostic({stage:'receipt',bodyMatch:'PRIVATE',exactUserCount:-1,escapedUserCount:129}), {stage:'receipt'});
});
test('TEXT12 decoder is the pinned upstream expression, not a Markdown parser', async t => {
  const upstream = await readFile(new URL('../.work/receipt-20261013/upstream/content.js', import.meta.url), 'utf8').catch(() => null);
  if (!upstream) return t.skip('Pinned source archive not present; literal contract tests still run.');
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.startsWith('  const unescapeMarkdown ='));
  assert.ok(start >= 0);
  const expression = lines.slice(start, start + 2).join('\n');
  assert.ok(expression.endsWith(';') && upstream.includes(expression));
});
