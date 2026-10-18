import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import { projectPageItem } from '../server/page-items.mjs';

const source = (extra = {}) => ({
  id: 'conversation:item-1', userMessageId: 'native-user-1',
  role: 'assistant', lane: 'output', kind: 'message',
  text: '原文答复。', format: 'markdown', order: [1, 3], ...extra,
});

// Every successful projection below must be accepted, without stripped fields,
// by the installed SDK, not by a handwritten ProviderTimelineItem approximation.
function project(item, options) {
  const output = projectPageItem(item, options);
  assert.ok(output, 'valid source content must never be swallowed as null');
  const event = { type: 'timeline.item', sessionId: 'offline-host', item: output };
  assert.deepEqual(ProviderEventSchema.parse(event), event);
  return output;
}
const visible = item => item.type === 'plugin' ? item.data.source.text :
  item.text ?? item.message ?? item.detail?.text;
const plugin = (extra = {}) => source({ lane: 'process', kind: 'message', ...extra });
const nativeTool = (extra = {}) => source({
  id: 'conversation:tool-1', lane: 'process', kind: 'tool_call',
  callId: 'actual-call-1', name: 'mymac · read', status: 'running',
  text: '正在读取文件。', ...extra,
});

// Synthetic content following the user's screenshot structure, NOT a claimed
// screenshot transcription or evidence that these tool calls really occurred.
function workFixture() {
  const progress = ['先核对来源。', '继续检查页面。', '正在整理可见内容。'].map((text, i) => plugin({
    id: `conversation:progress-${i}`, text, order: [1, i * 3],
  }));
  const activities = Array.from({ length: 7 }, (_, i) => plugin({
    id: `conversation:activity-${i}`, kind: 'tool_call',
    text: `活动摘要 ${i + 1}（网页原文）`, order: [1, i + 1],
    // The screenshot captions do not prove call IDs/names/results/statuses.
  }));
  const final = source({
    id: 'conversation:external-final', nativeMessageId: 'native-external-final',
    text: '这是 Work 外的正式回答。\n\n- 保留原文\n- 不混入过程', order: [1, 10],
  });
  return { progress, activities, final };
}

test('PAGE-01: Work progress and activity captions are page-source cards; only the external final is native assistant', () => {
  const { progress, activities, final } = workFixture();
  const originals = [...progress, ...activities, final].sort((a, b) => a.order[1] - b.order[1]);
  const rows = originals.map(item => project(item));
  assert.equal(rows.length, 11);
  assert.equal(new Set(rows.map(row => row.id)).size, 11);
  assert.equal(rows.filter(row => row.type === 'plugin').length, 10);
  assert.equal(rows.filter(row => row.type === 'notification').length, 0);
  assert.deepEqual(rows.filter(row => row.type === 'assistant_message'), [{
    type: 'assistant_message', id: 'page:conversation:external-final',
    messageId: 'native-external-final', text: final.text,
  }]);
  for (const item of [...progress, ...activities]) {
    const row = rows.find(entry => entry.id === `page:${item.id}`);
    assert.equal(row.type, 'plugin');
    assert.equal(row.pluginId, 'chatmode-in-paseo');
    assert.equal(row.kind, 'page-source');
    assert.equal(row.version, 1);
    assert.equal(row.data.source.text, item.text);
    assert.equal(row.data.source.role, item.role);
    assert.equal(row.data.source.lane, item.lane);
  }
  assert.equal(rows.some(row => row.type === 'tool_call'), false, 'activity captions are not invented calls');
});

test('PAGE-02: folding/expanding Work adds page-source cards without rewriting the native external final', () => {
  const { progress, activities, final } = workFixture();
  const collapsed = [final].map(item => project(item));
  const expanded = [...progress, ...activities, final].map(item => project(item));
  const collapsedAgain = [final].map(item => project(item));
  const answers = rows => rows.filter(row => row.type === 'assistant_message');
  assert.deepEqual(answers(expanded), collapsed);
  assert.deepEqual(collapsedAgain, collapsed);
  assert.equal(answers(expanded)[0].text, final.text);
  for (const item of [...progress, ...activities]) assert.ok(!final.text.includes(item.text));
});

test('PAGE-03: source identity is independent of host session/turn fragments, order and repeated receipt', () => {
  const item = source({ nativeMessageId: 'real-assistant-id' });
  const before = project(item, { sessionId: 'host-a', turnId: 'fragment-a' });
  const after = project(item, { sessionId: 'host-b', turnId: 'fragment-b' });
  assert.deepEqual(after, before);
  assert.equal(project({ ...item, order: [90, -1, 0.5] }).id, before.id);
  assert.equal(before.messageId, item.nativeMessageId);
  assert.equal(before.id, `page:${item.id}`);
  assert.notEqual(project(source({ id: 'a:b' })).id, project(source({ id: 'a%3Ab' })).id);

  const progress = plugin({ id: 'conversation:opaque-json-id' });
  const progressBefore = project(progress, { sessionId: 'host-a' });
  const progressAfter = project({ ...progress, order: [99] }, { sessionId: 'host-b', turnId: 'fragment-b' });
  assert.equal(progressBefore.id, `page:${progress.id}`);
  assert.equal(progressAfter.id, progressBefore.id);
  assert.equal(progressBefore.type, 'plugin');
  assert.equal(progressAfter.type, 'plugin');
});

test('PAGE-04: outputs A and B, even with identical text and the same user anchor, remain distinct messages', () => {
  const a = source({ id: 'conversation:output-A', nativeMessageId: 'native-A', text: '相同的原文' });
  const b = source({ id: 'conversation:output-B', nativeMessageId: 'native-B', text: a.text, order: [1, 4] });
  const rows = [a, b].map(item => project(item));
  assert.equal(rows.every(row => row.type === 'assistant_message'), true);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(rows.map(row => row.messageId), ['native-A', 'native-B']);
  const received = new Map();
  for (const item of [a, b, a, b]) received.set(project(item).id, project(item));
  assert.deepEqual([...received.values()], rows, 'repeat receipt must not merge A/B into a revision');
});

test('PAGE-05: user messages keep native user identity; absent native IDs are not invented', () => {
  const item = source({ id: 'conversation:user', userMessageId: null, role: 'user', text: '用户原文', nativeMessageId: 'native-user' });
  assert.deepEqual(project(item), {
    type: 'user_message', id: 'page:conversation:user', messageId: 'native-user', text: item.text,
  });
  assert.deepEqual(project({ ...item, nativeMessageId: undefined }), {
    type: 'user_message', id: 'page:conversation:user', text: item.text,
  });
  assert.equal(project({ ...item, lane: 'process' }).type, 'user_message');
  assert.equal(project(source()).messageId, undefined);
});

test('PAGE-06: only explicitly public assistant/process reasoning becomes native reasoning', () => {
  const text = '已对照两处公开记录，下一步核对来源。';
  const reasoning = project(source({ lane: 'process', kind: 'reasoning', text }));
  assert.deepEqual(reasoning, { type: 'reasoning', id: 'page:conversation:item-1', text });
  const commentary = project(plugin({ text }));
  assert.equal(commentary.type, 'plugin');
  assert.equal(commentary.data.source.text, text);
  assert.equal(visible(commentary).includes('私有思考'), false);
  assert.equal(project(source({ kind: 'reasoning', text })).type, 'plugin', 'output reasoning is not silently reclassified');
  assert.equal(project(source({ role: 'page', lane: 'process', kind: 'reasoning', text })).type, 'plugin');
});

for (const status of ['running', 'completed', 'failed']) {
  test(`PAGE-TOOL-${status}: confirmed tool metadata yields native tool_call with required detail/error and exact visible data`, () => {
    const item = nativeTool({
      status, text: '  网页显示的调用说明。\n第二行\n',
      details: { input: ' {"path":"/public/file"} ', output: '原始输出\n```text\n保留格式\n```\n' },
    });
    const row = project(item);
    assert.equal(row.type, 'tool_call');
    assert.equal(row.id, `page:${item.id}`);
    assert.equal(row.callId, item.callId);
    assert.equal(row.name, item.name);
    assert.equal(row.status, status);
    assert.deepEqual(row.detail, {
      type: 'plain_text', label: item.name,
      text: `${item.text}\n\n网页可见输入（原文）：\n${item.details.input}\n\n网页可见输出（原文）：\n${item.details.output}`,
    });
    assert.deepEqual(row.error, status === 'failed' ? { message: item.text } : null);
    assert.equal(row.metadata.source.id, item.id);
    assert.deepEqual(row.metadata.source.order, item.order);
    assert.equal(row.metadata.source.text, undefined, 'native tool metadata is identity only');
    assert.equal('exitCode' in row.detail, false, 'no inferred shell result');
    for (const required of ['detail', 'error']) {
      const incomplete = { ...row };
      delete incomplete[required];
      assert.equal(ProviderEventSchema.safeParse({ type: 'timeline.item', sessionId: 'offline-host', item: incomplete }).success, false);
    }
  });
}

test('PAGE-07: tool state changes update the same source ID without deriving state from native complete', () => {
  const running = project(nativeTool({ status: 'running', completed: true, nativeStatus: 'complete' }));
  const done = project(nativeTool({ status: 'completed', completed: false, nativeStatus: 'in_progress' }));
  const failed = project(nativeTool({ status: 'failed' }));
  assert.deepEqual([running.status, done.status, failed.status], ['running', 'completed', 'failed']);
  assert.equal(running.id, done.id);
  assert.equal(done.id, failed.id);
  const noResult = project(nativeTool({ text: '', details: undefined, status: 'completed' }));
  assert.equal(noResult.detail.text, '');
  assert.equal(noResult.error, null);
  assert.equal(visible(noResult).includes('成功'), false, 'completion metadata must not manufacture result text');
});

test('PAGE-08: page-role confirmed tools stay native; user/unconfirmed tools become source cards', () => {
  for (const change of [
    { callId: undefined }, { name: undefined }, { status: undefined },
    { callId: '' }, { name: '  ' }, { status: 'success' },
    { status: undefined, completed: true, nativeStatus: 'complete' },
  ]) {
    const item = nativeTool({ ...change, details: { output: '可见但未确证的活动文字' } });
    const row = project(item);
    assert.equal(row.type, 'plugin');
    assert.equal(row.id, `page:${item.id}`);
    assert.equal(row.data.source.text, item.text);
    assert.equal(row.data.source.details.output, item.details.output);
    assert.equal(row.data.source.callId, item.callId);
    assert.equal('callId' in row, false);
    assert.equal('error' in row, false);
  }
  const pageTool = project(nativeTool({ role: 'page' }));
  assert.equal(pageTool.type, 'tool_call');
  assert.equal(pageTool.metadata.source.role, 'page');
  assert.equal(project(nativeTool({ role: 'user' })).type, 'plugin');
  assert.equal(project(nativeTool({ lane: 'output' })).type, 'plugin');
});

test('PAGE-09: page notices/whole-page errors are source cards, including without a user anchor or composer', () => {
  const item = source({
    id: 'conversation:page-notice', userMessageId: null, role: 'page', kind: 'notice',
    status: 'failed', text: 'Something went wrong.\nRetry\n未知错误原文',
    sourceKind: 'browser-error',
  });
  const row = project(item);
  assert.equal(row.type, 'plugin');
  assert.equal(row.id, `page:${item.id}`);
  assert.equal(row.kind, 'page-source');
  assert.equal(row.data.source.text, item.text);
  assert.equal(row.data.source.sourceKind, item.sourceKind);
  assert.equal(row.data.source.status, 'failed');
  assert.equal(row.level, undefined);
  assert.equal(project({ ...item, status: undefined }).type, 'plugin');
  assert.equal(project(item, { notificationLevel: 'warning' }).type, 'plugin');
});

test('PAGE-10: future/unknown kinds become source cards and keep their raw body/source', () => {
  for (const kind of ['future_widget', 'assistant_message', 'commentary', 'error', 'notice-v2']) {
    const item = source({
      id: `conversation:${kind}`, kind, sourceKind: kind,
      text: '未分类原文\n<visible>保留 & 不改写</visible>\n',
      nativeMessageId: 'actual-native-id', order: [2, -1, 0],
    });
    const row = project(item);
    assert.equal(row.type, 'plugin');
    assert.equal(row.id, `page:${item.id}`);
    assert.equal(row.data.source.kind, kind);
    assert.equal(row.data.source.sourceKind, kind);
    assert.equal(row.data.source.text, item.text);
    assert.equal(row.data.source.nativeMessageId, item.nativeMessageId);
    assert.equal(row.message, undefined);
  }
});

test('PAGE-11: image/file descriptions become artifact-id source cards without inventing preview/download', () => {
  for (const kind of ['image', 'file']) {
    for (const media of [undefined, {}, { url: 'https://example.test/public-asset', name: '原始名称', width: 1024 }]) {
      const item = source({
        id: `conversation:${kind}`, kind, media, text: '页面上的原始产物描述。',
        completed: true, status: 'completed',
      });
      const row = project(item);
      assert.equal(row.type, 'plugin');
      assert.equal(row.id, `artifact:${item.id}`);
      assert.equal(row.data.source.kind, kind);
      assert.equal(row.data.source.text, item.text);
      assert.deepEqual(row.data.source.media, media);
      assert.equal(row.message, undefined);
      assert.equal(row.level, undefined);
      assert.equal(JSON.stringify(row.data).includes('图片已生成'), false);
      assert.equal(JSON.stringify(row.data).includes('blob:'), false);
    }
  }
});

test('PAGE-12: official/progress/unknown text is not truncated, reformatted, summarized or interpreted as lifecycle state', () => {
  const text = '  completed / finalConfirmed / Stop / Allow\n[正文](https://example.test/)\n$$x^2$$\n```md\n# literal\n```\n😀汉字'.repeat(5000) + '\n尾部 END  ';
  assert.ok(text.length > 256000);
  const answer = project(source({ text }));
  assert.equal(answer.type, 'assistant_message');
  assert.equal(answer.text, text);
  const progress = project(plugin({ text }));
  assert.equal(progress.type, 'plugin');
  assert.equal(progress.data.source.text, text);
  const unknown = project(source({ kind: 'future', sourceKind: 'future', text }));
  assert.equal(unknown.type, 'plugin');
  assert.equal(unknown.data.source.text, text);
  for (const row of [answer, progress, unknown]) {
    assert.equal('state' in row, false);
    assert.equal('pageState' in row, false);
    assert.equal('completed' in row, false);
  }
});

test('PAGE-13: native message publication does not depend on complete/final confirmation/delivery flags', () => {
  const expected = project(source());
  for (const extra of [
    { completed: false }, { completed: true }, { finalConfirmed: false },
    { finalConfirmed: true }, { nativeStatus: 'in_progress' }, { nativeStatus: 'complete' },
    { delivered: false }, { delivered: true }, { status: 'running' }, { status: 'failed' },
  ]) assert.deepEqual(project(source(extra)), expected);
  assert.equal(project(source({ text: '' })).text, '', 'an observed empty string is not an invalid/missing text value');
});

test('PAGE-14: validation refuses undefined/object/other non-string text without coercion and caller can continue the batch', () => {
  const coerced = { toString() { throw new Error('must never coerce text'); } };
  for (const text of [undefined, null, {}, coerced, [], ['text'], 12, true])
    assert.throws(() => projectPageItem(source({ text })), { code: 'PAGE_ITEM_INVALID' });
  const { text, ...missing } = source();
  assert.throws(() => projectPageItem(missing), { code: 'PAGE_ITEM_INVALID' });
  const rows = [], rejected = [];
  const batch = [source({ id: 'A' }), source({ id: 'bad', text: {} }), source({ id: 'B' })];
  for (const item of batch) {
    try { rows.push(project(item)); }
    catch (error) { rejected.push({ id: item.id, code: error.code }); }
  }
  assert.deepEqual(rows.map(row => row.id), ['page:A', 'page:B']);
  assert.deepEqual(rejected, [{ id: 'bad', code: 'PAGE_ITEM_INVALID' }]);
});

test('PAGE-15: malformed protocol metadata is rejected locally rather than creating fake native identity/content', () => {
  for (const extra of [
    { id: undefined }, { id: '' }, { id: {} }, { userMessageId: undefined },
    { userMessageId: {} }, { role: 'tool' }, { lane: 'private' }, { kind: undefined },
    { format: 'html' }, { order: undefined }, { order: [NaN] }, { order: [Infinity] },
    { order: Array(1) }, { nativeMessageId: {} }, { callId: {} }, { name: [] },
    { details: [] }, { details: { input: {} } }, { details: { output: false } }, { media: [] },
  ]) assert.throws(() => projectPageItem(source(extra)), { code: 'PAGE_ITEM_INVALID' });
  for (const item of [null, undefined, [], 'raw text'])
    assert.throws(() => projectPageItem(item), { code: 'PAGE_ITEM_INVALID' });
  assert.throws(() => projectPageItem(source(), { notificationLevel: 'success' }), { code: 'PAGE_ITEM_INVALID' });
});

test('PAGE-16: projection is deterministic and does not mutate source/options or share mutable source arrays', () => {
  const item = nativeTool({ details: { input: 'public input' } });
  const expected = structuredClone(item);
  const options = Object.freeze({ notificationLevel: 'warning' });
  Object.freeze(item.order);
  Object.freeze(item.details);
  Object.freeze(item);
  const a = project(item, options), b = project(item, options);
  assert.deepEqual(a, b);
  assert.deepEqual(item, expected);
  a.metadata.source.order.push(99);
  assert.deepEqual(item.order, expected.order);
  assert.deepEqual(b.metadata.source.order, expected.order);
  assert.equal(project(source({ role: 'page', userMessageId: null })).type, 'plugin');
});

test('PAGE-17: page-source data keeps only the whitelisted source, never ledger history or ACK fields', () => {
  const item = plugin({
    id: 'conversation:whitelist', text: '完整原文', sourceKind: 'unknown-widget',
    details: { input: '输入', output: '输出' }, media: { name: 'fixture.png', width: 2 },
    revision: 'ledger-revision', originalText: 'first', previousText: 'before',
    rewrites: [{ text: 'old' }], firstSeenAt: 1, updatedAt: 2,
    delivered: true, ack: { host: 'confirmed' }, history: [{ text: 'old' }],
  });
  const row = project(item);
  assert.equal(row.type, 'plugin');
  assert.deepEqual(row.data, { source: {
    id: item.id, userMessageId: item.userMessageId, role: item.role, lane: item.lane,
    kind: item.kind, format: item.format, order: item.order, sourceKind: item.sourceKind,
    text: item.text, details: item.details, media: item.media,
  } });
  for (const key of ['revision', 'originalText', 'previousText', 'rewrites', 'firstSeenAt',
    'updatedAt', 'delivered', 'ack', 'history']) {
    assert.equal(key in row.data.source, false);
    assert.equal(key in row.data, false);
  }
});

test('PAGE-18: a changed page-source revision updates the same plugin id, never a native assistant', () => {
  const first = plugin({ id: 'conversation:revision', text: '第一版' });
  const second = { ...first, text: '第二版' };
  const a = project(first), b = project(second);
  assert.equal(a.type, 'plugin');
  assert.equal(b.type, 'plugin');
  assert.equal(a.id, b.id);
  assert.equal(a.data.source.text, '第一版');
  assert.equal(b.data.source.text, '第二版');
  assert.equal(b.type === 'assistant_message', false);
});
