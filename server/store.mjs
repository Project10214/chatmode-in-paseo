import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { invariant, LIMITS } from './protocol.mjs';

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
export const initialState = () => ({ version: 1, sessions: {}, commands: {}, catalog: null, defaults: { appIds: [] } });
/** Serialized atomic replacement. Never publishes a mutation that failed to reach disk. */
export class Store {
  constructor(directory) { this.directory = directory; this.data = initialState(); this.tail = Promise.resolve(); }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.readFile(path.join(this.directory, 'state.json'), 'utf8');
      invariant(raw.length <= 64 * 1024 * 1024, 'STATE_TOO_LARGE');
      const data = JSON.parse(raw);
      invariant(data.version === 1 && data.sessions && !Array.isArray(data.sessions) && data.commands && !Array.isArray(data.commands), 'STATE_INVALID');
      this.data = data;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }
  read() { return structuredClone(this.data); }
  transaction(change, { control = false } = {}) {
    const work = this.tail.then(async () => {
      const next = structuredClone(this.data);
      const result = change(next);
      invariant(!(result instanceof Promise), 'ASYNC_TRANSACTION');
      const temp = path.join(this.directory, `.state-${randomUUID()}.tmp`);
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
        // Best-effort directory fsync; Windows may reject directory handles.
        let dir; try { dir = await fs.open(this.directory, 'r'); await dir.sync(); } catch {} finally { await dir?.close(); }
        this.data = next;
        return structuredClone(result);
      } catch (e) { await handle?.close(); await fs.rm(temp, { force: true }); throw e; }
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async flush() { await this.tail; }
}
