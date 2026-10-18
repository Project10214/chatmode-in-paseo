/** Terminal-state and restart persistence under the continuous contract.
 *
 * The old `native-activity` card recorded phase/nativeStatus/sync/outcome, and
 * failTurn/watchdog/reboot were asserted through it. That card is no longer
 * produced: page state comes from the visible buttons (page-state card), turn
 * content/terminals come from the source ledger and Paseo runs. Nothing may
 * infer completion from a body, a tool status, a lost observer or a restart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, sourceItem } from './helpers.mjs';
import { Store } from '../server/store.mjs';
import { Broker } from '../server/broker.mjs';

test('STRICT-A02b a restart keeps the last page-state card and never turns it into a completed turn', async t => {
 let reopened;
 t.after(() => reopened?.close());
 const f = await fixture(t), s = await f.ready(); await f.sending(s);
 await f.view(s, { state: 'running', items: [sourceItem('answer', 'still running', { nativeMessageId: 'native-answer' })] });
 const before = f.broker.snapshot(s.id);
 const card = before.history.find(row => row.kind === 'page-state');
 assert.equal(card.data.state, 'running');
 assert.equal(before.turn.outcome, null);
 assert.equal(before.observation.run.active, true);
 await f.broker.close();
 const store = await new Store(f.directory).open(), broker = reopened = new Broker(store);
 const after = broker.snapshot(s.id);
 const restored = after.history.find(row => row.kind === 'page-state');
 assert.equal(restored.id, card.id, 'the status card keeps its identity');
 assert.equal(restored.data.state, 'running', 'a restart does not invent a terminal page state');
 assert.equal(after.turn.outcome, null, 'a restart is not completion or failure');
 assert.equal(after.observation.run.active, true, 'a bound conversation keeps observing');
 assert.equal(Object.values(store.read().commands).filter(command =>
  ['send', 'stop', 'approval'].includes(command.kind)).length, 1,
  'restart never replays a Send/Stop/approval');
});

/* Retired assertions (mechanism removed):
 * STRICT-A01 only terminal confirmation turns activity into completed -> only a
 *   visible standby frame or a confirmed Stop ends the run; a body, a tool
 *   status or a quiet timer never does (CM-R7, CM-R8, CONTOBS-03).
 * STRICT-A02a a lost browser updates the activity card before the end -> a lost
 *   observer is a page-state issue/gap, not a turn event (CM-R9, CONTOBS-10).
 * STRICT-A02b failTurn/watchdog/reboot persisted the terminal activity card ->
 *   restarted above: the page-state card persists as-is and the run stays
 *   active; turn failure is only a real Broker failure (LINK9 still covers a
 *   failed Stop anchor).
 * STRICT-A02d Runtime recover retains the verified active turn and activity ->
 *   observation recovery is lease-based (CONTOBS-01, CM-R2), not an activity
 *   card snapshot.
 * STRICT-A02e the timeout watchdog marks the active card failed -> a command
 *   deadline expires the command (broker tick), not the page-state card; a lost
 *   page is not a failed native turn (CM-R9).
 * STRICT-A02c a successful Stop produces final activity, not a live tool -> the
 *   confirmed Stop ends the run and the late visible tail is still captured
 *   (CM-R8, CM-P2).
 */
