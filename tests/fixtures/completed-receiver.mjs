/** Test-only stand-in for the Broker's kind:'message' receipt contract.
 * The revision function is the production one, so the shape cannot drift:
 * SHA-256(UTF-8(JSON.stringify([messageId,format,messageState,text]))).
 * Same native ID + same revision -> unchanged; a different revision of an
 * already stored message -> rejected (MESSAGE_REVISION_CONFLICT). Host display
 * is never confirmed here. Non-message events are acknowledged like Broker.
 * For end-to-end coverage, prefer the real Broker (see append-only-production).
 */
import { webcrypto } from 'node:crypto';
import { messageRevision } from '../../server/message-delivery.mjs';

export { messageRevision };
export function completedReceiver({ active = () => true } = {}) {
  const stored = new Map(), events = [];
  function handle(event) {
    events.push(event);
    if (event.kind !== 'message') return { accepted: true, active: active(event) };
    const revision = messageRevision(event.messageId, event.format, event.messageState, event.text);
    const prior = stored.get(event.messageId);
    const disposition = prior === undefined ? 'stored' : prior === revision ? 'unchanged' : 'rejected';
    if (prior === undefined) stored.set(event.messageId, revision);
    return { accepted: true, active: active(event), receipt: { messageId: event.messageId, revision, disposition, host: 'unconfirmed',
      ...(disposition === 'rejected' ? { code: 'MESSAGE_REVISION_CONFLICT' } : {}) } };
  }
  return { handle, stored, events,
    bodies: () => events.filter(e => e.kind === 'message'),
    kinds: () => events.map(e => e.kind) };
}
/** Browser globals content.js needs for its own revision computation. */
export const vmCrypto = () => ({ crypto: webcrypto, TextEncoder });
