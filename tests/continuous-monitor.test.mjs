import test from 'node:test';
import assert from 'node:assert/strict';
import {clone,item,withoutRaw,controlView,deferred,flush,page,assertObserverOnly,LIMIT,URL_A} from './fixtures/content-page.mjs';
test('MON-01 identity is synchronous URL/document proof, independent of every content/transcript/control failure', async t => {
  const f = page(t);
  f.state.readSource = () => { throw new Error('body unavailable'); };
  f.state.readControls = () => { throw new Error('controls unavailable'); };
  const identity = await f.identity();
  assert.equal(identity.ok, true);
  assert.deepEqual(identity.value, { documentKey: f.session().documentKey, url: URL_A,
    engine: 'cos-native-alpha4.3', protocol: 9, observationRevoked: false });
  assert.equal(f.state.sourceReads, 0); assert.equal(f.state.controlReads, 0);
  assertObserverOnly(f);
});

test('MON-02 the same timer reads body and buttons in running/standby/abnormal and after later native users', async t => {
  const f = page(t);
  assert.equal(f.intervals.size, 1);
  assert.equal((await f.monitor(f.session({ nativeMessageId: null, completed: true, outcome: 'failed' }))).ok, true);
  for (const state of ['standby', 'abnormal', 'running']) {
    f.state.state = state;
    f.state.source.items = [item('output-' + state, '后续轮原文 ' + state)];
    await f.tick();
  }
  assert.equal(f.state.sourceReads, 4);
  assert.equal(f.state.controlReads, 5, 'abnormal is rechecked once');
  assert.deepEqual(f.accepted.map(request => request.event.view.page.state), ['running', 'standby', 'abnormal', 'running']);
  assert.equal(f.accepted.at(-1).event.view.items[0].id, 'output-running');
  assert.equal(f.intervals.size, 1, 'standby/local persistence cannot destroy the timer');
  assertObserverOnly(f);
});

test('MON-03 content and control read failures are isolated, with a second control check and no Retry click', async t => {
  const f = page(t);
  f.state.readSource = () => { throw new Error('unreadable content'); };
  await f.monitor();
  assert.equal(f.accepted[0].event.view.page.state, 'running');
  assert.ok(f.accepted[0].event.view.issues.some(issue => issue.code === 'CONTENT_READ_FAILED'));
  f.state.readSource = undefined;
  f.state.readControls = () => { throw new Error('unreadable controls'); };
  await f.tick();
  const view = f.accepted.at(-1).event.view;
  assert.equal(view.items[0].text, '原始回答');
  assert.equal(view.page.state, 'abnormal'); assert.equal(view.page.readable, false);
  assert.ok(view.issues.some(issue => issue.code === 'CONTROLS_READ_FAILED'));
  assert.equal(f.state.controlReads, 3);
  assertObserverOnly(f);
});

test('MON-04 an unrecognized first control sample is rechecked before abnormal is reported', async t => {
  const f = page(t);
  const samples = [controlView('abnormal'), controlView('standby')];
  f.state.readControls = () => samples.shift();
  await f.monitor();
  assert.equal(f.state.sourceReads, 1); assert.equal(f.state.controlReads, 2);
  assert.equal(f.accepted[0].event.view.page.state, 'standby');
  assertObserverOnly(f);
});

test('MON-05 failed persistence retries the identical frame/sequence while continuing to read and queue new source versions', async t => {
  const f = page(t); f.state.rpcFailures = 1;
  await f.monitor();
  const failed = clone(f.attempts()[0]);
  f.state.source.items = [item('answer-b', '输出 B（不可并入 A）')];
  await f.tick();
  const requests = f.attempts();
  assert.deepEqual(requests[1], failed, 'the sequence must not be reused for a newer body or timestamp');
  assert.equal(requests[2].event.sequence, 2);
  assert.equal(requests[2].event.view.items[0].id, 'answer-b');
  assert.equal(f.state.sourceReads, 2); assert.equal(f.state.controlReads, 2);
  assertObserverOnly(f);
});

test('MON-06 an in-flight RPC does not suppress reads or discard intermediate captured messages', async t => {
  const f = page(t), blocked = deferred();
  f.state.rpc = request => request.type === 'page-view' && request.event.sequence === 1 ? blocked.promise : undefined;
  await f.monitor();
  f.state.source.items = [item('B', '正文 B')]; await f.tick();
  f.state.source.items = [item('C', '正文 C')]; await f.tick();
  assert.equal(f.state.sourceReads, 3); assert.equal(f.state.controlReads, 3);
  assert.equal(f.attempts().length, 1);
  blocked.resolve({ ok: true, value: { accepted: true } }); await flush();
  assert.deepEqual(f.accepted.map(request => request.event.view.items[0].id), ['answer-a', 'B', 'C']);
  assert.deepEqual(f.accepted.map(request => request.event.sequence), [1, 2, 3]);
  assertObserverOnly(f);
});

test('MON-07 semantic dedup ignores observedAt but still reads on every tick and renews after 15 seconds', async t => {
  const f = page(t); await f.monitor();
  await f.tick(5000); await f.tick(5000);
  assert.equal(f.attempts().length, 1); assert.equal(f.state.sourceReads, 3);
  await f.tick(5000);
  assert.equal(f.attempts().length, 2); assert.equal(f.state.sourceReads, 4);
  assert.equal(f.attempts()[1].event.sequence, 2);
  assert.notEqual(f.attempts()[0].event.view.page.observedAt, f.attempts()[1].event.view.page.observedAt);
  assertObserverOnly(f);
});

test('MON-08 accepted:false or active:false is not a Paseo ACK, native completion, or permission to end monitoring', async t => {
  const f = page(t); f.state.persistenceAccepted = false;
  await f.monitor(); await f.tick();
  assert.equal(f.accepted.length, 0);
  assert.deepEqual(f.attempts()[1], f.attempts()[0]);
  f.state.persistenceAccepted = true; await f.tick();
  f.state.state = 'standby'; await f.tick();
  f.state.source.items = [item('later-final', '待命后的历史补齐')]; await f.tick();
  assert.equal(f.accepted.at(-1).event.view.items[0].id, 'later-final');
  assert.equal(f.state.sourceReads, 5);
  assertObserverOnly(f);
});

test('MON-09 large batches preserve every item/approval/closure/issue across UTF-8 frames <=384KiB', async t => {
  const f = page(t);
  const items = Array.from({ length: 65 }, (_, i) => item('source-' + i, '中文😀'.repeat(2000), { order: [i] }));
  const approvals = Array.from({ length: 7 }, (_, i) => ({ key: 'permission-' + i, text: '原始授权描述'.repeat(2000) }));
  const issues = [{ code: 'SOURCE_ID_UNCONFIRMED', text: '保留原文' }], closedApprovals = ['old-key'];
  f.state.source = { conversationId: 'chat-a', items, approvals, issues, closedApprovals };
  await f.monitor();
  assert.ok(f.accepted.length > 1);
  for (const request of f.accepted) {
    assert.ok(new TextEncoder().encode(JSON.stringify(request)).length <= LIMIT);
    assert.equal(request.event.view.page.state, 'running');
  }
  const joined = key => f.accepted.flatMap(request => request.event.view[key]);
  assert.deepEqual(joined('items'), items.map(withoutRaw)); assert.deepEqual(joined('approvals'), approvals);
  assert.deepEqual(joined('closedApprovals'), closedApprovals); assert.deepEqual(joined('issues'), issues);
  assert.deepEqual(f.accepted.map(request => request.event.sequence), f.accepted.map((_, i) => i + 1));
  assertObserverOnly(f);
});

test('MON-10 an oversized single item is explicitly reported without truncating it into a final or hiding siblings/buttons', async t => {
  const f = page(t), huge = item('oversized', '😀'.repeat(150000)), good = item('sibling', '正常条目完整原文');
  f.state.source.items = [huge, good];
  f.state.source.approvals = [{ key: 'visible-permission', text: 'Allow once / Deny' }];
  await f.monitor();
  const items = f.accepted.flatMap(request => request.event.view.items), issues = f.accepted.flatMap(request => request.event.view.issues);
  assert.deepEqual(items, [withoutRaw(good)]);
  assert.ok(issues.some(issue => issue.code === 'PAGE_ENTRY_TOO_LARGE' && issue.id === huge.id && issue.collection === 'items'));
  assert.equal(f.accepted[0].event.view.page.state, 'running');
  assert.equal(f.accepted[0].event.view.approvals[0].key, 'visible-permission');
  assert.equal(f.state.source.items[0].text, huge.text);
  assert.ok(f.accepted.every(request => new TextEncoder().encode(JSON.stringify(request)).length <= LIMIT));
  assertObserverOnly(f);
});

test('MON-11 A -> B -> A cannot revive an old lease; foreign route reads stop until a fresh lease arrives', async t => {
  const f = page(t); await f.monitor();
  f.navigate('chat-b'); await f.tick();
  assert.equal(f.state.sourceReads, 1); assert.equal(f.state.controlReads, 1);
  assert.equal((await f.identity()).value.observationRevoked, true);
  f.navigate('chat-a');
  assert.equal((await f.monitor()).ok, false);
  assert.equal(f.state.sourceReads, 1);
  assert.equal((await f.monitor(f.session({ observationLease: 'observation-new', generation: 1 }))).ok, true);
  assert.equal(f.state.sourceReads, 2);
  assert.equal(f.accepted.at(-1).event.observationLease, 'observation-new');
  assert.equal((await f.identity()).value.observationRevoked, false);
  assertObserverOnly(f);
});

test('MON-12 a delayed old-epoch response cannot consume a new epoch queue or change its payload/sequence', async t => {
  const f = page(t), old = deferred();
  f.state.rpc = request => request.type === 'page-view' && request.event.observationLease === 'observation-a' ? old.promise : undefined;
  await f.monitor();
  const oldRequest = clone(f.attempts()[0]);
  f.navigate('chat-b'); f.navigate('chat-a');
  await f.monitor(f.session({ observationLease: 'observation-new' }));
  old.resolve({ ok: true, value: { accepted: true } }); await flush();
  f.state.source.items = [item('new-output', '新 epoch 原文')]; await f.tick();
  const newRequests = f.attempts().filter(request => request.event.observationLease === 'observation-new');
  assert.deepEqual(newRequests.map(request => request.event.sequence), [1, 2]);
  assert.deepEqual(f.attempts()[0], oldRequest);
  assert.equal(newRequests.at(-1).event.view.items[0].text, '新 epoch 原文');
  assertObserverOnly(f);
});

test('MON-13 same lease host-fragment/native-user changes preserve observer identity and monotonically increasing sequence', async t => {
  const f = page(t); await f.monitor(f.session({ runId: 'fragment-a', nativeMessageId: 'user-a' }));
  f.state.source.items = [item('other-source', '第二条回答')];
  await f.monitor(f.session({ runId: 'fragment-b', turnId: 'another-turn', nativeMessageId: 'user-b', outcome: 'completed' }));
  assert.deepEqual(f.accepted.map(request => request.event.sequence), [1, 2]);
  assert.equal(f.accepted[1].event.observationLease, f.accepted[0].event.observationLease);
  assertObserverOnly(f);
});

test('MON-14 another conversation returned by the source API cannot leak through a correctly bound frame', async t => {
  const f = page(t); f.state.source.conversationId = 'chat-b';
  f.state.source.items = [item('foreign', 'must never cross the conversation boundary')];
  await f.monitor();
  assert.deepEqual(f.accepted[0].event.view.items, []);
  assert.ok(f.accepted[0].event.view.issues.some(issue => issue.code === 'CONTENT_CONVERSATION_UNCONFIRMED'));
  assert.equal(f.accepted[0].event.view.page.state, 'running');
  assert.equal(JSON.stringify(f.requests).includes('must never cross'), false);
  assertObserverOnly(f);
});

test('MON-15 approvals and confirmed closures are collected in standby without authorizing anything', async t => {
  const f = page(t); f.state.state = 'standby';
  const request = { key: 'allow-key', text: 'Allow ChatGPT?', input: '{"command":"visible"}', labels: ['Allow once', 'Deny'] };
  f.state.source.approvals = [request]; await f.monitor();
  assert.deepEqual(f.accepted[0].event.view.approvals, [request]);
  f.state.source.approvals = []; f.state.source.closedApprovals = ['allow-key']; await f.tick();
  assert.deepEqual(f.accepted[1].event.view.closedApprovals, ['allow-key']);
  assertObserverOnly(f);
});

test('MON-16 Stop uses only current observation proof, passes the adapter guard, and observes once after success', async t => {
  const f = page(t); await f.monitor();
  const command = f.command('stop');
  const reply = await f.send(command);
  assert.equal(reply.ok, true); assert.equal(f.state.stops, 1); assert.equal(f.state.sourceReads, 2);
  assert.equal(f.state.stopArgs.observationLease, f.session().observationLease);
  assert.equal(typeof f.state.stopArgs.guard, 'function');
  assert.equal(f.state.stopArgs.nativeMessageId, undefined);
  assert.equal(f.accepted.at(-1).event.view.page.state, 'standby');
  assert.equal((await f.send(command)).error, 'COMMAND_ALREADY_ATTEMPTED');
  assert.equal(f.state.stops, 1); assert.equal(f.state.sends, 0);
  await f.tick(); assert.equal(f.state.sourceReads, 3);
});

test('MON-17 stale/missing observation leases cannot Stop or answer approval, including A -> B -> A commands', async t => {
  const f = page(t); await f.monitor();
  for (const kind of ['stop', 'approval']) {
    for (const observationLease of [undefined, 'stale'])
      assert.equal((await f.send(f.command(kind, { observationLease, key: 'permission-key', choice: 'allow-once' }))).ok, false);
    for (const documentKey of [undefined, 'wrong-payload-document'])
      assert.equal((await f.send(f.command(kind, { documentKey, key: 'permission-key', choice: 'deny' }))).ok, false);
    assert.equal((await f.send(f.command(kind, {}, { documentKey: 'wrong-claim-document' }))).ok, false);
  }
  f.navigate('chat-b'); f.navigate('chat-a');
  assert.equal((await f.send(f.command('stop'))).ok, false);
  assert.equal(f.state.stops, 0); assert.equal(f.state.approvals, 0);
  assert.equal(f.state.sends, 0);
});

test('MON-18 approval adapter receives key/choice/conversation/guard, with no native user gate or automatic approval', async t => {
  const f = page(t); await f.monitor();
  const reply = await f.send(f.command('approval', { key: 'permission-key', choice: 'deny' }));
  assert.equal(reply.ok, true); assert.equal(f.state.approvals, 1);
  const args = f.state.approvalArgs;
  assert.equal(args.key, 'permission-key'); assert.equal(args.choice, 'deny');
  assert.equal(args.conversationId, 'chat-a'); assert.equal(typeof args.guard, 'function');
  assert.equal(f.state.sourceReads, 2); assert.equal(f.state.sends, 0);
});

test('MON-19 Stop guard rejects a navigation during the adapter action, not harmless same-route navigation', async t => {
  const f = page(t); await f.monitor();
  f.state.stopBehavior = async args => { f.emit('navigate'); f.emit('currententrychange'); args.guard(); };
  assert.equal((await f.send(f.command('stop'))).ok, true);
  f.state.stopBehavior = async args => { f.navigate('chat-b'); f.navigate('chat-a'); args.guard(); };
  assert.equal((await f.send(f.command('stop'))).ok, false);
  assert.equal(f.state.sends, 0);
});

test('MON-20 Send/file authorization remains one-shot and its genuine receipt is available to pending-receipt independently', async t => {
  const f = page(t), command = f.command('send', { text: 'synthetic outbound', files: [{ id: 'input-file' }] });
  const reply = await f.send(command); assert.equal(reply.ok, true);
  assert.equal((await f.send(command)).error, 'COMMAND_ALREADY_ATTEMPTED');
  assert.equal(f.state.sends, 1);
  assert.equal(f.requests.filter(request => request.type === 'authorize').length, 1);
  assert.equal(f.requests.filter(request => request.type === 'input-chunk').length, 1);
  const recovered = await f.message({ type: 'pending-receipt', session: f.session({ receiptPending: true, turnId: 'send-turn' }) });
  assert.equal(recovered.ok, true); assert.equal(recovered.value.nativeMessageId, 'real-send-user');
  assert.equal(f.state.sourceReads, 0);
});

test('MON-21 a delayed pending-receipt probe cannot cross a route epoch', async t => {
  const f = page(t), pending = deferred();
  f.state.sendBehavior = () => { throw Object.assign(new Error('uncertain'), { code: 'RECEIPT_UNCONFIRMED', bindingUrl: URL_A }); };
  await f.send(f.command('send'));
  f.state.probeReceipt = () => pending.promise;
  const reply = f.message({ type: 'pending-receipt', session: f.session({ receiptPending: true, turnId: 'send-turn' }) });
  f.navigate('chat-b'); f.navigate('chat-a'); pending.resolve({ available: true, nativeMessageId: 'late-user' });
  assert.equal((await reply).error, 'PAGE_IDENTITY_CHANGED');
  assert.equal(f.state.sends, 1);
});

test('MON-22 catalog/configure/ensure and archive-idle probes retain command safety with a continuous standby monitor', async t => {
  const f = page(t); f.state.transcriptThrows = false;
  assert.equal((await f.send(f.command('catalog', { conversationId: null }))).ok, false, 'catalog refuses a bound conversation');
  f.navigate(null);
  assert.equal((await f.send(f.command('catalog', { conversationId: null }))).ok, true);
  assert.equal(f.state.catalogued, 1);
  f.navigate('chat-a');
  for (const kind of ['configure', 'ensure']) assert.equal((await f.send(f.command(kind))).ok, true);
  assert.equal(f.state.configured, 1, 'Ensure only checks the page and does not apply a model');
  f.state.state = 'standby'; await f.monitor();
  assert.equal((await f.message({ type: 'archive-idle' })).value.idle, true);
  f.state.draft = 'unsent draft'; assert.equal((await f.message({ type: 'archive-idle' })).value.idle, false);
  f.state.draft = ''; f.state.pendingApproval = true;
  assert.equal((await f.message({ type: 'archive-idle' })).value.idle, false);
  f.state.pendingApproval = false; f.state.state = 'running';
  assert.equal((await f.message({ type: 'archive-idle' })).value.idle, false);
  assert.equal(f.state.sends, 0);
});

test('MON-23 legacy collection RPCs are removed; malformed descriptor proof and foreign extension senders cannot start reads', async t => {
  const f = page(t);
  for (const type of ['external-candidate', 'idle-probe', 'native-state'])
    assert.equal((await f.message({ type })).error, 'UNKNOWN_MESSAGE');
  for (const extra of [{ observationLease: undefined }, { documentKey: 'foreign' }, { conversationId: 'foreign' }, { tabId: -1 }])
    assert.equal((await f.monitor(f.session(extra))).ok, false);
  let responded = false;
  f.rawMessage({ type: 'monitor', session: f.session() }, { id: 'foreign-extension' }, () => { responded = true; });
  assert.equal(responded, false); assert.equal(f.state.sourceReads, 0); assert.equal(f.state.controlReads, 0);
  assertObserverOnly(f);
});

test('MON-24 pagehide ends this document observer, but successful persistence and standby never do', async t => {
  const f = page(t); await f.monitor(); f.state.state = 'standby'; await f.tick();
  assert.equal(f.intervals.size, 1);
  f.emit('pagehide'); assert.equal(f.intervals.size, 0);
  assert.equal((await f.identity()).error, 'PAGE_GONE');
  assert.equal((await f.monitor()).ok, false);
  assertObserverOnly(f);
});

test('MON-25 a failed middle batch frame retries byte-for-byte without skipping the remaining source items', async t => {
  const f = page(t), items = Array.from({ length: 30 }, (_, i) => item('large-' + i, '中文😀'.repeat(2500)));
  f.state.source.items = items;
  let failed = false;
  f.state.rpc = request => {
    if (request.type === 'page-view' && request.event.sequence === 2 && !failed) {
      failed = true; return { ok: false, error: 'OFFLINE_TEST_RETRY' };
    }
  };
  await f.monitor();
  const firstFailure = clone(f.attempts().find(request => request.event.sequence === 2));
  assert.ok(firstFailure); assert.equal(f.accepted.length, 1);
  await f.tick();
  const retries = f.attempts().filter(request => request.event.sequence === 2);
  assert.equal(retries.length, 2); assert.deepEqual(retries[1], firstFailure);
  assert.deepEqual(f.accepted.flatMap(request => request.event.view.items), items.map(withoutRaw));
  assert.ok(f.attempts().every(request => new TextEncoder().encode(JSON.stringify(request)).length <= LIMIT));
  assert.equal(f.state.sourceReads, 2); assertObserverOnly(f);
});

test('MON-26 a single source longer than legacy text limits is preserved exactly when the UTF-8 frame fits', async t => {
  const f = page(t), text = '  # original\n```text\n'.padEnd(300000, 'x') + '\n```\nEND  ';
  f.state.source.items = [item('long-source', text)];
  await f.monitor();
  assert.equal(f.accepted.length, 1);
  assert.equal(f.accepted[0].event.view.items[0].text, text);
  assert.deepEqual(f.accepted[0].event.view.issues, []);
  assertObserverOnly(f);
});
test('MON-27 an oversized optional raw supplement cannot strand a fitting DOM source as pending',async t=>{
  const f=page(t),dom=item('native-source','DOM original',{nativeMessageId:'native-source'});
  f.state.source.items=[dom];
  const rawText='x'.repeat(LIMIT+1);
  f.rawReader(async()=>({messages:[{nativeMessageId:'native-source',rawText,representation:'markdown',observedAt:f.state.now}],issues:[]}));
  await f.monitor();await f.tick();
  const items=f.accepted.flatMap(request=>request.event.view.items);
  const fallback=items.find(value=>value.prose?.code==='PUBLIC_MESSAGE_RAW_TOO_LARGE');
  assert.ok(fallback);assert.equal(fallback.text,dom.text);
  assert.equal(fallback.prose.status,'unavailable');assert.equal(fallback.prose.rawText,undefined);
  assert.ok(f.accepted.some(request=>request.event.view.issues.some(issue=>
    issue.code==='PAGE_ENTRY_TOO_LARGE'&&issue.collection==='items.prose'&&issue.id===dom.id)));
  assert.ok(f.accepted.every(request=>new TextEncoder().encode(JSON.stringify(request)).length<=LIMIT));
  assertObserverOnly(f);
});

