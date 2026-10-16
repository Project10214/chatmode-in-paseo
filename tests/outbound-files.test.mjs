import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, webcrypto, randomUUID } from 'node:crypto';
import { InputFileStore, INPUT_LIMITS, uploadAllowance } from '../server/input-files.mjs';
import { CAPABILITIES } from '../server/provider.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YkCvYoAAAAASUVORK5CYII=','base64');
const PDF=Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >>\n%%EOF\n');
const sha=b=>createHash('sha256').update(b).digest('hex');
const image=()=>({type:'image',data:PNG.toString('base64'),mimeType:'image/png'});
async function store(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cip-files-test-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return {dir,files:new InputFileStore(path.join(dir,'input-files'))};
}
test('FILE1 SDK image capability and direct image + PDF staging with no bytes in command descriptors',async t=>{
 assert(CAPABILITIES.includes('prompt.image'));
 const {dir,files}=await store(t),pdf=path.join(dir,'report.pdf');
 await fs.writeFile(pdf,PDF);
 const command=randomUUID();
 const list=await files.stage(command,[image(),{type:'uploaded_file',id:'test',fileName:'report.pdf',mimeType:'application/pdf',size:PDF.length,path:pdf}]);
 assert.deepEqual(list.map(x=>x.fileName),['paseo-image-1.png','report.pdf']);
 assert.deepEqual(list.map(x=>x.sha256),[sha(PNG),sha(PDF)]);
 assert.deepEqual(list.map(x=>x.uploadKind),['image','file'],'CoS native route is based on original Paseo part type');
 assert(!JSON.stringify(list).includes(PNG.toString('base64')));
 for(let i=0;i<list.length;i++){
   const chunk=await files.read(command,i,0,list[i]);
   assert.deepEqual(Buffer.from(chunk.data,'base64'),[PNG,PDF][i]);
 }
 await files.remove(command);
 await assert.rejects(files.read(command,0,0,list[0]),/ATTACHMENT_EXPIRED/);
});
test('FILE2 reject bogus image, masquerading PDF, unsupported executable and symlink',async t=>{
 const {dir,files}=await store(t);
 const outside=path.join(dir,'outside.pdf');await fs.writeFile(outside,PDF);
 const link=path.join(dir,'linked.pdf');await fs.symlink(outside,link);
 const badPdf=path.join(dir,'bad.pdf');await fs.writeFile(badPdf,Buffer.from('NOT A PDF'));
 const items=[
  {type:'image',mimeType:'image/png',data:Buffer.from('malformed').toString('base64')},
  {type:'uploaded_file',fileName:'bad.pdf',mimeType:'application/pdf',size:9,path:badPdf},
  {type:'uploaded_file',fileName:'malware.exe',mimeType:'application/octet-stream',size:PDF.length,path:outside},
  {type:'uploaded_file',fileName:'linked.pdf',mimeType:'application/pdf',size:PDF.length,path:link},
 ];
 for(const item of items)await assert.rejects(files.stage(randomUUID(),[item]),/ATTACHMENT_/);
});
test('FILE3 size limit and offset validation prevent unbounded reads',async t=>{
 const {files}=await store(t),id=randomUUID(),list=await files.stage(id,[image()]);
 await assert.rejects(files.read(id,0,1,list[0]),/ATTACHMENT_OFFSET_INVALID/);
 await assert.rejects(files.stage(randomUUID(),Array.from({length:INPUT_LIMITS.count+1},image)),/ATTACHMENT_COUNT_UNSUPPORTED/);
 await assert.rejects(files.stage(randomUUID(),[{type:'image',data:'A'.repeat(Math.ceil(INPUT_LIMITS.each*4/3)+100),mimeType:'image/png'}]),/ATTACHMENT_TOO_LARGE/);
 await files.remove(id);
});
test('FILE4 editor paste verifies SHA and exact remove-tile receipt, then removes only its own tiles',async()=>{
 const source=await fs.readFile(new URL('../extension/file-upload.js',import.meta.url),'utf8');
 let tiles=[],pasted=[];
 const input={files:[],getAttribute:()=>null,dispatchEvent(){assert.fail('a file input must never be used');}};
 const send={disabled:false,getAttribute:()=>null};
 const form={querySelectorAll:s=>s==='input[type="file"]'?[input]:
   s==='button[aria-label]'?tiles:s.includes('button[data-testid="send-button"]')?[send]:[],
   querySelector:()=>null};
 const box={isConnected:true,closest:s=>s==='form'?form:null,focus(){},dispatchEvent(e){
   assert.equal(e.type,'paste');pasted=e.clipboardData.files;e.defaultPrevented=true;
   tiles=pasted.map(f=>{const tile={getAttribute:k=>k==='aria-label'?'Remove file: '+f.name:null,
     closest:()=>null,parentElement:null,isConnected:true,
     click(){tile.isConnected=false;tiles=tiles.filter(x=>x!==tile);}};return tile;});
   return false;}};
 const userTile={getAttribute:k=>k==='aria-label'?'Remove file: user-notes.txt':null,
   closest:()=>null,parentElement:null,isConnected:true,click(){assert.fail('must not remove a user file');}};
 class DataTransfer{constructor(){const added=[];this.items={add:f=>added.push(f)};this.files=added;}}
 class File{constructor(chunks,name,props){this.bytes=Buffer.concat(chunks.map(c=>Buffer.from(c)));this.name=name;this.size=this.bytes.length;this.type=props.type;}}
 class ClipboardEvent{constructor(type,init){this.type=type;this.clipboardData=init.clipboardData;this.defaultPrevented=false;}}
 const context=vm.createContext({crypto:webcrypto,DataTransfer,File,ClipboardEvent,
   atob:s=>Buffer.from(s,'base64').toString('binary'),setTimeout,Buffer,Date,console});
 vm.runInContext(source,context);
 const metadata=[
   {fileName:'paseo-image-1.png',mimeType:'image/png',size:PNG.length,sha256:sha(PNG),uploadKind:'image'},
   {fileName:'report.pdf',mimeType:'application/pdf',size:PDF.length,sha256:sha(PDF),uploadKind:'file'}];
 const read=async req=>{const bytes=[PNG,PDF][req.index].subarray(req.offset,req.offset+INPUT_LIMITS.chunk);
   return {data:bytes.toString('base64'),offset:req.offset,total:metadata[req.index].size,sha256:metadata[req.index].sha256};};
 const upload=await context.CIP_UPLOAD.attach({id:randomUUID(),lease:'l',documentKey:'d',payload:{files:metadata}},box,read,()=>{},Date.now()+60000);
 assert.equal(upload.proof(),true);
 assert.deepEqual(pasted.map(x=>x.name),metadata.map(x=>x.fileName));
 assert.deepEqual(pasted.map(x=>x.bytes),[PNG,PDF]);
 tiles=[...tiles,userTile];
 assert.throws(()=>upload.proof(),/ATTACHMENT_EXTRA_CHANGED/);
 assert.equal(await upload.remove(),true);
 assert.deepEqual(tiles,[userTile]);
 tiles=[];
 assert.throws(()=>upload.proof(),/ATTACHMENT_REMOVED/);
});
test('FILE5 integrity mismatch is refused before pasting anything',async()=>{
 const source=await fs.readFile(new URL('../extension/file-upload.js',import.meta.url),'utf8');
 let pastes=0;
 const form={querySelectorAll:()=>[],querySelector:()=>null};
 const box={isConnected:true,closest:()=>form,focus(){},dispatchEvent(){pastes++;}};
 const context=vm.createContext({crypto:webcrypto,DataTransfer:class{},File:class{},ClipboardEvent:class{},
   atob:s=>Buffer.from(s,'base64').toString('binary'),document:{querySelectorAll:()=>[]},setTimeout});
 vm.runInContext(source,context);
 const metadata={fileName:'pic.png',mimeType:'image/png',size:PNG.length,sha256:'0'.repeat(64),uploadKind:'image'};
 await assert.rejects(context.CIP_UPLOAD.attach({id:'cmd',lease:'l',documentKey:'d',payload:{files:[metadata]}},box,
   async()=>({data:PNG.toString('base64'),offset:0,total:PNG.length,sha256:metadata.sha256}),()=>{},Date.now()+60000),
   /ATTACHMENT_INTEGRITY_FAILED/);
 assert.equal(pastes,0);
});
test('FILE6 Broker stages only descriptors in a one-shot Send; wrong lease cannot download',async t=>{
 const {fixture}=await import('./helpers.mjs');
 const f=await fixture(t),s=await f.ready({model:'m1',thinkingOption:'standard',appIds:[]});
 const pdf=path.join(f.directory,'private.pdf');
 await fs.writeFile(pdf,PDF);
 const options={attachments:[image(),{type:'uploaded_file',id:'doc',fileName:'private.pdf',mimeType:'application/pdf',size:PDF.length,path:pdf}]};
 const dispatched=await f.broker.prompt(s.id,'file-unique-1','Please review the files',options);
 const c=f.broker.queued().find(c=>c.kind==='send');
 assert(c && c.payload.files.length===2);
 assert.equal(c.payload.files[1].fileName,'private.pdf');
 assert(!JSON.stringify(c).includes(pdf) && !JSON.stringify(c).includes(PDF.toString('base64')));
 // A file Send gets upload time on top of the plain command budget.
 assert.equal(c.deadline-c.createdAt,f.broker.commandTimeout+uploadAllowance(c.payload.files));
 const claim=await f.broker.claim(c.id,s.tabId,s.documentKey);
 const good=await f.broker.readInputChunk({id:c.id,lease:claim.lease,documentKey:s.documentKey,index:1,offset:0});
 assert.deepEqual(Buffer.from(good.data,'base64'),PDF);
 await assert.rejects(f.broker.readInputChunk({id:c.id,lease:'different',documentKey:s.documentKey,index:1,offset:0}),/ATTACHMENT_NOT_AUTHORIZED/);
 assert(dispatched.turnId);
});
test('FILE7 attachment-only native turn is admitted with an empty text body',async t=>{
 const {fixture}=await import('./helpers.mjs');
 const f=await fixture(t),s=await f.ready({model:'m1',thinkingOption:'standard',appIds:[]});
 await f.broker.prompt(s.id,'file-only','',{attachments:[image()]});
 const c=f.broker.queued().find(c=>c.kind==='send');
 assert(c && c.payload.text==='' && c.payload.files.length===1);
 assert.equal(f.broker.snapshot(s.id).history.at(-1).text,'');
});

test('FILE8 real loopback runtime never exposes file Send to old Chrome and requires exact claim for chunks',async t=>{
 const {createRuntime}=await import('../server/runtime.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cip-upload-http-'));
 const runtime=await createRuntime({directory:dir,port:0});
 t.after(async()=>{await runtime.close();await fs.rm(dir,{recursive:true,force:true});});
 const code=JSON.parse(await fs.readFile(path.join(dir,'pairing.json'),'utf8')).code;
 const ext='a'.repeat(32);
 const pair=await fetch(runtime.address+'/pair',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({code,extensionId:ext})});
 assert.equal(pair.status,200);
 const {token}=await pair.json();
 const headers={'Authorization':'Bearer '+token,'X-CIP-Extension':ext};
 const get=async supported=>{
   const r=await fetch(runtime.address+'/commands',{headers:{...headers,...(supported?{'X-CIP-Features':'files-v2'}:{})}});
   assert.equal(r.status,200);
   return (await r.json()).commands;
 };
 const c=await runtime.broker.enqueue('send',null,{text:'Inspect files',files:[]});
 const descriptors=await runtime.broker.inputFiles.stage(c.id,[image()]);
 await runtime.store.transaction(d=>{d.commands[c.id].payload.files=descriptors;});
 assert.equal((await get(false)).length,0,'old version must not silently send text only');
 const oldChrome=await fetch(runtime.address+'/commands',{
   headers:{...headers,'X-CIP-Features':'files-v1'}});
 assert.equal(oldChrome.status,200);
 assert.equal((await oldChrome.json()).commands.length,0,
   'files-v1 may not claim descriptors with the new image/file origin field');
 assert.equal((await get(true)).length,1);
 async function post(route,data,supported=true){
   const r=await fetch(runtime.address+route,{method:'POST',
     headers:{...headers,'Content-Type':'application/json',...(supported?{'X-CIP-Features':'files-v2'}:{})},body:JSON.stringify(data)});
   return {status:r.status,value:await r.json()};
 }
 const noFeature=await post('/claim',{id:c.id,tabId:101,documentKey:'doc-1'},false);
 assert.equal(noFeature.value.error,'ATTACHMENT_FEATURE_REQUIRED');
 const claim=await post('/claim',{id:c.id,tabId:101,documentKey:'doc-1'});
 assert.equal(claim.status,200);
 const lease=claim.value.lease;
 const wrong=await post('/input-chunk',{id:c.id,lease:'incorrect',documentKey:'doc-1',index:0,offset:0});
 assert.equal(wrong.value.error,'ATTACHMENT_NOT_AUTHORIZED');
 const correct=await post('/input-chunk',{id:c.id,lease,documentKey:'doc-1',index:0,offset:0});
 assert.equal(correct.status,200);
 assert.deepEqual(Buffer.from(correct.value.data,'base64'),PNG);
});

test('FILE9 two different files with the same visible filename are refused before Send',async t=>{
 const {dir,files}=await store(t),first=path.join(dir,'first.pdf'),second=path.join(dir,'second.pdf');
 await fs.writeFile(first,PDF);await fs.writeFile(second,PDF);
 const id=randomUUID();
 await assert.rejects(files.stage(id,[
   {type:'uploaded_file',fileName:'report.pdf',mimeType:'application/pdf',size:PDF.length,path:first},
   {type:'uploaded_file',fileName:'REPORT.PDF',mimeType:'application/pdf',size:PDF.length,path:second}
 ]),/ATTACHMENT_NAME_AMBIGUOUS/);
 await assert.rejects(files.read(id,0,0,{size:PDF.length}),/ATTACHMENT_EXPIRED/);
});
test('FILE10 upload allowance grows with total size and is capped near five minutes',()=>{
 const mb=n=>({size:n*1024*1024});
 assert.equal(uploadAllowance([{size:1}]),70000);
 assert.equal(uploadAllowance([mb(3.8)]),100000);
 assert.equal(uploadAllowance([mb(12),mb(12)]),210000);
 assert(90000+uploadAllowance([mb(12),mb(12)])<=300000);
});
