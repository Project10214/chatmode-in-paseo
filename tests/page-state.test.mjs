import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as zod from 'zod';
import * as plugin from '@getpaseo/plugin';
import { observationHealth } from '../server/diagnostics.mjs';
import { Broker } from '../server/broker.mjs';
import { ensureObservation, recordPageView, pageControls } from '../server/continuous-observation.mjs';

// Execute the actual shared contracts and TSX with inert React Native primitives.
// This is an offline render-tree/contract test, not a real Paseo UI acceptance test.
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
const shared = load('shared/page-state.ts', { zod });
const rpc = load('shared/rpc.ts', { zod, '@getpaseo/plugin': plugin, './page-state.js': shared });
function render(file, name, props, state = []) {
  let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    react: { useState(value) { const at = cursor++; return [Object.hasOwn(state, at) ? state[at] : value, () => {}]; },
      useRef(value) { return { current: value }; }, useEffect() {} },
    'react-native': { Text: 'Text', View: 'View', Pressable: 'Pressable', Switch: 'Switch' },
    '@getpaseo/plugin/client': { useRpc: () => () => { throw Error('Renderer must not invoke RPC'); } },
    '@getpaseo/plugin/client/react-native': { Icon: 'Icon', TextInput: 'TextInput', copyText() { throw Error('No clipboard'); } },
    '../shared/page-state.js': shared, '../shared/rpc.js': rpc
  };
  return load('client/' + file, modules)[name](props);
}
function text(tree) {
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return Array.isArray(tree) ? tree.map(text).join('') : text(tree.props?.children);
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
}
const theme = { colors: Object.fromEntries(['foreground', 'foregroundMuted', 'surface0', 'surface1', 'surface2',
  'border', 'statusWarning', 'statusDanger', 'statusSuccess', 'accent', 'accentForeground'].map(key => [key, 'theme-' + key])) };
const control = (visible = false, enabled = false) => ({ visible, enabled });
const sample = (changes = {}) => ({ state: 'standby', readable: true, observedAt: 1700000000000,
  controls: { stop: control(), send: control(true, true), voice: control() }, issues: [], ...changes });
const props = (data, compact = false) => ({ item: { type: 'plugin', kind: 'page-state', version: 1, data }, theme, layout: { compact } });
const card = data => render('page-state.tsx', 'PageStateCard', props(shared.pageStateSchema.parse(data)));
function session(id, page = sample(), extra = {}) {
  return { id, conversationId: 'conversation-' + id, tabId: 7, documentKey: 'document-' + id,
    status: 'idle', observation: { page, lastObservedAt: page?.observedAt ?? null },
    history: page ? [{ id: 'page-state:' + id, type: 'plugin', kind: 'page-state', version: 1, data: page }] : [], ...extra };
}

// Schema validation runs for real, preserving arbitrary JSON issue metadata.
test('page-state schema validates the v1 data and preserves issue metadata', () => {
  const source = sample({ issues: [{ code: 'FUTURE_SOURCE_PROBLEM', sourceId: 'original-id', order: [1, 2], detail: { field: 'text' } }] });
  assert.deepEqual(shared.pageStateSchema.parse(source), source);
  for (const invalid of [
    { ...source, state: 'completed' }, { ...source, readable: 'false' }, { ...source, observedAt: NaN },
    { ...source, observedAt: 0 }, { ...source, controls: { ...source.controls, stop: { visible: false } } },
    { ...source, issues: [{ code: '' }] }, { ...source, issues: [{ code: 'BAD', value: () => {} }] },
    { ...source, outcome: 'completed' }
  ]) assert.equal(shared.pageStateSchema.safeParse(invalid).success, false);
});

test('visible Stop selects running, including disabled Stop and contradictory reported state', () => {
  for (const enabled of [true, false]) {
    const data = sample({ state: 'standby', controls: { stop: control(true, enabled), send: control(true), voice: control(true) } });
    const body = text(card(data));
    assert.match(body, /网页：运行中/);
    assert.match(body, enabled ? /可停止/ : /停止不可用/);
    assert.equal(shared.pageStateFromControls(data), 'running');
    assert.doesNotMatch(body, /任务已完成|已停止|恢复/);
  }
});

test('no Stop plus Send or Voice selects standby, independently of enabled', () => {
  for (const key of ['send', 'voice']) for (const enabled of [true, false]) {
    const data = sample({ state: 'running', controls: { stop: control(), send: control(), voice: control(), [key]: control(true, enabled) } });
    assert.equal(shared.pageStateFromControls(data), 'standby');
    assert.match(text(card(data)), /网页：待命/);
  }
});

test('unreadable controls never become a claim of confirmed absence or standby', () => {
  for (const stop of [control(), control(true, true)]) {
    const body = text(card(sample({ readable: false, state: 'running', controls: { stop, send: control(true), voice: control() } })));
    if(stop.visible) {
      assert.match(body,/网页：运行中/);
      assert.match(body,/可停止|停止不可用/);
    } else {
      assert.match(body,/网页：状态无法确认/);
      assert.match(body,/按钮状态未确认/);
    }
    assert.doesNotMatch(body,/网页：待命|已停止/);
  }
  const body = text(card(sample({ state: 'abnormal', controls: { stop: control(), send: control(), voice: control() } })));
  assert.match(body, /网页：状态无法确认/);
  assert.match(body, /按钮状态未确认/);
});

test('source errors do not replace confirmed button state or imply a stopped page', () => {
  for (const data of [sample(), sample({ state: 'running', controls: { stop: control(true, false), send: control(), voice: control() } })]) {
    const issues = [{ code: 'CONTENT_READ_FAILED' }, { code: 'SOURCE_PROJECTION_FAILED', sourceId: 'source-one' }];
    const body = text(card({ ...data, issues }));
    assert(body.includes('网页：' + shared.pageStateLabel[shared.pageStateFromControls(data)]));
    assert.match(body, /采集提示 2 条/);
    assert.doesNotMatch(body, /网页：异常|执行失败|可恢复/);
  }
});

test('control observation issues are presented separately from source issues', () => {
  const data = sample({ state: 'abnormal', readable: false, issues: [{ code: 'CONTROLS_READ_FAILED' }, { code: 'CONTENT_READ_FAILED' }] });
  const body = text(card(data));
  assert.match(body, /采集提示 1 条/);
  assert.match(body, /状态提示 1 条/);
});

test('renderer is read-only, theme-safe and compact-aware', () => {
  const data = shared.pageStateSchema.parse(sample({ issues: [{ code: 'SOURCE_READ_FAILED' }] }));
  const before = JSON.stringify(data);
  for (const compact of [false, true]) {
    const tree = render('page-state.tsx', 'PageStateCard', props(data, compact));
    assert.equal(tree.props.style.padding, compact ? 10 : 12);
    assert.match(text(tree), /最近观测/);
    for (const node of nodes(tree)) {
      assert.notEqual(node.type, 'Pressable');
      assert(!Object.keys(node.props ?? {}).some(key => /^on(?:Press|Click|Change)/.test(key)));
      if (node.type === 'Text') assert(Object.values(theme.colors).includes(node.props.style.color));
    }
  }
  assert.equal(JSON.stringify(data), before);
});

test('health matches live observation bindings, including ended runs and pending archive intents', () => {
  const running = sample({ state: 'running', controls: { stop: control(true, false), send: control(), voice: control() } });
  const sessions = {
    running: session('running', running, { turn: { outcome: 'completed', sync: { state: 'blocked' } } }),
    standby: session('standby', sample(), { status: 'blocked', turn: { outcome: 'failed' }, approvals: { request: { state: 'open' } } }),
    missing: session('missing', null, { tabId: null, documentKey: null }),
    unreadable: session('unreadable', sample({ readable: false })),
    abandoned: session('abandoned', running, { status: 'abandoned' }),
    archiving: session('archiving', running, { archiveIntent: { id: 'archive' } }),
    missingObservation: session('missingObservation', running, { observation: null }),
    missingDocument: session('missingDocument', running, { documentKey: null }),
    invalidTab: session('invalidTab', running, { tabId: '7' }),
    unbound: session('unbound', running, { conversationId: null })
  };
  const broker = { observationBindings() { throw Error('Read the supplied state snapshot, not an old recovery counter'); } };
  const storeState = { sessions, archiveIndex: { archived: { session: session('archived', running) } } };
  const health = observationHealth(storeState, broker);
  assert.deepEqual(health, { bound: 4, running: 2, standby: 1, abnormal: 1, sourceIssues: 0, lastObservedAt: running.observedAt });
  assert.equal(shared.observationHealthSchema.safeParse(health).success, true);
  const bindings = Broker.prototype.observationBindings.call({ store: { read: () => storeState } });
  assert.equal(health.bound, bindings.length, 'same membership as the actual Broker implementation');
  assert(bindings.some(binding => binding.sessionId === 'archiving'));
  delete sessions.archiving;
  assert.equal(observationHealth(storeState).bound, 3, 'only actual removal from sessions ends this binding');
});

test('health ignores turn outcome/sync and run activity; pending permission cannot restore running', () => {
  const s = session('permission', sample({ controls: { stop: control(), send: control(), voice: control(true, true) } }),
    { approvals: { key: { state: 'open' } } });
  s.observation.run = { active: true };
  Object.defineProperty(s, 'turn', { get() { throw Error('Old turn state must not be read'); } });
  assert.deepEqual(observationHealth({ sessions: { permission: s } }),
    { bound: 1, running: 0, standby: 1, abnormal: 0, sourceIssues: 0, lastObservedAt: s.observation.page.observedAt });
  assert.match(text(card(s.observation.page)), /网页：待命/);
});

test('health counts latest source issues separately without changing confirmed page state', () => {
  const s = session('source', sample());
  s.history[0].data = { ...s.observation.page, issues: [{ code: 'SOURCE_READ_FAILED' }, { code: 'SOURCE_TEXT_FAILED' }, { code: 'CONTROLS_METADATA_TOO_LARGE' }] };
  const health = observationHealth({ sessions: { source: s } });
  assert.equal(health.sourceIssues, 2);
  assert.equal(health.standby, 1);
  assert.equal(health.abnormal, 0);
  s.observation.page = { ...s.observation.page, observedAt: s.observation.page.observedAt + 1000 };
  assert.equal(observationHealth({ sessions: { source: s } }).sourceIssues, 0, 'stale historical issues are not current capture errors');
});

test('actual page-view projection validates and renders without turning a source error or approval into running', () => {
  const id = 'projected', conversationId = '12345678-1234-4234-8234-123456789abc';
  const s = { id, conversationId, tabId: 7, documentKey: 'document', status: 'idle', history: [],
    approvals: { existing: { state: 'open' } } };
  const observation = ensureObservation(s);
  observation.run = { id: 'prior-run', active: true };
  const page = sample({ observedAt: Date.now(), controls: { stop: control(), send: control(), voice: control(true, false) } });
  recordPageView(s, { observationLease: observation.lease, tabId: 7, documentKey: 'document',
    url: 'https://chatgpt.com/c/' + conversationId, sequence: 1,
    view: { conversationId, page, items: [{}], approvals: [], issues: [] } });
  const item = s.history.find(row => row.kind === 'page-state');
  assert.equal(shared.pageStateSchema.safeParse(item.data).success, true);
  assert.match(text(card(item.data)), /网页：待命/);
  const health = observationHealth({ sessions: { [id]: s } });
  assert.equal(health.standby, 1);
  assert.equal(health.running, 0);
  assert.equal(health.sourceIssues, item.data.issues.length);
  assert(health.sourceIssues > 0);
  assert.equal(s.approvals.existing.state, 'open');
});

test('health and renderer use the same button/readability semantics for every combination', () => {
  for (const readable of [false, true]) for (let mask = 0; mask < 64; mask++) {
    const controls = Object.fromEntries(['stop', 'send', 'voice'].map((key, i) => [key, control(Boolean(mask & (1 << (i * 2))), Boolean(mask & (2 << (i * 2))))]));
    const data = sample({ readable, controls, issues: [{ code: 'SOURCE_READ_FAILED' }] });
    const expected = shared.pageStateFromControls(data);
    assert.equal(pageControls(data).state,expected,'server, health and UI use the same button facts');
    const health = observationHealth({ sessions: { same: session('same', data) } });
    assert.equal(health[expected], 1);
    assert.equal(health.running + health.standby + health.abnormal, 1);
    assert.equal(health.sourceIssues, 1);
    assert(text(card(data)).includes('网页：' + shared.pageStateLabel[expected]));
  }
});

test('health timestamps use only current observation evidence, never old turn completion', () => {
  const s = session('time', sample({ observedAt: 1000 }), { turn: { lastObservedAt: 9000 } });
  s.observation.lastObservedAt = 1100;
  assert.equal(observationHealth({ sessions: { time: s } }).lastObservedAt, 1100);
  s.observation.lastObservedAt = Infinity;
  assert.equal(observationHealth({ sessions: { time: s } }).lastObservedAt, 1000);
  assert.deepEqual(observationHealth({ sessions: {} }), { bound: 0, running: 0, standby: 0, abnormal: 0, sourceIssues: 0, lastObservedAt: null });
});

test('new health schema rejects old dual-track counters and impossible partitions', () => {
  assert.equal(shared.observationHealthSchema.safeParse({ active: 1, syncBlocked: 0, recoverable: 1, lastObservedAt: null }).success, false);
  assert.equal(shared.observationHealthSchema.safeParse({ bound: 1, running: 1, standby: 1, abnormal: 0, sourceIssues: 0, lastObservedAt: null }).success, false);
});

const settingsSnapshot = observation => ({ checkedAt: 1700000001000,
  status: { connected: true, paired: true, address: '127.0.0.1', protocol: 1, lastSeenAt: 1700000000000 },
  observation, catalog: null, defaults: { appIds: [] }, autoAllow: false, blocked: [], capacity: { active: 0, waiting: 0, limit: 2 },
  pluginVersion: '0.1.0-alpha.4.47', extensionVersion: '0.2.52', installedExtensionVersion: '0.2.52',
  refreshing: false, refreshStartedAt: null, refreshError: null, lastCatalogAttempt: null });
test('real settings RPC schema accepts only the unified health fields', () => {
  const observation = { bound: 3, running: 1, standby: 1, abnormal: 1, sourceIssues: 2, lastObservedAt: 1700000000000 };
  assert.deepEqual(rpc.snapshot.output.parse(settingsSnapshot(observation)).observation, observation);
  assert.equal(rpc.snapshot.output.safeParse(settingsSnapshot({ active: 2, syncBlocked: 1, recoverable: 1 })).success, false);
});

test('settings renders unified counters and source issues in compact and wide layouts', () => {
  const observation = { bound: 3, running: 1, standby: 1, abnormal: 1, sourceIssues: 2, lastObservedAt: 1700000000000 };
  for (const compact of [false, true]) {
    const state = []; state[2] = settingsSnapshot(observation); state[13] = true;
    const tree = render('settings.tsx', 'SettingsScreen', { theme, layout: { compact } }, state);
    const body = text(tree);
    assert.match(body, /已绑定 3 · 运行中 1 · 待命 1 · 状态无法确认 1/);
    assert.match(body, /源采集问题 2 · 最近观测：/);
    assert.doesNotMatch(body, /可恢复|恢复跟踪|同步受阻|跟踪中 \d/);
    for (const node of nodes(tree).filter(node => node.type === 'Text')) assert(node.props.style?.color);
  }
});

test('settings without a health snapshot shows unknown, not invented zero counts', () => {
  const state = []; state[2] = settingsSnapshot(undefined);
  const body = text(render('settings.tsx', 'SettingsScreen', { theme, layout: { compact: true } }, state));
  assert.match(body, /会话状态尚未读取/);
  assert.doesNotMatch(body, /已绑定 0|待命 0|源采集问题 0/);
});
