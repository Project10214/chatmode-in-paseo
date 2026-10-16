import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

// All dates are local to the Runtime machine. Never use an untrusted path segment.
export function localArchiveDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}

export function archiveFile(directory, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('ARCHIVE_DATE_INVALID');
  return path.join(directory, 'archive', date + '.jsonl');
}

// Stream each day's records instead of loading a potentially large archive into RAM.
// A power cut can leave an incomplete *uncommitted* final line; the master state
// remains authoritative until a full row is fsynced and its index is committed.
export async function findArchiveRow(file, id, archiveId = null) {
  let latest = null;
  try {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row.id === id && row.session?.id === id &&
          (archiveId === null || row.archiveId === archiveId)) latest = row;
      } catch { /* A torn line was never committed to the master index. */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return latest;
}

// Re-confirm an already-present row is durable (file and directory) before the
// caller drops the master copy. Readable is not the same as fsynced.
export async function syncArchiveFile(file) {
  const handle = await fs.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  const dirHandle = await fs.open(path.dirname(file), 'r');
  try { await dirHandle.sync(); } finally { await dirHandle.close(); }
}

export async function appendArchiveRow(file, record) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const handle = await fs.open(file, 'a+', 0o600);
  try {
    await handle.chmod(0o600);
    // Separate any torn last line before appending a complete recoverable row.
    const stat = await handle.stat();
    if (stat.size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, stat.size - 1);
      if (last[0] !== 10) await handle.write('\n');
    }
    await handle.writeFile(JSON.stringify(record) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // The archive path itself must be durable before removing the master copy.
  const dirHandle = await fs.open(directory, 'r');
  try { await dirHandle.sync(); } finally { await dirHandle.close(); }
}
