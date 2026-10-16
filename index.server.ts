import type { PluginServerContext } from '@getpaseo/plugin/server';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from './server/runtime.mjs';
import { settingsSnapshot } from './server/diagnostics.mjs';
import { createProvider } from './server/provider.mjs';
import { createWakeCoordinator } from './server/wake.mjs';
import { snapshot, saveDefaults, saveConcurrency, pair, abandon } from './shared/rpc.js';
import { readImage } from './shared/images.js';

export default function contribute(server: PluginServerContext) {
  const wake = createWakeCoordinator();
  const hooks = [
    server.before('agent.session_open', ({request}, context) => { wake.adopt(context.paseo); return request; }),
    server.on('agent.turn_started', ({agent},context) => { wake.adopt(context.paseo); void wake.rememberAgent(agent.id); }),
    server.on('agent.turn_ended', ({agent},context) => { wake.adopt(context.paseo); void wake.rememberAgent(agent.id); }),
    server.on('agent.closed', ({agent},context) => { wake.adopt(context.paseo); void wake.rememberAgent(agent.id); })
  ];
  // Synchronous registration. Startup belongs to one shared promise, not each connection.
  const ready = createRuntime({ directory: path.resolve(process.env.CIP_STATE_DIR ?? path.join(os.homedir(), '.cos-in-paseo')),
    port: Number(process.env.CIP_PORT ?? 17843), onExternalTurn: sessionId => wake.wake(sessionId) });
  // Mark the startup rejection handled even before the first caller asks for status.
  void ready.catch(() => {});
  server.registerProvider({
    id: 'chatmode', label: 'Chatmode', icon: 'icon.svg',
    description: 'ChatGPT browser conversations with already-authorized apps',
    async status() {
      try { return await createProvider(await ready).status?.({}) ?? { available: false, diagnostic: 'Provider status unavailable' }; }
      catch { return { available: false, diagnostic: 'Chatmode runtime startup failed. Inspect the local port, state-directory permissions and runtime.lock; do not delete a live process lock.' }; }
    },
    async getCatalogCacheKey(options) { return createProvider(await ready).getCatalogCacheKey?.(options); },
    async connect(request) { return createProvider(await ready, value => ProviderEventSchema.parse(value)).connect(request); }
  });
  server.handle(snapshot, async ({ refresh }, context) => { wake.adopt(context.paseo); return settingsSnapshot(await ready, refresh); });
  server.handle(saveConcurrency, async ({ maxConcurrent }) => (await ready).broker.setConcurrency(maxConcurrent));
  server.handle(readImage, async input => { const { broker } = await ready; return broker.media.read(broker, input); });
  server.handle(saveDefaults, async selection => (await ready).broker.defaults(selection));
  server.handle(abandon, async ({ sessionId }) => { await (await ready).broker.abandon(sessionId); return { abandoned: true as const }; });
  server.handle(pair, async () => (await ready).renewPairing());
  return async () => { for(const stop of hooks) stop(); const runtime = await ready.catch(() => null); await runtime?.close(); };
}
