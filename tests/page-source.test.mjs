import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as zod from 'zod';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';

// Execute the actual shared schema and TSX with inert React Native primitives.
// This is an offline render-tree/contract test, not a Paseo UI acceptance test.
function load(file, modules) {
  const output = ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require(name) {
    assert(Object.hasOwn(modules, name), 'Unexpected dependency: ' + name);
    return modules[name];
  } }, { filename: file });
  return exports;
}
const shared = load('shared/page-source.ts', { zod });
function render(data, compact = false) {
  let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    react: { useState(value) { const at = cursor++; return [Object.hasOwn(state, at) ? state[at] : value, () => {}]; } },
    'react-native': { Text: 'Text', View: 'View' },
    '@getpaseo/plugin/client': { useRpc: () => () => { throw Error('Renderer must not invoke RPC'); } },
    '../shared/page-source.js': shared
  };
  const state = [];
  const item = { type: 'plugin', id: 'page:source-one', kind: 'page-source', version: 1, data };
  const theme = { colors: Object.fromEntries(['foreground', 'foregroundMuted', 'surface1', 'border', 'statusWarning']
    .map(key => [key, 'theme-' + key])) };
  return load('client/page-source.tsx', modules).PageSourceCard({ item, theme, layout: { compact } });
}
const text = tree => tree == null || typeof tree === 'boolean' ? '' :
  typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : text(tree.props?.children);
const nodes = tree => !tree || typeof tree !== 'object' ? [] :
  Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];

const source = (extra = {}) => ({
  id: 'conversation:source-1', userMessageId: 'native-user-1',
  role: 'assistant', lane: 'process', kind: 'message',
  text: '  原始进度\n第二行 **不是 Markdown 渲染**  ', format: 'text', order: [1, 2],
  ...extra
});

test('PS-01 schema accepts the full whitelist source, long text, details, media and opaque source ids', () => {
  const value = {
    source: source({
      id: '{"source":"page-1","slice":[0,2]}',
      sourceKind: 'future-widget',
      nativeMessageId: 'native-confirmed',
      details: { input: '输入原文', output: '输出原文' },
      media: { name: 'fixture.png', width: 2, nested: { visible: true } }
    })
  };
  assert.deepEqual(shared.pageSourceSchema.parse(value), value);
  assert.equal(shared.pageSourceSchema.parse(value).source.text, source().text);
  assert.equal(shared.pageSourceSchema.parse(value).source.nativeMessageId, 'native-confirmed');
  const long = '长'.repeat(300000);
  assert.equal(shared.pageSourceSchema.parse({ source: source({ text: long }) }).source.text, long);
  assert.equal(shared.pageSourceSchema.parse({ source: source({ nativeMessageId: undefined }) }).source.nativeMessageId, undefined);
});

test('PS-02 schema rejects ledger history, ACK state and malformed source fields', () => {
  for (const extra of [
    { revision: 'r1' }, { originalText: 'first' }, { previousText: 'before' },
    { rewrites: [{ text: 'old' }] }, { firstSeenAt: 1 }, { updatedAt: 2 },
    { delivered: true }, { ack: { host: 'confirmed' } }, { history: [{ text: 'old' }] },
    { role: 'tool' }, { lane: 'private' }, { format: 'html' }, { text: 42 },
    { order: [NaN] }, { userMessageId: undefined }, { details: { extra: 'x' } },
    { media: [] }, { nativeMessageId: '' }
  ]) assert.equal(shared.pageSourceSchema.safeParse({ source: source(extra) }).success, false);
  assert.equal(shared.pageSourceSchema.safeParse({ source: source(), extra: true }).success, false);
  assert.equal(shared.pageSourceSchema.safeParse({}).success, false);
});

test('PS-03 the SDK accepts the page-source plugin item and it is not a native assistant', () => {
  const data = shared.pageSourceSchema.parse({ source: source({ sourceKind: 'future-widget' }) });
  const item = { type: 'plugin', id: 'page:conversation:source-1', pluginId: 'chatmode-in-paseo',
    kind: 'page-source', version: 1, data };
  const event = { type: 'timeline.item', sessionId: 'offline-host', item };
  assert.deepEqual(ProviderEventSchema.parse(event), event);
  assert.equal(item.type, 'plugin');
  assert.equal(item.kind, 'page-source');
  assert.notEqual(item.type, 'assistant_message');
  assert.equal(shared.pageSourceTitle(data.source), '工作过程');
});

test('PS-04 process commentary is read-only source text, not Markdown, a summary or a control', () => {
  const value = source({ sourceKind: 'future-widget', text: '**原文**\n# 不是标题\n[链接](https://example.test/)\n' });
  const tree = render({ source: value });
  const body = text(tree);
  assert.match(body, /^工作过程/);
  assert.match(body, /原类型：future-widget/);
  assert.ok(body.includes(value.text));
  const content = nodes(tree).find(node => node.type === 'Text' && node.props?.children === value.text);
  assert.ok(content, 'source text is a Text node');
  assert.equal(content.props.selectable, true);
  assert.equal(content.props.numberOfLines, undefined);
  assert.equal(nodes(tree).some(node => /Pressable|Button|Link/.test(String(node.type))), false);
  assert.equal(nodes(tree).some(node => Object.keys(node.props ?? {}).some(key => /^on(?:Press|Click|Change)/.test(key))), false);
  assert.doesNotMatch(body, /任务已完成|已下载|可预览/);
});

test('PS-05 details render only when the source actually supplied them, verbatim', () => {
  const inputOnly = render({ source: source({ details: { input: '  输入 **原文**  ' } }) });
  const inputBody = text(inputOnly);
  assert.ok(inputBody.includes('网页可见输入（原文）'));
  assert.ok(inputBody.includes('  输入 **原文**  '));
  assert.equal(inputBody.includes('网页可见输出（原文）'), false);

  const outputOnly = render({ source: source({ details: { output: '  输出原文\n第二行  ' } }) });
  const outputBody = text(outputOnly);
  assert.ok(outputBody.includes('网页可见输出（原文）'));
  assert.ok(outputBody.includes('  输出原文\n第二行  '));
  assert.equal(outputBody.includes('网页可见输入（原文）'), false);

  const none = render({ source: source() });
  assert.equal(text(none).includes('网页可见输入（原文）'), false);
  assert.equal(text(none).includes('网页可见输出（原文）'), false);
});

test('PS-06 page notices/errors are labelled page content or page notice and never auto-act', () => {
  const notice = render({ source: source({
    id: 'page:error-1', userMessageId: null, role: 'page', lane: 'output', kind: 'notice',
    status: 'failed', sourceKind: 'browser-error',
    text: 'Something failed.\nRetry\nAllow once\nDeny'
  }) });
  const noticeBody = text(notice);
  assert.match(noticeBody, /^网页提示/);
  assert.ok(noticeBody.includes('原类型：browser-error'));
  assert.ok(noticeBody.includes('Something failed.\nRetry\nAllow once\nDeny'));
  assert.equal(nodes(notice).some(node => node.type === 'Pressable'), false);
  assert.equal(nodes(notice).some(node => Object.keys(node.props ?? {}).some(key => /^on(?:Press|Click)/.test(key))), false);

  const pageContent = render({ source: source({
    id: 'page:content-1', userMessageId: null, role: 'page', lane: 'output', kind: 'file',
    text: '页面上的文件说明。'
  }) });
  assert.match(text(pageContent), /^网页内容/);
  assert.ok(text(pageContent).includes('来源信息，预览/下载尚未确认'));
  assert.doesNotMatch(text(pageContent), /预览已就绪|下载完成|可下载/);
});

test('PS-07 media source shows only the unconfirmed source note; text and details remain readable', () => {
  for (const kind of ['image', 'file']) {
    const value = source({
      id: `artifact-source:${kind}`, kind, media: { name: 'fixture.png', width: 2 },
      text: '媒体描述原文', details: { input: '媒体输入原文' }
    });
    const tree = render({ source: value });
    const body = text(tree);
    assert.ok(body.includes('媒体描述原文'));
    assert.ok(body.includes('媒体输入原文'));
    assert.ok(body.includes('来源信息，预览/下载尚未确认'));
    assert.doesNotMatch(body, /图片已生成|预览已就绪|下载完成|可下载|blob:/);
    assert.equal(nodes(tree).some(node => node.type === 'Pressable'), false);
    const content = nodes(tree).find(node => node.type === 'Text' && node.props?.children === '媒体描述原文');
    assert.equal(content.props.selectable, true);
  }
});

test('PS-08 very long source text is not truncated or given a line limit', () => {
  const value = '开头\n' + '长文本 **不是 Markdown**\n'.repeat(20000) + '结尾';
  assert.ok(value.length > 256000);
  const tree = render({ source: source({ text: value }) });
  const content = nodes(tree).find(node => node.type === 'Text' && node.props?.children === value);
  assert.ok(content);
  assert.equal(content.props.selectable, true);
  assert.equal(content.props.numberOfLines, undefined);
  assert.equal(content.props.ellipsizeMode, undefined);
});

test('PS-09 compact layout changes only spacing; the original source remains present', () => {
  const value = source({ text: '紧凑布局原文' });
  const wide = render({ source: value }, false), compact = render({ source: value }, true);
  assert.equal(wide.props.style.padding, 12);
  assert.equal(compact.props.style.padding, 10);
  assert.ok(text(wide).includes(value.text));
  assert.ok(text(compact).includes(value.text));
});

test('PS-10 title categories and unknown source kind labelling are explicit', () => {
  assert.equal(shared.pageSourceTitle(source()), '工作过程');
  assert.equal(shared.pageSourceTitle(source({ id: 'page:notice', role: 'page', kind: 'notice' })), '网页提示');
  assert.equal(shared.pageSourceTitle(source({ id: 'page:content', role: 'page', kind: 'file' })), '网页内容');
  assert.equal(shared.pageSourceTitle(source({ id: 'page:process', kind: 'tool_call', sourceKind: 'future-tool' })), '工作过程');
  const tree = render({ source: source({ role: 'page', kind: 'notice', sourceKind: 'unknown-page-type', text: '原文' }) });
  assert.match(text(tree), /原类型：unknown-page-type/);
  assert.equal(nodes(tree).some(node => /Pressable|Button/.test(String(node.type))), false);
});
