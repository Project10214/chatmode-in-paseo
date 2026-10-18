import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

// A ChatGPT tab reloaded in the background can stay an empty shell (seen live
// three times on 2026-10-17). Before configure/ensure the worker reloads it once.
const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const script = source.replace(/\nvoid pump\(\);\s*$/, '') + '\nglobalThis.testSettle=settleBlankTab;';

function harness(readyAfterReloads) {
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
        reload: async () => { reloads++; },
        onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} }
      }
    }
  });
  vm.runInContext(script, context);
  return { settle: () => context.testSettle(7), reloads: () => reloads };
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
