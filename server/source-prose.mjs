/* Per-source, versioned presentation projection. This is not delivery/host ACK
 * state and never decides collection, permissions, page state or turn lifetime.
 * DIL v1 follows the CoS fallback grammar but intentionally REMOVES its old
 * 400-line display-math search cap. No raw body copies or decoder timeouts.
 */
import { createHash } from 'node:crypto';

const VERSION = 'source-prose/1-unbounded';
const MODES = new Set(['markdown', 'dil', 'literal']);
const punctuation = /[!-\/:-@[-`{-~]/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value, 'utf16le').digest('hex');
const invalid = (condition, code = 'SOURCE_PROSE_INVALID') => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
const issue = (code, message, extra = {}) => ({ code, message, ...extra });
const copy = state => ({ ...state,
  ...(object(state.input) ? { input: { ...state.input } } : {}),
  ...(object(state.parser) ? { parser: { ...state.parser,
    ...(object(state.parser.fence) ? { fence: { ...state.parser.fence } } : {}),
  } } : {}),
});
const proof = input => ({ length: input.length, hash: hash(input) });
const extendsInput = (input, previous) => input.length >= previous.length && hash(input.slice(0, previous.length)) === previous.hash;
const highSurrogate = char => char >= '\uD800' && char <= '\uDBFF';

// Each input character has a fixed expansion: prefixes remain prefixes. The
// entity mapping for horizontal whitespace prevents accidental indented code;
// fixed hard breaks retain line boundaries without wrapping the answer in code.
function literal(input) {
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    out.push(char === ' ' ? '&#32;' : char === '\t' ? '&#9;' : char === '\r' ? '&#13;' :
      char === '\n' ? '  \n' : punctuation.test(char) ? '\\' + char : char);
  }
  return out.join('');
}
function markerOf(line) {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return match ? { char: match[1][0], length: match[1].length, offset: match[0].length - match[1].length } : null;
}
function closesFence(line, fence) {
  const marker = markerOf(line);
  return marker && marker.char === fence.char && marker.length >= fence.length &&
    !line.slice(marker.offset + marker.length).trim();
}
function findBlockClose(raw, from, eof) {
  let start = from, lines = 0;
  while (start <= raw.length) {
    const newline = raw.indexOf('\n', start), end = newline < 0 ? raw.length : newline;
    lines++;
    if (newline < 0 && !eof) return { close: null, lines };
    if (raw.slice(start, end).trim() === '\\]') return { close: { start, end, newline: newline >= 0 }, lines };
    if (newline < 0) break;
    start = newline + 1;
  }
  return { close: null, lines };
}
function pending(code, start, end, extra = {}) {
  return issue(code, 'DIL 语法尾部尚未解歧；保留原文，未强制转换。', {
    start, end, heldCodeUnits: end - start, ...extra,
  });
}

// Parse only the as-yet-uncommitted tail. lineStart is an offset into the full
// current raw, so a restart needs no duplicate buffered raw string.
function advanceDil(raw, previous, eof) {
  const parser = { ...previous, fence: previous.fence ? { ...previous.fence } : null };
  const out = [], issues = [];
  const hold = (code, at = parser.cursor, extra = {}) => {
    parser.cursor = at; issues.push(pending(code, at, raw.length, extra));
  };
  outer: while (parser.cursor < raw.length) {
    const newline = raw.indexOf('\n', parser.lineStart), end = newline < 0 ? raw.length : newline;
    const known = newline >= 0 || eof, line = raw.slice(parser.lineStart, end);
    if (parser.lineMode === 'start') {
      if (parser.fence) parser.lineMode = 'fence-body';
      else {
        if (newline < 0 && eof && (/^ {0,3}(?:`{1,2}|~{1,2})$/.test(line) || /^\s*(?:\\(?:\[\s*)?)?$/.test(line)))
          parser.eofReleased = true; // EOF also resolves a partial line header.
        const marker = markerOf(line);
        const opening = marker && !(marker.char === '`' && line.slice(marker.offset + marker.length).includes('`'));
        if (opening) {
          // A tilde opener cannot be invalidated by later info-string text.
          // Backtick info strings CAN acquire a forbidden backtick later.
          if (marker.char === '`' && !known) { hold('DIL_PENDING_FENCE_LINE'); break; }
          parser.lineMode = 'fence-opening'; parser.fence = { char: marker.char, length: marker.length };
          if (newline < 0 && eof && marker.char === '`') parser.eofReleased = true;
        } else if (!known && /^ {0,3}(?:`{1,2}|~{1,2})$/.test(line)) {
          hold('DIL_PENDING_FENCE_START'); break;
        } else if (line.trim() === '\\[') {
          if (!known) { hold('DIL_PENDING_BLOCK_LINE'); break; }
          const result = findBlockClose(raw, newline < 0 ? raw.length : newline + 1, eof);
          if (result.close) {
            const close = result.close, to = close.end + (close.newline ? 1 : 0);
            out.push(raw.slice(parser.cursor, to));
            if (result.lines > 400) issues.push(issue('DIL_LEGACY_FORMULA_CAP_REMOVED',
              '公式跨越旧版 400 行窗口；新版按完整闭合区间原样保留。', { start: parser.lineStart, lines: result.lines }));
            parser.cursor = to; parser.lineStart = close.newline ? to : close.start;
            parser.lineMode = close.newline ? 'start' : 'normal';
            if (!close.newline) parser.eofReleased = true;
            continue;
          }
          if (!eof) { hold('DIL_PENDING_BLOCK_MATH', parser.cursor, { lines: result.lines, unbounded: true }); break; }
          // At genuine message EOF an unmatched opener follows normal escaping.
          // A later closer would revise this decision, so remember dependence.
          parser.eofReleased = true; parser.lineMode = 'normal';
        } else if (!known && /^\s*(?:\\(?:\[\s*)?)?$/.test(line)) {
          hold('DIL_PENDING_LINE_CLASSIFICATION'); break;
        } else parser.lineMode = 'normal';
      }
    }
    if (parser.lineMode === 'fence-opening' || parser.lineMode === 'fence-body') {
      let safeEnd = end;
      if (!eof && safeEnd === raw.length && highSurrogate(raw[safeEnd - 1])) safeEnd--;
      out.push(raw.slice(parser.cursor, safeEnd)); parser.cursor = safeEnd;
      if (safeEnd !== end) { hold('DIL_PENDING_UNICODE'); break; }
      if (newline < 0) break;
      if (parser.lineMode === 'fence-opening') {
        const marker = markerOf(line); parser.fence = { char: marker.char, length: marker.length };
      } else if (closesFence(line, parser.fence)) parser.fence = null;
      out.push('\n'); parser.cursor = newline + 1; parser.lineStart = parser.cursor; parser.lineMode = 'start';
      continue;
    }
    let at = parser.cursor;
    while (at < end) {
      const char = raw[at];
      if (!eof && at === raw.length - 1 && highSurrogate(char)) { hold('DIL_PENDING_UNICODE', at); break outer; }
      if (char === '\\' && raw[at + 1] === '(' && at + 1 < end) {
        const close = raw.indexOf('\\)', at + 2);
        if (close >= 0 && close + 2 <= end) { out.push(raw.slice(at, close + 2)); at = close + 2; continue; }
        if (!known) { hold('DIL_PENDING_INLINE_MATH', at); break outer; }
        if (newline < 0) parser.eofReleased = true;
      }
      if (char === '\\') {
        if (at + 1 === end && !known) { hold('DIL_PENDING_BACKSLASH', at); break outer; }
        if (at + 1 === end && newline < 0) parser.eofReleased = true;
        if (at + 1 < end && punctuation.test(raw[at + 1])) { out.push(raw[at + 1]); at += 2; continue; }
      }
      if (char === '`') {
        let runEnd = at + 1;
        while (runEnd < end && raw[runEnd] === '`') runEnd++;
        const length = runEnd - at;
        let scan = runEnd, close = null, uncertain = false;
        while (scan < end) {
          if (raw[scan] !== '`') { scan++; continue; }
          let next = scan + 1;
          while (next < end && raw[next] === '`') next++;
          if (next - scan === length) {
            if (next === end && !known) uncertain = true;
            else close = next;
            break;
          }
          scan = next;
        }
        if (close !== null) {
          out.push(raw.slice(at, close));
          if (close === end && newline < 0) parser.eofReleased = true;
          at = close; continue;
        }
        if (!known) { hold(uncertain ? 'DIL_PENDING_INLINE_CODE_CLOSER' : 'DIL_PENDING_INLINE_CODE', at); break outer; }
        if (newline < 0) parser.eofReleased = true;
        out.push(raw.slice(at, runEnd)); at = runEnd; continue;
      }
      out.push(char); at++;
    }
    parser.cursor = at;
    if (newline < 0) break;
    out.push('\n'); parser.cursor = newline + 1; parser.lineStart = parser.cursor; parser.lineMode = 'start';
  }
  return { parser, delta: out.join(''), issues };
}

function validState(state, id) {
  invalid(object(state) && typeof state.text === 'string' && typeof state.sourceId === 'string', 'SOURCE_PROSE_STATE_INVALID');
  invalid(state.sourceId === id, 'SOURCE_PROSE_IDENTITY_CONFLICT');
  if (state.version !== VERSION) return;
  invalid(MODES.has(state.mode) && object(state.input) && Number.isSafeInteger(state.input.length) && state.input.length >= 0 &&
    typeof state.input.hash === 'string' && /^[a-f0-9]{64}$/.test(state.input.hash), 'SOURCE_PROSE_STATE_INVALID');
  if (state.mode === 'dil') {
    const p = state.parser;
    invalid(object(p) && Number.isSafeInteger(p.cursor) && p.cursor >= 0 && p.cursor <= state.input.length &&
      Number.isSafeInteger(p.lineStart) && p.lineStart >= 0 && p.lineStart <= p.cursor &&
      ['start', 'normal', 'fence-opening', 'fence-body'].includes(p.lineMode) && typeof p.eofReleased === 'boolean' &&
      (!['fence-opening', 'fence-body'].includes(p.lineMode) || p.fence !== null) &&
      (p.fence === null || object(p.fence) && ['`', '~'].includes(p.fence.char) && Number.isSafeInteger(p.fence.length) && p.fence.length >= 3),
    'SOURCE_PROSE_STATE_INVALID');
  }
}

/**
 * Pure, per assistant/output/message presentation. Persist `state` by source.id;
 * it is NOT an ACK. Callers keep the untouched DOM text AND raw prose separately.
 * Normal syntax/representation failures return issues plus the last published
 * text. Invalid inputs/state identity throw rather than borrow another source.
 */
export function renderSourceProse(source, previousState) {
  invalid(object(source) && typeof source.id === 'string' && source.id.length > 0 && typeof source.text === 'string');
  if (source.role !== 'assistant' || source.lane !== 'output' || source.kind !== 'message')
    return { text: source.text, state: null, issues: [issue('SOURCE_PROSE_NOT_APPLICABLE', '此项不属于正式助手消息，未作正文表示转换。')] };
  const issues = [], prose = source.prose;
  const hasRaw = object(prose) && typeof prose.rawText === 'string' && ['markdown', 'dil'].includes(prose.representation);
  let state;
  if (previousState !== undefined && previousState !== null) {
    validState(previousState, source.id); state = copy(previousState);
    if (state.version !== VERSION) return { text: state.text, state, issues: [issue('SOURCE_PROSE_VERSION_MISMATCH',
      '转换版本不一致；未自动重算或替换已发布文本。')] };
  } else {
    state = { version: VERSION, sourceId: source.id, mode: hasRaw ? prose.representation : 'literal', text: '',
      input: proof(''), parser: hasRaw && prose.representation === 'dil'
        ? { cursor: 0, lineStart: 0, lineMode: 'start', fence: null, eofReleased: false } : null };
  }
  if (state.mode === 'literal') {
    if (hasRaw) issues.push(issue('SOURCE_PROSE_RAW_AVAILABLE_NOT_SELECTED', '原始表示已可用；此来源仍保持首次选定的字面文本表示。'));
    else if (prose !== undefined) issues.push(issue('SOURCE_PROSE_RAW_INVALID', '原始表示无效；未将其冒充为 Markdown。'));
    if (!extendsInput(source.text, state.input)) issues.push(issue('DOM_RENDERED_REPRESENTATION_CHANGED',
      '渲染表示变化；未将其归因为模型改稿，已发布文本保持不变。'));
    else { state.text += literal(source.text.slice(state.input.length)); state.input = proof(source.text); }
    return { text: state.text, state, issues };
  }
  if (!hasRaw) return { text: state.text, state, issues: [issue('SOURCE_PROSE_RAW_UNAVAILABLE', '原始表示暂不可读；未切换为 DOM 文本。')] };
  if (prose.representation !== state.mode) return { text: state.text, state, issues: [issue('SOURCE_PROSE_REPRESENTATION_CHANGED',
    '来源表示发生变化；未自动切换或替换已发布文本。')] };
  if (!extendsInput(prose.rawText, state.input)) return { text: state.text, state, issues: [issue('SOURCE_PROSE_RAW_NON_PREFIX',
    '原始表示发生非前缀变化；已发布文本保持不变，未拼接新旧正文。')] };
  if (state.mode === 'markdown') {
    const held = !prose.eof && highSurrogate(prose.rawText.at(-1));
    state.text = held ? prose.rawText.slice(0,-1) : prose.rawText;
    state.input = proof(prose.rawText);
    if (held) issues.push(issue('SOURCE_PROSE_PENDING_UNICODE','UTF-16 尾部待补齐，未发布替代字符。'));
    return { text: state.text, state, issues };
  }
  if (state.parser.eofReleased && prose.rawText.length > state.input.length) return { text: state.text, state, issues: [issue('DIL_EOF_BOUNDARY_EXTENDED',
    '同条来源在已释放 EOF 语法边界后继续增长；不能保证旧文本前缀，未覆盖已发布文本。')] };
  const advanced = advanceDil(prose.rawText, state.parser, prose.eof === true);
  state.text += advanced.delta; state.parser = advanced.parser; state.input = proof(prose.rawText);
  return { text: state.text, state, issues: advanced.issues };
}

/** Production CURRENT-source projection, not a published-text commitment.
 * Reuse the incremental parser while safe. On a rewrite/representation change,
 * render the current source afresh and hand it to the SAME delivery authority.
 * That authority alone knows whether an older body was actually published and
 * refuses unsafe native replacement. Local parser progress is never an ACK.
 */
export function projectSourceProse(source, previousState) {
  if (source.prose?.status === 'pending') return {text:previousState?.text??'',state:previousState??null,
    issues:[issue('SOURCE_PROSE_READ_PENDING','原文补读进行中；DOM 来源已采集。')]};
  const next = renderSourceProse(source, previousState);
  const rebuild = new Set(['SOURCE_PROSE_RAW_NON_PREFIX','SOURCE_PROSE_REPRESENTATION_CHANGED',
    'SOURCE_PROSE_RAW_AVAILABLE_NOT_SELECTED','DOM_RENDERED_REPRESENTATION_CHANGED','DIL_EOF_BOUNDARY_EXTENDED']);
  const reasons = next.issues.filter(value=>rebuild.has(value.code)).map(value=>value.code);
  if (!reasons.length) return next;
  const current = renderSourceProse(source);
  return {...current,issues:[...current.issues,issue('SOURCE_PROSE_REPROJECTED',
    '当前来源已重新转换；不代表允许替换宿主已发布正文。',{reasons})]};
}
