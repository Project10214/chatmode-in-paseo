import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fixture,pageView,selection,until} from './helpers.mjs';
import {nativeTimelineItem} from '../server/native-timeline.mjs';
import {createProvider,CAPABILITIES} from '../server/provider.mjs';

const script=await readFile(new URL('../extension/upstream/cos-activity-main.js',import.meta.url),'utf8');
const ctx=vm.createContext({});
vm.runInContext(script,ctx);
const project=turn=>JSON.parse(JSON.stringify(ctx.CIP_COS_ACTIVITY.publicTimeline(turn)));
const tool=(id,extra={})=>({type:'mcp-tool-call',callId:id,completed:false,
  invocation:{server:'mymac',tool:'run_shell_command',
    arguments:{password:'PRIVATE_TOKEN'},response:{secret:'NEVER_EXPOSE'}},...extra});

test('TIMELINE-01: public reasoning recap and separate tool call identities, no hidden CoT or raw arguments',()=>{
  const value=project({status:'in_progress',items:[
    {type:'chatgpt-reasoning-group',id:'reason-1',
      reasoningRecap:{type:'show',summary:'正在比较两种实现方案'},
      activeReasoning:{text:'PRIVATE_COT',presentation:'thought'},
      items:[tool('call-a'),tool('call-hidden',{channel:'analysis'})]},
    tool('call-b',{invocation:{server:'tasks',tool:'get_item',arguments:{apiKey:'NEVER_EXPOSE'}}}),
    tool('secret',{metadata:{is_visually_hidden_from_conversation:true}})
  ]});
  assert.deepEqual(value.reasoning,[{id:'reason-1',text:'正在比较两种实现方案',position:[0,-1]}]);
  assert.deepEqual(value.calls.map(x=>x.callId),['call-a','call-b']);
  assert(value.calls.every(c=>c.status==='running'));
  assert.equal(JSON.stringify(value).includes('PRIVATE_COT'),false);
  assert.equal(JSON.stringify(value).includes('PRIVATE_TOKEN'),false);
  assert.equal(JSON.stringify(value).includes('NEVER_EXPOSE'),false);
});
test('TIMELINE-02: hidden reasoning groups, raw analysis and untrusted tool names never leak',()=>{
  const value=project({status:'in_progress',items:[
    {type:'chatgpt-reasoning-group',reasoningRecap:{type:'hide_all',summary:'HIDDEN'},
      items:[tool('nested')]},
    {type:'chatgpt-reasoning-group',channel:'analysis',
      reasoningRecap:{type:'show',summary:'SECRET'},items:[tool('hidden-2')]},
    tool('private',{recipient:'analysis'}),
    tool('public',{invocation:{server:'mymac',tool:'read'},completed:true}),
    {type:'chatgpt-reasoning-group',id:'bad',
      reasoningRecap:{type:'raw_cot',text:'RAW_COT'},items:[]}
  ]});
  assert.equal(value.reasoning.length,0);
  assert.equal(value.calls.length,1);
  assert.equal(value.calls[0].callId,'public');
  assert.equal(value.calls[0].status,'completed');
});

test('TIMELINE-03: server strictly rejects arbitrary private details and foreign call status',()=>{
  for(const bad of [
    {type:'tool_call',callId:'call-a',name:'mymac · run_shell_command',kind:'tool',status:'running',
      arguments:{private:'SECRET'}},
    {type:'tool_call',callId:'call-a',name:'mymac · run_shell_command',kind:'tool',status:'success'},
    {type:'tool_call',callId:'call-a',name:'https://secret.example/x',kind:'tool',status:'running'},
    {type:'reasoning',id:'reason-a',text:'public',rawThought:'UNSAFE'},
    {type:'reasoning',id:'reason-a',text:'x'.repeat(5000)}
  ])assert.throws(()=>nativeTimelineItem(bad,'turn-1'));
});

test('TIMELINE-04: tool and reasoning sources upsert by source identity without inventing outcomes',async t=>{
 const f=await fixture(t),s=await f.ready();await f.sending(s);
 const tool=(id,status,text)=>({id,userMessageId:null,role:'page',lane:'process',kind:'tool_call',
  text,format:'text',order:[1],callId:'call-'+id,name:'mymac · run_shell_command',status});
 const reasoning=(text)=>({id:'recap-1',userMessageId:null,role:'assistant',lane:'process',
  kind:'reasoning',text,format:'markdown',order:[2]});
 const frame=options=>f.view(s,options);
 await frame({items:[tool('tool-1','running','running read')]});
 await frame({items:[tool('tool-1','completed','completed read')]});
 await frame({items:[tool('tool-1','completed','completed read'),tool('tool-2','running','second call')]});
 await frame({items:[tool('tool-1','completed','completed read'),tool('tool-2','running','second call'),
  reasoning('先核对代码')]});
 await frame({items:[tool('tool-1','completed','completed read'),tool('tool-2','running','second call'),
  reasoning('先核对代码，再确认错误')]});
 const history=f.broker.snapshot(s.id).history;
 const calls=history.filter(x=>x.type==='tool_call');
 assert.equal(calls.length,2,'two callIds are two cards');
 assert.equal(calls[0].status,'completed');assert.equal(calls[1].status,'running');
 const recaps=history.filter(x=>x.type==='reasoning');
 assert.deepEqual(recaps.map(x=>x.text),['先核对代码，再确认错误'],'the same source updates in place');
 assert.equal(new Set(recaps.map(x=>x.id)).size,1);
 assert.equal(f.broker.snapshot(s.id).status,'running','a tool status is not turn completion');
 await assert.rejects(f.broker.observeView({...pageView(f.broker.snapshot(s.id)),observationLease:'other'}));
 await frame({state:'standby',items:[tool('tool-1','completed','completed read'),
  tool('tool-2','running','second call'),reasoning('先核对代码，再确认错误')]});
 const finished=f.broker.snapshot(s.id);
 assert.equal(finished.turn.outcome,'completed');
 assert.equal(finished.history.find(x=>x.callId==='call-tool-2').status,'running',
  'standby does not invent a finished/canceled tool');
});
test('TIMELINE-05: Paseo emits stable tool/reasoning items and a reconnect replays each once',async t=>{
 const f=await fixture(t),events=[];
 const runtime={...f,status:()=>({connected:true})};
 const config={cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,
  model:selection.model,thinkingOption:selection.thinkingOption,providerOptions:{appIds:selection.appIds}};
 const conn=await createProvider(runtime).connect({versions:[1],capabilities:CAPABILITIES});
 t.after(()=>conn.close());conn.onEvent(e=>events.push(e));
 const s=await f.ready();await f.sending(s);
 await conn.send({type:'session.open',requestId:'bind',sessionId:'host',
  config,persistence:{version:1,data:{id:s.id}},history:'skip'});
 await until(()=>events.some(x=>x.type==='session.ready'));
 const tool=(status,text)=>({id:'tool-source',userMessageId:null,role:'page',lane:'process',
  kind:'tool_call',text,format:'text',order:[1],callId:'mcp-1',name:'mymac · search_text',status});
 const recap={id:'thought-1',userMessageId:null,role:'assistant',lane:'process',kind:'reasoning',
  text:'已验证网页摘要',format:'markdown',order:[2]};
 await f.view(s,{items:[tool('running','searching')]});
 await f.view(s,{items:[tool('completed','searched'),recap]});
 const interim=events.filter(x=>x.type==='timeline.item'&&['tool_call','reasoning'].includes(x.item?.type));
 assert.deepEqual(interim.map(x=>x.item.type),['tool_call','tool_call','reasoning']);
 assert.equal(interim[0].item.id,interim[1].item.id);
 assert.equal(interim[0].item.status,'running');
 assert.equal(interim[1].item.status,'completed');
 await conn.close();
 const reopened=await createProvider(runtime).connect({versions:[1],capabilities:CAPABILITIES});
 t.after(()=>reopened.close());
 const replay=[];reopened.onEvent(e=>replay.push(e));
 await reopened.send({type:'session.open',requestId:'replay',sessionId:'host-again',
  config,persistence:{version:1,data:{id:s.id}},history:'replay'});
 await until(()=>replay.some(x=>x.type==='session.ready'));
 assert.equal(replay.filter(x=>x.type==='timeline.item'&&x.item?.type==='tool_call').length,1);
 assert.equal(replay.filter(x=>x.type==='timeline.item'&&x.item?.type==='reasoning').length,1);
});
test('TIMELINE-REAL: signed-in ChatGPT link_<hex>/read tool IDs yield two separate public Paseo tool cards',()=>{
  // Captured public metadata only, from actual user-visible, completed ChatGPT
  // turn after two independent mymac read calls on unpredictable test files.
  // Never include invocation arguments or tool result payloads in the fixture.
  const link='link_6a61dca44c3c81918f489578c4f991b8/read';
  const turns=[
    {type:'mcp-tool-call',callId:'a4dd7864-e8c9-4d3a-9d00-ac6d5a7e00a1',
      invocation:{server:'mymac',tool:link},completed:false},
    {type:'mcp-tool-call',callId:'9b34512b-d6c5-482d-9b65-31b1f5595b41',
      invocation:{server:'mymac',tool:link},completed:false}
  ];
  const turn={status:'complete',items:[
    {type:'user-message',messageId:'native-user',message:'Challenge A and B'},
    {type:'chatgpt-reasoning-group',id:'public-recap',reasoningRecap:{
      type:'collapse',summary:'Inspected and verified two independent fixture files'},
      completed:true,items:turns},
    {type:'assistant-message',messageId:'assistant-final',completed:true,phase:'final_answer'}
  ]};
  const value=project(turn);
  assert.deepEqual(value.calls.map(c=>c.callId),turns.map(t=>t.callId));
  assert.deepEqual(value.calls.map(c=>c.name),['mymac · read','mymac · read']);
  // The turn is complete, so these calls are no longer running; they are
  // marked as settled by the turn end, which the card states explicitly.
  assert.deepEqual(value.calls.map(c=>[c.status,c.settled]),[['completed',true],['completed',true]]);
  for(const call of value.calls){
    const {position,...publicCall}=call;
    assert.equal(position[0],1);
    const safe=nativeTimelineItem({type:'tool_call',...publicCall},'real-turn');
    assert.equal(safe.name,'mymac · read');
    assert.equal(safe.type,'tool_call');
    assert(!JSON.stringify(safe).includes('link_'),'internal connector ID must not leak to Paseo');
  }
  assert(value.reasoning.length===1);
  assert(!JSON.stringify(value).includes('link_'));
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.CIP_COS_ACTIVITY.viewCallsOf(turn.items)))
    .map(x=>x.label),['mymac · read','mymac · read']);
});
test('TIMELINE-REAL-SAFETY: linked-tool decoder rejects paths, URLs and hidden connector calls',()=>{
  const raw=[
    tool('ok',{invocation:{server:'mymac',tool:'link_'+ 'a'.repeat(32)+'/read'}}),
    tool('path',{invocation:{server:'mymac',tool:'link_'+ 'a'.repeat(32)+'/../../private'}}),
    tool('url',{invocation:{server:'mymac',tool:'https://example.com/read'}}),
    tool('too-short',{invocation:{server:'mymac',tool:'link_abcdef/read'}}),
    tool('hidden',{invocation:{server:'mymac',tool:'link_'+ 'a'.repeat(32)+'/read'},channel:'analysis'})
  ];
  const value=project({status:'in_progress',items:raw});
  assert.deepEqual(value.calls.map(x=>x.callId),['ok']);
  assert.deepEqual(value.calls.map(x=>x.name),['mymac · read']);
});

test('TIMELINE-APP: an approval-gated app call shows one readable card; the wait step is not a card', async () => {
  const {recordNativeTimeline, toolOrigin} = await import('../server/native-timeline.mjs');
  const apps = [{id: 'asdk_app_6a61dc538d588191aba0dea895a73f80', label: 'mymac'}];
  const session = {turn: {id: 't1'}, history: []};
  const shown = [];
  const feed = (callId, name, status) => {
    const input = {type: 'tool_call', callId, name, kind: 'tool', status};
    const out = recordNativeTimeline(session, nativeTimelineItem(input, 't1', {apps}), {origin: toolOrigin(input, apps)});
    if (out?.item) shown.push(out.item);
  };
  // Order observed on the live page (2026-10-17): waiting card, wait step, then the run.
  feed('c-pending', 'asdk_app_6a61dc538d588191aba0dea895a73f80 · run_shell_command', 'running');
  feed('c-wait', 'codex_apps · mymac.approval_wait', 'completed');
  feed('c-run', 'codex_apps · mymac.run_shell_command', 'running');
  feed('c-run', 'codex_apps · mymac.run_shell_command', 'completed');
  feed('c-pending', 'asdk_app_6a61dc538d588191aba0dea895a73f80 · run_shell_command', 'running');
  const cards = session.history.filter(r => r.type === 'tool_call');
  assert.equal(cards.length, 1, JSON.stringify(cards));
  assert.equal(cards[0].name, 'mymac · run_shell_command');
  assert.equal(cards[0].status, 'completed');
  assert.equal(cards[0].id, 'tool:t1:c-pending');
  assert(shown.every(i => i.id === 'tool:t1:c-pending' && i.name === 'mymac · run_shell_command'));
  // A second approval-gated call is its own card.
  feed('c-pending-2', 'asdk_app_6a61dc538d588191aba0dea895a73f80 · run_shell_command', 'running');
  feed('c-run-2', 'codex_apps · mymac.run_shell_command', 'completed');
  assert.deepEqual(session.history.map(r => [r.id, r.status]), [['tool:t1:c-pending', 'completed'], ['tool:t1:c-pending-2', 'completed']]);
  // Unknown app ids never leak the raw id; other servers keep their name.
  assert.equal(nativeTimelineItem({type: 'tool_call', callId: 'x', name: 'asdk_app_unknown123 · read', kind: 'tool', status: 'running'}, 't1', {apps}).name, 'ChatGPT 应用 · read');
  assert.equal(nativeTimelineItem({type: 'tool_call', callId: 'y', name: 'tasks · get_item', kind: 'tool', status: 'running'}, 't1', {apps}).name, 'tasks · get_item');
});

test('TIMELINE-DONE: tool calls of a turn ChatGPT reports complete are completed even without per-call flags', () => {
  const done = project({status: 'complete', items: [tool('call-a'), tool('call-b', {status: 'failed'}), tool('call-c', {completed: true})]});
  assert.deepEqual(done.calls.map(c => [c.callId, c.status, c.settled ?? false]), [['call-a', 'completed', true], ['call-b', 'failed', false], ['call-c', 'completed', false]]);
  const card = nativeTimelineItem({type: 'tool_call', callId: 'call-a', name: 'presure · state', kind: 'tool', status: 'completed', settled: true}, 't1');
  assert.equal(card.status, 'completed');
  assert.match(card.detail.text, /网页未单独确认此调用的结果/);
  assert.throws(() => nativeTimelineItem({type: 'tool_call', callId: 'x', name: 'a · b', kind: 'tool', status: 'running', settled: true}, 't1'), /NATIVE_TIMELINE_INVALID/);
  const live = project({status: 'in_progress', items: [tool('call-a')]});
  assert.equal(live.calls[0].status, 'running');
});
