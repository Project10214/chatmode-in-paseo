import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsSnapshot } from '../server/diagnostics.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(call) {
  const state = { sessions: {}, commands: {}, catalog: null, defaults: { appIds: [] } };
  const runtime = { status: () => ({ connected: true, paired: true }),
    store: { read: () => structuredClone(state) }, broker: { call } };
  return { state, runtime };
}

test('FB1 refresh returns before a browser response; status remains readable during the wait', async () => {
  let release, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const { runtime } = setup(async () => { calls++; await waiting; });
  let timer;
  try {
    const value = await Promise.race([settingsSnapshot(runtime, true), new Promise(resolve => {
      timer = setTimeout(() => resolve('RPC_BLOCKED'), 200);
    })]);
    assert.notEqual(value, 'RPC_BLOCKED');
    assert.equal(value.refreshing, true);
    assert.equal(value.refreshError, null);
    assert.equal((await settingsSnapshot(runtime, false)).status.connected, true);
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); release(); await flush(); }
});

test('FB2 late native success is visible on ordinary polling without a second refresh', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { runtime, state } = setup(async () => {
    await waiting;
    state.catalog = { models: [{ id: 'model' }], apps: [], observedAt: 15 };
    state.commands.c = { kind: 'catalog', phase: 'done', createdAt: 10 };
  });
  assert.equal((await settingsSnapshot(runtime, true)).refreshing, true);
  release(); await flush();
  const result = await settingsSnapshot(runtime, false);
  assert.equal(result.refreshing, false);
  assert.equal(result.refreshError, null);
  assert.equal(result.catalog.models[0].id, 'model');
});

test('FB3 late failure is retained and not hidden by a healthy Chrome connection', async () => {
  let reject;
  const waiting = new Promise((_, fail) => { reject = fail; });
  const { runtime } = setup(() => waiting);
  await settingsSnapshot(runtime, true);
  reject(Object.assign(new Error('APP_MENU_TIMEOUT'), { code: 'APP_MENU_TIMEOUT' }));
  await flush();
  const result = await settingsSnapshot(runtime, false);
  assert.equal(result.status.connected, true);
  assert.equal(result.refreshing, false);
  assert.equal(result.refreshError, 'APP_MENU_TIMEOUT');
});

test('FB4 refresh attaches to an existing provider discovery without opening another tab', async () => {
  let calls = 0, waits = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { runtime, state } = setup(async () => { calls++; });
  state.commands.existing = { id: 'existing', kind: 'catalog', phase: 'claimed', createdAt: 10 };
  runtime.broker.wait = async id => { assert.equal(id, 'existing'); waits++; await waiting; };
  await settingsSnapshot(runtime, true);
  await settingsSnapshot(runtime, true);
  assert.equal(calls, 0); assert.equal(waits, 1);
  assert.equal((await settingsSnapshot(runtime, false)).refreshing, true);
  state.commands.existing.phase = 'failed'; state.commands.existing.error = 'APP_MENU_TIMEOUT';
  release(); await flush();
  assert.equal((await settingsSnapshot(runtime, false)).refreshError, 'APP_MENU_TIMEOUT');
});
