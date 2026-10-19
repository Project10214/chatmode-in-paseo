import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

// A brand-new ChatGPT tab created with active:false has never painted its
// conversation. Activate it once before the first Send; ChatGPT's current
// renderer otherwise keeps the first answer in a reveal/hydration state that
// the background observer cannot read until the user clicks the tab.
const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const script = source.replace(/\nvoid pump\(\);\s*$/, '') + '\nglobalThis.testHydrate=hydrateTab;';

function harness({ active }) {
  let clock = 0;
  const tab = { id: 7, windowId: 1, active, status: 'complete', url: 'https://chatgpt.com/c/chat-a' };
  const previous = { id: 9, windowId: 1, active: true, status: 'complete', url: 'https://chatgpt.com/' };
  const updates = [];
  const context = vm.createContext({
    URL, AbortSignal, structuredClone, crypto: webcrypto, console,
    Date: class extends Date { static now() { return clock += 100; } },
    setTimeout: fn => setImmediate(fn), clearTimeout: () => {},
    fetch: async () => ({ ok: true, text: async () => '{}' }),
    chrome: {
      runtime: { id: 'a'.repeat(32), getURL: p => p, getManifest: () => ({ version: '0' }),
        onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} } },
      storage: { local: { setAccessLevel: async () => {}, get: async () => ({}), set: async () => {} },
        session: { get: async () => ({}), set: async () => {} } },
      alarms: { onAlarm: { addListener: () => {} }, create: () => {} },
      tabs: {
        get: async id => structuredClone(id === 7 ? tab : id === 9 ? previous : null),
        query: async () => [structuredClone(previous), structuredClone(tab)],
        update: async (id, patch) => {
          updates.push([id, patch.active]);
          if (id === 7 && Object.hasOwn(patch, 'active')) { tab.active = patch.active; if (patch.active) previous.active = false; }
          if (id === 9 && Object.hasOwn(patch, 'active')) { previous.active = patch.active; if (patch.active) tab.active = false; }
          return structuredClone(id === 7 ? tab : previous);
        },
        sendMessage: async () => ({ ok: true, value: {} }),
        reload: async () => {}, onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} }
      }
    }
  });
  vm.runInContext(script, context);
  return { hydrate: () => context.testHydrate(7), updates, tab, previous };
}

test('HYDRATE-1 a new background tab is activated once, then the previous tab is restored', async () => {
  const h = harness({ active: false });
  assert.equal(await h.hydrate(), true);
  assert.deepEqual(h.updates, [[7, true], [9, true]]);
  assert.equal(h.tab.active, false);
  assert.equal(h.previous.active, true);
});

test('HYDRATE-2 an already active tab is not switched', async () => {
  const h = harness({ active: true });
  assert.equal(await h.hydrate(), true);
  assert.deepEqual(h.updates, []);
});
