/** Real HTTP runtime on port 0 with a temporary state directory.
 * No Chrome, account, Send, Stop or reload is involved.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../server/runtime.mjs';
import { validateCatalog } from '../../server/protocol.mjs';
import { rawCatalog, selection, until } from '../helpers.mjs';

export async function httpHarness(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cip-http-'));
  const wake = [];
  let runtime = await createRuntime({ directory, port: 0, onExternalTurn: id => wake.push(id) });
  t.after(async () => { await runtime.close().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {}); });
  const pairing = JSON.parse(await readFile(path.join(directory, 'pairing.json'), 'utf8'));
  const extensionId = 'b'.repeat(32);
  const request = (route, value, headers = {}) => fetch(runtime.address + route, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: value === undefined ? undefined : JSON.stringify(value)
  });
  const credential = await (await request('/pair', { code: pairing.code, extensionId })).json();
  const auth = { Authorization: 'Bearer ' + credential.token, 'X-CIP-Extension': extensionId };
  const signed = (route, value) => request(route, value, auth);
  await runtime.store.transaction(data => { data.catalog = validateCatalog(rawCatalog); });
  const status = async (route, value) => (await signed(route, value)).status;
  let tab = 40;
  // One real bound session with a confirmed Send receipt.
  async function bound() {
    const broker = runtime.broker, tabId = ++tab;
    const session = await broker.create(selection), opening = broker.configure(session.id, selection);
    opening.catch(() => {});
    const open = await until(() => broker.queued().find(c => c.kind === 'open' && c.sessionId === session.id));
    const oclaim = await broker.claim(open.id, tabId, 'document-' + tabId);
    await broker.result(open.id, oclaim.lease, { config: selection, tabId, url: 'https://chatgpt.com/' });
    await opening;
    const sent = await broker.prompt(session.id, 'c-' + tabId, 'hello');
    const command = broker.queued().find(c => c.kind === 'send' && c.sessionId === session.id);
    const claim = await broker.claim(command.id, tabId, 'document-' + tabId);
    await broker.authorize(command.id, claim.lease);
    await broker.result(command.id, claim.lease, { receipt: true, nativeMessageId: 'native-' + tabId,
      config: selection, url: `https://chatgpt.com/c/chat-${tabId}` });
    return { session, tabId, turnId: sent.turnId, claim, snapshot: broker.snapshot(session.id) };
  }
  // New runtime on the same durable directory (restart), same credential file.
  async function restart() {
    await runtime.close();
    runtime = await createRuntime({ directory, port: 0, onExternalTurn: id => wake.push(id) });
    return runtime;
  }
  return { get runtime() { return runtime; }, directory, wake, request, signed, status, auth, bound, restart };
}
