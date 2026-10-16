import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
async function walk(dir) { const out = []; for (const e of await readdir(dir, { withFileTypes: true })) { if (['node_modules', '.git', '.state'].includes(e.name)) continue; const full = path.join(dir, e.name); if (e.isDirectory()) out.push(...await walk(full)); else out.push(full); } return out; }
const protocol = await import('../server/protocol.mjs');
const workerProtocol = /const PROTOCOL = (\d+)/.exec(await readFile(path.join(root, 'extension/background.js'), 'utf8'));
if (!workerProtocol || Number(workerProtocol[1]) !== protocol.PROTOCOL) throw new Error('CIP protocol declarations disagree');
let count = 0;
for (const file of await walk(root)) {
  if (/\.(mjs|js)$/.test(file)) { const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); if (r.status !== 0) { console.error(r.stderr); process.exit(1); } count++; }
  if (file.endsWith('.json')) JSON.parse(await readFile(file, 'utf8'));
}
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
if (manifest.permissions.some(x => ['cookies', 'debugger', '<all_urls>'].includes(x))) throw new Error('Unexpected extension privilege');
for (const entry of manifest.content_scripts) for (const name of entry.js) await readFile(path.join(root,'extension',name));
// Chrome and Paseo can be upgraded separately; Chrome's visible version must
// identify the extension itself. Protocol compatibility is checked above.
if (manifest.version_name !== manifest.version) throw new Error('Displayed Chrome extension version disagrees with manifest version');
console.log(`PASS: ${count} JavaScript files parsed; JSON manifests valid; no cookie/debugger permissions.`);
console.log('This is a syntax check, not SDK typechecking or a live ChatGPT acceptance test.');
