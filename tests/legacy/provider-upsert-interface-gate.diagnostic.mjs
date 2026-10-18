/**
 * Interface gate BEFORE changing production code.
 *
 * Test both sides of the pinned installed Paseo contract:
 *   Provider -> plugin-provider.mapTimelineItem -> renderer.applyStreamEvent
 *   Provider -> plugin-provider.mapTimelineItem -> agent-manager.getLastAssistantMessage
 *                                     -> agent-prompt.setupFinishNotification
 *
 * CoS's "same logical message => replace" semantics are the desired output,
 * but the existing Paseo native assistant timeline is append-only.
 *
 * GATE-RED failures are intentional unmet user acceptance criteria, NOT tests
 * to weaken or silently skip. Real-host parity is opt-in and pinned to hashes.
 * No production code, user state, private app, or network is written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertPinnedAgentSource} from './fixtures/paseo-host-sources.mjs';
import path from 'node:path';
import vm from 'node:vm';
import {fixture,selection,until} from './helpers.mjs';
import {createProvider,CAPABILITIES} from '../server/provider.mjs';
import {createHostConverter,portableRender} from './fixtures/paseo-0.11.4-contract.mjs';
import {loadInstalledPaseoContract,realTranslate,realRender} from './fixtures/paseo-real-contract.mjs';

const installed=await loadInstalledPaseoContract();
const providerPath=process.env.CIP_PASEO_PROVIDER_SOURCE;
let realResultMethods=null;
if(providerPath) {
  const file=path.join(path.dirname(providerPath),'agent-manager.js');
  const source=await readFile(file,'utf8');
  assert(assertPinnedAgentSource(source,'agent-manager.js').includes(installed.appVersion),'Manager and renderer must be the same audited version');
  const beg=source.indexOf('    getLastAssistantMessageSegmentFromTimeline(timeline) {');
  const end=source.indexOf('\n    async getLastItemFromStores(agentId) {',beg);
  assert(beg>=0&&end>beg,'Original manager assistant-result methods not found');
  realResultMethods=vm.runInNewContext('({'+source.slice(beg,end).replace('\n    async getLastAssistantMessageFromStores(',',\n    async getLastAssistantMessageFromStores(')+'\n})');
  assert.equal(typeof realResultMethods.getLastAssistantMessageSegmentFromTimeline,'function');
  assert.equal(typeof realResultMethods.getLastAssistantMessageFromStores,'function');
}
function hostTranslate(events) {
  const translator=createHostConverter(),mapped=[];
  for(const event of events)
    mapped.push(...translator.translate(event));
  if(installed)
    assert.deepEqual(JSON.parse(JSON.stringify(mapped)),
      JSON.parse(JSON.stringify(realTranslate(events,installed).map(x=>{const {_source,...rest}=x;return rest;}))),
      'Native host conversion and portable 0.11.4 contract differ');
  return mapped;
}
function hostRender(events,mapped){
  const picture=portableRender(mapped);
  if(installed){
    const original=realRender(realTranslate(events,installed),installed);
    assert.deepEqual(picture.filter(x=>x.kind==='assistant_message').map(x=>x.text),
      original.filter(x=>x.kind==='assistant_message').map(x=>x.text),
      'Host assistant renderer parity failed');
    assert.deepEqual(picture.filter(x=>x.kind==='plugin').map(x=>x.data),
      original.filter(x=>x.kind==='plugin').map(x=>x.data),
      'Host plugin upsert parity failed');
  }
  return picture;
}
const timeline=mapped=>mapped.filter(e=>e.type==='timeline').map(e=>e.item);
function segment(timeline) {
  const chunks=[];
  let startsAtBeginning=false;
  for(let i=timeline.length-1;i>=0;i--){
    const item=timeline[i];
    if(item.type!=='assistant_message') {
      if(chunks.length) break;
      continue;
    }
    chunks.push(item.text);
    startsAtBeginning=i===0;
  }
  return chunks.length?{text:chunks.toReversed().join(''),startsAtBeginning}:null;
}
async function getLastAssistantMessage(items,{durableText=null,durableLastType='assistant_message'}={}){
  const portable=segment(items);
  let value;
  if(portable){
    if(portable.startsAtBeginning&&durableText&&durableLastType==='assistant_message')
      value=durableText+portable.text;
    else value=portable.text;
  } else value=durableText;
  if(realResultMethods){
    const core={
      ...realResultMethods,
      agents:new Map([['synthetic-agent',{}]]),
      timelineStore:{getItems:()=>items},
      durableTimelineStore:{
        getLastItem:async()=>durableText?{type:durableLastType,text:durableText}:null,
        getLastAssistantMessage:async()=>durableText
      }
    };
    const original=await core.getLastAssistantMessageFromStores('synthetic-agent');
    assert.equal(value,original,'Actual host native result differs from portable extraction');
    assert.deepEqual(portable,JSON.parse(JSON.stringify(core.getLastAssistantMessageSegmentFromTimeline(items))),
      'Actual host contiguous assistant extraction differs');
  }
  return value;
}
const userId='synthetic-user';
const answerId='assistant:synthetic-turn:synthetic-message';
const pluginId='chatmode-in-paseo';
const pluginAnswerId='synthetic-upsert';
const short='计划(1)。！';
const second='计划(1)。：\n| 模块 | 完成 |\n| --- | --- |\n| 回归 | 是 |';
const revised='计划(1)。：\n| 模块 | 完成 |\n| --- | --- |\n| 回归 | 已验证 |';
const final='计划(1)。：\n| 模块 | 完成 |\n| --- | --- |\n| 回归 | 已验证 |\n结果完成。';
const snapshots=[short,second,revised,final];
assert(snapshots.slice(1).every((s,i)=>s.length>snapshots[i].length));
assert(!second.startsWith(short)&&!revised.startsWith(second));
function run(events){
  const mapped=hostTranslate(events);
  const rendered=hostRender(events,mapped);
  return {mapped,rendered,items:timeline(mapped),
    displayAssistant:rendered.filter(x=>x.kind==='assistant_message').map(x=>x.text).join(''),
    displayPlugins:rendered.filter(x=>x.kind==='plugin'&&x.pluginId===pluginId)};
}
const start={type:'session.turn',sessionId:'synthetic-session',turnId:'synthetic-turn',state:'started'};
const end={type:'session.turn',sessionId:'synthetic-session',turnId:'synthetic-turn',state:'completed'};
const user={type:'timeline.item',sessionId:'synthetic-session',
  item:{type:'user_message',id:userId,text:'合成问题'}};
const native=text=>({type:'timeline.item',sessionId:'synthetic-session',
  item:{type:'assistant_message',id:answerId,text}});
const tool={type:'timeline.item',sessionId:'synthetic-session',item:{
  type:'tool_call',id:'synthetic-tool',callId:'synthetic-tool',name:'mymac · read',kind:'tool',
  status:'completed',error:null,detail:{type:'plain_text',text:'合成工具状态'}
}};
const plugin=(text,n)=>({type:'timeline.item',sessionId:'synthetic-session',item:{
  type:'plugin',id:pluginAnswerId,pluginId,kind:'synthetic-canonical-prose',
  version:1,data:{text,revision:n,complete:n===snapshots.length-1}
}});
const nativeStream=[start,user,native(short),tool,native(second),native(revised),native(final),end];
const pluginStream=[start,user,plugin(short,0),tool,plugin(second,1),plugin(revised,2),plugin(final,3),end];

test('GATE-GREEN native assistant produces final result for one monotonic update, no tools',async()=>{
  const exact='合成消息正常追加完毕';
  const values=[exact.slice(0,4),exact.slice(0,8),exact];
  const result=run([start,user,...values.map(native),end]);
  assert.equal(result.displayAssistant,exact);
  assert.equal(await getLastAssistantMessage(result.items),exact);
});

test('GATE-GREEN plugin card has one identity, updates in original position around tool, even on replay',()=>{
  const result=run(pluginStream);
  assert.equal(result.displayPlugins.length,1);
  assert.equal(result.displayPlugins[0].data.text,final);
  const cardAt=result.rendered.findIndex(x=>x.kind==='plugin'&&x.itemKind==='synthetic-canonical-prose');
  const toolAt=result.rendered.findIndex(x=>x.kind==='tool_call');
  assert(cardAt>=0&&toolAt>cardAt,'B: revised plugin item remains anchored before tool call');
  assert.equal(result.displayPlugins[0].data.complete,true);
  assert.equal(result.displayAssistant,'');
  // A resumed Provider session emits one persisted final upsert.
  const replay=run([start,user,plugin(final,3),tool,end]);
  assert.equal(replay.displayPlugins.length,1);
  assert.equal(replay.displayPlugins[0].data.text,final);
});

test('GATE-RED native monotonic chunks separated by a tool must still report full final',async()=>{
  const expected='合成答案已经完成';
  const events=[start,user,native(expected.slice(0,4)),tool,native(expected),end];
  const result=run(events);
  assert.equal(result.displayAssistant,expected,'Normal monotonic updates display exact prose');
  assert.equal(await getLastAssistantMessage(result.items),expected,
    'C: host returns only the last assistant chunk after an interleaved tool');
});

test('GATE-RED native-only flow must replace non-prefix revisions in place AND report exact final',async()=>{
  const result=run(nativeStream);
  assert.equal(result.displayAssistant,final,
    'A: native append-only assistant display duplicates non-prefix revisions');
  assert.equal(await getLastAssistantMessage(result.items),final,
    'C: machine result must reflect all same-ID revisions and interleaved tools');
});

test('GATE-RED plugin-only canonical upsert must still return the current native finish result',async()=>{
  const result=run(pluginStream);
  assert.equal(result.displayPlugins.length,1,'A/B: same-item upsert and stable order');
  assert.equal(await getLastAssistantMessage(result.items),final,
    'C: getLastAssistantMessage ignores plugin items; completion notification is empty');
});

test('GATE-RED plugin-only new turn must never return an older durable native answer',async()=>{
  const result=run(pluginStream);
  assert.equal(await getLastAssistantMessage(result.items,{durableText:'上一轮的合成答案'}),final,
    'C: plugin-only text returns last durable assistant instead of this turn');
});

test('GATE-RED plugin-live plus terminal-native would require forbidden dual-lane/duplicated answer',async()=>{
  const events=[...pluginStream.slice(0,-1),native(final),end];
  const result=run(events);
  assert.equal(await getLastAssistantMessage(result.items),final,
    'C: terminal native segment must satisfy completion');
  assert.equal(result.displayPlugins.length+
    result.rendered.filter(x=>x.kind==='assistant_message').length,1,
    'A: plugin prose plus native final duplicates one logical answer in two tracks');
});

test('GATE-GREEN SDK supports plugin data but no native replace or textual turn result',async()=>{
  // Default portable mode does not depend on any installed app/package.
  // Set CIP_SDK_MODULE=file:///.../@getpaseo/plugin/dist/server/provider.js
  // for an additional, strict schema check using the selected real SDK.
  const stream=[start,end,native(short),plugin(final,3)];
  assert.deepEqual(stream.map(e=>e.type),
    ['session.turn','session.turn','timeline.item','timeline.item']);
  if(realResultMethods){
    const promptSource=await readFile(path.join(path.dirname(providerPath),'agent-prompt.js'),'utf8');
    assert(assertPinnedAgentSource(promptSource,'agent-prompt.js').includes(installed.appVersion),'Prompt and renderer must be the same audited version');
    const startAt=promptSource.indexOf('function formatFinishNotificationBody(params) {');
    // beta.2 removed the comment that used to follow the function; the next
    // declaration exists in every audited version.
    const endAt=promptSource.indexOf('\nconst armedFinishNotifications',startAt);
    assert(startAt>=0&&endAt>startAt);
    const format=vm.runInNewContext('('+promptSource.slice(startAt,endAt)+')',
      {FINISH_NOTIFICATION_MESSAGE_LIMIT:4000});
    const params={childAgentId:'synthetic-agent',title:'synthetic',reason:'completed'};
    assert.equal(format({...params,lastAssistantMessage:null}).includes('<agent-response>'),false,
      'Actual Paseo completion drops answer payload when machine result is null');
    assert.equal(format({...params,lastAssistantMessage:'旧合成文本'}).includes('旧合成文本'),true,
      'Actual Paseo completion publishes previous durable text if returned by manager');
  }
  if(process.env.CIP_SDK_MODULE){
    const {ProviderEventSchema}=await import(process.env.CIP_SDK_MODULE);
    const change=ProviderEventSchema.parse({
      ...native(final),item:{...native(final).item,mode:'replace',seq:4,final:true}
    });
    assert.equal(change.item.type,'assistant_message');
    assert.equal('mode' in change.item,false);
    assert.equal('seq' in change.item,false);
    assert.equal('final' in change.item,false);
    const terminal=ProviderEventSchema.parse({...end,finalText:final});
    assert.equal('finalText' in terminal,false);
    const arbitrary=ProviderEventSchema.safeParse({type:'timeline.item',
      sessionId:'synthetic-session',item:{type:'assistant_revision',id:answerId,text:final}});
    assert.equal(arbitrary.success,false,'No public assistant revision event');
    const card=ProviderEventSchema.parse(plugin(final,3));
    assert.equal(card.item.data.text,final,'Plugin data is user-defined, but not machine result');
  }
});
