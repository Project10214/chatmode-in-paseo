/**
 * Production-entry regressions under the continuous page-view contract.
 * Prose cases still exercise the REAL extension/upstream/cos-shell-public.js
 * sourceFor and the Paseo 0.11.4 host contract; delivery cases use the real
 * Broker, the real Provider and a synthetic projected host. A native message is
 * observed continuously: visible text is captured without waiting for the task
 * to end, equal re-reads are idempotent, and an already published body is never
 * rewritten by a later revision.
 * No web account, browser, credentials or mounted user state is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHostConverter,portableRender} from './fixtures/paseo-0.11.4-contract.mjs';
import {loadInstalledPaseoContract,realTranslate,realRender} from './fixtures/paseo-real-contract.mjs';
import {sourceItem,until} from './helpers.mjs';
import {decodePublicProse} from '../shared/public-prose.mjs';
import {world} from './fixtures/provider-delivery-world.mjs';
const host=await loadInstalledPaseoContract();
const files=['cos-transcript-core.js','cos-shell-public.js'];
const source=await Promise.all(files.map(f=>readFile(new URL('../extension/upstream/'+f,import.meta.url),'utf8')));
const nativeId='native-assistant-unique',userId='native-user-unique';
const decode=raw=>decodePublicProse({text:raw,format:'dil'});
const formal=(id,rawText,extra={})=>sourceItem(id,'DOM '+id,{nativeMessageId:'native-'+id,
 order:[1],prose:{status:'available',nativeMessageId:'native-'+id,rawText,
 representation:'markdown',observedAt:Date.now()},...extra});
const rowOf=(s,id)=>s.history.find(row=>row.type==='assistant_message'&&row.messageId==='native-'+id);
const actual=(w,id)=>w.rows.filter(r=>r.item.type==='assistant_message'&&r.item.messageId==='native-'+id)
 .map(r=>r.item.text).join('');
const confirmed=(w,id,text)=>w.broker.snapshot(w.s.id).nativeDelivery?.durable.deliveries
 .some(d=>d.sourceId===rowOf(w.broker.snapshot(w.s.id),id)?.id&&d.confirmedText===text&&!d.pending);
function fixture(){
  const c=vm.createContext({location:{pathname:'/c/fixture-conversation'},URL,console,
    addEventListener:()=>{},removeEventListener:()=>{}});
  for(const code of source)vm.runInContext(code,c);
  const item={type:'assistant-message',messageId:nativeId,phase:'final_answer',
    content:'::chatgpt-content-reference{test-reference}',completed:false,
    contentReferences:[{type:'dil',source_message_id:nativeId,model_dil_v2:{fallbackMarkdown:''}}]};
  const turn={status:'in_progress',items:[{type:'user-message',messageId:userId,message:'Synthetic user'},item]};
  const evidence={conversationId:'fixture-conversation',conflict:false};
  // One production read: what the page currently shows for this native message.
  const read=(raw,final=false)=>{
    if(item.contentReferences[0])item.contentReferences[0].model_dil_v2.fallbackMarkdown=raw;
    item.completed=final;turn.status=final?'complete':'in_progress';
    const view=c.CIP_COS_SHELL_PUBLIC.sourceFor({memoizedProps:{turn}},{matches:()=>true,closest:()=>null},evidence);
    const found=view.messages.find(x=>x.id===item.messageId);
    assert(found,'assistant native ID missing');
    return {id:found.id,text:c.CIP_COS_PUBLIC_CORE.authoredText(found)??'',format:found.metadata.cipProseFormat,
      messageState:found.metadata.cipMessageState,readable:found.metadata.cipProseReadable,endTurn:found.end_turn};
  };
  return {read,item,turn,c};
}
// Host display of a sequence of Provider assistant snapshots for one item.
const render=values=>{
  const events=[{type:'session.turn',sessionId:'synthetic-session',turnId:'synthetic-turn',state:'started'}];
  for(const text of values)events.push({type:'timeline.item',sessionId:'synthetic-session',
    item:{type:'assistant_message',id:'assistant:synthetic-turn:'+nativeId,text}});
  events.push({type:'session.turn',sessionId:'synthetic-session',turnId:'synthetic-turn',state:'completed'});
  const converter=createHostConverter(),transport=[];
  for(const event of events)transport.push(...converter.translate(event));
  const text=items=>items.filter(x=>x.kind==='assistant_message').map(x=>x.text).join('');
  const actual=text(portableRender(transport));
  if(host){
    const installed=text(realRender(realTranslate(events,host),host));
    assert.equal(installed,actual.replace(/\r\n/g,'\n'));
  }
  return actual;
};
// Every unfinished prefix is pending (no body); the completed raw is intact;
// one receiver decode is exact; the host shows it once.
const deliverWhole=(f,raw,expected,{step=1}={})=>{
  let pending=0;
  for(let i=step;i<raw.length;i+=step){
    const r=f.read(raw.slice(0,i));
    assert.equal(r.messageState,'pending','no prose packet for an unfinished message');pending++;
  }
  const done=f.read(raw,true);
  assert.equal(done.messageState,'complete');assert.equal(done.format,'dil');
  assert.equal(done.text,raw,'raw public string reaches the receiver intact');
  const text=decode(done.text);
  if(expected!==undefined)assert.equal(text,expected);
  return {text,pending};
};

test('PROD direct native fallback regression: raw \\\\( grows to completed \\\\(x\\\\), delivered once and exact',()=>{
  const f=fixture(),expected='前言 \\(x\\) 成功。';
  const {text}=deliverWhole(f,'前言 \\\\(x\\\\) 成功。',expected);
  assert.equal(render([text]),expected,'PROD: inline formula shown once, no duplicated prefix');
});
test('PROD indentation LF: legal two-space and tab display-math prefixes remain accurate',()=>{
  for(const indent of ['  ','\t']){
    const raw='前言。\n'+indent+'\\['+'\n'+'x+y\n'+indent+'\\]\n结尾。';
    const {text}=deliverWhole(fixture(),raw,raw);
    assert.equal(render([text]),raw);
  }
});
test('PROD literal inside code fence arrives whole; nothing early, nothing outside the fence altered',()=>{
  const raw='代码：\n'+String.fromCharCode(96).repeat(3)+'text\n\\[\nnot a formula\n'+
    String.fromCharCode(96).repeat(3)+'\n结尾。';
  const f=fixture(),prefix=raw.slice(0,raw.indexOf('not a formula')+'not a formula\n'.length);
  assert.equal(f.read(prefix).messageState,'pending','an unfinished fence is not a body');
  assert.equal(deliverWhole(f,raw,raw).text,raw);
});
/* F-001/F-005 migrated: same-ID re-read and stale shorter reads under the
 * continuous source contract. The source ledger keeps current page truth;
 * delivery never rewrites an already published body. */
test('PROD same-ID updates keep one canonical body: equal re-reads are unchanged, a shorter read never replaces it',async t=>{
 const w=await world(t,{pageState:'running'});
 const full='第一段文字已完成';
 await w.view(w.s,{items:[formal('answer',full)]});
 await until(()=>confirmed(w,'answer',full));
 const count=w.bodies().length,revision=w.broker.snapshot(w.s.id).sources[0].revision,events=[];
 w.broker.subscribe(w.s.id,event=>events.push(event));
 await w.view(w.s,{items:[formal('answer',full)]});
 assert.equal(w.broker.snapshot(w.s.id).sources[0].revision,revision,'equal re-reads are idempotent');
 assert.equal(events.filter(event=>event.state==='source').length,0);
 assert.equal(w.bodies().length,count);
 // A stale/shorter visible read stays current source truth and a retained
 // rewrite, but it can neither replace nor truncate the delivered body.
 await w.view(w.s,{items:[formal('answer','第一段')]});
 await until(()=>w.events.some(event=>event.notice?.id==='native-content-delivery'&&event.notice.dismissed===false));
 const after=w.broker.snapshot(w.s.id);
 assert.equal(after.sources[0].text,'DOM answer','DOM text remains the current visible source');
 assert.equal(after.sources[0].prose.rawText,'第一段');
 assert.equal(after.sources[0].proseRewrites[0].rawText,full);
 assert.equal(actual(w,'answer'),full);
 assert.equal(w.bodies().length,count);
 assert.equal(after.turn.outcome,null);
});

/* F-002 migrated: content equality is not identity. */
test('PROD source answer identities are never deduped by equal prose',async t=>{
 const w=await world(t,{pageState:'running'});
 const first=formal('one','相同文字',{order:[1]}),second=formal('two','相同文字',{order:[2]});
 assert.notEqual(first.id,second.id);
 await w.view(w.s,{items:[first,second]});
 await until(()=>confirmed(w,'one','相同文字')&&confirmed(w,'two','相同文字'));
 const rows=w.broker.snapshot(w.s.id).history.filter(row=>row.type==='assistant_message');
 assert.deepEqual(rows.map(row=>row.messageId),['native-one','native-two']);
 assert.notEqual(rows[0].id,rows[1].id);
 assert.equal(w.bodies().filter(event=>event.item.text==='相同文字').length,2);
 assert.equal(actual(w,'one'),'相同文字');assert.equal(actual(w,'two'),'相同文字');
});

/* F-003 migrated: an empty source or an unreadable representation is never a
 * placeholder or an empty successful body; literal fallback stays visible. */
test('PROD an empty or unavailable source is never an empty successful body',async t=>{
 const w=await world(t,{pageState:'running'});
 const empty=sourceItem('empty','',{nativeMessageId:'native-empty',order:[1]});
 const literal=sourceItem('literal','*still visible*',{nativeMessageId:'native-literal',order:[2],
  prose:{status:'unavailable',code:'PUBLIC_MESSAGE_RAW_UNAVAILABLE'}});
 await w.view(w.s,{items:[empty,literal]});
 // Literal fallback escapes ASCII Markdown punctuation and encodes the space;
 // it is the visible text, not a placeholder and not an empty success.
 await until(()=>w.bodies().some(event=>event.item.messageId==='native-literal'));
 const state=w.broker.snapshot(w.s.id);
 assert.ok(!state.history.some(row=>row.type==='assistant_message'&&row.messageId==='native-empty'));
 assert.ok(!w.bodies().some(event=>event.item.messageId==='native-empty'));
 assert.equal(actual(w,'empty'),'');
 assert.equal(actual(w,'literal'),'\\*still&#32;visible\\*');
});

/* F-004 (raw revision retained as an issue, never a fake final) is covered by
 * CM-R4 and PD-11: a published non-prefix revision is retained and refused.
 * F-006 (source -> Broker -> Provider -> host -> replay) is covered by CPROV-08
 * (duplicate frame and reconnect replay deliver the body exactly once),
 * CPROV-01/CONTOBS-05 (process/tool identity independent of the body) and CM-P1.
 * F-007 (page facts/observation survive a prose failure) is covered by
 * CONTOBS-04/CONTOBS-10 and CPROV-07: a read failure is an issue, not a state.
 */
test('PROD finite source matrix: indents, LF/CRLF, formula, code fence, table, emoji, fragment sizes',t=>{
  const indents=['',' ','  ','   ','    ','\t',' \t'];
  const lineEndings=['\n','\r\n'];
  const sizes=[1,2,3,7];
  let cases=0,realHost=0,pendingFrames=0;
  for(const spaces of indents)for(const eol of lineEndings){
    const bt=String.fromCharCode(96).repeat(3);
    const options=[
      '中文🙂'+eol+spaces+'\\['+eol+'x+y'+eol+spaces+'\\]'+eol+'结尾  ',
      '中文🙂'+eol+spaces+'内联公式 \\(x+y\\) 与转义 \\! ，结束'+eol,
      '代码🙂'+eol+bt+'text'+eol+spaces+'\\['+eol+spaces+'\\(literal\\)'+eol+bt+eol+'最终句',
      '围栏🙂'+eol+'~~~js'+eol+spaces+'\\['+eol+'literal'+eol+'~~~'+eol+
        spaces+'\\['+eol+'x+y'+eol+spaces+'\\]'+eol+'完成',
      '表格🙂'+eol+spaces+'| 项目 | 结果 |'+eol+spaces+
        '| --- | --- |'+eol+spaces+'| A | 完成 |'+eol+'末尾  '
    ];
    for(const raw of options)for(const step of sizes){
      const {text,pending}=deliverWhole(fixture(),raw,undefined,{step});
      pendingFrames+=pending;
      if(cases%12===0){
        assert.equal(render([text]),text,'Actual host projection of one whole message');
        realHost++;
      }
      cases++;
    }
  }
  t.diagnostic(JSON.stringify({cases,realHost,pendingFrames}));
  assert.equal(cases,280);
  assert(realHost>=20&&pendingFrames>=200,'many unfinished frames were checked and none became a body');
});

test('PROD same-message DIL final appears only after the message completes, with all syntax resolved once',()=>{
  const f=fixture();
  assert.equal(f.read('开头。\n\\[\n未闭合').messageState,'pending');
  const {text}=deliverWhole(f,'开头。\n\\[\n未闭合','开头。\n[\n未闭合');
  assert.equal(render([text]),text);
});

test('PROD live metadata-shaped LCP 7→177→250→393 from raw-only growth: no revised partial is ever published',()=>{
  const r1='背景说明六：\\(';
  const suffix2='`\\!\\*';
  const base2=r1+'x\\)';
  const r2=base2+'中'.repeat(177-decode(base2+suffix2).length)+suffix2;
  const base3=r2+'`';
  const suffix3='\\(';
  const r3=base3+'甲'.repeat(250-decode(base3+suffix3).length)+suffix3;
  const base4=r3+'z\\)';
  const r4=base4+'乙'.repeat(393-decode(base4).length);
  const states=[r1,r2,r3,r4];
  for(const size of [451,499,580,598])
    states.push(states.at(-1)+'后'.repeat(size-decode(states.at(-1)).length));
  const mapped=states.map(x=>decode(x));
  const lcp=(a,b)=>{let n=0;while(n<Math.min(a.length,b.length)&&a[n]===b[n])n++;return n;};
  assert.deepEqual(mapped.map(x=>x.length),[7,177,250,393,451,499,580,598]);
  assert.deepEqual(mapped.slice(1).map((x,i)=>lcp(mapped[i],x)),[6,175,249,393,451,499,580],
    'Decoding unfinished raw would revise old tails even though raw never rewrites');
  assert(states.slice(1).every((x,i)=>x.startsWith(states[i])));
  const f=fixture();
  for(const state of states.slice(0,-1))assert.equal(f.read(state).messageState,'pending','no unfinished projection is published');
  const done=f.read(states.at(-1),true);
  assert.equal(decode(done.text),mapped.at(-1),'Full final text equals the one-shot CoS decode');
  assert.equal(render([decode(done.text)]),mapped.at(-1));
});
