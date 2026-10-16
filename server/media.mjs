import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { invariant, identifier, nativeMessageId, conversationId } from './protocol.mjs';

export const IMAGE_LIMITS = Object.freeze({ bytes: 384000, count: 8, disk: 128 * 1024 * 1024, chunk: 32768 });
const errors = new Set(['not_loaded', 'not_rendered', 'oversized', 'tainted', 'capture_failed']);
export function imageDescriptor(event) {
  invariant(event.completed === true, 'IMAGE_NOT_COMPLETE');
  nativeMessageId(event.messageId); nativeMessageId(event.userMessageId);
  invariant(event.userMessageId === event.nativeMessageId, 'TURN_IDENTITY_MISMATCH');
  invariant(typeof event.assetId === 'string' && /^file_[A-Za-z0-9_-]{8,100}$/.test(event.assetId), 'IMAGE_IDENTITY_UNPROVEN');
  invariant(['available','unavailable'].includes(event.previewStatus), 'IMAGE_STATUS_INVALID');
  const out = { sessionId: identifier(event.sessionId), turnId: identifier(event.turnId), messageId: event.messageId,
    assetId: event.assetId, status: event.previewStatus, conversationId: conversationId(event.url) };
  invariant(out.conversationId, 'WRONG_CONVERSATION');
  for (const key of ['width','height','previewWidth','previewHeight']) {
    if (event[key] !== undefined) { invariant(Number.isInteger(event[key]) && event[key] > 0 && event[key] <= 30000, 'IMAGE_DIMENSIONS_INVALID'); out[key] = event[key]; }
  }
  if (out.status === 'unavailable') { invariant(errors.has(event.previewError), 'IMAGE_ERROR_INVALID'); out.error = event.previewError; }
  return out;
}
export class MediaStore {
  constructor(directory) { this.directory = directory; this.tail = Promise.resolve(); }
  async put(event) {
    const descriptor = imageDescriptor(event);
    if (descriptor.status === 'unavailable') return descriptor;
    invariant(Number.isInteger(descriptor.previewWidth) && Number.isInteger(descriptor.previewHeight) && descriptor.previewWidth <= 1600 && descriptor.previewHeight <= 1600, 'IMAGE_DIMENSIONS_INVALID');
    const data = event.previewDataUrl;
    invariant(typeof data === 'string' && data.length <= 512100 && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(data), 'IMAGE_DATA_INVALID');
    const encoded = data.slice('data:image/webp;base64,'.length), bytes = Buffer.from(encoded, 'base64');
    invariant(bytes.length > 12 && bytes.length <= IMAGE_LIMITS.bytes && bytes.toString('base64') === encoded, 'IMAGE_DATA_INVALID');
    invariant(bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length, 'IMAGE_DATA_INVALID');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const write = this.tail.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      invariant(!(await fs.lstat(this.directory)).isSymbolicLink(), 'MEDIA_PATH_UNSAFE');
      const target = path.join(this.directory, digest + '.webp');
      let existing;
      try { existing = await fs.lstat(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing) {
        invariant(existing.isFile() && !existing.isSymbolicLink() && existing.size === bytes.length, 'MEDIA_PATH_UNSAFE');
        invariant(createHash('sha256').update(await fs.readFile(target)).digest('hex') === digest, 'MEDIA_INTEGRITY_FAILED');
        return;
      }
      let usage = 0;
      for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
        if (entry.isFile()) usage += (await fs.stat(path.join(this.directory, entry.name))).size;
      }
      invariant(usage + bytes.length <= IMAGE_LIMITS.disk, 'MEDIA_STORAGE_FULL');
      const file = await fs.open(target, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    });
    this.tail = write.catch(() => {}); await write;
    return { ...descriptor, digest, mimeType: 'image/webp', bytes: bytes.length };
  }
  /** @returns {Promise<{data: string, nextOffset: number|null, total: number, mimeType: 'image/webp'}>} */
  async read(broker, input) {
    const state = broker.snapshot(identifier(input.sessionId));
    invariant(typeof input.digest === 'string' && /^[a-f0-9]{64}$/.test(input.digest), 'IMAGE_UNKNOWN');
    const row = state.history.find(x => x.type === 'plugin' && x.kind === 'generated-image' && x.data?.turnId === input.turnId && x.data.digest === input.digest);
    invariant(row && row.data.status === 'available', 'IMAGE_UNKNOWN');
    const p = path.join(this.directory, input.digest + '.webp'), info = await fs.lstat(p);
    invariant(info.isFile() && !info.isSymbolicLink() && info.size <= IMAGE_LIMITS.bytes && info.size === row.data.bytes, 'MEDIA_INTEGRITY_FAILED');
    const bytes = await fs.readFile(p);
    invariant(createHash('sha256').update(bytes).digest('hex') === input.digest, 'MEDIA_INTEGRITY_FAILED');
    const encoded = bytes.toString('base64'), offset = input.offset ?? 0;
    invariant(Number.isInteger(offset) && offset >= 0 && offset % 4 === 0 && offset < encoded.length, 'IMAGE_OFFSET_INVALID');
    const end = Math.min(encoded.length, offset + IMAGE_LIMITS.chunk);
    return { data: encoded.slice(offset, end), nextOffset: end < encoded.length ? end : null, total: encoded.length, mimeType: 'image/webp' };
  }
}
