import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const ARTIFACT_LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, chunk: 32768, disk: 128 * 1024 * 1024, uploads: 2, lifetime: 60000 });
export const ARTIFACT_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'application/zip', 'application/octet-stream', 'text/plain', 'text/csv', 'text/markdown', 'application/json']);
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function artifactMetadata(input) {
  check(input && typeof input.digest === 'string' && /^[a-f0-9]{64}$/.test(input.digest), 'ARTIFACT_HASH_INVALID');
  check(Number.isSafeInteger(input.bytes) && input.bytes > 0 && input.bytes <= ARTIFACT_LIMITS.bytes, 'ARTIFACT_SIZE_INVALID');
  check(ARTIFACT_MIMES.includes(input.mimeType), 'ARTIFACT_MIME_UNSUPPORTED');
  check(typeof input.name === 'string' && input.name.length > 0 && input.name.length <= 180 &&
    !/[\\/:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(input.name) && !/^\.+$/.test(input.name), 'ARTIFACT_NAME_INVALID');
  return { digest: input.digest, bytes: input.bytes, mimeType: input.mimeType, name: input.name };
}
function decode(data, limit) {
  check(typeof data === 'string' && data.length > 0 && data.length <= limit && data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(data), 'ARTIFACT_DATA_INVALID');
  const bytes = Buffer.from(data, 'base64');
  check(bytes.toString('base64') === data, 'ARTIFACT_DATA_INVALID');
  return bytes;
}
function verify(meta, bytes) {
  check(bytes.length === meta.bytes, 'ARTIFACT_SIZE_MISMATCH');
  check(hash(bytes) === meta.digest, 'ARTIFACT_HASH_MISMATCH');
  const starts = value => bytes.subarray(0, value.length).equals(Buffer.from(value));
  let valid = true;
  switch (meta.mimeType) {
    case 'image/png': valid = starts([137,80,78,71,13,10,26,10]) && bytes.length >= 24 && bytes.toString('ascii',12,16) === 'IHDR'; break;
    case 'image/jpeg': valid = starts([255,216,255]) && bytes.length >= 4 && bytes.at(-2) === 255 && bytes.at(-1) === 217; break;
    case 'image/gif': valid = (starts('GIF87a') || starts('GIF89a')) && bytes.length >= 13; break;
    case 'image/webp': valid = bytes.length >= 12 && starts('RIFF') && bytes.toString('ascii',8,12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length; break;
    case 'application/pdf': valid = starts('%PDF-'); break;
    case 'application/zip': valid = starts([80,75,3,4]) || starts([80,75,5,6]); break;
    case 'application/json':
    case 'text/plain':
    case 'text/csv':
    case 'text/markdown':
      try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); valid = !text.includes('\0'); if (meta.mimeType === 'application/json') JSON.parse(text); }
      catch { valid = false; }
  }
  // Signature/encoding validation, not a document decoder or malware scanner.
  check(valid, 'ARTIFACT_MIME_MISMATCH');
}

// Header dimensions gate client decoding, not original-resource storage. Unknown
// encodings keep their bytes but cannot claim a safely bounded image preview.
function imageDimensions(bytes, mimeType) {
  let width, height;
  if (mimeType === 'image/png') { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  if (mimeType === 'image/gif') { width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); }
  if (mimeType === 'image/webp' && bytes.length >= 30) {
    const chunk = bytes.toString('ascii',12,16);
    if (chunk === 'VP8X') { width = 1 + bytes.readUIntLE(24,3); height = 1 + bytes.readUIntLE(27,3); }
    if (chunk === 'VP8 ' && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    if (chunk === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 1 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (offset < bytes.length && bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) break;
      if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset+3); width = bytes.readUInt16BE(offset+5); break;
      }
      offset += length;
    }
  }
  return width > 0 && height > 0 ? { width, height } : {};
}

/** Blob storage only. No URL fetching, lease, session or turn-state decisions.
 * Integration MUST validate the observation lease/current binding before accepting
 * each upload chunk. For reads, derive metadata from the authorized session's
 * persisted artifact row; a caller-supplied digest is NOT a read capability.
 */
export class ArtifactStore {
  constructor(directory) { this.directory = path.resolve(directory); this.tail = Promise.resolve(); this.uploads = new Map(); this.canonicalDirectory = null; }
  async directoryReady(create = false) {
    if (create) await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'ARTIFACT_PATH_UNSAFE');
    const canonical = await fs.realpath(this.directory);
    check(this.canonicalDirectory === null || this.canonicalDirectory === canonical, 'ARTIFACT_PATH_UNSAFE');
    this.canonicalDirectory = canonical;
  }
  expire() { for (const [id, row] of this.uploads) if (Date.now() - row.created > ARTIFACT_LIMITS.lifetime) this.uploads.delete(id); }
  begin(input) {
    const metadata = artifactMetadata(input); this.expire();
    check(this.uploads.size < ARTIFACT_LIMITS.uploads, 'ARTIFACT_UPLOAD_LIMIT');
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { metadata, chunks: [], offset: 0, created: Date.now() });
    return { uploadId };
  }
  append(uploadId, { offset, data }) {
    this.expire(); const row = this.uploads.get(uploadId);
    check(row, 'ARTIFACT_UPLOAD_UNKNOWN');
    check(Number.isSafeInteger(offset) && offset === row.offset, 'ARTIFACT_OFFSET_INVALID');
    const total = 4 * Math.ceil(row.metadata.bytes / 3), bytes = decode(data, ARTIFACT_LIMITS.chunk);
    check(offset + data.length <= total && (offset + data.length === total || !data.includes('=')), 'ARTIFACT_SIZE_MISMATCH');
    // Full-sized nonfinal chunks bound array/Buffer overhead as well as bytes.
    check(data.length === Math.min(ARTIFACT_LIMITS.chunk,total-offset), 'ARTIFACT_CHUNK_SIZE_INVALID');
    row.chunks.push(bytes); row.offset += data.length;
    return { nextOffset: row.offset < total ? row.offset : null, total };
  }
  abort(uploadId) { this.uploads.delete(uploadId); }
  async commit(uploadId) {
    this.expire(); const row = this.uploads.get(uploadId);
    check(row, 'ARTIFACT_UPLOAD_UNKNOWN'); this.uploads.delete(uploadId);
    check(row.offset === 4 * Math.ceil(row.metadata.bytes / 3), 'ARTIFACT_INCOMPLETE');
    return this.persist(row.metadata, Buffer.concat(row.chunks));
  }
  async put(input) {
    const meta = artifactMetadata(input);
    return this.persist(meta, decode(input.base64, 4 * Math.ceil(ARTIFACT_LIMITS.bytes / 3)));
  }
  async verifiedBytes(meta) {
    await this.directoryReady();
    const target = path.join(this.directory, meta.digest + '.blob');
    const info = await fs.lstat(target);
    check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === meta.bytes, 'ARTIFACT_PATH_UNSAFE');
    const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      check(opened.isFile() && opened.ino === info.ino && opened.dev === info.dev && opened.nlink === 1 && opened.size === meta.bytes, 'ARTIFACT_PATH_UNSAFE');
      // Fixed allocation prevents a concurrently growing file from exhausting memory.
      const bytes = Buffer.alloc(meta.bytes); let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        check(bytesRead > 0, 'ARTIFACT_SIZE_MISMATCH'); offset += bytesRead;
      }
      check((await file.stat()).size === bytes.length, 'ARTIFACT_SIZE_MISMATCH');
      verify(meta, bytes); return bytes;
    } finally { await file.close(); }
  }
  async persist(meta, bytes) {
    verify(meta, bytes); meta = { ...meta, ...imageDimensions(bytes,meta.mimeType) };
    const operation = this.tail.then(async () => {
      await this.directoryReady(true);
      const target = path.join(this.directory, meta.digest + '.blob');
      let exists = false;
      try { await fs.lstat(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (exists) { await this.verifiedBytes(meta); return meta; }
      let usage = 0;
      for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
        check(!entry.isSymbolicLink(), 'ARTIFACT_PATH_UNSAFE');
        if (entry.isFile()) usage += (await fs.lstat(path.join(this.directory, entry.name))).size;
      }
      check(usage + bytes.length <= ARTIFACT_LIMITS.disk, 'ARTIFACT_STORAGE_FULL');
      const temporary = path.join(this.directory, randomUUID() + '.part');
      try {
        const file = await fs.open(temporary, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await fs.rename(temporary, target);
        const directory = await fs.open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await fs.rm(temporary, { force: true }); }
      return meta;
    });
    this.tail = operation.catch(() => {}); return operation;
  }
  /** offset/total/nextOffset count BASE64 characters, not raw bytes. */
  async read(authorizedMetadata, { offset = 0 } = {}) {
    const meta = artifactMetadata(authorizedMetadata), total = 4 * Math.ceil(meta.bytes / 3);
    check(Number.isSafeInteger(offset) && offset >= 0 && offset % 4 === 0 && offset < total, 'ARTIFACT_OFFSET_INVALID');
    const encoded = (await this.verifiedBytes(meta)).toString('base64');
    const end = Math.min(total, offset + ARTIFACT_LIMITS.chunk);
    return { data: encoded.slice(offset, end), nextOffset: end < total ? end : null, total, mimeType: meta.mimeType, digest: meta.digest };
  }
}
