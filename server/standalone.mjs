import path from 'node:path';
import os from 'node:os';
import { createRuntime } from './runtime.mjs';
const runtime = await createRuntime({ directory: path.resolve(process.env.CIP_STATE_DIR ?? path.join(os.homedir(), '.chatmode-in-paseo')), port: Number(process.env.CIP_PORT ?? 17843) });
console.log(`Chatmode in Paseo runtime: ${runtime.address}`);
console.log('Pairing code is in the private state directory pairing.json. No ChatGPT credentials are collected.');
console.log('Do not run standalone while the Paseo plugin runtime is enabled.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await runtime.close(); process.exit(0); });
