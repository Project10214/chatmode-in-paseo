import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { invariant, LIMITS } from './protocol.mjs';
import { appendArchiveRow, archiveFile, findArchiveRow, localArchiveDate, syncArchiveFile } from './archive.mjs';

export const MAX_STATE_BYTES = 32 * 1024 * 1024;
export const CONTROL_RESERVE_BYTES = 128 * 1024;
export const TURN_RESERVE_BYTES = LIMITS.answer * 12 + 32 * 1024;
function unspentReservations(data) {
  return Object.values(data.sessions).reduce((sum, s) => {
    if (!s.turn || s.turn.outcome || s.turn.historyStart === undefined) return sum;
    const spent = Buffer.byteLength(JSON.stringify(s.history.slice(s.turn.historyStart))) + Buffer.byteLength(JSON.stringify(s.turn.lastText ?? ''));
    return sum + Math.max(0, TURN_RESERVE_BYTES - spent);
  }, 0);
}
export const initialState = () => ({ version: 1, sessions: {}, archiveIndex: {}, commands: {}, catalog: null, defaults: { appIds: [] } });

/** Serialized, crash-safe state. Archive rows are durable before master records leave. */
export class Store {
  constructor(directory) { this.directory = directory; this.data = initialState(); this.tail = Promise.resolve(); }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.readFile(path.join(this.directory, 'state.json'), 'utf8');
      invariant(raw.length <= 64 * 1024 * 1024, 'STATE_TOO_LARGE');
      const data = JSON.parse(raw);
      invariant(data.version === 1 && data.sessions && !Array.isArray(data.sessions) &&
        data.commands && !Array.isArray(data.commands) && (!data.archiveIndex ||
        (typeof data.archiveIndex === 'object' && !Array.isArray(data.archiveIndex))), 'STATE_INVALID');
      this.data = { ...data, archiveIndex: data.archiveIndex ?? {} };
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }
  read() { return structuredClone(this.data); }
  #serialize(operation) {
    const work = this.tail.then(operation);
    this.tail = work.catch(() => {});
    return work;
  }
  async #publish(next, { control = false } = {}) {
    const temp = path.join(this.directory, '.state-' + randomUUID() + '.tmp');
    const target = path.join(this.directory, 'state.json');
    let handle;
    try {
      const serialized = JSON.stringify(next);
      const bytes = Buffer.byteLength(serialized);
      invariant(bytes <= MAX_STATE_BYTES, 'STATE_TOO_LARGE');
      invariant(control || bytes + unspentReservations(next) <= MAX_STATE_BYTES - CONTROL_RESERVE_BYTES, 'STATE_CAPACITY_RESERVED');
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp, target);
      let dir;
      try { dir = await fs.open(this.directory, 'r'); await dir.sync(); }
      catch { /* Some filesystems do not support directory fsync. */ }
      finally { await dir?.close(); }
      this.data = next;
    } catch (e) { await handle?.close(); await fs.rm(temp, { force: true }); throw e; }
  }
  transaction(change, { control = false } = {}) {
    return this.#serialize(async () => {
      const next = structuredClone(this.data);
      const result = change(next);
      invariant(!(result instanceof Promise), 'ASYNC_TRANSACTION');
      await this.#publish(next, { control });
      return structuredClone(result);
    });
  }
  // Eligibility is checked inside the same queue that guards every state.json
  // mutation. A crash before the second publish leaves the full master session.
  archiveSession(id, eligible) {
    return this.#serialize(async () => {
      let session = this.data.sessions[id];
      if (!session?.archiveIntent || this.data.archiveIndex[id] || !eligible(session, this.data))
        return { moved: false };
      const retried = session.archiveIntent.appendStarted === true;
      const date = session.archiveIntent.date ?? localArchiveDate();
      if (!retried || !session.archiveIntent.date) {
        const marked = structuredClone(this.data);
        marked.sessions[id].archiveIntent = {
          ...marked.sessions[id].archiveIntent, date, appendStarted: true
        };
        await this.#publish(marked, { control: true });
      }
      session = structuredClone(this.data.sessions[id]);
      const file = archiveFile(this.directory, date);
      const prior = retried ? await findArchiveRow(file, id, session.archiveIntent.id) : null;
      if (prior && JSON.stringify(prior.session) !== JSON.stringify(session))
        return { moved: false, conflict: true };
      if (!prior) await appendArchiveRow(file, { id, archiveId: session.archiveIntent.id, session });
      else await syncArchiveFile(file);
      const next = structuredClone(this.data);
      next.archiveIndex[id] = date;
      delete next.sessions[id];
      await this.#publish(next, { control: true });
      return { moved: true, date };
    });
  }
  // Undo is also a single serialized operation: a concurrent close command is
  // canceled before the restored Session is published, never left half-restored.
  unarchiveSession(id) {
    return this.#serialize(async () => {
      const date = this.data.archiveIndex[id];
      let restored = false, next;
      if (date) {
        const row = await findArchiveRow(archiveFile(this.directory, date), id);
        if (!row) return { restored: false, missing: true };
        next = structuredClone(this.data);
        if (!next.sessions[id]) {
          next.sessions[id] = structuredClone(row.session);
          restored = true;
        }
        delete next.archiveIndex[id];
      } else if (this.data.sessions[id]?.archiveIntent) {
        next = structuredClone(this.data);
      } else return { restored: false };
      if (next.sessions[id]) delete next.sessions[id].archiveIntent;
      for (const command of Object.values(next.commands)) {
        if (command.sessionId === id && command.kind === 'close-tab' &&
          ['queued', 'claimed', 'authorized'].includes(command.phase)) {
          command.phase = 'failed';
          command.error = 'ARCHIVE_CANCELLED';
        }
      }
      await this.#publish(next, { control: true });
      return { restored };
    });
  }
  async flush() { await this.tail; }
}
