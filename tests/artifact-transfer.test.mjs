import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { ArtifactStore } from '../server/artifacts.mjs';
import { createArtifactTransfer } from '../server/artifact-transfer.mjs';
import { ensureObservation, resetObservationDocument } from '../server/continuous-observation.mjs';
import { reconcileSources } from '../server/source-ledger.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1cAAAAASUVORK5CYII=','base64');
const metadata = (bytes=png,mimeType='image/png',name='original.png') => ({digest:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mimeType,name});
const source = (id='image-source',kind='image',extra={}) => ({id,userMessageId:null,role:'assistant',lane:'output',kind,
  nativeMessageId:'native-image-1',text:'visible source',format:'text',order:[0],
  media:{assetId:'file_fixture_original_1',messageId:'native-image-1',kind,provenance:'native-original'},...extra});
const deferred = () => {let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const until = async fn => {for(let i=0;i<500;i++){const value=fn();if(value)return value;await new Promise(done=>setTimeout(done,2));}throw Error('Fixture wait timed out');};
const script = await fs.readFile(new URL('../extension/artifact-transfer.js',import.meta.url),'utf8');

async function fixture(t,{item=source(),outcome='completed',page='standby'}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cip-artifact-transfer-'));
  const store=await new Store(path.join(directory,'state')).open(),artifacts=new ArtifactStore(path.join(directory,'blobs')),events=[],cleanup=[];
  const session={id:'session-a',tabId:91,documentKey:'document-a',conversationId:'conversation-fixture',status:'idle',history:[],turn:{outcome}};
  ensureObservation(session);session.observation.page={state:page};reconcileSources(session,[item]);
  await store.transaction(data=>{data.sessions[session.id]=session;});
  const transfer=createArtifactTransfer({store,artifacts,emit:event=>events.push(structuredClone(event))});
  const binding=()=>{const s=store.read().sessions['session-a'];return {sessionId:s.id,observationLease:s.observation.lease,tabId:s.tabId,documentKey:s.documentKey,url:'https://chatgpt.com/c/'+s.conversationId,conversationId:s.conversationId};};
  const event=(extra={})=>({...binding(),sourceId:item.id,provenance:item.media.provenance,...extra});
  const dispatch=request=>{
    const method={'artifact-begin':'begin','artifact-chunk':'chunk','artifact-commit':'commit','artifact-unsupported':'unsupported'}[request.type];
    assert.ok(method,'known RPC type');return transfer[method](structuredClone(request));
  };
  t.after(async()=>{for(const close of cleanup)await close();await store.flush();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,store,artifacts,events,transfer,binding,event,dispatch,item,cleanup};
}
async function upload(f,{bytes=png,mimeType='image/png',name='original.png',transfer=f.transfer,event=f.event()}={}) {
  const meta=metadata(bytes,mimeType,name),begin=await transfer.begin({...event,metadata:meta}),encoded=bytes.toString('base64');
  const chunks=[];
  for(let offset=0;offset<encoded.length;offset+=32768){const request={...event,uploadId:begin.uploadId,offset,data:encoded.slice(offset,offset+32768)};chunks.push({request,receipt:await transfer.chunk(request)});}
  return {event,meta,begin,chunks,item:await transfer.commit({...event,uploadId:begin.uploadId})};
}
async function readAll(transfer,input) {
  const parts=[];let offset=0;
  do {const chunk=await transfer.read({...input,offset});parts.push(chunk.data);offset=chunk.nextOffset;}while(offset!==null);
  return Buffer.from(parts.join(''),'base64');
}
async function extension(f,{bytes=png,kind=f.item.kind,rpc=f.dispatch,capture,read,guard=()=>{},binding=f.binding}={}) {
  const captured=[],released=[],live=new Map();let now=Date.now(),sequence=0;
  const media={
    async captureOriginal(descriptor,check){check();captured.push(structuredClone(descriptor));const id='transfer-'+(++sequence);live.set(id,bytes.toString('base64'));
      const result=capture?await capture(descriptor,check,id):{status:'available',transferId:id,...metadata(bytes,kind==='image'?'image/png':'application/octet-stream',kind==='image'?'original.png':'original.bin')};
      if(result.status!=='available')live.delete(id);return {...result,provenance:result.provenance ?? descriptor.provenance};},
    readOriginal(id,offset,check){check();const encoded=live.get(id);assert.equal(typeof encoded,'string');const end=Math.min(encoded.length,offset+32768);
      const chunk={data:encoded.slice(offset,end),nextOffset:end<encoded.length?end:null,total:encoded.length};return read?read(chunk):chunk;},
    releaseOriginal(id){released.push(id);live.delete(id);}
  };
  const context=vm.createContext({URL,console,CIP_MEDIA:media,Date:class extends Date{static now(){return now;}},setTimeout:fn=>setTimeout(fn,0)});
  vm.runInContext(script,context,{filename:'extension/artifact-transfer.js'});
  const controller=context.CIP_ARTIFACT_TRANSFER.create({rpc,guard,binding});f.cleanup.push(()=>controller.dispose());
  return {controller,captured,released,live,advance:milliseconds=>{now+=milliseconds;}};
}

test('ATR1 ledger-derived identity and original bytes survive real Store/ArtifactStore reconstruction',async t=>{
  const f=await fixture(t),event=f.event({conversationId:'payload-is-not-proof',messageId:'forged',assetId:'file_forged_asset_1',kind:'file'});
  const sent=await upload(f,{event}),row=sent.item;
  assert.equal(row.id,'artifact:'+f.item.id);assert.equal(row.kind,'generated-file');assert.equal(row.version,1);
  assert.equal(row.data.conversationId,'conversation-fixture');assert.equal(row.data.messageId,f.item.media.messageId);
  assert.equal(row.data.assetId,f.item.media.assetId);assert.equal(row.data.kind,'image');assert.equal(row.data.resource.mimeType,'image/png');assert.equal(row.data.resource.width,1);
  const restoredStore=await new Store(f.store.directory).open();
  const restored=createArtifactTransfer({store:restoredStore,artifacts:new ArtifactStore(f.artifacts.directory)});
  assert.deepEqual(await readAll(restored,{sessionId:'session-a',sourceId:f.item.id,digest:sent.meta.digest}),png);
  assert.equal(f.events.length,1);assert.equal(f.events[0].id,'session-a');assert.equal(f.events[0].state,'artifact');
  assert.equal(JSON.stringify(restoredStore.read()).includes(png.toString('base64')),false,'no file bytes in state.json');
});
test('ATR2 begin/chunk/commit ACK retries are idempotent, conflicts fail and timeline emits once',async t=>{
  const f=await fixture(t,{item:source('file-source','file')}),bytes=Buffer.alloc(100001,0xab),meta=metadata(bytes,'application/octet-stream','raw.bin'),event=f.event();
  const begin=await f.transfer.begin({...event,metadata:meta});assert.deepEqual(await f.transfer.begin({...event,metadata:meta}),begin);
  const encoded=bytes.toString('base64'),requests=[];
  for(let offset=0;offset<encoded.length;offset+=32768){const request={...event,uploadId:begin.uploadId,offset,data:encoded.slice(offset,offset+32768)};requests.push(request);
    const first=await f.transfer.chunk(request);assert.deepEqual(await f.transfer.chunk(request),first);
    if(!offset)await assert.rejects(f.transfer.chunk({...request,data:'AAAA'+request.data.slice(4)}),/CHUNK_CONFLICT/);
  }
  const commit={...event,uploadId:begin.uploadId},rows=await Promise.all([f.transfer.commit(commit),f.transfer.commit(commit),f.transfer.commit(commit)]);
  assert.deepEqual(rows[0],rows[1]);assert.deepEqual(rows[1],rows[2]);assert.equal(f.events.length,1);
  assert.deepEqual(await f.transfer.chunk(requests[0]),await f.transfer.chunk(requests[0]));
  assert.equal(f.store.read().sessions['session-a'].history.length,1);
  assert.deepEqual(await readAll(f.transfer,{sessionId:'session-a',sourceId:f.item.id,digest:meta.digest}),bytes);
});
test('ATR3 all ingest methods reject stale leases, wrong tab/document/conversation and forged sources',async t=>{
  const f=await fixture(t),meta=metadata(),begin=await f.transfer.begin(f.event({metadata:meta}));
  for(const change of [{observationLease:'stale'},{tabId:999},{documentKey:'different'},{url:'https://chatgpt.com/c/different-conversation'}]){
    const event=f.event({...change,metadata:meta,uploadId:begin.uploadId,offset:0,data:png.toString('base64'),reason:'not-real'});
    for(const name of ['begin','chunk','commit','unsupported'])await assert.rejects(f.transfer[name](event),/OBSERVATION_LEASE_MISMATCH|PAGE_IDENTITY_MISMATCH/);
  }
  for(const sourceId of ['missing','__proto__'])for(const name of ['begin','unsupported'])await assert.rejects(f.transfer[name](f.event({sourceId,metadata:meta,reason:'native_source_unproven'})),/SOURCE_UNPROVEN/);
  await f.store.transaction(data=>{delete data.sessions['session-a'].sources[0].media.messageId;});
  await assert.rejects(f.transfer.begin(f.event({metadata:meta})),/INVALID_TEXT|SOURCE_UNPROVEN/);
  assert.equal(f.events.length,0);assert.equal(f.store.read().sessions['session-a'].history.length,0);
});
test('ATR4 upload ownership cannot cross sources or sessions',async t=>{
  const f=await fixture(t),begin=await f.transfer.begin(f.event({metadata:metadata()}));
  await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[source('other-source')]);
    const other=structuredClone(data.sessions['session-a']);other.id='session-b';ensureObservation(other);data.sessions[other.id]=other;});
  const request=f.event({uploadId:begin.uploadId,offset:0,data:png.toString('base64')});
  await assert.rejects(f.transfer.chunk({...request,sourceId:'other-source'}),/UPLOAD_OWNER_MISMATCH/);
  await assert.rejects(f.transfer.commit({...request,sessionId:'session-b'}),/UPLOAD_OWNER_MISMATCH/);
  assert.equal(f.events.length,0);
});
test('ATR5 rebind during asynchronous blob commit never writes history or emits stale resource',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();
  const artifacts={begin:x=>f.artifacts.begin(x),append:(...x)=>f.artifacts.append(...x),abort:x=>f.artifacts.abort(x),read:(...x)=>f.artifacts.read(...x),
    commit:async id=>{const meta=await f.artifacts.commit(id);entered.resolve();await release.promise;return meta;}};
  const transfer=createArtifactTransfer({store:f.store,artifacts,emit:event=>f.events.push(event)}),event=f.event();
  const begin=await transfer.begin({...event,metadata:metadata()});await transfer.chunk({...event,uploadId:begin.uploadId,offset:0,data:png.toString('base64')});
  const pending=transfer.commit({...event,uploadId:begin.uploadId});pending.catch(()=>{});await entered.promise;
  await f.store.transaction(data=>{resetObservationDocument(data.sessions['session-a'],92,'document-b');});release.resolve();
  await assert.rejects(pending,/OBSERVATION_LEASE_MISMATCH/);
  assert.equal(f.store.read().sessions['session-a'].history.length,0);assert.equal(f.events.length,0);
  await assert.rejects(transfer.read({sessionId:'session-a',sourceId:f.item.id,digest:metadata().digest}),/ARTIFACT_UNKNOWN/);
});
test('ATR6 every chunk rechecks after asynchronous append; source metadata revisions invalidate commits',async t=>{
  const f=await fixture(t),artifacts={begin:x=>f.artifacts.begin(x),abort:x=>f.artifacts.abort(x),commit:x=>f.artifacts.commit(x),read:(...x)=>f.artifacts.read(...x),
    append:async (...args)=>{const receipt=f.artifacts.append(...args);await f.store.transaction(data=>{resetObservationDocument(data.sessions['session-a'],92,'document-b');});return receipt;}};
  const transfer=createArtifactTransfer({store:f.store,artifacts}),event=f.event(),begin=await transfer.begin({...event,metadata:metadata()});
  await assert.rejects(transfer.chunk({...event,uploadId:begin.uploadId,offset:0,data:png.toString('base64')}),/LEASE_MISMATCH/);
  const fresh=f.event(),next=await f.transfer.begin({...fresh,metadata:metadata()});await f.transfer.chunk({...fresh,uploadId:next.uploadId,offset:0,data:png.toString('base64')});
  await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[{...f.item,media:{...f.item.media,resourceRevision:'changed'}}]);});
  await assert.rejects(f.transfer.commit({...fresh,uploadId:next.uploadId}),/SOURCE_CHANGED/);
  assert.equal(f.events.length,0);assert.equal(f.store.read().sessions['session-a'].history.length,0);
});
test('ATR7 source changes while committing are fenced even when lease/document did not change',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();
  const artifacts={begin:x=>f.artifacts.begin(x),append:(...x)=>f.artifacts.append(...x),abort:x=>f.artifacts.abort(x),read:(...x)=>f.artifacts.read(...x),commit:async id=>{const value=await f.artifacts.commit(id);entered.resolve();await release.promise;return value;}};
  const transfer=createArtifactTransfer({store:f.store,artifacts,emit:event=>f.events.push(event)}),event=f.event(),begin=await transfer.begin({...event,metadata:metadata()});
  await transfer.chunk({...event,uploadId:begin.uploadId,offset:0,data:png.toString('base64')});const committing=transfer.commit({...event,uploadId:begin.uploadId});committing.catch(()=>{});await entered.promise;
  await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[{...f.item,media:{...f.item.media,resourceRevision:'new'}}]);});release.resolve();
  await assert.rejects(committing,/SOURCE_CHANGED/);assert.equal(f.events.length,0);assert.equal(f.store.read().sessions['session-a'].history.length,0);
});
test('ATR8 unsupported reason is truthful/idempotent and cannot downgrade an available resource',async t=>{
  const f=await fixture(t),event=f.event({reason:'native_source_unproven'}),first=await f.transfer.unsupported(event);
  assert.equal(first.data.status,'unsupported');assert.equal(first.data.reason,'native_source_unproven');assert.equal(first.data.resource,undefined);
  assert.deepEqual(await f.transfer.unsupported(event),first);assert.equal(f.events.length,1);
  await assert.rejects(f.transfer.unsupported({...event,reason:'pretend_available'}),/REASON_INVALID/);
  const sent=await upload(f);assert.equal(f.events.length,2);
  assert.deepEqual(await f.transfer.unsupported({...event,reason:'resource_unavailable'}),sent.item);assert.equal(f.events.length,2);
  await f.store.transaction(data=>{data.sessions['session-a'].sources=[];});
  await assert.rejects(f.transfer.unsupported(event),/SOURCE_UNPROVEN/);
  assert.deepEqual(await readAll(f.transfer,{sessionId:'session-a',sourceId:f.item.id,digest:sent.meta.digest}),png);
});
test('ATR9 authorized history, not arbitrary digest/metadata or active turn, grants reads',async t=>{
  const f=await fixture(t),sent=await upload(f);
  for(const patch of [{digest:'0'.repeat(64)},{digest:'../secrets'},{sourceId:'other-source'},{sessionId:'no-session'}])
    await assert.rejects(f.transfer.read({sessionId:'session-a',sourceId:f.item.id,digest:sent.meta.digest,...patch}),/ARTIFACT_UNKNOWN|SESSION_UNKNOWN/);
  const chunk=await f.transfer.read({sessionId:'session-a',sourceId:f.item.id,digest:sent.meta.digest,metadata:metadata(Buffer.from('forged'),'application/octet-stream','fake.bin')});
  assert.deepEqual(Buffer.from(chunk.data,'base64'),png);assert.equal(chunk.mimeType,'image/png');
  await assert.rejects(f.transfer.read({sessionId:'session-a',sourceId:f.item.id,digest:sent.meta.digest,offset:1}),/OFFSET_INVALID/);
});
test('ATR10 standby, abnormal, ended/failed/canceled turns do not gate original transfer',async t=>{
  for(const [outcome,page] of [['completed','standby'],['failed','abnormal'],['canceled','standby'],[null,'running']]){
    const f=await fixture(t,{outcome,page}),sent=await upload(f);
    assert.deepEqual(await readAll(f.transfer,{sessionId:'session-a',sourceId:f.item.id,digest:sent.meta.digest}),png);
    assert.equal(f.store.read().sessions['session-a'].turn.outcome,outcome);
  }
});
test('ATR11 extension is nonblocking, serial, original-byte correct and idempotent after lost begin/chunk/commit ACKs',async t=>{
  const f=await fixture(t),lost=new Set(),calls=[],x=await extension(f,{rpc:async event=>{calls.push(structuredClone(event));const value=await f.dispatch(event);
    if(!lost.has(event.type)){lost.add(event.type);throw Object.assign(new Error('ACK lost'),{code:'ACK_LOST'});}return value;}});
  assert.equal(x.controller.observe([f.item]),undefined,'does not block text/control collection');
  await until(()=>x.released.length===1);assert.equal(f.events.length,1);assert.equal(x.captured.length,1);
  for(const type of ['artifact-begin','artifact-chunk','artifact-commit']){const matching=calls.filter(value=>value.type===type);assert.equal(matching.length,2);assert.deepEqual(matching[0],matching[1]);}
  for(let i=0;i<5;i++)x.controller.observe([f.item]);
  x.controller.observe([{...f.item,revision:'text-only-change',text:'Caption changed, resource metadata did not'}]);
  x.controller.observe([]);x.controller.observe([f.item]);
  await new Promise(done=>setTimeout(done,5));assert.equal(x.captured.length,1);assert.equal(f.events.length,1);
  assert.deepEqual(await readAll(f.transfer,{sessionId:'session-a',sourceId:f.item.id,digest:metadata().digest}),png);
});
test('ATR12 extension retries unsupported after backoff, visibility return or media changes, never fabricates IDs',async t=>{
  const f=await fixture(t);let attempts=0;
  const x=await extension(f,{capture:async (_d,_g,id)=>++attempts<4?{status:'unsupported',reason:'native_source_unproven'}:{status:'available',transferId:id,...metadata()}});
  x.controller.observe([{id:'unproven',kind:'image',media:{kind:'image',src:'https://evil.invalid/arbitrary'}}]);await new Promise(done=>setTimeout(done,5));assert.equal(x.captured.length,0);assert.equal(f.events.length,0);
  x.controller.observe([f.item]);await until(()=>attempts===1&&f.events.length===1);x.controller.observe([f.item]);await new Promise(done=>setTimeout(done,5));assert.equal(attempts,1);
  x.advance(31000);x.controller.observe([f.item]);await until(()=>attempts===2);
  x.controller.observe([]);x.controller.observe([f.item]);await until(()=>attempts===3);
  const changed={...f.item,media:{...f.item.media,resourceRevision:'new'}};await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[changed]);});
  x.controller.observe([changed]);await until(()=>x.released.length===1);assert.equal(attempts,4);assert.equal(f.events.at(-1).item.data.status,'available');
});
test('ATR13 extension binding loss/disposal releases the original transfer and sends no stale RPC',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();
  const x=await extension(f,{capture:async (_d,_g,id)=>{entered.resolve();await release.promise;return {status:'available',transferId:id,...metadata()};}});
  x.controller.observe([f.item]);await entered.promise;const closed=x.controller.dispose();release.resolve();await closed;
  assert.equal(x.released.length,1);assert.equal(x.live.size,0);assert.equal(f.events.length,0);assert.equal(f.artifacts.uploads.size,0);
  const y=await extension(f,{rpc:async event=>{const value=await f.dispatch(event);if(event.type==='artifact-begin')await f.store.transaction(data=>{resetObservationDocument(data.sessions['session-a'],92,'document-b');});return value;}});
  y.controller.observe([f.item]);await until(()=>y.released.length===1);assert.equal(f.events.length,0);assert.equal(f.store.read().sessions['session-a'].history.length,0);
});
test('ATR14 independent upload lane serializes multiple files, rejects invalid chunks and releases failures',async t=>{
  const item=source('file-a','file'),f=await fixture(t,{item}),other={...source('file-b','file'),media:{...item.media,assetId:'file_fixture_original_2'}};
  await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[other]);});
  const x=await extension(f,{bytes:Buffer.alloc(100001,0xa3)});x.controller.observe([item,other]);await until(()=>x.released.length===2);
  assert.equal(f.events.length,2);assert.equal(x.captured.length,2);assert.equal(x.live.size,0);
  assert.deepEqual(await readAll(f.transfer,{sessionId:'session-a',sourceId:other.id,digest:metadata(Buffer.alloc(100001,0xa3)).digest}),Buffer.alloc(100001,0xa3));
  const bad=await extension(f,{read:chunk=>({...chunk,nextOffset:4})});bad.controller.observe([item]);await until(()=>bad.released.length===1);
  assert.equal(f.events.length,2,'invalid chunks cannot become available');assert.equal(bad.live.size,0);
});
test('ATR15 incomplete commit preserves upload; rejected blob cannot poison a corrected begin/retry',async t=>{
  const f=await fixture(t),event=f.event(),meta=metadata();
  await assert.rejects(f.transfer.begin({...event,metadata:metadata(png,'application/pdf','fake.pdf')}),/MIME_MISMATCH/);
  const first=await f.transfer.begin({...event,metadata:meta});
  await assert.rejects(f.transfer.commit({...event,uploadId:first.uploadId}),/INCOMPLETE/);
  assert.ok(f.artifacts.uploads.has(first.uploadId));
  const corrupted=Buffer.from(png);corrupted[25]^=1;
  await f.transfer.chunk({...event,uploadId:first.uploadId,offset:0,data:corrupted.toString('base64')});
  await assert.rejects(f.transfer.commit({...event,uploadId:first.uploadId}),/HASH_MISMATCH/);
  assert.equal(f.events.length,0);assert.equal(f.store.read().sessions['session-a'].history.length,0);
  const second=await f.transfer.begin({...event,metadata:meta});assert.notEqual(second.uploadId,first.uploadId);
  await f.transfer.chunk({...event,uploadId:second.uploadId,offset:0,data:png.toString('base64')});
  const row=await f.transfer.commit({...event,uploadId:second.uploadId});assert.equal(row.data.status,'available');assert.equal(f.events.length,1);
});
test('ATR16 failed state persistence retries verified commit without consuming blob twice',async t=>{
  const f=await fixture(t);let fail=true,commits=0;
  const store={read:()=>f.store.read(),transaction:change=>{if(fail){fail=false;return Promise.reject(new Error('STATE_WRITE_FIXTURE'));}return f.store.transaction(change);}};
  const artifacts={begin:x=>f.artifacts.begin(x),append:(...x)=>f.artifacts.append(...x),abort:x=>f.artifacts.abort(x),read:(...x)=>f.artifacts.read(...x),commit:id=>{commits++;return f.artifacts.commit(id);}};
  const transfer=createArtifactTransfer({store,artifacts,emit:event=>f.events.push(event)}),event=f.event(),begun=await transfer.begin({...event,metadata:metadata()});
  await transfer.chunk({...event,uploadId:begun.uploadId,offset:0,data:png.toString('base64')});
  await assert.rejects(transfer.commit({...event,uploadId:begun.uploadId}),/STATE_WRITE_FIXTURE/);assert.equal(f.events.length,0);
  const row=await transfer.commit({...event,uploadId:begun.uploadId});assert.equal(row.data.status,'available');assert.equal(commits,1);assert.equal(f.events.length,1);
  assert.deepEqual(await transfer.commit({...event,uploadId:begun.uploadId}),row);assert.equal(f.events.length,1);
});
const localImage = (provenance='visible-image-resource') => source('dom-local-image','image',{nativeMessageId:undefined,text:'原描述\n保持原文 🖼',
  media:{kind:'image',provenance,messageId:null,assetId:null,src:'blob:https://chatgpt.com/visible-resource',resourceRevision:'resource-1'}});
test('ATR17 local source IDs preserve images without fake native IDs and prohibit provenance upgrades',async t=>{
  const f=await fixture(t,{item:localImage()}),sent=await upload(f);
  assert.equal(sent.item.data.messageId,null);assert.equal(sent.item.data.assetId,null);assert.equal(sent.item.data.provenance,'visible-image-resource');
  assert.equal(sent.item.data.sourceText,f.item.text);assert.equal(sent.item.data.original,undefined);assert.ok(sent.item.data.resource);
  assert.deepEqual(await readAll(f.transfer,{sessionId:'session-a',sourceId:f.item.id,digest:sent.meta.digest}),png);
  await assert.rejects(f.transfer.begin(f.event({metadata:metadata(),provenance:'native-original'})),/PROVENANCE_INVALID/);
  const preview=await fixture(t,{item:localImage('rendered-preview')});
  await assert.rejects(preview.transfer.begin(preview.event({metadata:metadata(),provenance:'visible-image-resource'})),/PROVENANCE_INVALID/);
  const native=await fixture(t),fallback=await upload(native,{event:native.event({provenance:'rendered-preview'})});
  assert.equal(fallback.item.data.provenance,'rendered-preview');assert.equal(fallback.item.data.assetId,native.item.media.assetId);
});
test('ATR18 caption/order/visibility changes while blob commits do not revoke bytes; real resource URL does',async t=>{
  const f=await fixture(t,{item:localImage()}),entered=deferred(),release=deferred();
  const artifacts={begin:x=>f.artifacts.begin(x),append:(...x)=>f.artifacts.append(...x),abort:x=>f.artifacts.abort(x),read:(...x)=>f.artifacts.read(...x),commit:async id=>{const value=await f.artifacts.commit(id);entered.resolve();await release.promise;return value;}};
  const transfer=createArtifactTransfer({store:f.store,artifacts,emit:event=>f.events.push(event)}),event=f.event(),begin=await transfer.begin({...event,metadata:metadata()});
  await transfer.chunk({...event,url:event.url+'?layout=changed#folded',uploadId:begin.uploadId,offset:0,data:png.toString('base64')});
  const pending=transfer.commit({...event,uploadId:begin.uploadId});pending.catch(()=>{});await entered.promise;
  const updated={...f.item,text:'新描述\n不能丢失',order:[999],media:{...f.item.media,alt:'updated description',visible:false,width:55}};
  await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[updated]);});release.resolve();
  const row=await pending;assert.equal(row.data.status,'available');assert.equal(row.data.sourceText,updated.text);assert.equal(f.events.length,1);
  const fresh=await f.transfer.begin(f.event({metadata:metadata(),provenance:'rendered-preview'}));
  await f.transfer.chunk(f.event({uploadId:fresh.uploadId,offset:0,data:png.toString('base64')}));
  await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[{...updated,media:{...updated.media,src:'blob:https://chatgpt.com/replaced-resource'}}]);});
  await assert.rejects(f.transfer.commit(f.event({uploadId:fresh.uploadId})),/SOURCE_CHANGED/);
});
test('ATR19 capture completion permits upload after omission/folding without recapture or native ID invention',async t=>{
  const f=await fixture(t,{item:localImage()}),entered=deferred(),release=deferred();
  const x=await extension(f,{rpc:async event=>{const result=await f.dispatch(event);if(event.type==='artifact-begin'){entered.resolve();await release.promise;}return result;}});
  x.controller.observe([f.item]);await entered.promise;x.controller.observe([]);
  const updated={...f.item,text:'折叠后的原文',order:[7],media:{...f.item.media,visible:false,alt:'same asset',width:100}};
  await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[updated]);});release.resolve();
  await until(()=>x.released.length===1);assert.equal(f.events.length,1);assert.equal(x.captured.length,1);
  assert.equal(f.events[0].item.data.messageId,null);assert.equal(f.events[0].item.data.assetId,null);assert.equal(f.events[0].item.data.sourceText,updated.text);
  x.controller.observe([updated]);await new Promise(done=>setTimeout(done,5));assert.equal(x.captured.length,1);
});
test('ATR20 placeholder upgrades in place to one generated-file row and preserves the ledger description',async t=>{
  for(const available of [true,false]){
    const f=await fixture(t,{item:localImage()}),placeholder={type:'plugin',pluginId:'chatmode-in-paseo',id:'artifact:'+f.item.id,kind:'page-source',version:1,data:{source:f.item}};
    await f.store.transaction(data=>{data.sessions['session-a'].history=[{id:'before',type:'assistant_message',text:'before'},placeholder,{id:'after',type:'assistant_message',text:'after'}];});
    const row=available?(await upload(f)).item:await f.transfer.unsupported(f.event({reason:'resource_unavailable'}));
    const history=f.store.read().sessions['session-a'].history;
    assert.equal(history.length,3);assert.equal(history[1].id,placeholder.id);assert.equal(history[1].kind,'generated-file');
    assert.deepEqual(history[1],row);assert.equal(row.data.sourceText,f.item.text);assert.equal(row.data.messageId,null);assert.equal(row.data.assetId,null);assert.equal(f.events.length,1);
  }
});
test('ATR21 same-asset fallbacks never downgrade available native/display-resource bytes; true revision may replace them',async t=>{
  const f=await fixture(t,{item:localImage()}),first=await upload(f),different=Buffer.from(png);different[25]^=1;
  const fallback=await upload(f,{bytes:different,event:f.event({provenance:'rendered-preview'})});
  assert.deepEqual(fallback.item,first.item);assert.equal(f.events.length,1);assert.equal(fallback.item.data.resource.digest,first.meta.digest);
  await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[{...f.item,media:{...f.item.media,resourceRevision:'resource-2'}}]);});
  const replaced=await upload(f,{bytes:different,event:f.event({provenance:'rendered-preview'})});
  assert.equal(replaced.item.data.provenance,'rendered-preview');assert.equal(replaced.item.data.resource.digest,metadata(different).digest);assert.equal(f.events.length,2);
});
test('ATR22 extension accepts a higher-quality cached row without treating the fallback as original',async t=>{
  const f=await fixture(t,{item:localImage()}),first=await upload(f),different=Buffer.from(png);different[25]^=1;
  const x=await extension(f,{bytes:different,capture:async (_d,_g,id)=>({status:'available',transferId:id,provenance:'rendered-preview',...metadata(different)})});
  x.controller.observe([f.item]);await until(()=>x.released.length===1);
  assert.equal(f.events.length,1);assert.deepEqual(f.store.read().sessions['session-a'].history[0],first.item);
  x.advance(31000);x.controller.observe([f.item]);await new Promise(done=>setTimeout(done,5));assert.equal(x.captured.length,1);
});
test('ATR23 file href belongs to the asset fence, while unrelated source description does not',async t=>{
  const item=source('file-href','file');item.media.href='https://chatgpt.com/backend-api/estuary/content?id='+item.media.assetId;
  const f=await fixture(t,{item}),event=f.event(),begun=await f.transfer.begin({...event,metadata:metadata()});
  await f.transfer.chunk({...event,uploadId:begun.uploadId,offset:0,data:png.toString('base64')});
  await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[{...item,text:'description only',order:[20]}]);});
  assert.deepEqual(await f.transfer.begin({...event,metadata:metadata()}),begun,'metadata/text revisions do not replace begin receipts');
  await f.store.transaction(data=>{reconcileSources(data.sessions['session-a'],[{...item,media:{...item.media,href:item.media.href+'&download=1'}}]);});
  await assert.rejects(f.transfer.commit({...event,uploadId:begun.uploadId}),/SOURCE_CHANGED/);assert.equal(f.events.length,0);
});

test('ATR24 folded media waits for visibility without reporting a fake unsupported resource',async t=>{
  const item=source();item.media.visible=false;
  const f=await fixture(t,{item}),e=await extension(f);
  e.controller.observe([item]);await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(e.captured.length,0);assert.equal(f.events.length,0);
  item.media.visible=true;e.controller.observe([item]);
  await until(()=>f.events.some(event=>event.item?.data.status==='available'));
  assert.equal(e.captured.length,1);
});
