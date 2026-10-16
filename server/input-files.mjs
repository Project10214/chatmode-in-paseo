import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { BridgeError, invariant } from './protocol.mjs';

// Outbound user-selected files never enter JSON session history or command payloads.
// A claimed, paired Chrome command can read bounded chunks of these private copies.
export const INPUT_LIMITS = Object.freeze({ count: 4, each: 12 * 1024 * 1024, total: 24 * 1024 * 1024, chunk: 128 * 1024 });
const TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.rtf': 'application/rtf'
});
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const nameOK = n => typeof n === 'string' && n.length > 0 && n.length <= 150 &&
  n !== '.' && n !== '..' && !/[\\/\x00-\x1f\x7f]/.test(n) && !n.endsWith('.');
const sha = b => createHash('sha256').update(b).digest('hex');
function actualType(bytes, extension) {
  const b = bytes, head = (n) => b.subarray(0,n).toString('latin1');
  if (extension === '.png') return head(8) === '\x89PNG\r\n\x1a\n';
  if (extension === '.jpg' || extension === '.jpeg') return b[0]===0xff && b[1]===0xd8 && b[2]===0xff;
  if (extension === '.gif') return ['GIF87a','GIF89a'].includes(head(6));
  if (extension === '.webp') return head(4)==='RIFF' && b.subarray(8,12).toString()==='WEBP';
  if (extension === '.pdf') return head(5)==='%PDF-';
  if (['.docx','.xlsx','.pptx'].includes(extension)) return head(4)==='PK\x03\x04';
  if (['.doc','.xls','.ppt'].includes(extension)) return b.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex'));
  if (['.txt','.md','.csv','.json','.rtf'].includes(extension)) {
    try {new TextDecoder('utf-8',{fatal:true}).decode(b);return !b.includes(0);}catch{return false;}
  }
  return false;
}
async function fileBytes(item, number) {
  if (item.type === 'image') {
    const mime=item.mimeType, ext=Object.keys(TYPES).find(e => TYPES[e]===mime && e!=='.jpeg');
    invariant(ext && mime.startsWith('image/'), 'ATTACHMENT_TYPE_UNSUPPORTED');
    invariant(typeof item.data==='string' && item.data.length>0 &&
      item.data.length<=Math.ceil(INPUT_LIMITS.each*4/3)+64, 'ATTACHMENT_TOO_LARGE');
    const raw=item.data.replace(/^data:image\/[a-z+.-]+;base64,/i,'');
    invariant(raw.length%4===0 && /^[A-Za-z0-9+/]+={0,2}$/.test(raw), 'ATTACHMENT_INVALID');
    const bytes=Buffer.from(raw,'base64');
    invariant(bytes.length>0 && bytes.toString('base64')===raw && actualType(bytes,ext), 'ATTACHMENT_INVALID');
    return { bytes, fileName:'paseo-image-'+(number+1)+ext, mimeType:mime, uploadKind:'image' };
  }
  invariant(item.type==='uploaded_file', 'ATTACHMENT_UNSUPPORTED');
  const {fileName,mimeType,size}=item, ext=path.extname(fileName??'').toLowerCase();
  invariant(nameOK(fileName) && TYPES[ext] &&
    (mimeType===TYPES[ext] || mimeType==='application/octet-stream' ||
      (ext==='.md' && mimeType==='text/plain') ||
      (ext==='.csv' && mimeType==='text/plain')), 'ATTACHMENT_TYPE_UNSUPPORTED');
  invariant(Number.isInteger(size) && size>0 && size<=INPUT_LIMITS.each, 'ATTACHMENT_TOO_LARGE');
  invariant(typeof item.path==='string' && path.isAbsolute(item.path) &&
    !item.path.split(path.sep).includes('..') && item.path.length<4096,'ATTACHMENT_PATH_INVALID');
  const resolved=path.resolve(item.path);
  const stat=await fs.lstat(resolved).catch(()=>null);
  invariant(stat?.isFile() && !stat.isSymbolicLink(),'ATTACHMENT_PATH_INVALID');
  const real=await fs.realpath(resolved).catch(()=>null);
  // macOS maps /tmp and /var/folders into /private. These trusted system
  // aliases are normal for Paseo uploads, unlike a user-made parent symlink.
  invariant(real && (real===resolved ||
    (resolved.startsWith('/tmp/') && real==='/private'+resolved) ||
    (resolved.startsWith('/var/folders/') && real==='/private'+resolved)), 'ATTACHMENT_PATH_INVALID');
  const fd=await fs.open(real,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW).catch(()=>{throw new BridgeError('ATTACHMENT_UNREADABLE');});
  let bytes;
  try {
    const stat=await fd.stat();
    invariant(stat.isFile() && stat.size===size && stat.size<=INPUT_LIMITS.each,'ATTACHMENT_SIZE_CHANGED');
    bytes=await fd.readFile();
  }finally{await fd.close();}
  invariant(bytes.length===size,'ATTACHMENT_SIZE_CHANGED');
  invariant(actualType(bytes,ext),'ATTACHMENT_INVALID');
  return {bytes,fileName,mimeType:TYPES[ext],uploadKind:'file'};
}
export class InputFileStore {
  constructor(directory) { this.directory=directory; }
  location(commandId,index) {
    invariant(uuid(commandId) && Number.isInteger(index) && index>=0 && index<INPUT_LIMITS.count,'ATTACHMENT_ID_INVALID');
    return path.join(this.directory,commandId+'-'+index+'.bin');
  }
  async stage(commandId,items) {
    invariant(Array.isArray(items) && items.length>0 && items.length<=INPUT_LIMITS.count,'ATTACHMENT_COUNT_UNSUPPORTED');
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    const output=[];let total=0;
    try {
      for(let i=0;i<items.length;i++){
        const {bytes,fileName,mimeType,uploadKind}=await fileBytes(items[i],i);
        invariant(bytes.length<=INPUT_LIMITS.each && bytes.length>0,'ATTACHMENT_TOO_LARGE');
        invariant(!output.some(f=>f.fileName.toLowerCase()===fileName.toLowerCase()),'ATTACHMENT_NAME_AMBIGUOUS');
        total+=bytes.length;invariant(total<=INPUT_LIMITS.total,'ATTACHMENT_TOO_LARGE');
        await fs.writeFile(this.location(commandId,i),bytes,{mode:0o600,flag:'wx'});
        output.push({fileName,mimeType,size:bytes.length,sha256:sha(bytes),uploadKind});
      }
      return output;
    }catch(e){await this.remove(commandId);throw e;}
  }
  async read(commandId,index,offset,expected) {
    invariant(Number.isInteger(offset) && offset>=0 && offset<expected.size &&
      offset%INPUT_LIMITS.chunk===0,'ATTACHMENT_OFFSET_INVALID');
    const file=this.location(commandId,index);
    const fd=await fs.open(file,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW)
      .catch(()=>{throw new BridgeError('ATTACHMENT_EXPIRED');});
    try {
      const st=await fd.stat();
      invariant(st.isFile()&&st.size===expected.size,'ATTACHMENT_SIZE_CHANGED');
      const bytes=Buffer.alloc(Math.min(INPUT_LIMITS.chunk,expected.size-offset));
      const {bytesRead}=await fd.read(bytes,0,bytes.length,offset);
      invariant(bytesRead===bytes.length,'ATTACHMENT_UNREADABLE');
      return {data:bytes.toString('base64'),offset,total:expected.size,sha256:expected.sha256};
    }finally{await fd.close();}
  }
  async remove(commandId) {
    if(!uuid(commandId))return;
    await Promise.all(Array.from({length:INPUT_LIMITS.count},(_,i)=>
      fs.rm(path.join(this.directory,commandId+'-'+i+'.bin'),{force:true}).catch(()=>{})));
  }
  async pruneOlderThan(ms=86400000) {
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    const entries=await fs.readdir(this.directory);
    for(const name of entries){
      if(!/^[0-9a-f-]{36}-[0-3]\.bin$/i.test(name))continue;
      const full=path.join(this.directory,name),st=await fs.lstat(full).catch(()=>null);
      if(st && Date.now()-st.mtimeMs>ms)await fs.rm(full,{force:true}).catch(()=>{});
    }
  }
}
