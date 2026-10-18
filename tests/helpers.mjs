import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { Broker } from '../server/broker.mjs';
import { validateCatalog } from '../server/protocol.mjs';
export const rawCatalog = { defaultModel: 'm1', models: [
  { id: 'm1', label: 'Model One', thinkingOptions: [{ id: 'standard', label: 'Standard' }, { id: 'extended', label: 'Extended' }], defaultThinkingOptionId: 'standard' },
  { id: 'm2', label: 'Model Two', thinkingOptions: [] }
], apps: [{ id: 'asdk_app_a', label: 'Development Mac' }, { id: 'asdk_app_b', label: 'Tasks' }] };
export const selection = { model: 'm1', thinkingOption: 'standard', appIds: ['asdk_app_a'] };
export const sourceItem=(id,text,extra={})=>({id,userMessageId:null,role:'assistant',lane:'output',
  kind:'message',text,format:'text',order:[0],...extra});
export function pageView(session,{state='running',items=[],approvals=[],closedApprovals=[],issues=[],
  sequence=(session.observation?.lastSequence??0)+1,page,sendAttempt,...extra}={}) {
  const flag=visible=>({visible,enabled:visible});
  const attempt=sendAttempt??(session.turn?.receivedAt&&session.turn.lease?{
    commandId:session.turn.commandId,turnId:session.turn.id,lease:session.turn.lease,documentKey:session.documentKey}:null);
  return {sessionId:session.id,observationLease:session.observation.lease,tabId:session.tabId,
    documentKey:session.documentKey,url:'https://chatgpt.com/c/'+session.conversationId,sequence,
    view:{conversationId:session.conversationId,page:page??{observedAt:Date.now(),readable:true,
      controls:{stop:flag(state==='running'),send:flag(state==='standby'),voice:flag(false)}},
      items,approvals,closedApprovals,issues,...(attempt?{sendAttempt:attempt}:{}),...extra}};
}
// Polling budget for a real asynchronous chain (source -> Broker -> Provider ->
// delivery coordinator -> host snapshot). Measured: ~0.95s standalone and
// ~1.6-1.8s under 4-way full-suite load for one delivery confirmation, so the
// former 1s budget failed on load alone. This is a wait budget, not a relaxed
// assertion; the 15s test timeout still catches a hung chain.
export async function until(fn) { for (let i = 0; i < 800; i++) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 5)); } throw new Error('Test wait timed out'); }
export async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cip-test-'));
  const store = await new Store(directory).open(); await store.transaction(d => { d.catalog = validateCatalog(rawCatalog); });
  const broker = new Broker(store, options); let nextTab = 100;
  t.after(async () => { await broker.close(); await rm(directory, { recursive: true, force: true }); });
  async function ready(chosen = selection) {
    const s = await broker.create(chosen); const p = broker.configure(s.id, chosen); p.catch(() => {});
    const c = await until(() => broker.queued().find(c => c.sessionId === s.id));
    const tabId = ++nextTab; const claim = await broker.claim(c.id, tabId, `document-${tabId}`);
    await broker.result(c.id, claim.lease, { config: broker.snapshot(s.id).config, tabId, url: 'https://chatgpt.com/' });
    await p; return broker.snapshot(s.id);
  }
  async function sending(s, clientMessageId = 'message-1', value = 'hello', confirm = true) {
    const result = await broker.prompt(s.id, clientMessageId, value);
    const c = broker.queued().find(c => c.kind === 'send' && c.sessionId === s.id);
    const claim = await broker.claim(c.id, s.tabId, s.documentKey);
    await broker.authorize(c.id, claim.lease);
    if (confirm) await broker.result(c.id, claim.lease, { receipt: true, config: s.config, nativeMessageId: `native-${clientMessageId}`, url: `https://chatgpt.com/c/chat-${s.tabId}` });
    return { result, claim, event: { sessionId: s.id, turnId: result.turnId, lease: claim.lease, nativeMessageId: `native-${clientMessageId}`,
      tabId: s.tabId, documentKey: s.documentKey, url: `https://chatgpt.com/c/chat-${s.tabId}` } };
  }
  // Consume an already queued one-shot Send; never enqueue a second prompt.
  // Dispatch observation and native receipt are deliberately separate steps.
  async function dispatchSend(session,options={}) {
    const current=broker.snapshot(typeof session==='string'?session:session.id);
    const command=broker.queued().find(c=>c.kind==='send'&&c.sessionId===current.id);
    if(!command)throw new Error('Fixture expected a queued Send');
    const claim=await broker.claim(command.id,current.tabId,current.documentKey);
    await broker.authorize(command.id,claim.lease);
    const url='https://chatgpt.com/c/'+(current.conversationId??'chat-'+current.tabId);
    await broker.bindConversation(command.id,claim.lease,{tabId:current.tabId,documentKey:current.documentKey,url});
    const event=pageView(broker.snapshot(current.id),{...options,sendAttempt:{
      commandId:command.id,turnId:command.payload.turnId,lease:claim.lease,documentKey:current.documentKey}});
    await broker.observeView(event);
    return {command,claim,event};
  }
  async function view(session,options={}) {
    const current=broker.snapshot(typeof session==='string'?session:session.id);
    return broker.observeView(pageView(current,options));
  }
  return { directory, store, broker, ready, sending, dispatchSend, view };
}
