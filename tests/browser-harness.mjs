// Test-only stdin control; no production HTTP execution endpoint is added.
import readline from 'node:readline';
import { createProvider, CAPABILITIES } from '../server/provider.mjs';
import path from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
const runtime = await createRuntime({ directory: path.resolve(process.argv[2]), port: Number(process.argv[3] ?? 17843) });
// Optional REAL installed SDK schema, never a hand-written substitute.
const sdk = process.env.CIP_SDK_MODULE ? await import(process.env.CIP_SDK_MODULE) : null;
const provider = await createProvider(runtime, sdk ? event => sdk.ProviderEventSchema.parse(event) : event => event).connect({ versions: [1], capabilities: CAPABILITIES });
const events = []; provider.onEvent(e => events.push(e));
process.stdout.write(JSON.stringify({ ready: true, address: runtime.address, sdkValidated: Boolean(sdk) }) + '\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  let q;
  try {
    q = JSON.parse(line); let result;
    switch (q.action) {
      case 'provider-input': result = await provider.send(q.input); break;
      case 'events': result = events; break;
      case 'defaults': result = await runtime.broker.defaults(q.selection); break;
      case 'concurrency': result = await runtime.broker.setConcurrency(q.limit); break;
      case 'capacity': result = runtime.broker.slots.snapshot(); break;
      case 'catalog': result = await runtime.broker.call('catalog', null); break;
      case 'create': { const s = await runtime.broker.create(q.selection); await runtime.broker.configure(s.id, q.selection); result = runtime.broker.snapshot(s.id); break; }
      case 'prompt': result = await runtime.broker.prompt(q.id, q.clientMessageId, q.text); break;
      case 'read': result = runtime.broker.snapshot(q.id); break;
      case 'interrupt': result = await runtime.broker.interrupt(q.id); break;
      case 'close': await provider.close(); await runtime.close(); input.close(); break;
      default: throw new Error('Unknown test action');
    }
    process.stdout.write(JSON.stringify({ request: q.request, result }) + '\n');
  } catch (e) { process.stdout.write(JSON.stringify({ request: q?.request, error: e.message, code: e.code }) + '\n'); }
});
input.on('close', () => void runtime.close());
