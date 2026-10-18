/**
 * HISTORICAL research ONLY: one native ID, authoritative raw prefix, safe
 * projected prefix. This models the abandoned character-streaming design and
 * is NOT production. Since 2026-10-17 the user-authorized spec delivers whole
 * completed messages; production coverage lives in append-only-production,
 * public-prose-* and completed-message-* tests. Every test here is titled
 * "HISTORICAL" so it can never be reported as a production pass.
 * The frozen decoder oracle is the receiver's one-shot CoS decoder
 * (shared/public-prose.mjs), since production Chrome no longer decodes prose.
 * Optional actual Paseo mapper+renderer parity is hash-pinned by fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostConverter,portableRender} from './fixtures/paseo-0.11.4-contract.mjs';
import {loadInstalledPaseoContract,realTranslate,realRender} from './fixtures/paseo-real-contract.mjs';
import {decodePublicProse} from '../shared/public-prose.mjs';

const historical=(name,...rest)=>test('HISTORICAL research (not production): '+name,...rest);
// Frozen decoder oracle: the original CoS F semantics, now owned by the receiver.
const oldDecoder=raw=>decodePublicProse({text:raw,format:'dil'});
const host=await loadInstalledPaseoContract();
const messageId='synthetic-native-id', userId='synthetic-user-id';
const ref='::chatgpt-content-reference{synthetic}';
function project(raw,mode='fallback'){
  if(!raw||mode==='fallback'&&!raw.trim())return '';
  return mode==='plain'?raw:oldDecoder(raw);
}
/**
 * Narrow, grammar-aware research boundary for the exact installed CoS F.
 *
 * Only complete lines can establish a fence opening/closing decision.
 * An unfinished line that *could become* an indented standalone \\[ keeps
 * ALL its leading spaces/tabs, not only the slash. Inside an established
 * fenced block, even literal math openers are emitted raw, as F does.
 *
 * Do not confuse this bounded executable model with proof of every parser
 * input: the combo suite below probes finite cases and source parity only.
 */
function boundary(raw,final=false){
  if(final)return raw.length;
  const completeEnd=raw.lastIndexOf('\n')+1;
  const complete=raw.slice(0,completeEnd);
  const lines=complete?complete.slice(0,-1).split('\n'):[];
  const offsets=[];let cursor=0;
  for(const line of lines){offsets.push(cursor);cursor+=line.length+1;}
  let fence=null;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const marker=/^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if(fence!==null){
      if(marker && marker[0]===fence[0] && marker.length>=fence.length &&
         !line.slice(line.indexOf(marker)+marker.length).trim())fence=null;
      continue; // inside code fences, formula-looking lines are literal
    }
    if(marker && !(marker[0]==='`' &&
       line.slice(line.indexOf(marker)+marker.length).includes('`'))){
      fence=marker;
      continue;
    }
    if(line.trim()==='\\['){
      let closed=-1;
      for(let j=i+1;j<=Math.min(i+400,lines.length-1);j++)
        if(lines[j].trim()==='\\]'){closed=j;break;}
      if(closed>=0){i=closed;continue;} // F copies whole math block verbatim
      if(lines.length-1<i+400)return offsets[i];
      // After 400 full lines no future closer can revise this opener.
    }
  }
  const partial=raw.slice(completeEnd);
  let safe=partial.length;
  if(fence===null){
    // Potential complete formula line: whitespace + \[ + whitespace.
    // IMPORTANT: whitespace already published here would later be retracted.
    if(/^\s*$/.test(partial) ||
       /^\s*\\$/.test(partial) ||
       /^\s*\\\[\s*$/.test(partial))safe=0;
    else{
      for(let i=0;i<partial.length;i++){
        if(partial[i]==='\\'||partial[i]==='`'){safe=i;break;}
      }
      if(/^ {0,3}~/.test(partial))
        safe=Math.min(safe,partial.indexOf('~'));
    }
  }
  // The input can be cut between UTF-16 surrogate units during tests.
  if(safe>0 && /[\uD800-\uDBFF]/.test(partial[safe-1]))safe--;
  return completeEnd+safe;
}
class Publisher{
  constructor(source='typed:view',nativeId=messageId,mode='fallback'){
    this.source=source;this.nativeId=nativeId;this.mode=mode;
    this.raw='';this.text='';this.done=false;this.changes=0;this.committedRawEnd=0;
  }
  update({raw,source=this.source,id=this.nativeId,final=false}){
    assert.equal(id,this.nativeId,'DIFFERENT_NATIVE_MESSAGE');
    if(this.done)return {text:this.text,delta:'',ignoredLate:raw!==this.raw};
    assert.equal(source,this.source,'SOURCE_SWITCH_REQUIRES_PROOF');
    assert.equal(typeof raw,'string');
    assert(raw.startsWith(this.raw),'AUTHORITATIVE_NON_PREFIX_MUST_BE_DIAGNOSED');
    if(final&&this.mode==='fallback'&&!raw.trim())
      throw new Error('FINAL_FALLBACK_UNAVAILABLE: do not mark completed');
    // Even unconverted native prose should not publish a lone high UTF-16
    // surrogate while the next raw slice may supply its low half.
    const codePointBoundary=!final && raw.length>0 &&
      /[\uD800-\uDBFF]/.test(raw[raw.length-1])?raw.length-1:raw.length;
    const safeEnd=this.mode==='plain'?codePointBoundary:boundary(raw,final);
    assert(safeEnd>=this.committedRawEnd,'BOUNDARY_CURSOR_REGRESSION: research classifier bug, not proof of bad webpage data');
    const published=project(raw.slice(0,safeEnd),this.mode);
    assert(published.startsWith(this.text),'DERIVED_NON_PREFIX_MUST_NOT_PUBLISH');
    const delta=published.slice(this.text.length);
    this.raw=raw;this.text=published;this.done=final;this.committedRawEnd=safeEnd;
    if(delta)this.changes++;
    return {text:published,delta,held:raw.length-safeEnd,final};
  }
}
function hostRender(snapshots){
  const events=[{type:'session.turn',sessionId:'synthetic-session',turnId:'synthetic-turn',state:'started'}];
  for(const text of snapshots)events.push({type:'timeline.item',sessionId:'synthetic-session',
    item:{type:'assistant_message',id:'assistant:synthetic-turn:'+messageId,text}});
  events.push({type:'session.turn',sessionId:'synthetic-session',turnId:'synthetic-turn',state:'completed'});
  const adapter=createHostConverter(),translated=[];
  for(const e of events)translated.push(...adapter.translate(e));
  const textOf=items=>items.filter(x=>x.kind==='assistant_message').map(x=>x.text).join('');
  const output=textOf(portableRender(translated));
  if(host){
    // The installed Metro reducer normalizes CRLF to LF for its rendered
    // assistant text. Keep original CRLF intact in the source/Provider data;
    // compare presentation with presentation rather than corrupting the source.
    const visible=textOf(realRender(realTranslate(events,host),host));
    assert.equal(visible,output.replace(/\r\n/g,'\n'),
      'Original Paseo text-display parity (CRLF is a host presentation normalization)');
  }
  return output;
}
function stream(raw,{mode='fallback',chunk=1}={}){
  const p=new Publisher('typed:view',messageId,mode),frames=[],held=[];
  for(let n=chunk;n<raw.length;n+=chunk){
    const result=p.update({raw:raw.slice(0,n)});
    if(result.delta)frames.push(result.text);
    held.push(result.held);
  }
  const complete=p.update({raw,final:true});
  if(complete.delta)frames.push(complete.text);
  return {p,frames,maxHeld:Math.max(0,...held),complete};
}
const corpus=[
  ['Chinese','先观察中文，再核验结果。'],
  ['escaped punctuation','请保留 \\! \\* \\# \\(x\\) 的表现。\n'],
  ['table','| 项目 | 状态 |\n|---|---|\n| A | 完成 |\n'],
  ['code fence','```js\nconst x = "\\\\(";\nconsole.log(x)\n```\n'],
  ['inline math','公式：\\(a+b=c\\)，结果成立。\n'],
  ['display math','解释：\n\\[\na+b=c\n\\]\n结论成立。\n'],
  ['inline code','`x\\*y` 与 `const a=1`。\n'],
  ['whitespace','首段  \n\n第二段\t  \n结尾  ']
];
historical('SOURCE exact counterexample: raw prefix grows, frame-by-frame fallback projection does not',()=>{
  const a='公式 \\(',b='公式 \\(x\\)';
  assert(b.startsWith(a));
  assert.equal(project(a),'公式 (');
  assert.equal(project(b),'公式 \\(x\\)');
  assert(!project(b).startsWith(project(a)));
});
historical('SOURCE direct raw forwarding is not the incumbent converted final text',()=>{
  const raw='括号 \\(x\\) 和转义 \\! 。';
  assert.notEqual(raw,project(raw),'Raw Markdown cannot be substituted without display-compatibility tests');
});
historical('PLAN grammar-boundary publisher maintains prefix and EXACT original final for corpus',()=>{
  let early=0,held=0;
  for(const [name,raw] of corpus){
    const result=stream(raw);
    assert.equal(result.p.text,project(raw),name);
    assert.equal(result.frames.at(-1),project(raw),name);
    assert(result.frames.every((frame,i)=>i===0||frame.startsWith(result.frames[i-1])),name);
    assert.equal(hostRender(result.frames),project(raw),name);
    if(result.frames.length>1)early++;
    if(result.maxHeld)held++;
  }
  assert(early>=5,'Real-time prefix should appear for ordinary text');
  assert(held>=2,'Ambiguous syntax must be held');
});
historical('PLAN native/plain answer bypasses fallback conversion; Chinese streams from first character',()=>{
  const raw='中文正文没有转换必要。';
  const result=stream(raw,{mode:'plain'});
  assert.equal(result.frames.length,raw.length);
  assert.equal(result.p.text,raw);
});
historical('PLAN display-math lookup expires only beyond its upstream 400-line syntax window',()=>{
  const intro='引言。\n\\[\n';
  const pending=intro+Array.from({length:399},(_,i)=>'第'+i+'行\n').join('');
  const decided=pending+'第400行\n';
  const pendingModel=new Publisher();
  assert.equal(pendingModel.update({raw:pending}).text,'引言。\n');
  const released=pendingModel.update({raw:decided});
  assert.equal(released.text,project(decided));
  const afterLimit=decided+'\\]\n尾声';
  assert(project(afterLimit).startsWith(released.text),
    'A closing delimiter outside the 400-line window cannot revise emitted text');
  assert.equal(pendingModel.update({raw:afterLimit,final:true}).text,project(afterLimit));
});

historical('PLAN unresolved display formula pauses until matching grammar boundary',()=>{
  const p=new Publisher();
  assert.equal(p.update({raw:'前言。\n\\[\na+b=c\n'}).text,'前言。\n');
  const closed='前言。\n\\[\na+b=c\n\\]\n';
  assert.equal(p.update({raw:closed}).text,project(closed));
  assert.equal(p.update({raw:closed+'结尾。',final:true}).text,project(closed+'结尾。'));
});
historical('PLAN ambiguity is syntax-dependent, NOT the arbitrary last N characters',()=>{
  const raw='前言。\n\\[\n'+Array.from({length:20},(_,i)=>'内容行'+i+'\n').join('');
  const p=new Publisher(),v=p.update({raw});
  assert.equal(v.text,'前言。\n');
  assert(v.held>32);
  assert.equal(p.update({raw,final:true}).text,project(raw));
});
historical('PLAN duplicate, final and stale post-final frames are safe',()=>{
  const p=new Publisher('typed:view','same-id','plain');
  assert.equal(p.update({raw:'第一段'}).delta,'第一段');
  assert.equal(p.update({raw:'第一段'}).delta,'');
  assert.equal(p.update({raw:'第一段已完成',final:true}).text,'第一段已完成');
  const late=p.update({raw:'第一段'});
  assert.equal(late.ignoredLate,true);
  assert.equal(p.text,'第一段已完成');
  assert.equal(hostRender(['第一段','第一段已完成']),'第一段已完成');
});
historical('PLAN pinned message/source identity never merges separate native messages',()=>{
  const a=new Publisher('typed:view','commentary','plain');
  const b=new Publisher('typed:view','final','plain');
  a.update({raw:'工具前的发言',final:true});
  b.update({raw:'工具后的最终结果',final:true});
  assert.equal(a.text,'工具前的发言');
  assert.equal(b.text,'工具后的最终结果');
  assert.throws(()=>b.update({id:'commentary',raw:'另一个消息'}),/DIFFERENT_NATIVE_MESSAGE/);
});
historical('PLAN missing final fallback prose terminates explicitly, never publishes a reference marker',()=>{
  const p=new Publisher();
  const preview=p.update({raw:'   '});
  assert.equal(preview.text,'');
  assert.throws(()=>p.update({raw:'   ',final:true}),/FINAL_FALLBACK_UNAVAILABLE/);
  assert.equal(p.done,false,'An unconfirmed empty fallback is not successful completion');
});

historical('PLAN anomalous raw revision or reader-switch fails loudly rather than dropping edits',()=>{
  const p=new Publisher('typed:view',messageId,'plain');
  p.update({raw:'规范正文'});
  assert.throws(()=>p.update({raw:'不同正文'}),/AUTHORITATIVE_NON_PREFIX/);
  assert.throws(()=>p.update({raw:'规范正文追加',source:'legacy:dom'}),/SOURCE_SWITCH/);
});


/** Boss-reviewed legal append-only inputs. These MUST fail on the old boundary. */
historical('BOUNDARY-REGRESSION LF with two spaces before display-math opener cannot retract published whitespace',()=>{
  const raw='前言。\n  \\[\nx+y\n  \\]\n结尾。';
  const result=stream(raw,{chunk:1});
  assert.equal(result.p.text,project(raw));
  assert(result.frames.every((t,i)=>i===0||t.startsWith(result.frames[i-1])));
  assert.equal(hostRender(result.frames),project(raw));
});

historical('BOUNDARY-REGRESSION LF with tab before display-math opener cannot retract published tab',()=>{
  const raw='前言。\n\t\\[\nx+y\n\\]\n结尾。';
  const result=stream(raw,{chunk:1});
  assert.equal(result.p.text,project(raw));
  assert(result.frames.every((t,i)=>i===0||t.startsWith(result.frames[i-1])));
  assert.equal(hostRender(result.frames),project(raw));
});

historical('BOUNDARY-REGRESSION code-fence literal display-math opener is not a pending outside formula',()=>{
  const raw='代码：\n```text\n\\[\nnot a formula\n```\n结尾。';
  const prefix='代码：\n```text\n\\[\nnot a formula\n';
  assert.equal(project(prefix),prefix,'Original converter keeps the entire fenced block literal');
  const model=new Publisher();
  const state=model.update({raw:prefix});
  assert.equal(state.text,project(prefix),'Fenced literal math must be safe once full code line arrived');
  assert.equal(state.held,0,'A literal fenced line has no display-math closure dependency');
  const finished=model.update({raw,final:true});
  assert.equal(finished.text,project(raw));
  assert.equal(hostRender([state.text,finished.text]),project(raw));
  const paced=stream(raw,{chunk:1});
  assert(paced.maxHeld<23,'An inner code fence is literal, so it must not stall as an outside formula');
});


historical('COMBINATIONS source-prefix and final-byte invariants over finite indent/EOL/syntax/chunk matrix',t=>{
  // Deterministic finite matrix, NOT a mathematical proof or live-browser test.
  const indents=['',' ','  ','   ','    ','\t',' \t'];
  const eols=['\n','\r\n'];
  const sizes=[1,2,3,7];
  let sequences=0,frames=0,hostParity=0;
  for(const indent of indents){
    for(const eol of eols){
      const code='```';
      const variants=[
        ['display-math','前言🙂'+eol+indent+'\\['+eol+'x+y'+eol+indent+'\\]'+eol+'结尾  '],
        ['inline-math','中文🙂'+eol+indent+'公式 \\(x+y\\) 与 \\! 表格|'+eol+'尾随\t '],
        ['fenced-literal','标题🙂'+eol+code+'text'+eol+indent+'\\['+eol+indent+'\\(not-math\\)'+eol+code+eol+'正常结束'+eol],
        ['post-fence-math','代码🙂'+eol+'~~~md'+eol+indent+'\\['+eol+'literal \\(raw'+eol+'~~~'+eol+indent+'\\['+eol+'x+y'+eol+indent+'\\]'+eol+'尾'],
        ['ordinary-table','中文🙂'+eol+indent+'| 项目 | 结果 |'+eol+indent+'| --- | --- |'+eol+indent+'| A | B |'+eol+'\t尾行  ']
      ];
      for(const [name,raw] of variants){
        for(const chunk of sizes){
          const result=stream(raw,{chunk});
          const exact=project(raw);
          assert.equal(result.p.text,exact,JSON.stringify({name,indent,eol,chunk}));
          assert(result.frames.every((f,i)=>i===0||f.startsWith(result.frames[i-1])),
            JSON.stringify({name,indent,eol,chunk,issue:'published prefix'}));
          assert.equal(result.frames.at(-1),exact);
          for(const f of result.frames){
            assert(!/[\uD800-\uDBFF]$/.test(f),'Never publish a dangling high surrogate: '+name);
            frames++;
          }
          if(chunk===1 && sequences%12===0){
            assert.equal(hostRender(result.frames),exact,'Real installed host parity '+name);
            hostParity++;
          }
          sequences++;
        }
      }
    }
  }
  t.diagnostic(JSON.stringify({sequences,frames,hostParity,indents:indents.length,
    eols:eols.length,fragmentSizes:sizes}));
  assert(sequences>=200 && hostParity>=20);
});

historical('COMBINATIONS safe source cursor never regresses on indented math and code fences',()=>{
  for(const indent of ['',' ','  ','   ','    ','\t',' \t','\t  ']){
    for(const eol of ['\n','\r\n']){
      for(const raw of [
        '前言🙂'+eol+indent+'\\['+eol+'x+y'+eol+indent+'\\]'+eol+'结尾',
        '代码🙂'+eol+'```'+eol+indent+'\\['+eol+'literal'+eol+'```'+eol+'结尾'
      ]){
        let prev=0;
        for(let i=1;i<=raw.length;i++){
          const current=boundary(raw.slice(0,i));
          assert(current>=prev,JSON.stringify({indent,eol,i,prev,current}));
          prev=current;
        }
      }
    }
  }
});

historical('COMBINATIONS plain source emoji is never published as one dangling surrogate',()=>{
  const p=new Publisher('typed:view',messageId,'plain');
  const emoji='前🙂后';
  const snapshot=p.update({raw:emoji.slice(0,2)});
  assert(!/[\uD800-\uDBFF]$/.test(snapshot.text),
    'Plain-source streaming should also wait one UTF-16 unit for an incomplete emoji');
  assert.equal(p.update({raw:emoji,final:true}).text,emoji);
});
