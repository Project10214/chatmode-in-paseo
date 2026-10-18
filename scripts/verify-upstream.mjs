// Integrity/traceability check, not a claim of byte-identical whole upstream files or live validation.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const p=JSON.parse(await readFile(path.join(root,'vendor/cos/provenance.json'),'utf8'));
const m=JSON.parse(await readFile(path.join(root,'extension/manifest.json'),'utf8'));
assert.equal(p.commit,'ccd23b66cecf2f684fa3e12ca190297be02842cf');
assert.match(await readFile(path.join(root,'vendor/cos/LICENSE'),'utf8'),/Copyright \(c\) 2026 Chat On Steroids contributors/);
for(const f of p.files){
 const text=await readFile(path.join(root,f.localPath),'utf8');
 assert.equal(createHash('sha256').update(text).digest('hex'),f.localSha256,`Unrecorded upstream adaptation: ${f.localPath}`);
 if(f.world==='SERVER'){
  assert.equal(f.localPath,'shared/public-prose.mjs');
  assert.equal(f.importedBy,'server/message-delivery.mjs');
  const consumer=await readFile(path.join(root,f.importedBy),'utf8');
  assert(consumer.includes("from '../shared/public-prose.mjs'")&&consumer.includes('decoded = decodePublicProse('),'Receiver decoder must be imported AND used');
 }else{
  assert(['MAIN','ISOLATED'].includes(f.world),'Unknown runtime');
  const manifestPath=f.localPath.replace(/^extension\//,'');
  assert(m.content_scripts.some(e=>(e.world??'ISOLATED')===f.world&&e.js.includes(manifestPath)&&(!f.runAt||e.run_at===f.runAt)),`Not loaded in expected world/start timing: ${f.localPath}`);
 }
 for(const name of f.sourceFunctions)assert.match(text,new RegExp(`function ${name}\\(`),`Missing transplanted function ${name}`);
 // Some pinned CoS helpers are const arrow functions; record that source shape
 // explicitly rather than forcing a declaration rewrite or skipping name checks.
 for(const name of f.sourceArrowFunctions??[]){
  assert.match(name,/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  assert.match(text,new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\([^)]*\\)\\s*=>`),`Missing transplanted arrow function ${name}`);
 }
}
console.log(`PASS: ${p.files.length} active source-derived modules, recorded hashes, MIT notice and manifest worlds verified.`);
console.log('Function excerpts contain documented adaptations; no whole-file upstream equivalence or live-host claim.');
