import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSourceProse } from '../server/source-prose.mjs';
import { decodePublicProse } from '../shared/public-prose.mjs';

const source = (extra = {}) => ({ id: 'source-a', userMessageId: 'user-a', nativeMessageId: 'native-a',
  role: 'assistant', lane: 'output', kind: 'message', text: 'DOM 渲染正文', format: 'text', order: [1], ...extra });
const rawSource = (rawText, representation = 'dil', extra = {}) => source({
  prose: { rawText, representation, observedAt: 123, ...extra },
});
const restart = state => JSON.parse(JSON.stringify(state));
const codes = result => result.issues.map(issue => issue.code);

// Independent whole-input oracle, adapted from the CoS/MIT fallback semantics
// in shared/public-prose.mjs. The sole deliberate grammar change is UNBOUNDED
// display-math lookup: the historical 400-line cap is explicitly not retained.
// Production incremental code never calls this oracle or the whole decoder.
function reference(raw) {
  const lines = raw.split('\n'), out = []; let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = null;
      out.push(line); continue;
    }
    if (marker && !(marker[0] === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`'))) {
      fence = marker; out.push(line); continue;
    }
    if (line.trim() === '\\[') {
      let close = -1;
      for (let at = index + 1; at < lines.length; at++) if (lines[at].trim() === '\\]') { close = at; break; }
      if (close > index) { for (; index <= close; index++) out.push(lines[index]); index--; continue; }
    }
    let text = '';
    for (let at = 0; at < line.length;) {
      const char = line[at];
      if (char === '\\' && line[at + 1] === '(') {
        const close = line.indexOf('\\)', at + 2);
        if (close >= 0) { text += line.slice(at, close + 2); at = close + 2; continue; }
      }
      if (char === '\\' && /[!-\/:-@[-`{-~]/.test(line[at + 1] || '')) { text += line[at + 1]; at += 2; continue; }
      if (char === '`') {
        const run = /^`+/.exec(line.slice(at))[0];
        const close = new RegExp(`(?<!\u0060)${run}(?!\u0060)`).exec(line.slice(at + run.length));
        if (close) { const end = at + run.length + close.index + run.length; text += line.slice(at, end); at = end; continue; }
        text += run; at += run.length; continue;
      }
      text += char; at++;
    }
    out.push(text);
  }
  return out.join('\n');
}

const corpus = [
  ['', ''],
  ['plain Unicode', '普通文字立即释放 hello 😀 e\u0301 结束'],
  ['punctuation escapes', '句子 \\! \\_ \\* \\[x\\] \\{y\\} \\\\ end\n'],
  ['inline code', 'prefix `a\\_b \\*x\\*` tail\n'],
  ['unequal code runs', 'pre ``a`b\\_c`` post\n'],
  ['closing run grows', 'lead `a\\_b`` tails `close\\_x` end'],
  ['unmatched inline', 'prefix `x\\_y and \\!'],
  ['unmatched math', 'prefix \\(x\\_y + 2'],
  ['closed inline math', '公式 \\(x\\_y+1\\) 后 \\!\n'],
  ['escaped math opener', '\\\\(x\\_y\\\\)\\!\n'],
  ['backslash tail', 'text\\'],
  ['backtick fence', '```js\nconst x="\\\\("; \\_ \\*\n```\n后缀 \\_\n'],
  ['invalid backtick info', '```lang` \\_x\nbody \\*\n```\n'],
  ['tilde fence growth', '~~~~lang`\n\\[\nliteral \\_\n~~~\nstill \\!\n~~~~\nnormal \\_'],
  ['indented display math', '前言\n  \\[  \nx\\_y + \\!\n  \\] \n结尾'],
  ['CRLF and tabs', '前言\r\n\t \\[ \r\nx\\_y\r\n\t\\] \r\n结尾'],
  ['unterminated display math', 'prefix\n\\[\n\\*inner\\*\nnext `x\\_y`'],
  ['nested math opener', '\\[\n\\[\na\\_b\n\\]\nend\\_\n'],
  ['fenced literal formulas', '~~~text\n\\[\n\\(raw\\)\n\\]\n~~~\nplain\\_'],
  ['surrogate split positions', '😀 标题\\_字\n```text\n🙂\\_x\n```\n\\(🙂x\\)'],
  ['prefix whitespace disambiguation', 'before\n  \\[ not standalone\\_\n\t \\(x\\)\n'],
  ['fence closing info', '```\n\\_raw\n```not-close\n\\_raw\n```\nnormal\\_'],
];

function streamEveryCodeUnit(raw, id = 'source-a') {
  const want = reference(raw), emitted = [], allIssues = [];
  let state, text = '';
  for (let end = 0; end <= raw.length; end++) {
    const input = rawSource(raw.slice(0, end)); input.id = id; input.text = 'DOM revision ' + end;
    const result = renderSourceProse(input, state);
    assert.ok(result.text.startsWith(text), JSON.stringify({ end, raw, old: text, text: result.text, issues: result.issues }));
    assert.ok(want.startsWith(result.text), JSON.stringify({ end, raw, want, text: result.text, issues: result.issues }));
    for (const item of result.issues) if (item.code.startsWith('DIL_PENDING_')) {
      assert.equal(item.end, end); assert.equal(item.heldCodeUnits, end - item.start);
      assert.ok(item.start >= 0 && item.start <= end);
    }
    text = result.text; emitted.push(text); allIssues.push(...result.issues); state = restart(result.state);
  }
  const done = rawSource(raw, 'dil', { eof: true }); done.id = id;
  const result = renderSourceProse(done, state);
  assert.ok(result.text.startsWith(text)); assert.equal(result.text, want);
  assert.equal(result.issues.some(item => item.code.startsWith('DIL_PENDING_')), false);
  allIssues.push(...result.issues);
  return { ...result, emitted, allIssues };
}

for (const [name, raw] of corpus) {
  test(`PROSE-STREAM ${name}: every UTF-16 split is append-safe across serialized restarts and EOF matches reference`, () => {
    assert.equal(reference(raw), decodePublicProse({ text: raw, format: 'dil' }), 'ordinary corpus retains installed reference semantics');
    streamEveryCodeUnit(raw);
    for (let cut = 0; cut <= raw.length; cut++) {
      const a = renderSourceProse(rawSource(raw.slice(0, cut)));
      const b = renderSourceProse(rawSource(raw, 'dil', { eof: true }), restart(a.state));
      assert.ok(b.text.startsWith(a.text)); assert.equal(b.text, reference(raw), `two-chunk cut ${cut}`);
    }
  });
}

test('PROSE-01 markdown is fixed raw, unchanged and immediate; DOM rendering revisions and completion/page flags do not gate it', () => {
  let state, published = '';
  const raw = '# 原始 **Markdown**\n```js\nlet x = 1;\n```\n';
  for (let end = 0; end <= raw.length; end++) {
    const input = rawSource(raw.slice(0, end), 'markdown', { eof: false });
    input.text = end % 2 ? 'DOM complete rendering' : '**DOM partial';
    input.page = { state: ['running', 'standby', 'abnormal'][end % 3] };
    input.turn = { outcome: ['completed', 'failed', null][end % 3] };
    input.completed = false; input.authorized = false;
    const result = renderSourceProse(input, state);
    assert.equal(result.text, input.prose.rawText); assert.ok(result.text.startsWith(published));
    assert.deepEqual(result.issues, []); assert.equal(result.state.mode, 'markdown');
    published = result.text; state = restart(result.state);
  }
});

test('PROSE-02 first DOM chooses explicit literal Markdown escaping, not mislabeled raw; every character expansion preserves prefixes', () => {
  const input = '# Heading\n    a*b [x](y) <i>& \\ `code`\t🙂';
  let state, previous = '';
  for (let end = 0; end <= input.length; end++) {
    const result = renderSourceProse(source({ text: input.slice(0, end) }), state);
    assert.ok(result.text.startsWith(previous)); assert.equal(result.state.mode, 'literal');
    previous = result.text; state = restart(result.state);
  }
  assert.equal(previous, '\\#&#32;Heading  \n&#32;&#32;&#32;&#32;a\\*b&#32;\\[x\\]\\(y\\)&#32;\\<i\\>\\&&#32;\\\\&#32;\\`code\\`&#9;🙂');
  const laterRaw = source({ text: input + ' more', prose: { rawText: '# completely different original', representation: 'markdown', observedAt: 456 } });
  const result = renderSourceProse(laterRaw, state);
  assert.equal(result.state.mode, 'literal'); assert.ok(result.text.startsWith(previous));
  assert.ok(codes(result).includes('SOURCE_PROSE_RAW_AVAILABLE_NOT_SELECTED'));
});

test('PROSE-03 DOM non-prefix revisions are rendered-representation changes, never alleged model edits or old/new concatenation', () => {
  const a = renderSourceProse(source({ text: '**bold' }));
  const b = renderSourceProse(source({ text: 'bold', prose: { rawText: '**bold**', representation: 'markdown', observedAt: 0 } }), restart(a.state));
  assert.equal(b.text, a.text); assert.deepEqual(b.state, a.state);
  assert.ok(codes(b).includes('DOM_RENDERED_REPRESENTATION_CHANGED'));
  assert.ok(codes(b).includes('SOURCE_PROSE_RAW_AVAILABLE_NOT_SELECTED'));
  assert.equal(b.text.includes(a.text + 'bold'), false);
  assert.ok(b.issues.find(i => i.code === 'DOM_RENDERED_REPRESENTATION_CHANGED').message.includes('未将其归因为模型改稿'));
});

test('PROSE-04 raw rewrite, withdrawal or representation switch preserves the original published projection and proof', () => {
  for (const representation of ['markdown', 'dil']) {
    const a = renderSourceProse(rawSource('prefix\\_text', representation));
    for (const [input, code] of [
      [rawSource('replacement', representation), 'SOURCE_PROSE_RAW_NON_PREFIX'],
      [rawSource('prefix', representation), 'SOURCE_PROSE_RAW_NON_PREFIX'],
      [source({ text: 'DOM fallback must not be appended' }), 'SOURCE_PROSE_RAW_UNAVAILABLE'],
      [rawSource('prefix\\_text', representation === 'markdown' ? 'dil' : 'markdown'), 'SOURCE_PROSE_REPRESENTATION_CHANGED'],
    ]) {
      const result = renderSourceProse(input, restart(a.state));
      assert.equal(result.text, a.text); assert.deepEqual(result.state, a.state); assert.ok(codes(result).includes(code));
    }
  }
});

test('PROSE-05 ordinary DIL text and unambiguous escapes release before message EOF', () => {
  const a = renderSourceProse(rawSource('普通文字 plain \\_ escaped'));
  assert.equal(a.text, '普通文字 plain _ escaped'); assert.deepEqual(a.issues, []);
  const b = renderSourceProse(rawSource('普通文字 plain \\_ escaped \\(x\\_y'));
  assert.equal(b.text, a.text + ' ');
  assert.ok(codes(b).includes('DIL_PENDING_INLINE_MATH'));
  const c = renderSourceProse(rawSource('普通文字 plain \\_ escaped \\(x\\_y\\) next'), restart(b.state));
  assert.equal(c.text, '普通文字 plain _ escaped \\(x\\_y\\) next');
  assert.deepEqual(c.issues, []);
});

test('PROSE-06 inline code closing backticks at the current end are not assumed exact until disambiguated', () => {
  const a = renderSourceProse(rawSource('before `a\\_b`'));
  assert.equal(a.text, 'before '); assert.ok(codes(a).includes('DIL_PENDING_INLINE_CODE_CLOSER'));
  const b = renderSourceProse(rawSource('before `a\\_b`` more'), restart(a.state));
  assert.equal(b.text, a.text); assert.ok(codes(b).includes('DIL_PENDING_INLINE_CODE'));
  const c = renderSourceProse(rawSource('before `a\\_b`` more\n'), restart(b.state));
  assert.equal(c.text, reference('before `a\\_b`` more\n')); assert.ok(c.text.startsWith(a.text));
});

test('PROSE-07 >400-line display math has no timeout/old cap; pending raw is not duplicated into projection state', () => {
  const prefix = 'Lead\n', body = Array.from({ length: 520 }, (_, i) => `x${i}\\_y`).join('\n');
  const pendingRaw = prefix + '\\[\n' + body + '\n';
  const pending = renderSourceProse(rawSource(pendingRaw));
  assert.equal(pending.text, prefix);
  assert.ok(pending.issues.some(i => i.code === 'DIL_PENDING_BLOCK_MATH' && i.lines > 400 && i.unbounded));
  assert.ok(JSON.stringify(pending.state).length < 1000);
  assert.equal(JSON.stringify(pending.state).includes(body), false);
  const raw = pendingRaw + '\\]\nEnd';
  const done = renderSourceProse(rawSource(raw), restart(pending.state));
  assert.equal(done.text, reference(raw));
  assert.notEqual(done.text, decodePublicProse({ text: raw, format: 'dil' }), 'the old silent 400-line decision is deliberately deprecated');
  assert.ok(codes(done).includes('DIL_LEGACY_FORMULA_CAP_REMOVED'));
  assert.match(done.state.version, /unbounded/);
  streamEveryCodeUnit(raw, 'long-math');
});

test('PROSE-08 only source.prose.eof can release ambiguous tails; standby/outcome/permissions never supply EOF', () => {
  const raw = 'prefix \\(unclosed\\_x';
  const a = renderSourceProse({ ...rawSource(raw), page: { state: 'standby' }, completed: true, outcome: 'completed', finalConfirmed: true, allowed: true });
  assert.equal(a.text, 'prefix '); assert.ok(codes(a).includes('DIL_PENDING_INLINE_MATH'));
  const b = renderSourceProse(rawSource(raw, 'dil', { eof: true }), restart(a.state));
  assert.equal(b.text, reference(raw)); assert.equal(b.state.parser.eofReleased, true);
  const extended = renderSourceProse(rawSource(raw + '\\)'), restart(b.state));
  assert.equal(extended.text, b.text); assert.ok(codes(extended).includes('DIL_EOF_BOUNDARY_EXTENDED'));
  const ordinary = renderSourceProse(rawSource('plain text', 'dil', { eof: true }));
  const ordinaryLater = renderSourceProse(rawSource('plain text still extends'), restart(ordinary.state));
  assert.equal(ordinaryLater.text, 'plain text still extends', 'EOF itself is not a collection or publication end gate');
});

test('PROSE-09 each source keeps independent parser/representation/proof and cannot borrow another identity', () => {
  const states = new Map();
  for (let round = 0; round < 4; round++) for (let index = 0; index < 45; index++) {
    const input = rawSource('source ' + index + ' ' + 'x'.repeat(round), index % 2 ? 'markdown' : 'dil');
    input.id = 'source-' + index;
    const result = renderSourceProse(input, states.get(input.id));
    assert.equal(result.text, input.prose.rawText);
    states.set(input.id, restart(result.state));
  }
  assert.equal(states.size, 45);
  assert.throws(() => renderSourceProse({ ...rawSource('source B'), id: 'B' }, states.get('source-0')), { code: 'SOURCE_PROSE_IDENTITY_CONFLICT' });
});

test('PROSE-10 raw and DOM objects remain unchanged; returned state does not mutate or alias previous mutable parser/proof objects', () => {
  const input = rawSource('before `pending\\_code');
  const original = structuredClone(input), a = renderSourceProse(input), saved = restart(a.state);
  const frozen = Object.freeze({ ...input, prose: Object.freeze({ ...input.prose }) });
  const result = renderSourceProse(frozen, Object.freeze({ ...a.state, input: Object.freeze(a.state.input), parser: Object.freeze(a.state.parser) }));
  assert.deepEqual(input, original); assert.deepEqual(a.state, saved);
  result.state.parser.cursor = 0; result.state.input.hash = 'changed';
  assert.deepEqual(a.state, saved);
});

test('PROSE-11 hashing proves exact UTF-16 raw prefixes, including cuts through Unicode surrogate pairs', () => {
  const a = renderSourceProse(rawSource('\uD800', 'markdown'));
  const wrong = renderSourceProse(rawSource('\uD801X', 'markdown'), restart(a.state));
  assert.equal(wrong.text, a.text); assert.ok(codes(wrong).includes('SOURCE_PROSE_RAW_NON_PREFIX'));
  const correct = renderSourceProse(rawSource('\uD800\uDC00', 'markdown'), restart(a.state));
  assert.equal(correct.text, '\uD800\uDC00');
  const dil = renderSourceProse(rawSource('a\uD83D'));
  assert.equal(dil.text, 'a'); assert.ok(codes(dil).includes('DIL_PENDING_UNICODE'));
  assert.equal(renderSourceProse(rawSource('a😀'), restart(dil.state)).text, 'a😀');
});

test('PROSE-12 unsupported conversion versions are not silently upgraded or replayed', () => {
  const a = renderSourceProse(rawSource('old text'));
  const old = { ...a.state, version: 'previous-converter' };
  const result = renderSourceProse(rawSource('old text plus'), old);
  assert.equal(result.text, a.text); assert.deepEqual(result.state, old);
  assert.ok(codes(result).includes('SOURCE_PROSE_VERSION_MISMATCH'));
});

test('PROSE-13 malformed source/state is refused without text coercion; non-target roles are not reclassified', () => {
  for (const text of [undefined, {}, null, [], 12]) assert.throws(() => renderSourceProse(source({ text })), { code: 'SOURCE_PROSE_INVALID' });
  const good = renderSourceProse(rawSource('safe'));
  assert.throws(() => renderSourceProse(rawSource('safe'), { ...good.state, input: { length: 4, hash: 'bad' } }), { code: 'SOURCE_PROSE_STATE_INVALID' });
  for (const extra of [{ role: 'user' }, { lane: 'process' }, { kind: 'notice' }]) {
    const input = source(extra), result = renderSourceProse(input);
    assert.equal(result.text, input.text); assert.equal(result.state, null);
    assert.ok(codes(result).includes('SOURCE_PROSE_NOT_APPLICABLE'));
  }
});

test('PROSE-14 invalid raw never becomes fake Markdown; an initially empty DOM source still has a fixed literal representation', () => {
  const a = renderSourceProse(source({ text: '', prose: { rawText: {}, representation: 'markdown' } }));
  assert.equal(a.state.mode, 'literal'); assert.ok(codes(a).includes('SOURCE_PROSE_RAW_INVALID'));
  const b = renderSourceProse(source({ text: '*DOM*', prose: { rawText: '**raw**', representation: 'markdown', observedAt: 0 } }), restart(a.state));
  assert.equal(b.text, '\\*DOM\\*'); assert.equal(b.state.mode, 'literal');
  assert.ok(codes(b).includes('SOURCE_PROSE_RAW_AVAILABLE_NOT_SELECTED'));
});

test('PROSE-15 deterministic syntax combinations exercise every character boundary, not selected whole-frame examples', () => {
  const alphabet = ['x', ' ', '\t', '\\', '`', '~', '(', ')', '[', ']', '_', '*', '\n', '\r', '😀'];
  let seed = 0x5267;
  const next = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let index = 0; index < 250; index++) {
    let raw = '';
    for (let count = next(45); count > 0; count--) raw += alphabet[next(alphabet.length)];
    streamEveryCodeUnit(raw, 'generated-' + index);
  }
});

test('PROSE-16 EOF-resolved partial line headers are recorded, while guaranteed tilde fences can still extend safely', () => {
  for (const raw of [' ', '\t ', '~', '  ~~', '\uFEFF']) {
    const before = renderSourceProse(rawSource(raw, 'dil', { eof: true }));
    assert.equal(before.text, reference(raw)); assert.equal(before.state.parser.eofReleased, true);
    const after = renderSourceProse(rawSource(raw + 'more'), restart(before.state));
    assert.equal(after.text, before.text); assert.ok(codes(after).includes('DIL_EOF_BOUNDARY_EXTENDED'));
  }
  const a = renderSourceProse(rawSource('~~~', 'dil', { eof: true }));
  assert.equal(a.state.parser.eofReleased, false);
  const raw = '~~~\nraw\\_literal\n~~~\nnormal\\_';
  const b = renderSourceProse(rawSource(raw), restart(a.state));
  assert.equal(b.text, reference(raw)); assert.ok(b.text.startsWith(a.text));
});

test('PROSE-17 every corpus EOF cut either resumes with the exact oracle or explicitly retains its EOF-dependent projection', () => {
  for (const [name, raw] of corpus) for (let cut = 0; cut <= raw.length; cut++) {
    const a = renderSourceProse(rawSource(raw.slice(0, cut), 'dil', { eof: true }));
    assert.equal(a.text, reference(raw.slice(0, cut)), name + ' EOF prefix');
    const b = renderSourceProse(rawSource(raw, 'dil', { eof: true }), restart(a.state));
    if (a.state.parser.eofReleased && cut < raw.length) {
      assert.equal(b.text, a.text); assert.ok(codes(b).includes('DIL_EOF_BOUNDARY_EXTENDED'));
    } else {
      assert.equal(b.text, reference(raw), JSON.stringify({ name, cut, parser: a.state.parser }));
      assert.ok(b.text.startsWith(a.text));
    }
  }
});

test('PROSE-18 page/turn/authorization/completion getters are not even consulted in any representation mode', () => {
  for (const mode of ['markdown', 'dil', 'literal']) {
    const input = mode === 'literal' ? source({ text: 'plain' }) : rawSource('plain', mode);
    for (const key of ['page', 'turn', 'outcome', 'authorization', 'permissions', 'completed', 'nativeStatus', 'delivered'])
      Object.defineProperty(input, key, { get() { throw new Error('Forbidden state gate: ' + key); } });
    const result = renderSourceProse(input);
    assert.equal(result.text, 'plain'); assert.equal(result.state.mode, mode); assert.deepEqual(result.issues, []);
  }
});
