import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import * as copy from '../shared/ui-copy.mjs';
import { phaseLabel } from '../server/activity.mjs';
import { permissionRequest } from '../server/approval.mjs';
import { nativeTimelineItem } from '../server/native-timeline.mjs';
import { activityText, createProvider, CAPABILITIES } from '../server/provider.mjs';
import { fixture, sourceItem, until } from './helpers.mjs';

// Execute the shipped TSX with inert native primitives and hooks. This tests
// rendered copy, not screenshots or a real React Native layout/browser session.
function renderer(file, { state = [], useRpc = () => async () => ({}) } = {}) {
  let cursor = 0, refCursor = 0;
  const refs = [], rpc = Object.fromEntries(['snapshot', 'saveDefaults', 'saveConcurrency', 'pair', 'abandon'].map(k => [k, Symbol(k)]));
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: {
      useState(initial) {
        const at = cursor++;
        if (!Object.hasOwn(state, at)) state[at] = initial;
        return [state[at], next => { state[at] = typeof next === 'function' ? next(state[at]) : next; }];
      },
      useRef: value => refs[refCursor++] ??= { current: value },
      useEffect() {}
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Text: 'Text', View: 'View', Pressable: 'Pressable', Switch: 'Switch', Image: 'Image' },
    '@getpaseo/plugin/client': { useRpc: contract => useRpc(contract, rpc), openExternalUrl: async () => {} },
    '@getpaseo/plugin/client/react-native': { Icon: 'Icon', TextInput: 'TextInput', Modal: Object.assign('Modal', { Content: 'ModalContent' }), copyText: async () => {} },
    '../shared/ui-copy.mjs': copy,
    '../shared/rpc.js': rpc,
    '../shared/images.js': { readImage: Symbol('readImage') }
  };
  const output = ts.transpileModule(readFileSync(new URL('../client/' + file, import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require(name) { assert(Object.hasOwn(modules, name), name); return modules[name]; } }, { filename: file });
  return { state, render(name, props) { cursor = refCursor = 0; return exports[name](props); } };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return Array.isArray(tree) ? tree.map(text).join('') : text(tree.props?.children);
}
const theme = { colors: Object.fromEntries(['foreground', 'foregroundMuted', 'surface0', 'surface1', 'surface2', 'border', 'statusWarning', 'statusDanger', 'statusSuccess', 'accent', 'accentForeground'].map(k => [k, '#' + k])) };
const base = () => ({
  turnId: 'turn-copy', phase: 'working', nativeStatus: 'in_progress', steps: [],
  native: { phase: 'working', status: 'in_progress', observedAt: Date.now() },
  sync: { state: 'ok', issues: [] }, outcome: null, error: null, recoveries: 0, page: null
});
const props = data => ({ item: { data }, theme, layout: { compact: true } });
const card = { key: '12345678-1234-4000-8000-123456789abc', app: 'Chrome', tool: null, input: null, clickable: true, allowLabel: 'Allow', denyLabel: 'Deny' };

test('COPY phases use one shared vocabulary; round completion does not claim all tasks completed', () => {
  assert.equal(phaseLabel, copy.phaseLabel);
  assert.equal(phaseLabel('approval'), '等待授权');
  assert.equal(phaseLabel('completed'), '本轮已结束');
  assert.equal(phaseLabel('failed'), '本轮跟踪中断');
  assert.equal(phaseLabel('unrecognized'), '网页状态未知');
});

test('COPY both activity versions point to Paseo approval cards with a webpage fallback', () => {
  const render = renderer('native-activity.tsx');
  for (const name of ['NativeActivity', 'NativeActivityV2']) {
    const body = text(render.render(name, props({ ...base(), phase: 'approval' })));
    assert(body.includes(copy.approvalHint));
    assert.doesNotMatch(body, /不会替你点击|请到对应 ChatGPT 网页决定/);
  }
});

test('COPY webpage execution, tracking failure and sync blockage remain separate facts', () => {
  const data = { ...base(), phase: 'failed', outcome: 'failed', error: 'STOP_UNCONFIRMED',
    sync: { state: 'blocked', issues: [{ code: 'ANSWER_RAW_DIVERGED', resolvedAt: null }] } };
  const body = text(renderer('native-activity.tsx').render('NativeActivityV2', props(data)));
  assert.match(body, /网页：运行中/);
  assert.match(body, /Paseo 跟踪：已中断（STOP_UNCONFIRMED）/);
  assert.match(body, /网页任务是否停止未确认/);
  assert.match(body, /内容同步：正文同步受阻：ANSWER_RAW_DIVERGED/);
  assert.doesNotMatch(body, /任务已停止|任务执行失败|同步正常/);
});

test('COPY legacy tracking failure no longer says the webpage was stopped', () => {
  const body = text(renderer('native-activity.tsx').render('NativeActivity', props({ ...base(), phase: 'failed' })));
  assert.match(body, /跟踪中断/);
  assert.doesNotMatch(body, /已停止/);
});

test('COPY finalizing is not a pending send receipt or confirmed completion', () => {
  const data = { ...base(), phase: 'finalizing', nativeStatus: 'complete', native: { ...base().native, status: 'complete' } };
  const h = renderer('native-activity.tsx');
  assert.match(text(h.render('NativeActivity', props(data))), /正在确认回答.*网页已结束 · 待确认/);
  const body = text(h.render('NativeActivityV2', props(data)));
  assert.match(body, /网页：回答已结束/);
  assert.match(body, /Paseo 跟踪：进行中/);
  assert.match(body, /回答结束不代表远程工具或后台任务已结束/);
  assert.doesNotMatch(body, /等待回执|任务已完成/);
});

test('COPY page notices keep their exact content and identify redaction without claiming original text', () => {
  const original = '原网页提示：token=[REDACTED]。Retry is available.';
  const data = { ...base(), page: { observedAt: Date.now(), readable: true, controls: { approval: false, stop: null },
    notices: [{ scope: 'page', text: original, buttons: [{ label: 'Retry', enabled: true }], redacted: true, clipped: false }] } };
  const body = text(renderer('native-activity.tsx').render('NativeActivityV2', props(data)));
  assert(body.includes(original));
  assert.match(body, /网页提示（已脱敏）/);
  assert.match(body, /网页按钮（仅展示）：Retry（可用）/);
  assert.doesNotMatch(body, /原文，已脱敏|网页页面/);
  assert(activityText(data).includes(original));
  assert.match(activityText(data), /网页提示（已脱敏）/);
});

test('COPY approval labels preserve actual scope; a Chrome Allow is not described as allow once', () => {
  const request = permissionRequest(card);
  assert.deepEqual(request.actions.map(a => a.label), ['允许（Allow）', '拒绝（Deny）']);
  assert.doesNotMatch(JSON.stringify(request), /允许一次|自动授权/);
  assert.equal(request.detail.text, '网页未提供调用详情。');
  assert.equal(ProviderEventSchema.safeParse({ type: 'session.permission', sessionId: 'copy', request }).success, true);
});

test('COPY settled tools do not manufacture a successful result; reasoning remains verbatim', () => {
  const tool = nativeTimelineItem({ type: 'tool_call', callId: 'copy-tool', name: 'presure · project', kind: 'tool', status: 'completed', settled: true }, 'copy-turn');
  assert.match(tool.detail.text, /本轮已结束；网页未单独确认此调用的结果/);
  assert.match(tool.detail.text, /输入、输出未同步/);
  assert.doesNotMatch(tool.detail.text, /执行成功|以回答内容为准/);
  const summary = '这是网页公开摘要，不应被文案修订改写。';
  assert.equal(nativeTimelineItem({ type: 'reasoning', id: 'copy-summary', text: summary }, 'copy-turn').text, summary);
});

test('COPY errors are concise, preserve uncertainty, and never expose arbitrary exception text', () => {
  assert.match(copy.errorLabel('STOP_UNCONFIRMED'), /停止操作未确认/);
  assert.doesNotMatch(copy.errorLabel('STOP_UNCONFIRMED'), /已停止/);
  assert.match(copy.errorLabel('RECEIPT_UNCONFIRMED'), /不会自动重发/);
  assert.match(copy.errorLabel('FUTURE_ERROR'), /FUTURE_ERROR/);
  assert.doesNotMatch(copy.errorLabel('private user text or secret=123'), /private|123/);
});

const settingsState = () => ({ checkedAt: Date.now(), status: { connected: true, paired: true, address: '127.0.0.1', lastSeenAt: Date.now() },
  defaults: { appIds: [] }, autoAllow: false, catalog: null, observation: { active: 1, syncBlocked: 0, recoverable: 0 },
  capacity: { active: 1, waiting: 0, limit: 2 }, refreshing: false, blocked: [], lastCatalogAttempt: { phase: 'done' } });

test('COPY settings render in compact and wide layouts without stale version or streaming claims', () => {
  for (const compact of [true, false]) {
    const state = []; state[2] = settingsState(); state[13] = true; // settings snapshot; diagnostics expanded
    const tree = renderer('settings.tsx', { state }).render('SettingsScreen', { theme, layout: { compact } });
    const body = text(tree);
    assert.match(body, /扩展已连接/);
    assert.match(body, /扩展在线不代表会话同步正常/);
    assert.match(body, /并发上限/);
    assert.match(body, /仅用于新建 Agent/);
    assert.match(body, /最近列表更新：已完成/);
    assert.doesNotMatch(body, /alpha\.3\.15|文字流式回传|不自动点击授权|建议先用 4 路/);
    for (const node of nodes(tree).filter(n => n.type === 'Text')) assert(node.props.style?.color, 'Text needs themed color');
  }
});

test('COPY image messages distinguish a generated image from an unavailable or loading preview', () => {
  const image = { sessionId: 'copy-session', turnId: 'copy-turn', conversationId: 'copy-conversation', status: 'unavailable' };
  const h = renderer('generated-image.tsx');
  const unavailable = text(h.render('GeneratedImage', props(image)));
  assert.match(unavailable, /图片已生成，预览不可用/);
  // The card opens the conversation; a compressed preview is never the
  // original file and must not promise an original-image download.
  assert.match(unavailable, /打开原对话/);
  assert.match(unavailable, /压缩预览，非原文件/);
  assert.doesNotMatch(unavailable, /查看原图|下载原图/);
  const loading = text(h.render('GeneratedImage', props({ ...image, status: 'available', digest: 'a'.repeat(64) })));
  assert.match(loading, /正在加载预览/);
  assert.doesNotMatch(loading, /正在生成图片/);
});

test('COPY uncertain settings save keeps the selection and does not claim nothing changed remotely', async () => {
  const state = []; state[0] = 4; state[2] = settingsState();
  const h = renderer('settings.tsx', { state, useRpc: () => async () => { throw new Error('offline'); } });
  const tree = h.render('SettingsScreen', { theme, layout: { compact: true } });
  const save = nodes(tree).find(n => n.type === 'Pressable' && text(n) === '应用并发上限');
  save.props.onPress();
  await until(() => state[1]);
  assert.match(state[1], /保存未确认/);
  assert.equal(state[0], 4);
  assert.doesNotMatch(state[1], /未修改并发上限/);
});

test('COPY provider notices do not infer page execution, completion or approval outcome', async t => {
  const f = await fixture(t), s = await f.ready();await f.sending(s);
  const p = await createProvider({ ...f, status: () => ({ connected: true }) }, value => ProviderEventSchema.parse(value))
    .connect({ versions: [1], capabilities: CAPABILITIES.filter(value => value !== 'timeline.plugin') });
  t.after(() => p.close()); const events = []; p.onEvent(e => events.push(e));
  await p.send({ type: 'session.open', requestId: 'copy-open', sessionId: 'copy-host', history: 'skip', persistence: { version: 1, data: { id: s.id } },
    config: { cwd: '/copy', env: {}, settings: {}, mcpServers: {}, persist: true, model: s.config.model, thinkingOption: s.config.thinkingOption, providerOptions: { appIds: s.config.appIds } } });
  await until(() => events.some(e => e.type === 'session.ready'));
  // An unreadable page is reported as unknown state, not as running/finished.
  await f.view(s, { state: 'abnormal', items: [] });
  const abnormal = await until(() => events.find(e => e.notice?.title === '状态无法确认'));
  assert.doesNotMatch(abnormal.notice.title, /正在运行|已完成/);
  // A published non-prefix revision is an explicit limitation notice.
  await f.view(s, { state: 'running', items: [sourceItem('answer', 'new', { nativeMessageId: 'native-answer' })] });
  await f.view(s, { state: 'running', items: [sourceItem('answer', 'rewritten', { nativeMessageId: 'native-answer' })] });
  const revision = await until(() => events.find(e => e.notice?.title === 'CIP：正文修订无法原位同步'));
  assert.doesNotMatch(revision.notice.description ?? '', /网页已不在生成|已完成/);
  // An externally closed card is not a recorded allow/deny decision.
  await f.view(s, { state: 'standby', approvals: [card] });
  await f.view(s, { state: 'standby', approvals: [], closedApprovals: [card.key] });
  assert.equal(events.at(-1).notice.title, '网页授权框已离开或关闭');
  assert.doesNotMatch(events.at(-1).notice.title, /批准|已处理/);
  await p.send({ type: 'session.configure', requestId: 'copy-config', sessionId: 'copy-host', changes: { model: 'nonexistent' } });
  const failed = await until(() => events.find(e => e.type === 'request.failed' && e.requestId === 'copy-config'));
  assert.equal(failed.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(failed.error.message, copy.errorLabel('MODEL_UNAVAILABLE'));
  assert.equal(f.broker.queued().filter(c => ['send', 'approval', 'stop'].includes(c.kind)).length, 0);
});
