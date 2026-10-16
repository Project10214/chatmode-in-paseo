import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Store } from '../server/store.mjs';
import { createRuntime } from '../server/runtime.mjs';

test('store serializes parallel writes without losing data', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cip-store-')); t.after(() => rm(dir, { recursive: true, force: true })); const store = await new Store(dir).open();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.transaction(d => { d.sessions[`s${i}`] = { id: i }; })));
  assert.equal(Object.keys(store.read().sessions).length, 20); assert.equal(Object.keys((await new Store(dir).open()).read().sessions).length, 20);
});
test('failed transaction cannot publish partial in-memory state', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cip-store-')); t.after(() => rm(dir, { recursive: true, force: true })); const store = await new Store(dir).open();
  await assert.rejects(store.transaction(d => { d.version = 99; throw new Error('test'); })); assert.equal(store.read().version, 1);
  await store.transaction(d => { d.defaults.appIds = ['asdk_app_a']; }); assert.deepEqual(store.read().defaults.appIds, ['asdk_app_a']);
});
test('corrupt state is preserved and refused, not reset to a fresh permissive state', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cip-store-')); t.after(() => rm(dir, { recursive: true, force: true })); await writeFile(path.join(dir, 'state.json'), '{bad');
  await assert.rejects(new Store(dir).open()); assert.equal(await readFile(path.join(dir, 'state.json'), 'utf8'), '{bad');
});
async function runtimeFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cip-http-')); const r = await createRuntime({ directory, port: 0 });
  t.after(async () => { await r.close(); await rm(directory, { recursive: true, force: true }); });
  const pairing = JSON.parse(await readFile(path.join(directory, 'pairing.json'), 'utf8')); const extensionId = 'a'.repeat(32);
  const request = (route, value, headers = {}) => fetch(r.address + route, { method: value === undefined ? 'GET' : 'POST', headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
  const pairResponse = await request('/pair', { code: pairing.code, extensionId }); assert.equal(pairResponse.status, 200); const pair = await pairResponse.json();
  return { r, directory, request, pairing, extensionId, auth: { Authorization: `Bearer ${pair.token}`, 'X-CIP-Extension': extensionId } };
}
test('bridge exposes health but requires its own token for commands', async t => { const f = await runtimeFixture(t); assert.equal((await f.request('/hello')).status, 200); assert.equal((await f.request('/commands')).status, 403); assert.equal((await f.request('/commands', undefined, f.auth)).status, 200); });
test('pairing code is single-use', async t => { const f = await runtimeFixture(t); assert.equal((await f.request('/pair', { code: f.pairing.code, extensionId: f.extensionId })).status, 403); });
test('webpage Origin and DNS-rebinding Host rejected even with valid token', async t => { const f = await runtimeFixture(t); assert.equal((await f.request('/commands', undefined, { ...f.auth, Origin: 'https://chatgpt.com' })).status, 403); const status = await new Promise((resolve, reject) => { const req = http.get(f.r.address + '/commands', { headers: { ...f.auth, Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); }); assert.equal(status, 403); });
test('other extension identity cannot reuse the paired token', async t => { const f = await runtimeFixture(t); assert.equal((await f.request('/commands', undefined, { ...f.auth, 'X-CIP-Extension': 'b'.repeat(32) })).status, 403); });
test('no file, shell, permission-changing or generic proxy endpoint exists', async t => { const f = await runtimeFixture(t); for (const route of ['/exec', '/read', '/permissions', '/proxy']) assert.equal((await f.request(route, {}, f.auth)).status, 404); });
test('oversized JSON is refused', async t => { const f = await runtimeFixture(t); assert.equal((await f.request('/event', { text: 'x'.repeat(800000) }, f.auth)).status, 400); });
test('second runtime cannot take over the same state directory', async t => { const f = await runtimeFixture(t); await assert.rejects(createRuntime({ directory: f.directory, port: 0 }), /RUNTIME_LOCKED/); });

test('concurrent attempts cannot consume the same newly issued pairing code twice', async t => {
  const f = await runtimeFixture(t); const pairing = await f.r.renewPairing();
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.request('/pair', { code: pairing.code, extensionId: f.extensionId })));
  assert.equal(responses.filter(x => x.status === 200).length, 1);
  assert.equal(responses.filter(x => x.status === 403).length, 4);
});
