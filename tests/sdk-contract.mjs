// Uses the real SDK only. Default: installed pinned npm SDK. Optional: the user's
// installed Paseo app module, run with its Electron helper in Node mode (asar support).
import test from 'node:test';
import assert from 'node:assert/strict';
const sdkModule = process.env.CIP_SDK_MODULE ?? '@getpaseo/plugin/server/provider';
assert.ok(sdkModule === '@getpaseo/plugin/server/provider' || sdkModule.startsWith('file:///'), 'SDK must be a local package or local file URL');
const { ProviderEventSchema, ProviderInputSchema } = await import(sdkModule);
import { createProvider, CAPABILITIES, configState, wireModels } from '../server/provider.mjs';
import { fixture, selection, until } from './helpers.mjs';

test('installed SDK validates catalog, configuration, opening, messages and terminal events', async t => {
  const f = await fixture(t), events = [];
  const p = await createProvider({ ...f, status: () => ({ connected: true }) }, e => ProviderEventSchema.parse(e)).connect({ versions: [1], capabilities: CAPABILITIES });
  t.after(() => p.close()); p.onEvent(e => events.push(e));
  const opening = ProviderInputSchema.parse({ type: 'session.open', requestId: 'open', sessionId: 'host', history: 'skip', config: {
    cwd: '/fixture', env: {}, settings: {}, mcpServers: { paseo: { type: 'http', url: 'http://127.0.0.1:1234/mcp/agents' } }, persist: true, model: selection.model, thinkingOption: selection.thinkingOption, providerOptions: { appIds: selection.appIds } } });
  await p.send(opening);
  await until(() => events.some(e => e.type === 'session.ready'));
  assert.equal(f.broker.queued().length,0);
  const nativeConfig=events.find(event=>event.type==='session.config');
  assert.ok(nativeConfig);
  assert.equal(nativeConfig.config.settings.length,1);
  assert.equal(nativeConfig.config.settings[0].type,'select');
  assert.equal(nativeConfig.config.settings[0].id,'app:quick');
  assert.equal(nativeConfig.config.settings[0].value,'app:asdk_app_a');
  assert(nativeConfig.config.settings[0].options.some(x=>x.value==='app:asdk_app_b'));
  ProviderInputSchema.parse({type:'session.configure',requestId:'quick',sessionId:'host',
    changes:{settings:{'app:quick':'app:asdk_app_b'}}});
  ProviderEventSchema.parse({ type: 'catalog', requestId: 'catalog', catalog: { models: wireModels(f.store.read().catalog), modes: [], defaultModel: 'm1' } });
  for (const e of events) assert.equal(ProviderEventSchema.safeParse(e).success, true);
  await p.send(ProviderInputSchema.parse({ type: 'session.prompt', sessionId: 'host', prompt: { clientMessageId: 'text', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hello' }] } } }));
  const c = await until(() => f.broker.queued().find(c=>c.kind==='open')); const claim = await f.broker.claim(c.id,123,'document');
  await f.broker.result(c.id,claim.lease,{config:c.payload.config,tabId:123,url:'https://chatgpt.com/'});
  await until(() => events.some(e => e.type === 'session.turn'));
  await p.send({ type: 'session.interrupt', sessionId: 'host', requestId: 'stop' });
  await until(() => events.some(e => e.type === 'session.turn' && e.state === 'canceled'));
  assert.equal(events.some(e => e.type === 'session.runtime_failed'), false);
});

test('installed SDK accepts archive persistence and the provider acknowledges an unloaded Agent', async t => {
  assert.ok(CAPABILITIES.includes('session.archive'));
  const f=await fixture(t), s=await f.ready(), events=[];
  const p=await createProvider({...f,status:()=>({connected:true})}, e=>ProviderEventSchema.parse(e))
    .connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>p.close());
  p.onEvent(e=>events.push(e));
  const input=ProviderInputSchema.parse({type:'session.archive',requestId:'sdk-archive',
    persistence:{version:1,data:{id:s.id}}});
  await p.send(input);
  await until(()=>events.some(e=>e.type==='request.completed'&&e.requestId==='sdk-archive'));
  assert.equal(f.broker.queued().filter(c=>c.kind==='close-tab').length,1);
  assert.ok(CAPABILITIES.includes('session.unarchive'));
  await p.send(ProviderInputSchema.parse({type:'session.unarchive',requestId:'sdk-unarchive',
    persistence:{version:1,data:{id:s.id}}}));
  await until(()=>events.some(e=>e.type==='request.completed'&&e.requestId==='sdk-unarchive'));
  assert.equal(f.broker.queued().filter(c=>c.kind==='close-tab').length,0);
  assert.equal(f.broker.snapshot(s.id).tabId,s.tabId);
});
