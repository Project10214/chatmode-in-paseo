import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { until } from './helpers.mjs';

const source = await readFile(new URL('../extension/upstream/cos-apps-observer.js', import.meta.url), 'utf8');
const url = 'https://chatgpt.com/backend-api/system_hints?mode=plugins';
const hint = (id, name, extra = {}) => ({ system_hint: `plugin:${id}`, name, ...extra });
const body = hints => ({ system_hints: hints });
function response(data, address = url, status = 200) {
  const r = new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  Object.defineProperty(r, 'url', { value: address }); return r;
}
function fixture(t, downstream) {
  const posts = [], handlers = new Map(); let calls = 0;
  const w = { fetch(...args) { calls++; return downstream(...args); },
    postMessage(data) { posts.push(data); },
    addEventListener(name, fn) { const set = handlers.get(name) ?? new Set(); set.add(fn); handlers.set(name, set); },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); } };
  const ctx = vm.createContext({ window: w, location: { origin: 'https://chatgpt.com', pathname: '/' },
    document: { readyState: 'loading' }, URL, TextDecoder, Date, Response, Set, Map, WeakSet, setTimeout, clearTimeout });
  vm.runInContext(source, ctx);
  t.after(() => w.__CIP_COS_APPS_OBSERVER__.dispose());
  const dispatch = (name, event) => { for (const fn of [...handlers.get(name) ?? []]) fn(event); };
  const snapshot = () => {
    dispatch('message', { source: w, origin: 'https://chatgpt.com', data: { source: 'cip-cos-app-catalog-ask', nonce: 'test-nonce-1234567890' } });
    return posts.filter(p => p.source === 'cip-cos-app-catalog-reply').at(-1);
  };
  return { w, posts, snapshot, dispatch, calls: () => calls };
}

test('APP1 CoS system_hints plugin response yields exact IDs without opening an @ menu', async t => {
  const data = body([hint('asdk_app_host','开发主机',{token:'NEVER_EXPORT'}), {system_hint:'agent',name:'not an app'}]);
  const native = response(data), promise = Promise.resolve(native);
  const h = fixture(t, () => promise);
  const returned = h.w.fetch(url);
  assert.equal(returned, promise, 'the original native promise is returned');
  const received = await returned;
  assert.deepEqual(await received.json(), data, 'the page retains its original readable response');
  await until(() => h.snapshot().available);
  assert.deepEqual(JSON.parse(JSON.stringify(h.snapshot().apps)), [{id:'asdk_app_host',label:'开发主机'}]);
  assert.ok(!JSON.stringify(h.posts).includes('NEVER_EXPORT')); assert.equal(h.calls(),1);
});
test('APP2 observer installation and polling never initiate a network request', t => {
  const h = fixture(t, () => { throw new Error('unexpected request'); });
  assert.equal(h.snapshot().available,false); h.snapshot(); h.dispatch('DOMContentLoaded',{});
  assert.equal(h.calls(),0);
});
test('APP3 complete empty list clears apps; a basic list never overwrites a plugin list', async t => {
  let data = body([hint('asdk_app_a','A')]);
  const h = fixture(t, address => Promise.resolve(response(data,address)));
  await h.w.fetch(url); await until(()=>h.snapshot().available);
  data = body([]); await h.w.fetch('https://chatgpt.com/backend-api/system_hints?mode=basic');
  assert.equal(h.snapshot().apps.length,1);
  await h.w.fetch(url); await until(()=>h.snapshot().available);
  assert.equal(h.snapshot().apps.length,0);
});
test('APP4 a late old response cannot restore an earlier account list', async t => {
  const resolutions=[]; const h=fixture(t,()=>new Promise(r=>resolutions.push(r)));
  const a=h.w.fetch(url),b=h.w.fetch(url);
  resolutions[1](response(body([hint('asdk_app_new','New')]))); await b; await until(()=>h.snapshot().available);
  resolutions[0](response(body([hint('asdk_app_old','Old')]))); await a;
  await new Promise(r=>setTimeout(r,20)); assert.equal(h.snapshot().apps[0].id,'asdk_app_new');
});
test('APP5 denied or limited lists invalidate stale evidence; no automatic network retry', async t => {
  let status=200; const h=fixture(t,()=>Promise.resolve(response(body([hint('asdk_app_a','A')]),url,status)));
  await h.w.fetch(url); await until(()=>h.snapshot().available);
  status=429; await h.w.fetch(url); await until(()=>h.snapshot().error);
  assert.equal(h.snapshot().available,false);assert.equal(h.snapshot().error,'APP_LIST_RATE_LIMITED');assert.equal(h.calls(),2);
});
test('APP6 duplicate names retain distinct IDs; conflicting names for one ID refuse', async t => {
  let data=body([hint('asdk_app_a','Same'),hint('asdk_app_b','Same')]);
  const h=fixture(t,()=>Promise.resolve(response(data)));await h.w.fetch(url);await until(()=>h.snapshot().available);
  assert.equal(h.snapshot().apps.length,2);
  data=body([hint('asdk_app_a','A'),hint('asdk_app_a','Wrong')]);await h.w.fetch(url);await until(()=>h.snapshot().error);
  assert.equal(h.snapshot().error,'APP_ID_CONFLICT'); assert.equal(h.snapshot().available,false);
});
test('APP7 bounded parse refuses oversized and explicitly paginated lists', async t => {
  let data={...body([]),has_more:true};const h=fixture(t,()=>Promise.resolve(response(data)));
  await h.w.fetch(url);await until(()=>h.snapshot().error);assert.equal(h.snapshot().error,'APP_LIST_INCOMPLETE');
  data={...body([]),irrelevant:'x'.repeat(1024*1024)};await h.w.fetch(url);await until(()=>h.snapshot().error);
  assert.equal(h.snapshot().error,'APP_LIST_TOO_LARGE');
});
test('APP8 reattachment preserves a native wrapper without recursion or duplicate reads', async t => {
  const h=fixture(t,()=>Promise.resolve(response(body([hint('asdk_app_a','A')]))));
  const first=h.w.fetch;let nativeCalls=0;h.w.fetch=function(...args){nativeCalls++;return first.apply(this,args)};
  h.dispatch('DOMContentLoaded',{});await h.w.fetch(url);await until(()=>h.snapshot().available);
  assert.equal(nativeCalls,1);assert.equal(h.calls(),1);
});
test('APP9 unrelated origins/routes and request headers are never inspected', async t => {
  const h=fixture(t,()=>Promise.resolve(response(body([hint('asdk_app_wrong','Wrong')]),'https://unrelated.test/backend-api/system_hints?mode=plugins')));
  const request={url:'https://unrelated.test/backend-api/system_hints?mode=plugins',method:'GET',get headers(){throw new Error('headers accessed')}};
  await h.w.fetch(request);assert.equal(h.snapshot().available,false);assert.equal(h.snapshot().error,null);
});
