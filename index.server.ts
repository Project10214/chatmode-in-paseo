import type { PluginServerContext } from '@getpaseo/plugin/server';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from './server/runtime.mjs';
import { settingsSnapshot } from './server/diagnostics.mjs';
import { createProvider } from './server/provider.mjs';
import { createWakeCoordinator } from './server/wake.mjs';
import { createHostObservation } from './server/host-observation.mjs';
import { snapshot, saveDefaults, saveConcurrency, saveAutoAllow, pair, abandon } from './shared/rpc.js';
import { readImage } from './shared/images.js';
import { readArtifact } from './shared/artifacts.js';

export default function contribute(server: PluginServerContext) {
  // One host-subscription barrier shared by the wake coordinator (read-only
  // commands()) and every Provider instance: a resumed turn's `started` waits
  // until the host session that will receive it is subscribed.
  const observation = createHostObservation();
  const wake = createWakeCoordinator({ observation });
  const hostObservation = { hostObservation: observation };
  const hooks = [
    server.before('agent.session_open', ({request}, context) => { wake.adopt(context.paseo); return request; }),
    server.on('agent.turn_started', ({agent},context) => { wake.adopt(context.paseo); void wake.rememberAgent(agent.id); }),
    server.on('agent.turn_ended', ({agent},context) => { wake.adopt(context.paseo); void wake.rememberAgent(agent.id); }),
    server.on('agent.closed', ({agent},context) => { wake.adopt(context.paseo); void wake.rememberAgent(agent.id); })
  ];
  // Synchronous registration. One shared runtime, but a failed start is not remembered
  // forever: a crashed earlier run can leave a stale lock behind, so the next call retries
  // instead of leaving the provider broken until the plugin is reloaded by hand.
  const startRuntime = () => createRuntime({ directory: path.resolve(process.env.CIP_STATE_DIR ?? path.join(os.homedir(), '.chatmode-in-paseo')),
    port: Number(process.env.CIP_PORT ?? 17843), onExternalTurn: sessionId => wake.wake(sessionId) });
  type Runtime = Awaited<ReturnType<typeof startRuntime>>;
  let starting: Promise<Runtime> | null = null;
  let failedAt = 0;
  const RETRY_AFTER_MS = 3000;
  function ready(): Promise<Runtime> {
    if (starting) return starting;
    const delay = failedAt ? Math.max(0, RETRY_AFTER_MS - (Date.now() - failedAt)) : 0;
    return (delay ? new Promise<void>(resolve => setTimeout(resolve, delay)) : Promise.resolve()).then(() => {
      if (starting) return starting;
      const attempt = startRuntime();
      starting = attempt;
      attempt.then(() => { failedAt = 0; }, () => { if (starting === attempt) starting = null; failedAt = Date.now(); });
      return attempt;
    });
  }
  server.registerProvider({
    id: 'chatmode', label: 'Chatmode', icon: 'icon.svg',
    description: '在 Paseo 收发 ChatGPT 网页消息，使用已授权应用。',
    async status() {
      try { return await createProvider(await ready(), undefined, hostObservation).status?.({}) ?? { available: false, diagnostic: '无法读取 Chatmode 状态。' }; }
      catch (e) { return { available: false, diagnostic: `Chatmode 启动失败：${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` }; }
    },
    async getCatalogCacheKey(options) { return createProvider(await ready(), undefined, hostObservation).getCatalogCacheKey?.(options); },
    async connect(request) { return createProvider(await ready(), value => ProviderEventSchema.parse(value), hostObservation).connect(request); }
  });
  server.handle(snapshot, async ({ refresh }, context) => { wake.adopt(context.paseo); return settingsSnapshot(await ready(), refresh); });
  server.handle(saveConcurrency, async ({ maxConcurrent }) => (await ready()).broker.setConcurrency(maxConcurrent));
  server.handle(saveAutoAllow, async ({ enabled }) => (await ready()).broker.setAutoAllowApprovals(enabled));
  server.handle(readImage, async input => { const { broker } = await ready(); return broker.media.read(broker, input); });
  server.handle(readArtifact, async input => (await ready()).broker.artifactTransfer.read(input));
  server.handle(saveDefaults, async selection => (await ready()).broker.defaults(selection));
  server.handle(abandon, async ({ sessionId }) => { await (await ready()).broker.abandon(sessionId); return { abandoned: true as const }; });
  server.handle(pair, async () => (await ready()).renewPairing());
  return async () => { for(const stop of hooks) stop(); const runtime = await ready().catch(() => null); await runtime?.close(); };
}
