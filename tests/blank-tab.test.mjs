import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

// A ChatGPT tab reloaded in the background can stay an empty shell (seen live
// three times on 2026-10-17). Before configure/ensure the worker reloads it once.
// A tab whose document is still LOADING is a slow page, not an empty shell:
// reloading it restarts the load and makes it slower, so it is only waited for.
const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const script = source.replace(/\nvoid pump\(\);\s*$/, '') + '\nglobalThis.testSettle=settleBlankTab;';

const CHATGPT = 'https://chatgpt.com/c/fixture';

function harness(readyAfterReloads, tab = { status: 'complete', url: CHATGPT, discarded: false }, deadline) {
  let clock = 0, reloads = 0;
  const FakeDate = class extends Date { static now() { return clock += 500; } };
  const context = vm.createContext({
    URL, AbortSignal, structuredClone, crypto: webcrypto, console, Date: FakeDate,
    setTimeout: fn => setImmediate(fn), clearTimeout: () => {},
    fetch: async () => ({ ok: true, text: async () => '{}' }),
    chrome: {
      runtime: { id: 'a'.repeat(32), getURL: p => p, getManifest: () => ({ version: '0' }),
        onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} } },
      storage: { local: { setAccessLevel: async () => {}, get: async () => ({}), set: async () => {} },
        session: { get: async () => ({}), set: async () => {} } },
      alarms: { onAlarm: { addListener: () => {} }, create: () => {} },
      tabs: {
        sendMessage: async (id, message) => {
          assert.equal(message.type, 'page-ready');
          return { ok: true, value: { composer: readyAfterReloads !== null && reloads >= readyAfterReloads, documentKey: 'd' } };
        },
        get: async () => tab,
        reload: async () => { reloads++; },
        onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} }
      }
    }
  });
  vm.runInContext(script, context);
  return { settle: () => context.testSettle(7, deadline), reloads: () => reloads, clock: () => clock };
}

test('BLANK-1 a loaded page is never reloaded', async () => {
  const h = harness(0);
  assert.equal(await h.settle(), false);
  assert.equal(h.reloads(), 0);
});

test('BLANK-2 an empty shell is reloaded once and then used', async () => {
  const h = harness(1);
  assert.equal(await h.settle(), true);
  assert.equal(h.reloads(), 1);
});

test('BLANK-3 a page that stays empty is reloaded only once; the normal checks then fail as before', async () => {
  const h = harness(null);
  assert.equal(await h.settle(), true);
  assert.equal(h.reloads(), 1);
});

test('BLANK-4 a page that is still loading is waited for, never reloaded', async () => {
  // Reloading a slow ChatGPT page restarts the load and makes it slower, and
  // the claim that follows would then be filed after the command deadline.
  const h = harness(null, { status: 'loading', url: CHATGPT, discarded: false });
  assert.equal(await h.settle(), true);
  assert.equal(h.reloads(), 0);
});

test('BLANK-5 a discarded tab is reloaded once', async () => {
  const h = harness(1, { status: 'complete', url: CHATGPT, discarded: true });
  assert.equal(await h.settle(), true);
  assert.equal(h.reloads(), 1);
});

test('BLANK-6 the wait is bounded by the command deadline', async () => {
  // A deadline that is already spent must not buy another long wait.
  const h = harness(null, { status: 'loading', url: CHATGPT, discarded: false });
  const before = h.clock();
  await h.settle();
  assert.ok(h.clock() - before < 40000, 'the wait must stay inside the deadline budget');
  assert.equal(h.reloads(), 0);
});
