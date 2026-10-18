/**
 * Stage 1 regression investigation: no production changes.
 *
 * Assertions run through the ACTUAL Provider/Broker, a pinned 0.11.4 daemon
 * snapshot-to-delta compatibility contract, and a narrow host renderer model.
 * With CIP_PASEO_PROVIDER_SOURCE + CIP_PASEO_RENDERER_BUNDLE, the same events
 * are ALSO run against the untouched installed daemon mapper and Metro 3661.
 *
 * Most importantly, the default tests run in a clean clone without a Paseo
 * installation; no tests are silently skipped. Observations below are
 * SYNTHETIC, not claimed to have happened in the user's production session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fixture,selection,until} from './helpers.mjs';
import {createProvider,CAPABILITIES} from '../server/provider.mjs';
import {PASEO_0114,createHostConverter,portableRender} from './fixtures/paseo-0.11.4-contract.mjs';
import {loadInstalledPaseoContract,realTranslate,realRender} from './fixtures/paseo-real-contract.mjs';

const actualHost=await loadInstalledPaseoContract();
const answerId='assistant-native-one';
const partial='收到两张图片';
const finalText='收到两张图片，一张是电影画面，另一张是文字截图。';
// Shapes ONLY from the approved 2026-10-16 metadata; these are wholly
// synthetic words and punctuation. No historical body, ID or raw log.
const fieldSizes=[7,177,250,393,451,499,580,598];
const lcp=(a,b)=>{let n=0;while(n<Math.min(a.length,b.length)&&a[n]===b[n])n++;return n;};
function shapedText(prefix,total,end=''){
  assert(prefix.length+end.length<=total);
  const filler='示例内容·合成记录\n| 项目 | 状态 |\n|---|---|\n| 本轮 | 校验 |\n';
  return prefix+filler.repeat(Math.ceil((total-prefix.length-end.length)/filler.length))
    .slice(0,total-prefix.length-end.length)+end;
}
function fieldShapedSnapshots(){
  const s0='计划(1)。！'; // 7 UTF-16 units
  const s1=shapedText(s0.slice(0,-1)+'：\n\n| 阶段 | 结果 |\n| --- | --- |',177,'--');
  const s2=shapedText(s1.slice(0,175)+'）\n| 校验 | 合成 |',250,'?');
  const s3=shapedText(s2.slice(0,249)+']\n> 合成数据',393);
  const parts=[s0,s1,s2,s3];
  for(const size of fieldSizes.slice(4))parts.push(shapedText(parts.at(-1)+'\n| 行 | 合成 |\n',size));
  assert.deepEqual(parts.map(x=>x.length),fieldSizes);
  assert.deepEqual(parts.slice(1).map((x,i)=>lcp(parts[i],x)),[6,175,249,393,451,499,580]);
  return parts;
}
const cfg={cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,
  model:selection.model,thinkingOption:selection.thinkingOption,providerOptions:{appIds:selection.appIds}};
const assistant=rows=>rows.filter(x=>x.kind==='assistant_message');
const assistantsText=rows=>assistant(rows).map(x=>x.text).join('');
const activity=rows=>rows.filter(x=>x.kind==='plugin'&&x.itemKind==='native-activity');
const tool=rows=>rows.filter(x=>x.kind==='tool_call');

function translate(events,replay=false){
  const converter=createHostConverter();
  let isReplay=replay;
  const output=[];
  for(const item of events){
    if(item.type==='session.ready'){isReplay=false;continue;}
    output.push(...converter.translate(item).map(e=>({...e,_source:isReplay?'replay':'live'})));
  }
  return output;
}
const plain = value => JSON.parse(JSON.stringify(value));
function diagnose(t,events,initialReplay=false) {
  const converted=translate(events,initialReplay);
  const rendered=portableRender(converted);
  if(actualHost){
    const nativeConverted=realTranslate(events,actualHost,initialReplay);
    assert.deepEqual(plain(converted),plain(nativeConverted),
      'Pinned contract adapter must produce exactly the real daemon translation');
    const nativeRendered=realRender(nativeConverted,actualHost);
    assert.deepEqual(assistant(rendered).map(x=>x.text),assistant(nativeRendered).map(x=>x.text),
      'Pinned renderer subset diverged from real Metro 3661 assistant segmentation');
    assert.deepEqual(activity(rendered).map(x=>x.data.phase),activity(nativeRendered).map(x=>x.data.phase));
    assert.equal(tool(rendered).length,tool(nativeRendered).length);
  }
  t.diagnostic('daemon assistant deltas='+JSON.stringify(converted.filter(
    x=>x.type==='timeline'&&x.item.type==='assistant_message').map(x=>x.item.text)));
  return {converted,rendered};
}

async function attach(t,f,s,{hostId='host',history='skip'}={}){
  const events=[];
  const provider=await createProvider({...f,status:()=>({connected:true})})
    .connect({versions:[1],capabilities:CAPABILITIES});
  t.after(()=>provider.close());provider.onEvent(e=>events.push(e));
  await provider.send({type:'session.open',requestId:'open-'+hostId,sessionId:hostId,
    config:cfg,persistence:{version:1,data:{id:s.id}},history});
  await until(()=>events.some(e=>e.type==='session.ready'));
  assert.equal(events.some(e=>e.type==='request.failed'||e.type==='session.runtime_failed'),false);
  return {provider,events};
}

async function fixtureScenario(t,{pieces=[partial,finalText],interleave='none'}={}){
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  const connected=await attach(t,f,s);
  const input={...event,kind:'snapshot',messageId:answerId};
  await f.broker.observe({...input,text:pieces[0]});
  if(interleave==='activity')await f.broker.observe({...event,kind:'activity',activity:{
    phase:'thinking',nativeStatus:'in_progress',steps:[]}});
  if(interleave==='tool')await f.broker.observe({...event,kind:'native_timeline',item:{
    type:'tool_call',callId:'call-1',kind:'tool',status:'running',
    name:'mymac · read'
  }});
  for(const text of pieces.slice(1))await f.broker.observe({...input,text});
  // Polling an exact duplicate MUST NOT create a new broker event.
  await f.broker.observe({...input,text:pieces.at(-1)});
  await f.broker.observe({...event,kind:'completed',messageId:answerId,finalConfirmed:true});
  await until(()=>connected.events.some(x=>x.type==='session.turn'&&x.state==='completed'));
  return {f,s,event,provider:connected.provider,events:connected.events,history:f.broker.snapshot(s.id).history,
    expected:pieces.at(-1)};
}

test('HOST-0.11.4: pinned source/version documented, fixtures never silently skip',()=>{
  assert.equal(PASEO_0114.appVersion,'0.11.4');
  assert.equal(PASEO_0114.sdkVersion,'0.11.2');
  assert.match(PASEO_0114.daemonFileSha256,/^[a-f0-9]{64}$/);
  assert.match(PASEO_0114.webBundleSha256,/^[a-f0-9]{64}$/);
  assert.equal(typeof createHostConverter().translate,'function');
});

test('GREEN: monotonically growing full Provider snapshots become only host deltas',async t=>{
  const {events,history,expected}=await fixtureScenario(t);
  const raw=events.filter(e=>e.type==='timeline.item'&&e.item?.type==='assistant_message');
  assert.deepEqual(raw.map(e=>e.item.text),[partial,expected],
    'Full snapshots are CORRECT Provider input, not pre-delta text');
  assert.equal(new Set(raw.map(x=>x.item.id)).size,1);
  assert.deepEqual(history.filter(e=>e.type==='assistant_message').map(x=>x.text),[expected]);
  const {rendered,converted}=diagnose(t,events);
  assert.deepEqual(converted.filter(x=>x.type==='timeline'&&x.item.type==='assistant_message')
    .map(x=>x.item.text),[partial,expected.slice(partial.length)]);
  assert.equal(assistantsText(rendered),expected);
});

test('GREEN: activity card interleaves same-id snapshot updates without duplication',async t=>{
  const {events,expected}=await fixtureScenario(t,{interleave:'activity'});
  const {rendered}=diagnose(t,events);
  assert.equal(assistantsText(rendered),expected,'A split around a card is not itself duplication');
  assert.equal(activity(rendered).length,1,'Host upserts the plugin identity');
  assert.equal(activity(rendered)[0].data.phase,'completed');
});

test('GREEN: native tool card interleaves same-id snapshot updates without duplication',async t=>{
  const pieces=['我继续 PRESURE。','我继续 PRESURE。先检查代码和实际文件。'];
  const {events,expected}=await fixtureScenario(t,{interleave:'tool',pieces});
  const {rendered}=diagnose(t,events);
  assert.equal(tool(rendered).length,1);
  assert.equal(assistantsText(rendered),expected,'Two display segments may form one coherent response');
});

test('GREEN: completed history replay uses one canonical saved snapshot',async t=>{
  const {f,s,provider,history,expected}=await fixtureScenario(t,{interleave:'activity'});
  await provider.close();
  const reopened=await attach(t,f,s,{hostId:'replay',history:'replay'});
  const {rendered}=diagnose(t,reopened.events,true);
  assert.equal(history.filter(x=>x.type==='assistant_message').length,1);
  assert.equal(assistantsText(rendered),expected);
  assert.equal(activity(rendered).length,1);
});

test('GREEN: active turn restoration seeds NEW host snapshot Map before live extension',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  const input={...event,kind:'snapshot',messageId:answerId};
  await f.broker.observe({...input,text:partial});
  const resumed=await attach(t,f,s,{hostId:'resumed',history:'replay'});
  assert(resumed.events.some(e=>e.type==='timeline.item'&&e.item.type==='assistant_message'&&e.item.text===partial));
  await f.broker.observe({...input,text:finalText});
  await f.broker.observe({...event,kind:'completed',messageId:answerId,finalConfirmed:true});
  await until(()=>resumed.events.some(e=>e.type==='session.turn'&&e.state==='completed'));
  const {rendered}=diagnose(t,resumed.events,true);
  assert.equal(assistantsText(rendered),finalText);
  assert.equal(f.broker.snapshot(s.id).history.filter(e=>e.type==='assistant_message').length,1);
});

test('RED controlled same-id shrink then full: host currently repeats previously displayed prefix',async t=>{
  const middle='收到两张图片';
  const pieces=['收到两张图片，一张',middle,finalText];
  const {events,expected,history}=await fixtureScenario(t,{pieces});
  const {rendered}=diagnose(t,events);
  assert.deepEqual(history.filter(x=>x.type==='assistant_message').map(x=>x.text),[expected]);
  assert.equal(assistantsText(rendered),expected,
    'Observed host duplicates earlier content after a NON-PREFIX shrink. This order is SYNTHETIC, not proven historical.');
});

test('RED controlled same-id rewrite: host currently repeats common prefix on changed suffix',async t=>{
  const pieces=['收到两张图片，一张是游戏截图','收到两张图片，一张是电影画面'];
  const {events,expected}=await fixtureScenario(t,{pieces});
  const {rendered}=diagnose(t,events);
  assert.equal(assistantsText(rendered),expected,
    'Non-prefix change is currently appended, not replaced; duplicate prefix is visible');
});

test('DESIGN-GREEN synthetic plugin upsert can replace a full snapshot without native assistant append',t=>{
  // Future protocol option only. No corresponding answer renderer is
  // implemented; this checks host item identity and replacement semantics.
  const pieces=fieldShapedSnapshots();
  const events=[
    {type:'session.turn',turnId:'synthetic-turn',state:'started'},
    ...pieces.map((text,revision)=>({type:'timeline.item',sessionId:'synthetic-session',
      item:{type:'plugin',id:'synthetic-answer-text',pluginId:'chatmode-in-paseo',
        kind:'synthetic-revisable-answer',version:1,data:{revision,text}}})),
    {type:'session.turn',turnId:'synthetic-turn',state:'completed'}
  ];
  const {rendered}=diagnose(t,events);
  const cards=rendered.filter(x=>x.kind==='plugin'&&x.itemKind==='synthetic-revisable-answer');
  assert.equal(cards.length,1,'One plugin identity must upsert in place');
  assert.equal(cards[0].data.text,pieces.at(-1));
  assert.equal(assistant(rendered).length,0,'Do not mix a second append-only assistant stream');
  if(actualHost){
    const original=realRender(realTranslate(events,actualHost),actualHost);
    const realCard=original.filter(x=>x.kind==='plugin'&&x.itemKind==='synthetic-revisable-answer');
    assert.equal(realCard.length,1);
    assert.equal(realCard[0].data.text,pieces.at(-1));
  }
});

test('DESIGN-LIMIT a startsWith-only guard can leave incorrect final text forever',()=>{
  const pieces=fieldShapedSnapshots();
  let published='';
  for(const full of pieces){
    if(full.startsWith(published))published=full;
  }
  assert.equal(published,pieces[0],'Every later verified snapshot can differ at the initial last character');
  assert.notEqual(published,pieces.at(-1),'Filtering non-prefix events cannot repair the completed answer');
});

test('FIELD-GREEN synthetic 7→177→250→393→451→499→580→598 stable-prefix control',async t=>{
  const final=shapedText('计划(1)。！\n\n| 阶段 | 结果 |\n| --- | --- |\n',598);
  const pieces=fieldSizes.map(n=>final.slice(0,n));
  assert.deepEqual(pieces.map(x=>x.length),fieldSizes);
  assert(pieces.slice(1).every((x,i)=>x.startsWith(pieces[i])));
  const {events,expected}=await fixtureScenario(t,{pieces,interleave:'activity'});
  const {rendered}=diagnose(t,events);
  assert.equal(assistantsText(rendered),expected);
});

test('FIELD-RED metadata-matched increasing lengths with edits of 1–2 old tail units',async t=>{
  // Observed metadata pattern only: 7->177 LCP 6, 177->250 LCP 175,
  // 250->393 LCP 249, then monotonically extending. Synthetic punctuation,
  // parentheses and Markdown table are NOT facts about the user's answer.
  const pieces=fieldShapedSnapshots();
  assert(pieces.slice(1,4).every((text,i)=>
    text.length>pieces[i].length && !text.startsWith(pieces[i])));
  const {events,history,expected}=await fixtureScenario(t,{pieces,interleave:'activity'});
  assert.deepEqual(history.filter(x=>x.type==='assistant_message').map(x=>x.text),[expected]);
  const {rendered,converted}=diagnose(t,events);
  assert.equal(converted.filter(x=>x.type==='timeline'&&x.item.type==='assistant_message').length,
    pieces.length);
  assert.equal(assistantsText(rendered),expected,
    'Host cannot revise already emitted characters; increasing length alone is not monotonic');
});

test('OBSERVER-GREEN same-monitor pending RPC serializes overlapping synthetic polls',async()=>{
  const source=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
  const site='https://chatgpt.com/c/synthetic-conversation',cid='synthetic-conversation';
  const extensionId='a'.repeat(32),documentKey='synthetic-document';
  let listener=null,release=null,current='准备步骤',count=0;
  const observed=[];
  const D={
    conversationId:()=>cid,refreshTranscript:async()=>{},
    state:()=>({busy:true,waiting:false,error:null,activity:null,timeline:null,
      answer:{id:current==='准备步骤'?'synthetic-answer':'synthetic-next',text:current,final:false,messageState:'complete',format:'text',readable:true},images:[],imageFinalId:null}),
    messages:()=>[]
  };
  const context={crypto:{subtle:webcrypto.subtle,randomUUID:()=>documentKey},TextEncoder,Promise,setTimeout,clearTimeout,
    performance:{now:()=>1000},URL,
    location:{hostname:'chatgpt.com',pathname:'/c/'+cid,href:site},
    addEventListener:()=>{},removeEventListener:()=>{},
    setInterval:()=>1,clearInterval:()=>{},CIP_DOM:D,
    chrome:{runtime:{id:extensionId,onMessage:{addListener:fn=>listener=fn},
      sendMessage:async message=>{
        if(message.type==='observation'&&message.event.kind==='message'){
          observed.push(message.event.text);
          count++;
          const e=message.event,revision=createHash('sha256').update(JSON.stringify([e.messageId,e.format,e.messageState,e.text])).digest('hex');
          const value={active:true,receipt:{messageId:e.messageId,revision,disposition:'stored',host:'unconfirmed'}};
          if(count===1)return new Promise(resolve=>{release=()=>resolve({ok:true,value});});
          return {ok:true,value};
        }
        return {ok:true,value:{active:true}};
      }
    }}
  };
  vm.runInNewContext(source,context,{filename:'extension/content.js'});
  const monitor={sessionId:'synthetic-session',turnId:'synthetic-turn',
    lease:'synthetic-lease',tabId:1,documentKey,
    conversationId:cid,nativeMessageId:'synthetic-user'};
  const pulse=()=>new Promise(resolve=>listener({type:'monitor',session:monitor},
    {id:extensionId},resolve));
  await pulse();
  await until(()=>observed.length===1&&typeof release==='function');
  current='准备步骤与完成情况';
  await pulse();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(observed,['准备步骤'],'Pending snapshot RPC must block a second observation');
  release();
  await new Promise(resolve=>setImmediate(resolve));
  await pulse();
  await until(()=>observed.length===2);
  assert.deepEqual(observed,['准备步骤','准备步骤与完成情况']);
});

test('READER-GREEN complete-message projection preserves raw punctuation and decodes only at receiver',async t=>{
  const core=await readFile(new URL('../extension/upstream/cos-transcript-core.js',import.meta.url),'utf8');
  const shell=await readFile(new URL('../extension/upstream/cos-shell-public.js',import.meta.url),'utf8');
  const ctx=vm.createContext({location:{pathname:'/c/synthetic'},addEventListener(){}});
  vm.runInContext(core,ctx);vm.runInContext(shell,ctx);
  const raw=String.raw`| 公式 | \(x\)`;
  const item={type:'assistant-message',messageId:answerId,phase:'final_answer',completed:true,
    content:'::chatgpt-content-reference{synthetic}',contentReferences:[{type:'dil',source_message_id:answerId,model_dil_v2:{fallbackMarkdown:raw}}]};
  const result=ctx.CIP_COS_SHELL_PUBLIC.sourceFor({memoizedProps:{turn:{status:'complete',items:[
    {type:'user-message',messageId:'synthetic-user',message:'example'},item]}}},
    {matches:()=>true,closest:()=>null},{conflict:false,conversationId:'synthetic'});
  const native=result.messages.find(x=>x.id===answerId);
  assert.equal(native.metadata.cipMessageState,'complete');
  assert.equal(ctx.CIP_COS_PUBLIC_CORE.authoredText(native),raw);
  assert.equal(ctx.CIP_PUBLIC_PROSE,undefined);
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s),connected=await attach(t,f,s);
  const ack=await f.broker.observe({...event,kind:'message',messageId:answerId,text:raw,format:'dil',messageState:'complete'});
  await f.broker.observe({...event,kind:'completed',finalConfirmed:true,messageId:answerId,finalRevision:ack.receipt.revision});
  const {rendered}=diagnose(t,connected.events);
  assert.equal(assistantsText(rendered),raw);
});

/** Synthetic pre-completion DOM changes stay local; only the completed message
 * crosses the actual observer/Broker/Provider/host chain. No live source claim. */
test('GREEN pending DOM rollback is not published by the complete-message observer',async t=>{
  const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
  const connected=await attach(t,f,s);
  const source=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
  const publicReaderSource=await readFile(new URL('../extension/upstream/cos-transcript-core.js',import.meta.url),'utf8');
  const publicContext=vm.createContext({});
  vm.runInContext(publicReaderSource,publicContext);
  const nativeMessage={id:answerId,author:{role:'assistant'},
    content:{content_type:'text',parts:['']}};
  const nativeText=()=>publicContext.CIP_COS_PUBLIC_CORE.authoredText(nativeMessage);
  const cid=f.broker.snapshot(s.id).conversationId;
  const location={hostname:'chatgpt.com',pathname:'/c/'+cid,href:'https://chatgpt.com/c/'+cid};
  const extensionId='a'.repeat(32);
  let listener=null,observationCount=0,done=false;
  const submitted=[];
  const D={
    conversationId:()=>cid,
    refreshTranscript:async()=>{},
    state:()=>({busy:!done,waiting:false,error:null,activity:{phase:done?'completed':'thinking',nativeStatus:done?'complete':'in_progress',steps:[]},timeline:null,
      answer:{id:answerId,text:nativeText(),final:done,messageState:done?'complete':'pending',format:'text',readable:true},images:[],imageFinalId:null}),
    messages:()=>[]
  };
  const context={
    crypto:{subtle:webcrypto.subtle,randomUUID:()=>event.documentKey},TextEncoder,Promise,setTimeout,clearTimeout,
    performance:{now:()=>1000},URL,location,
    addEventListener:()=>{},removeEventListener:()=>{},
    setInterval:()=>1,clearInterval:()=>{},CIP_DOM:D,
    chrome:{runtime:{id:extensionId,onMessage:{addListener:fn=>{listener=fn;}},
      sendMessage:async message=>{
        if(message.type==='observation'){
          submitted.push(message.event);
          const outcome=await f.broker.observe(message.event);
          if(message.event.kind==='message')observationCount++;
          return {ok:true,value:outcome};
        }
        return {ok:true,value:{}};
      }
    }}
  };
  vm.runInNewContext(source,context,{filename:'extension/content.js'});
  const m={...event,conversationId:cid};
  for(const [i,value] of ['收到两张图片，一张',partial,finalText].entries()){
    nativeMessage.content.parts=[value];done=i===2;
    assert.equal(nativeText(),value,'Original public reader exposes this synthetic visible text');
    const reply=await new Promise(resolve=>
      listener({type:'monitor',session:m},{id:extensionId},resolve));
    assert.equal(reply.ok,true);
    if(done){
      for(let n=0;n<200&&observationCount!==1;n++){
        await new Promise(resolve=>listener({type:'monitor',session:m},{id:extensionId},resolve));
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      assert.equal(observationCount,1);
    }
    else{for(let n=0;n<20;n++)await new Promise(r=>setImmediate(r));assert.equal(observationCount,0);}
  }
  assert.deepEqual(submitted.filter(x=>x.kind==='message').map(x=>x.text),[finalText]);
  await until(()=>connected.events.some(x=>x.type==='session.turn'&&x.state==='completed'));
  const {rendered}=diagnose(t,connected.events);
  assert.equal(assistantsText(rendered),finalText,
    'Pending snapshots must not reach the append-only host');
});
