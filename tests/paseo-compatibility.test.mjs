/** Real Paseo requirement validator, not a hand-written semver approximation.
 * Load eligibility does NOT certify recovery, delivery, persistence or display.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertPluginCompatibility } from '@getpaseo/protocol/plugin-requirements';
const manifest=JSON.parse(await readFile(new URL('../paseo-plugin.json',import.meta.url),'utf8'));
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const check=(version,runtime='daemon',requirements=manifest.requirements)=>assertPluginCompatibility({id:manifest.id,requirements,version,runtime});

test('compat: the installed old range explains the 0.12.0-beta.1 load failure',()=>{
 assert.throws(()=>check('0.12.0-beta.1','daemon',{paseo:'>=0.11.2 <0.12.0'}),/requires Paseo.*Your daemon is 0\.12\.0-beta\.1/);
});
test('compat: the alpha.4.25 range explains the 0.12.0-beta.2 load failure (2026-10-18)',()=>{
 assert.throws(()=>check('0.12.0-beta.2','daemon',{paseo:'>=0.11.4 <0.12.0 || =0.12.0-beta.1'}),/requires Paseo.*Your daemon is 0\.12\.0-beta\.2/);
});
// User decision 2026-10-18: Paseo auto-updates on restart, so every later
// version (betas included) loads. Protocol negotiation (v1) and the installed
// SDK's event schema still turn an interface change into a visible error;
// each Paseo update is audited after the fact (docs/PASEO_012_COMPATIBILITY.md).
test('compat: every audited and every later Paseo version loads on daemon AND app',()=>{
 for(const version of ['0.11.4','0.12.0-beta.1','0.12.0-beta.2','0.12.0-beta.3','0.12.0','0.12.5','0.13.0-beta.1','1.0.0'])
  for(const runtime of ['daemon','app'])assert.doesNotThrow(()=>check(version,runtime),version+' '+runtime);
});
test('compat: versions before the supported baseline and unknown runtimes are still refused',()=>{
 // Paseo judges a prerelease by its stable core, so 0.11.4-beta.x loads like 0.11.4.
 for(const version of ['0.11.3','0.11.3-beta.1','0.10.0',null])assert.throws(()=>check(version),undefined,String(version));
});
test('compat: all declared and installed Paseo SDK packages target the audited beta',async()=>{
 for(const name of ['@getpaseo/plugin','@getpaseo/client','@getpaseo/protocol']){
  assert.equal(pkg.devDependencies[name],'0.12.0-beta.2',name+' declaration');
  const entry=import.meta.resolve(name==='@getpaseo/protocol'?name+'/plugin-requirements':name);
  const installed=JSON.parse(await readFile(new URL('../package.json',entry),'utf8'));
  assert.equal(installed.version,'0.12.0-beta.2',name+' actual dependency');
 }
});
