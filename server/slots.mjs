import { BridgeError, invariant } from './protocol.mjs';

export const CONCURRENCY = Object.freeze({ min: 1, max: 8, default: 2 });
export function concurrencyValue(value) {
  invariant(Number.isInteger(value) && value >= CONCURRENCY.min && value <= CONCURRENCY.max, 'INVALID_CONCURRENCY');
  return value;
}
/** One runtime owns all provider connections. Queued requests have NOT clicked Send.
 * They are cancellable and discarded on shutdown; never replayed across a restart.
 * A reservation spans page preparation -> durable Send admission, with no gap.
 */
export class SlotQueue {
  constructor(broker) { this.broker = broker; this.waiting = []; this.held = new Map(); this.closed = false; this.pumping = false; }
  activeIds() {
    const ids = new Set([...this.held.keys()]);
    for (const s of Object.values(this.broker.store.read().sessions)) if (['sending','running','stopping'].includes(s.status)) ids.add(s.id);
    return ids;
  }
  snapshot() { return { limit: this.broker.maxConcurrent, active: this.activeIds().size, waiting: this.waiting.length }; }
  has(id) { return this.held.has(id); }
  acquire(id, { signal, onPosition = () => {} } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(new BridgeError('SEND_CANCELLED'));
    invariant(!this.held.has(id) && !this.waiting.some(r => r.id === id), 'SESSION_BUSY');
    const state = this.broker.snapshot(id).status;
    invariant(state === 'idle', state === 'blocked' ? 'DELIVERY_UNCONFIRMED' : 'SESSION_BUSY');
    invariant(this.waiting.length < 64, 'QUEUE_FULL');
    return new Promise((resolve, reject) => {
      const row = { id, signal, onPosition, resolve, reject, position: null, abort: null };
      row.abort = () => {
        const at = this.waiting.indexOf(row);
        if (at < 0) return;
        this.waiting.splice(at, 1); this.dispose(row); reject(new BridgeError('SEND_CANCELLED')); this.pump();
      };
      // A queued prompt has not been sent. The only valid exit is capacity,
      // explicit cancellation or shutdown—not another model's run duration.
      signal?.addEventListener('abort',row.abort,{once:true});
      this.waiting.push(row);
      if (signal?.aborted) row.abort(); else this.pump();
    });
  }
  dispose(row) { row.signal?.removeEventListener('abort', row.abort); }
  notice(row, position) { if (row.position === position) return; row.position=position; try { row.onPosition(position); } catch {} }
  pump() {
    if (this.closed || this.pumping) return; this.pumping=true;
    try {
      while (this.waiting.length && this.activeIds().size < this.broker.maxConcurrent) {
        const row=this.waiting.shift(); this.dispose(row);
        if (row.signal?.aborted) { row.reject(new BridgeError('SEND_CANCELLED')); continue; }
        const lease={ id:row.id, release:() => { if(this.held.get(row.id)!==lease)return;this.held.delete(row.id);this.pump(); } };
        this.held.set(row.id,lease); this.notice(row,0); row.resolve(lease);
      }
      this.waiting.forEach((row,index)=>this.notice(row,index+1));
    } finally { this.pumping=false; }
  }
  close() {
    this.closed=true;
    for(const row of this.waiting.splice(0)){this.dispose(row);row.reject(new BridgeError('CONNECTION_CLOSED'));}
    this.held.clear();
  }
}
