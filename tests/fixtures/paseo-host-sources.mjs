/** Pinned original Paseo host sources for the opt-in real-class suite
 * (tests/host-observation-real.mjs). The package's OWN version selects one
 * exact entry; unknown versions, missing files, different bytes or mismatched
 * dependency versions throw. Nothing is skipped and no other SDK is borrowed:
 * ProviderEventSchema is imported from the host package's own node_modules.
 *
 * Provenance (read-only, offline):
 *  - 0.11.4: public npm @getpaseo/server-0.11.4.tgz, integrity
 *    sha512-rm7Ultkt+6immOSf24srXt/XHgmZOrfRUD8uBzDeui5pLYj4r5PLciUBdJBZAznC5wq5tuEC2L6gyD673MAi9A==;
 *    core files byte-identical to the then-installed Paseo 0.11.4 app.asar.
 *  - 0.12.0-beta.1: official @getpaseo/server-0.12.0-beta.1 tarball (integrity
 *    verified when downloaded); core files match the installed app.asar.
 *    Manager and prompt orchestration changed; the provider/lifecycle core did not.
 *  - 0.12.0-beta.2: official tarballs (server/plugin/client/protocol/relay/highlight
 *    integrity verified 2026-10-18); core files match the installed app.asar.
 *    plugin-provider, run-state and SDK types are unchanged; agent-manager only
 *    strips the agent-message envelope before out-of-band slash commands,
 *    agent-prompt reworks caller finish notifications, agent-loading adds
 *    AgentNotFoundError. The plugin SDK/protocol dist is byte-identical to beta.1.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const AGENT = 'dist/server/server/agent/';
const SHARED_CORE = {
  [AGENT + 'agent-run-state.js']: 'ac8b7ff61bf91350b073858c5ca10dedd1ca99dd2ae40f9f562d4bd26fc29ec0',
  [AGENT + 'plugin-provider.js']: 'dc9948ca942d2aeef10a48c4ef1fc625819005ef28296bb386cfb9737502d475',
  [AGENT + 'agent-sdk-types.js']: 'ef63bac8a1dedbbe2c03ee36d3a1a65a7b40d3e9b4251f78b869f7727eaf9dba'
};
const LOADING_011 = { [AGENT + 'agent-loading.js']: '34f6031fd0fb027640b29d43bcdec61cf967f26417b3f22a161a20a868337c0d' };
const SDK_PROVIDER = 'node_modules/@getpaseo/plugin/dist/server/provider.js';
export const PASEO_HOST_SOURCES = Object.freeze({
  '0.11.4': {
    files: { ...SHARED_CORE, ...LOADING_011, [AGENT + 'agent-manager.js']: '5baa385f48c1a06938ab3fcc073f4534fa0b04c1ec4a2c0228e653e929210450',
      [AGENT + 'agent-prompt.js']: 'd715636be2ab04b0d4b6a8c7e549388484dd7e3ffd6e53232d57b4479dbedecb',
      [SDK_PROVIDER]: '53d8c6be6e12ff496bcf213ee0ea751226ae12e273969ddc56a1987b0712fa8e' },
    dependencies: { '@getpaseo/plugin': '0.11.4', '@getpaseo/protocol': '0.11.4', '@getpaseo/client': '0.11.4' }
  },
  '0.12.0-beta.1': {
    files: { ...SHARED_CORE, ...LOADING_011, [AGENT + 'agent-manager.js']: '63c27c34cb1079880594cfc5a8b498adbd838d6411036fdd49fb79e730be442e',
      [AGENT + 'agent-prompt.js']: 'd6e4f2a8e3e048cd68bb7e0ea8d205c5eb77eb8cb6b0afab8101fdc6e839da30',
      [SDK_PROVIDER]: '53d8c6be6e12ff496bcf213ee0ea751226ae12e273969ddc56a1987b0712fa8e' },
    dependencies: { '@getpaseo/plugin': '0.12.0-beta.1', '@getpaseo/protocol': '0.12.0-beta.1', '@getpaseo/client': '0.12.0-beta.1',
      '@getpaseo/relay': '0.12.0-beta.1' }
  },
  '0.12.0-beta.2': {
    files: { ...SHARED_CORE, [AGENT + 'agent-loading.js']: '68a49992ea1f6e4813b8a1860cb725bc43cb5d4a4dae6c4db9b5ba0a0e39ae44',
      [AGENT + 'agent-manager.js']: 'e5a60e7a4b11691bc378196e267dfebc0d8171c26bd5427c46c067e5dc8587d4',
      [AGENT + 'agent-prompt.js']: 'b2c262e9fb6165e47fb3c9407f392bd06e5d1485c1ffe5a2d270c0927e3a96e6',
      [SDK_PROVIDER]: '53d8c6be6e12ff496bcf213ee0ea751226ae12e273969ddc56a1987b0712fa8e' },
    dependencies: { '@getpaseo/plugin': '0.12.0-beta.2', '@getpaseo/protocol': '0.12.0-beta.2', '@getpaseo/client': '0.12.0-beta.2',
      '@getpaseo/relay': '0.12.0-beta.2' }
  }
});

/** For detached pure-function audits: identify exact known bytes, never accept an arbitrary new hash. */
export function assertPinnedAgentSource(source, filename) {
  const sha=createHash('sha256').update(source).digest('hex');
  const versions=Object.entries(PASEO_HOST_SOURCES).filter(([,p])=>p.files[AGENT+filename]===sha).map(([version])=>version);
  assert(versions.length>0,'Unaudited Paseo source '+filename+' ('+sha+')');
  return versions;
}
const readJson = async file => JSON.parse(await readFile(file, 'utf8').catch(() => { throw new Error('Missing ' + file); }));
/** Verify and load one extracted @getpaseo/server package directory. */
export async function loadPaseoHost(packageDir) {
  if (!packageDir) throw new Error('CIP_PASEO_SERVER_PACKAGE is required (an extracted @getpaseo/server package dir). Not skipped.');
  const pkg = await readJson(path.join(packageDir, 'package.json'));
  assert.equal(pkg.name, '@getpaseo/server', 'Not a @getpaseo/server package: ' + packageDir);
  const pinned = PASEO_HOST_SOURCES[pkg.version];
  if (!pinned) throw new Error(`Unsupported @getpaseo/server ${pkg.version}; pinned: ${Object.keys(PASEO_HOST_SOURCES).join(', ')}`);
  for (const [file, sha] of Object.entries(pinned.files)) {
    const bytes = await readFile(path.join(packageDir, file)).catch(() => { throw new Error(`Missing pinned ${pkg.version} host source ${file}`); });
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha, `Host source differs from pinned ${pkg.version}: ${file}`);
  }
  for (const [name, version] of Object.entries(pinned.dependencies)) {
    assert.equal(pkg.dependencies?.[name], version, `${pkg.version} declares ${name}@${pkg.dependencies?.[name]}`);
    const installed = await readJson(path.join(packageDir, 'node_modules', name, 'package.json'));
    assert.equal(installed.version, version, `Installed ${name} is ${installed.version}, expected ${version} for server ${pkg.version}`);
  }
  const load = file => import(pathToFileURL(path.join(packageDir, file)).href);
  const { AgentManager } = await load(AGENT + 'agent-manager.js');
  const { PluginAgentClientRegistry } = await load(AGENT + 'plugin-provider.js');
  const { ensureAgentLoaded } = await load(AGENT + 'agent-loading.js');
  const { ProviderEventSchema } = await load(SDK_PROVIDER); // the host package's own SDK, never the repo's
  for (const [name, value] of Object.entries({ AgentManager, PluginAgentClientRegistry, ensureAgentLoaded, ProviderEventSchema }))
    assert.ok(value, `${pkg.version}: ${name} not exported`);
  return { version: pkg.version, AgentManager, PluginAgentClientRegistry, ensureAgentLoaded, ProviderEventSchema };
}
