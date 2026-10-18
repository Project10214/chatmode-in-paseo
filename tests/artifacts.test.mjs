import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ArtifactStore, ARTIFACT_LIMITS } from '../server/artifacts.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1cAAAAASUVORK5CYII=', 'base64');
function payload(bytes = png, mimeType = 'image/png', name = 'original.png') {
  return { digest:createHash('sha256').update(bytes).digest('hex'), bytes:bytes.length, mimeType, name, base64:bytes.toString('base64') };
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'cip-artifacts-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
  const directory = path.join(root,'blobs'); return { root, directory, store:new ArtifactStore(directory) };
}
async function all(store, meta) {
  let offset = 0; const parts = [];
  do { const chunk = await store.read(meta,{offset}); assert.ok(chunk.data.length <= ARTIFACT_LIMITS.chunk); parts.push(chunk.data); offset = chunk.nextOffset; } while (offset !== null);
  return Buffer.from(parts.join(''),'base64');
}

test('ART1 original PNG bytes survive exact round trip and store reconstruction (not WebP preview)',async t => {
  const {store,directory} = await setup(t), input = payload(), meta = await store.put(input);
  assert.equal(meta.mimeType,'image/png'); assert.equal(meta.width,1); assert.equal(meta.height,1);
  assert.equal(meta.base64,undefined); assert.deepEqual(await all(store,meta),png);
  assert.deepEqual(await all(new ArtifactStore(directory),meta),png);
  assert.deepEqual(await fs.readFile(path.join(directory,meta.digest+'.blob')),png);
  assert.equal((await fs.stat(path.join(directory,meta.digest+'.blob'))).mode & 0o777,0o600);
});
test('ART2 chunk upload/download preserves multi-chunk binary bytes including padding',async t => {
  const {store} = await setup(t), bytes = Buffer.alloc(100001); for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  const input = payload(bytes,'application/octet-stream','data.bin'), {uploadId} = store.begin(input);
  for(let offset=0;offset<input.base64.length;offset+=ARTIFACT_LIMITS.chunk) store.append(uploadId,{offset,data:input.base64.slice(offset,offset+ARTIFACT_LIMITS.chunk)});
  const meta = await store.commit(uploadId); assert.deepEqual(await all(store,meta),bytes);
  assert.deepEqual(await store.put(input),meta); // identical content is deduplicated
});
test('ART3 invalid digest, paths, names, MIME and size are rejected before writing',async t => {
  const {store,directory} = await setup(t);
  for(const change of [{digest:'../../secret'},{digest:'A'.repeat(64)},{bytes:0},{bytes:-1},{bytes:1.5},{bytes:ARTIFACT_LIMITS.bytes+1},{mimeType:'image/svg+xml'},{mimeType:'text/html'},{name:'../secret'},{name:'a\\b'},{name:'a\0b'},{name:'a\nb'},{name:'a:b'},{name:'..'},{name:'\u202esecret'}])
    await assert.rejects(store.put({...payload(),...change}),/ARTIFACT_/);
  await assert.rejects(fs.stat(directory),{code:'ENOENT'});
});
test('ART4 canonical base64, size and SHA are verified independently',async t => {
  const {store} = await setup(t), input = payload();
  for(const base64 of ['', '!!!!', input.base64+'\n', 'AB==', 'AAAA==='])await assert.rejects(store.put({...input,base64}),/ARTIFACT_DATA_INVALID/);
  await assert.rejects(store.put({...input,bytes:input.bytes+1}),/ARTIFACT_SIZE_MISMATCH/);
  await assert.rejects(store.put({...input,digest:'0'.repeat(64)}),/ARTIFACT_HASH_MISMATCH/);
});
test('ART5 signature/MIME mismatch, invalid UTF-8 and invalid JSON fail closed',async t => {
  const {store} = await setup(t);
  for(const type of ['image/jpeg','image/webp','image/gif','application/pdf','application/zip','text/plain','application/json'])
    await assert.rejects(store.put(payload(png,type)),/ARTIFACT_MIME_MISMATCH/);
  await assert.rejects(store.put(payload(Buffer.from([255]),'text/plain','text.txt')),/ARTIFACT_MIME_MISMATCH/);
  await assert.rejects(store.put(payload(Buffer.from('{broken'),'application/json','data.json')),/ARTIFACT_MIME_MISMATCH/);
  const bytes = Buffer.from('你好\nline two\r\n'); assert.deepEqual(await all(store,await store.put(payload(bytes,'text/plain','字节.txt'))),bytes);
});
test('ART6 upload bounds, order, replay, padding and incomplete commits are refused',async t => {
  const {store} = await setup(t), input = payload(Buffer.alloc(60000),'application/octet-stream','file.bin');
  let {uploadId} = store.begin(input);
  assert.throws(()=>store.append(uploadId,{offset:4,data:'AAAA'}),/OFFSET_INVALID/);
  assert.throws(()=>store.append(uploadId,{offset:0,data:'A'.repeat(ARTIFACT_LIMITS.chunk+4)}),/DATA_INVALID/);
  assert.throws(()=>store.append(uploadId,{offset:0,data:'AA=='}),/SIZE_MISMATCH/);
  assert.throws(()=>store.append(uploadId,{offset:0,data:'AAAA'}),/CHUNK_SIZE_INVALID/);
  store.append(uploadId,{offset:0,data:input.base64.slice(0,ARTIFACT_LIMITS.chunk)});
  assert.throws(()=>store.append(uploadId,{offset:0,data:'AAAA'}),/OFFSET_INVALID/);
  await assert.rejects(store.commit(uploadId),/INCOMPLETE/);
  assert.throws(()=>store.append(uploadId,{offset:4,data:'AAAA'}),/UPLOAD_UNKNOWN/);
  ({uploadId} = store.begin(payload())); store.abort(uploadId); await assert.rejects(store.commit(uploadId),/UPLOAD_UNKNOWN/);
  store.begin(payload());store.begin(payload());assert.throws(()=>store.begin(payload()),/UPLOAD_LIMIT/);
});
test('ART7 incorrect uploaded digest is never published and aborted slots are reusable',async t => {
  const {store,directory} = await setup(t), input = {...payload(),digest:'0'.repeat(64)}, {uploadId} = store.begin(input);
  store.append(uploadId,{offset:0,data:input.base64}); await assert.rejects(store.commit(uploadId),/HASH_MISMATCH/);
  await assert.rejects(fs.stat(directory),{code:'ENOENT'});
  const next = store.begin(payload());store.abort(next.uploadId);
});
test('ART8 aligned read offsets only; metadata size/MIME and hash are revalidated',async t => {
  const {store} = await setup(t), meta = await store.put(payload());
  for(const offset of [-4,1,2,Infinity,NaN,4*Math.ceil(meta.bytes/3)]) await assert.rejects(store.read(meta,{offset}),/OFFSET_INVALID/);
  await assert.rejects(store.read({...meta,digest:'../x'}),/HASH_INVALID/);
  await assert.rejects(store.read({...meta,bytes:meta.bytes+1}),/PATH_UNSAFE/);
  await assert.rejects(store.read({...meta,mimeType:'application/pdf'}),/MIME_MISMATCH/);
});
test('ART9 corruption and symlink/hardlink substitution cannot be read or deduplicated',async t => {
  const {store,directory,root} = await setup(t), input = payload(), meta = await store.put(input), target = path.join(directory,meta.digest+'.blob');
  await fs.writeFile(target,Buffer.alloc(meta.bytes)); await assert.rejects(store.read(meta),/HASH_MISMATCH/); await assert.rejects(store.put(input),/HASH_MISMATCH/);
  await fs.rm(target); const outside = path.join(root,'outside'); await fs.writeFile(outside,png); await fs.symlink(outside,target);
  await assert.rejects(store.read(meta),/PATH_UNSAFE/); await assert.rejects(store.put(input),/PATH_UNSAFE/);
  await fs.rm(target); await fs.link(outside,target); await assert.rejects(store.read(meta),/PATH_UNSAFE/);
});
test('ART11 header dimensions come from stored bytes, not caller labels (not full decoder validation)',async t => {
  const {store} = await setup(t);
  const gif = Buffer.from('47494638396103000200000000','hex');
  const jpeg = Buffer.from('ffd8ffc00008080002000300ffd9','hex');
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22,4); webp.write('WEBPVP8X',8); webp.writeUInt32LE(10,16); webp.writeUIntLE(2,24,3); webp.writeUIntLE(1,27,3);
  for(const [bytes,mime] of [[gif,'image/gif'],[jpeg,'image/jpeg'],[webp,'image/webp']]) {
    const meta = await store.put({...payload(bytes,mime,'image.bin'),width:999,height:999});
    assert.equal(meta.width,3); assert.equal(meta.height,2); assert.deepEqual(await all(store,meta),bytes);
  }
});
test('ART10 directory symlink and disk quota rejected',async t => {
  const {store,directory,root} = await setup(t), outside = path.join(root,'outside'); await fs.mkdir(outside); await fs.symlink(outside,directory);
  await assert.rejects(store.put(payload()),/PATH_UNSAFE/); await fs.rm(directory); await fs.mkdir(directory);
  const file = await fs.open(path.join(directory,'quota.blob'),'w'); await file.truncate(ARTIFACT_LIMITS.disk); await file.close();
  await assert.rejects(store.put(payload()),/STORAGE_FULL/);
});
test('ART12 retrieval has no active-turn dependency; expired upload does not remove completed blobs',async t => {
  const {store,directory} = await setup(t), meta = await store.put(payload());
  const {uploadId} = store.begin(payload()); store.uploads.get(uploadId).created -= ARTIFACT_LIMITS.lifetime+1;
  await assert.rejects(store.commit(uploadId),/UPLOAD_UNKNOWN/);
  // Storage-unit scope only: no real Broker/SDK authorization is exercised here.
  // Its caller may retrieve an authorized history row after the turn has ended.
  const endedHistory = { turn:{outcome:'completed'}, artifact:meta };
  assert.deepEqual(await all(new ArtifactStore(directory),endedHistory.artifact),png);
});
// These are pinned public SDK declaration/source audits, not client runtime
// download tests. A future SDK upgrade requires re-auditing this boundary.
test('ART13 audited public SDK exposes an HTTP(S) opener, not a file-save contract',async () => {
  const source = async name => fs.readFile(new URL('../node_modules/@getpaseo/plugin/'+name,import.meta.url),'utf8');
  const pkg = JSON.parse(await source('package.json'));
  assert.equal(pkg.version,'0.12.0-beta.2','SDK changed: re-audit public file-save support before updating this evidence');
  const entry = await source('dist/client/index.d.ts'), context = await source('dist/client/contracts.d.ts');
  assert.match(entry,/Open an absolute HTTP\(S\) URL/);
  assert.match(entry,/openExternalUrl\(url: string\): Promise<void>/);
  assert.doesNotMatch(entry+context,/\b(?:saveFile|downloadFile|saveBlob|downloadBlob|saveArtifact|downloadArtifact)\b/);
});
test('ART14 preview/conversation links are not presented as original-file downloads',async () => {
  const image = await fs.readFile(new URL('../client/generated-image.tsx',import.meta.url),'utf8');
  assert.match(image,/openExternalUrl\('https:\/\/chatgpt\.com\/c\/'\+image\.conversationId\)/);
  assert.match(image,/button\('打开原对话'/);
  assert.match(image,/压缩预览，非原文件/);
  assert.doesNotMatch(image,/button\('(?:查看原图|下载[^']*)'/);
  const file = await fs.readFile(new URL('../client/generated-file.tsx',import.meta.url),'utf8');
  assert.match(file,/当前环境不支持文件下载/);
  assert.match(file,/已请求浏览器下载，保存结果由客户端决定/);
  assert.doesNotMatch(file,/userAgent|maxTouchPoints|下载完成|保存成功/);
});
test('ART15 maximum-size original survives storage without base64 regexp stack overflow',async t => {
  const {store,directory} = await setup(t), bytes = Buffer.alloc(ARTIFACT_LIMITS.bytes,0xa5);
  const input = payload(bytes,'application/octet-stream','maximum.bin'),meta = await store.put(input);
  assert.deepEqual(await fs.readFile(path.join(directory,meta.digest+'.blob')),bytes);
  const offset = Math.floor((input.base64.length-1)/ARTIFACT_LIMITS.chunk)*ARTIFACT_LIMITS.chunk;
  const last = await store.read(meta,{offset});
  assert.equal(last.data,input.base64.slice(offset));assert.equal(last.nextOffset,null);
});
test('ART16 shipped Web helper is safe without a DOM; canonical base64 decoder handles full size',async () => {
  const {default:ts} = await import('typescript');
  const source = await fs.readFile(new URL('../client/generated-file.tsx',import.meta.url),'utf8');
  const block = source.split('// BEGIN STANDARD WEB ARTIFACT DOWNLOAD')[1].split('// END STANDARD WEB ARTIFACT DOWNLOAD')[0];
  const code = ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  assert.doesNotMatch(code,/require\(/); // self-contained standard capabilities only
  const helpers = {}; new Function('exports',code)(helpers);
  assert.equal(helpers.supportsArtifactBrowserDownload('web'),false);
  assert.equal(helpers.supportsArtifactBrowserDownload('ios'),false);
  assert.equal(helpers.supportsArtifactBrowserDownload('android'),false);
  await assert.rejects(helpers.prepareArtifactBrowserDownload(payload(),png.toString('base64'),'web'),/DOWNLOAD_UNSUPPORTED/);
  for(const encoded of ['AB==','AAB=','!!!!','AA===','A==='])assert.throws(()=>helpers.decodeArtifactBase64(encoded,1),/ARTIFACT_/);
  const bytes = Buffer.alloc(ARTIFACT_LIMITS.bytes,0xa5);
  assert.deepEqual(Buffer.from(helpers.decodeArtifactBase64(bytes.toString('base64'),bytes.length)),bytes);
});
test('ART17 one resource schema distinguishes provenance, nullable native IDs and literal source text',async () => {
  const [{default:ts},sdk,zod] = await Promise.all([import('typescript'),import('@getpaseo/plugin'),import('zod')]);
  const source = await fs.readFile(new URL('../shared/artifacts.ts',import.meta.url),'utf8');
  const code = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const exported = {};new Function('require','exports',code)(name=>name==='zod'?zod:name==='@getpaseo/plugin'?sdk:null,exported);
  const data={sessionId:'session-a',sourceId:'dom:picture',sourceText:'网页描述\n原样保留 🖼',conversationId:'conversation-fixture',kind:'image',messageId:null,assetId:null,
    provenance:'visible-image-resource',status:'available',resource:payload()};
  const parsed=exported.artifactCardSchema.parse(data);assert.equal(parsed.messageId,null);assert.equal(parsed.assetId,null);assert.equal(parsed.sourceText,data.sourceText);
  assert.equal(exported.artifactCardSchema.parse({...data,provenance:'rendered-preview'}).provenance,'rendered-preview');
  for(const patch of [{provenance:'native-original'},{kind:'file'},{provenance:'guessed-original'},{resource:undefined,original:payload()},{sourceText:undefined}])
    assert.equal(exported.artifactCardSchema.safeParse({...data,...patch}).success,false);
  const client=await fs.readFile(new URL('../client/generated-file.tsx',import.meta.url),'utf8');
  assert.match(client,/artifact\.provenance === 'native-original' \? '原文件'/);assert.match(client,/'网页显示图片' : '预览图'/);
  assert.match(client,/\{artifact\.sourceText\}/);assert.doesNotMatch(client,/artifact\.original/);
});
