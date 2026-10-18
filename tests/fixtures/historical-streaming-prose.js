/* CIP-owned MAIN-world adapter, not transplanted CoS code.
 * Converts SAME native assistant fallbackMarkdown snapshot to an append-only
 * canonical public snapshot. Only newly arrived UTF-16 units enter the grammar
 * state. Final text is checked once against the original CoS decoder.
 *
 * One bounded state per native message ID. No network, account data, hidden
 * analysis, tool arguments or plugin protocol is read here.
 */
(() => {
  'use strict';
  if (globalThis.CIP_PUBLIC_PROSE) return;
  const MAX_TEXT=256000, MAX_ENTRIES=32, MAX_FORMULA_LINES=400;
  let route=location.pathname;
  const entries=new Map(), failures=new Map();
  const MAX_FAILURES=400; // Content-free tombstones outlive disposable parsing state.
  const reject=code=>{throw Object.assign(new Error(code),{code});};
  const trimmed=line=>line.trim();
  const opening=line=>{
    const marker=/^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    return marker && !(marker[0]==='`'&&line.slice(line.indexOf(marker)+marker.length).includes('`'))?marker:null;
  };
  const closing=(line,fence)=>{
    const marker=/^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    return !!marker&&marker[0]===fence[0]&&marker.length>=fence.length&&
      !line.slice(line.indexOf(marker)+marker.length).trim();
  };
  const resetLine=entry=>{
    entry.line='';entry.released=0;entry.scanned=0;
    entry.leading=true;entry.held=false;
  };
  const newEntry=source=>({raw:'',text:'',source,finished:false,error:null,
    line:'',released:0,scanned:0,leading:true,held:false,fence:null,math:null});
  const publish=(entry,text)=>{
    if(text)entry.text+=text;
    if(entry.text.length>MAX_TEXT)reject('ANSWER_TOO_LARGE');
  };
  function partial(entry){
    if(entry.math||entry.held)return;
    // Visit each new code unit at most once, not the growing line per token.
    if(entry.fence)entry.scanned=entry.line.length;
    else while(entry.scanned<entry.line.length){
      const char=entry.line[entry.scanned];
      if(entry.leading&&/\s/.test(char)){entry.scanned++;continue;}
      if(char==='\\'||char==='`'||(entry.leading&&char==='~')){
        entry.held=true;break;
      }
      entry.leading=false;entry.scanned++;
    }
    let cut=!entry.fence&&entry.leading?0:entry.scanned;
    if(cut>0&&/[\uD800-\uDBFF]/.test(entry.line[cut-1]))cut--;
    if(cut<entry.released)reject('ANSWER_SAFE_CURSOR_REGRESSION');
    if(cut>entry.released){
      publish(entry,entry.line.slice(entry.released,cut));
      entry.released=cut;
    }
  }
  function lineComplete(entry,rawLine,decode,{noMathStart=false}={}){
    const full=rawLine.slice(0,-1);
    const lineTail=rawLine.slice(entry.released);
    const released=entry.released;
    entry.released=0;
    if(entry.math){
      entry.math.lines.push(rawLine);
      if(trimmed(full)==='\\]'&&entry.math.lines.length-1<=MAX_FORMULA_LINES){
        publish(entry,entry.math.lines.join(''));
        entry.math=null;
      }else if(entry.math.lines.length-1>=MAX_FORMULA_LINES){
        // The original CoS decoder can only look 400 lines forward.
        // Expire one opener and replay only this bounded pending window.
        const saved=entry.math.lines;
        entry.math=null;
        for(let i=0;i<saved.length;i++)
          lineComplete(entry,saved[i],decode,{noMathStart:i===0});
      }
      return;
    }
    if(entry.fence){
      publish(entry,lineTail);
      if(closing(full,entry.fence))entry.fence=null;
      return;
    }
    if(!noMathStart&&trimmed(full)==='\\['){
      if(released!==0)reject('ANSWER_SAFE_CURSOR_REGRESSION');
      entry.math={lines:[rawLine]};
      return;
    }
    const fence=opening(full);
    if(fence){
      if(released!==0)reject('ANSWER_SAFE_CURSOR_REGRESSION');
      publish(entry,rawLine);
      entry.fence=fence;
      return;
    }
    // Decode this completed line ONCE with its original line-start context.
    // Decoding a suffix alone could misread mid-sentence ``` as a code fence.
    const decoded=decode(full)+'\n';
    if(!decoded.startsWith(rawLine.slice(0,released)))reject('ANSWER_DERIVED_NON_PREFIX');
    publish(entry,decoded.slice(released));
  }
  const ensureRoute=()=>{
    if(route!==location.pathname){entries.clear();failures.clear();route=location.pathname;}
  };
  function update({id,raw,source='typed',final=false},decode){
    ensureRoute();
    if(typeof id!=='string'||!id||id.length>200||typeof raw!=='string'
      ||typeof decode!=='function')reject('ANSWER_STREAM_INVALID');
    if(raw.length>MAX_TEXT)reject('ANSWER_TOO_LARGE');
    if(failures.has(id))reject(failures.get(id));
    let e=entries.get(id);
    if(!e){
      if(entries.size>=MAX_ENTRIES){
        const done=[...entries].find(([key,v])=>v.finished||(v.error&&failures.has(key)));
        if(!done)reject('ANSWER_STREAM_CAPACITY');
        entries.delete(done[0]);
      }
      e=newEntry(source);entries.set(id,e);
    }
    if(e.error)reject(e.error);
    try{return advance(e,raw,source,final,decode);}
    catch(error){
      e.error=error.code??'ANSWER_STREAM_INVALID';
      if(failures.has(id)||failures.size<MAX_FAILURES)failures.set(id,e.error);
      throw error;
    }
  }
  function advance(e,raw,source,final,decode){
    if(e.finished){
      if(final&&raw!==e.raw&&decode(raw)!==e.text)reject('ANSWER_FINAL_MISMATCH');
      return e.text; // stale streaming frame cannot overwrite verified final
    }
    if(raw===e.raw&&!final)return e.text;
    if(!raw.startsWith(e.raw)){
      // A shorter re-mounted frame may be stale. Do not send it to append-only
      // host. Final must independently prove the complete stable source.
      if(!final&&e.raw.startsWith(raw))return e.text;
      // fallbackMarkdown is a display representation, not raw model tokens.
      // Recompute only on representation changes. Accept the new grammar state
      // ONLY if its safe projection preserves every already-published unit.
      // Actual visible revisions still fail; no truncation, dedupe or second body.
      const candidate=newEntry(source);
      const projected=advance(candidate,raw,source,final,decode);
      if(projected.startsWith(e.text)){
        Object.assign(e,candidate);return e.text;
      }
      reject(final?'ANSWER_FINAL_MISMATCH':'ANSWER_RAW_DIVERGED');
    }
    if(source!==e.source){
      // DOM/Fiber remount is accepted if exact native raw prefix continuity
      // proves it is the same canonical text under the same message ID.
      e.source=source;
    }
    const delta=raw.slice(e.raw.length);
    e.raw=raw;
    for(let from=0;from<delta.length;){
      const newline=delta.indexOf('\n',from);
      if(newline<0){e.line+=delta.slice(from);partial(e);break;}
      e.line+=delta.slice(from,newline+1);
      lineComplete(e,e.line,decode);
      resetLine(e);from=newline+1;
    }
    if(final){
      // ONLY whole-answer decode pass; exact final CoS semantics, bounded 256K.
      const exact=decode(raw);
      if(!exact.startsWith(e.text))reject('ANSWER_DERIVED_NON_PREFIX');
      publish(e,exact.slice(e.text.length));
      e.finished=true;e.line='';e.math=null;
    }
    return e.text;
  }
  function current(id){
    ensureRoute();
    const entry=entries.get(id);
    if(failures.has(id)||entry?.error)reject(failures.get(id)??entry.error);
    return entry?.text??'';
  }
  const has=id=>{ensureRoute();return entries.has(id)||failures.has(id);};
  const finished=id=>{ensureRoute();return entries.get(id)?.finished===true;};
  // Only the already-published projection is returned, never raw source or private data.
  const inspect=id=>{ensureRoute();const e=entries.get(id);return {
    text:e?.text??'',error:failures.get(id)??e?.error??null,finished:e?.finished===true};};
  addEventListener('pagehide',()=>{entries.clear();failures.clear();});
  globalThis.CIP_PUBLIC_PROSE=Object.freeze({update,current,has,finished,inspect});
})();
