import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.mjs';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';
import { catalogService } from '../server/catalog.mjs';
import { safeDiagnostic } from '../server/diagnostics.mjs';

async function connection(t, f) {
  const runtime = { store: f.store, broker: f.broker, status: () => ({ connected: true }) };
  const provider = await createProvider(runtime).connect({ versions: [1], capabilities: CAPABILITIES });
  t.after(() => provider.close());
  const events = []; provider.onEvent(e => events.push(e));
  return { runtime, provider, events, service: catalogService(runtime) };
}
async function failRefresh(f, service) {
  const refreshing = service.ensure({ force: true });
  const settled = assert.rejects(refreshing, /APP_CATALOG_UNAVAILABLE/);
  const c = await until(() => f.broker.queued().find(c => c.kind === 'catalog'));
  const claim = await f.broker.claim(c.id, 400, 'catalog-regression-document');
  await f.broker.result(c.id, claim.lease, { error: 'APP_CATALOG_UNAVAILABLE', diagnostic: { stage: 'apps' } });
  await settled;
}

test('CATFORM1 failed refresh must not poison previously confirmed creation-form choices', async t => {
  const f = await fixture(t); const { service, provider, events } = await connection(t, f);
  await failRefresh(f, service);
  await provider.send({ type: 'catalog', requestId: 'form-after-refresh-failure' });
  await until(() => events.some(e => e.requestId === 'form-after-refresh-failure'));
  const result = events.find(e => e.requestId === 'form-after-refresh-failure');
  assert.equal(result.type, 'catalog', JSON.stringify(result));
  assert.equal(result.catalog.models[0].id, 'm1');
  assert.equal(f.broker.queued().length, 0, 'opening the form is not a request to open another Chrome tab');
  assert.equal(service.snapshot().error, 'APP_CATALOG_UNAVAILABLE', 'the refresh failure remains visible, not relabeled successful');
});

test('CATFORM2 a model form does not wait behind a background refresh when confirmed choices exist', async t => {
  const f = await fixture(t); const { service, provider, events } = await connection(t, f);
  await f.store.transaction(d => { d.catalog.observedAt = Date.now() - 3600000; });
  const refreshing = service.ensure({ force: true }); void refreshing.catch(() => {});
  await until(() => f.broker.queued().some(c => c.kind === 'catalog'));
  await provider.send({ type: 'catalog', requestId: 'form-during-refresh' });
  await until(() => events.some(e => e.requestId === 'form-during-refresh'));
  assert.equal(events.find(e => e.requestId === 'form-during-refresh').type, 'catalog');
  assert.equal(service.snapshot().refreshing, true, 'still a pending refresh, not a fabricated current list');
  service.close(); await assert.rejects(refreshing);
});

test('CATFORM3 first install still reports discovery failure; it never manufactures an empty apps list', async t => {
  const f = await fixture(t); await f.store.transaction(d => { d.catalog = null; });
  const { service, provider, events } = await connection(t, f);
  await failRefresh(f, service);
  await provider.send({ type: 'catalog', requestId: 'form-first-install' });
  await until(() => events.some(e => e.requestId === 'form-first-install'));
  const result = events.find(e => e.requestId === 'form-first-install');
  assert.equal(result.type, 'request.failed');
  assert.equal(result.error.code, 'APP_CATALOG_UNAVAILABLE');
  assert.equal(f.store.read().catalog, null);
});

test('CATFORM4 app diagnostics retain only bounded proof flags, never message or account contents', () => {
  assert.deepEqual(safeDiagnostic({stage:'apps',nativeProbeAttempted:true,hintRequestSeen:false,observerReplySeen:true,
    text:'PRIVATE',token:'PRIVATE',cookies:'PRIVATE',endpoint:'PRIVATE'}),
    {stage:'apps',nativeProbeAttempted:true,hintRequestSeen:false,observerReplySeen:true});
  assert.deepEqual(safeDiagnostic({stage:'apps',nativeProbeAttempted:'secret',hintRequestSeen:1,observerReplySeen:null}), {stage:'apps'});
});
