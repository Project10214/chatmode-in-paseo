import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fixture,selection,until} from './helpers.mjs';
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
  assert.deepEqual(value.reasoning,[{id:'reason-1',text:'正在比较两种实现方案'}]);
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

test('TIMELINE-04: broker native tool cards are upserted per callId with streamed status and reasoning',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  const seen=[];f.broker.subscribe(s.id,v=>seen.push(v));
  const observation=item=>f.broker.observe({...event,kind:'native_timeline',item});
  const publicTool={type:'tool_call',callId:'mcp-tool-1',name:'mymac · run_shell_command',
    kind:'tool',status:'running'};
  await observation(publicTool);
  await observation(publicTool);
  await observation({...publicTool,status:'completed'});
  await observation({type:'tool_call',callId:'mcp-tool-2',name:'tasks · list_items',
    kind:'search',status:'running'});
  await observation({type:'reasoning',id:'recap-1',text:'先核对代码'});
  await observation({type:'reasoning',id:'recap-1',text:'先核对代码，再确认错误'});
  await observation({type:'reasoning',id:'recap-1',text:'改写全部文本'});
  const history=f.broker.snapshot(s.id).history;
  const calls=history.filter(x=>x.type==='tool_call');
  assert.equal(calls.length,2);
  assert.equal(calls[0].status,'completed');
  assert.equal(calls[1].status,'running');
  assert.deepEqual(history.filter(x=>x.type==='reasoning').map(x=>x.text),['先核对代码，再确认错误']);
  assert.equal(seen.filter(x=>x.state==='native-timeline').length,5);
  assert.equal(f.broker.snapshot(s.id).status,'running');
  for(const invalid of [{...event,tabId:999},{...event,lease:'other'},{...event,nativeMessageId:'other'}])
    await assert.rejects(f.broker.observe({...invalid,kind:'native_timeline',item:publicTool}));
  await f.broker.observe({...event,kind:'snapshot',messageId:'final-answer',text:'答复'});
  await f.broker.observe({...event,kind:'completed',messageId:'final-answer',finalConfirmed:true});
  const finished=f.broker.snapshot(s.id);
  assert.equal(finished.history.find(x=>x.callId==='mcp-tool-1').status,'completed');
  assert.equal(finished.history.find(x=>x.callId==='mcp-tool-2').status,'canceled',
    'unknown tool outcome must not be invented as success');
  assert.equal(finished.turn.outcome,'completed');
});

test('TIMELINE-05: Paseo emits NATIVE reasoning and tool_call, retaining distinct identities',async t=>{
  const f=await fixture(t),events=[];
  const runtime={...f,status:()=>({connected:true})};
  const conn=await createProvider(runtime).connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>conn.close());conn.onEvent(e=>events.push(e));
  const config={cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,
    model:selection.model,thinkingOption:selection.thinkingOption,providerOptions:{appIds:selection.appIds}};
  const s=await f.ready(),{event}=await f.sending(s);
  await conn.send({type:'session.open',requestId:'bind',sessionId:'host',
    config,persistence:{version:1,data:{id:s.id}},history:'skip'});
  await until(()=>events.some(x=>x.type==='session.ready'));
  // Provider receives a native turn from its own existing observation mechanism.
  const toolCall={type:'tool_call',callId:'mcp-1',name:'mymac · search_text',
    kind:'search',status:'running'};
  await f.broker.observe({...event,kind:'native_timeline',item:toolCall});
  await f.broker.observe({...event,kind:'native_timeline',item:{...toolCall,status:'completed'}});
  await f.broker.observe({...event,kind:'native_timeline',item:{type:'reasoning',id:'thought-1',text:'已验证网页摘要'}});
  const interim=events.filter(x=>x.type==='timeline.item'&&
    ['tool_call','reasoning'].includes(x.item?.type));
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
  assert.deepEqual(value.calls.map(c=>c.status),['running','running'],
    'native completed=false MUST NOT be represented as tool success');
  for(const call of value.calls){
    const safe=nativeTimelineItem({type:'tool_call',...call},'real-turn');
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
