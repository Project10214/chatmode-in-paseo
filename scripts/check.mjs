import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
// The repository's own sources only. `.test-tools` holds local tool state
// (playwright venv, an extracted Paseo package); it is gitignored and must
// never be parsed as if it were part of this project.
async function walk(dir) { const out = []; for (const e of await readdir(dir, { withFileTypes: true })) { if (['node_modules', '.git', '.state', '.test-tools'].includes(e.name)) continue; const full = path.join(dir, e.name); if (e.isDirectory()) out.push(...await walk(full)); else out.push(full); } return out; }
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
// The plugin loader keeps plugin modules inside client/, server/ and shared/,
// so the shipped versions are declared in shared/versions.ts instead of being
// read from the package root. They must not drift from the files they
// describe: a stale constant would show the wrong build in the settings page.
const versions = await readFile(path.join(root, 'shared/versions.ts'), 'utf8');
const declared = name => new RegExp(`export const ${name} = '([^']*)'`).exec(versions)?.[1] ?? null;
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (declared('PLUGIN_VERSION') !== pkg.version)
  throw new Error(`shared/versions.ts PLUGIN_VERSION (${declared('PLUGIN_VERSION')}) disagrees with package.json (${pkg.version})`);
if (declared('INSTALLED_EXTENSION_VERSION') !== manifest.version)
  throw new Error(`shared/versions.ts INSTALLED_EXTENSION_VERSION (${declared('INSTALLED_EXTENSION_VERSION')}) disagrees with extension/manifest.json (${manifest.version})`);
console.log(`PASS: ${count} JavaScript files parsed; JSON manifests valid; no cookie/debugger permissions.`);
console.log(`PASS: shipped versions agree (plugin ${pkg.version}, extension ${manifest.version}).`);
console.log('This is a syntax check, not SDK typechecking or a live ChatGPT acceptance test.');
