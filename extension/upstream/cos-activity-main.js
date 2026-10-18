/* Chat On Steroids (MIT), copyright (c) 2026 Chat On Steroids contributors.
 * Adapted function-level sources from pinned extension/fiber.js:
 * shellTurnTrace (2145-2185), viewCallsOf (1796-1827),
 * shellTurnSource (2192-2274). See vendor/cos/provenance.json.
 *
 * Public UI lifecycle ONLY. Never project reasoning content, arguments,
 * results, hidden/private steps, browsing URLs, or native credential data.
 * Activity is descriptive evidence, NOT permission to terminate a turn.
 */
(() => {
  'use strict';
  const TOKEN=/^[a-zA-Z_][a-zA-Z0-9_.:-]{0,79}$/;
  const ID=/^[a-zA-Z0-9:._-]{1,200}$/;
  const MAX_STEPS=12, MAX_ITEMS=400;
  const safe=v=>typeof v==='string'&&TOKEN.test(v)?v:null;
  // Verified on a real signed-in ChatGPT turn: connected MCP calls can
  // expose an opaque tool identity such as link_<hex>/read. The slash and
  // internal link ID are not a user-facing tool name, so project ONLY the
  // final safe action token. Reject URLs, paths and unknown slash forms.
  const linkedTool=/^link_[a-f0-9]{16,64}\/([a-zA-Z_][a-zA-Z0-9_.:-]{0,79})$/i;
  const displayTool=value=>{
    if(typeof value!=='string')return null;
    const match=linkedTool.exec(value);
    return safe(match?match[1]:value);
  };
  // Only genuinely public items may contribute a visible tool label. Parent
  // reasoning-group metadata is as authoritative as the nested tool's flags.
  const publicItem=item=>!!item && typeof item==='object' && !Array.isArray(item) &&
    item.isVisuallyHidden!==true && item.isTransient!==true &&
    !['analysis','private'].includes(item.channel) &&
    // Public tool calls are directed to their provider, not to "all".
    // Applying the prose-recipient rule here discards folded MCP tool cards.
    ((['mcp-tool-call','dynamic-tool-call'].includes(item.type) &&
      !['analysis','private'].includes(item.recipient)) ||
      item.recipient==null||item.recipient==='all') &&
    item.reasoningRecap?.type!=='hide_all' &&
    item.metadata?.is_visually_hidden_from_conversation!==true &&
    item.metadata?.is_visually_hidden!==true &&
    item.metadata?.is_visually_hidden_reasoning_group!==true &&
    item.metadata?.summary_type!=='raw_cot';
  const nativeId=v=>typeof v==='string'&&ID.test(v)&&!/^fallback-turn-/i.test(v)&&!/:\d+:(?:user|assistant)$/.test(v);
  const status=v=>v==='complete'||v==='in_progress'?v:null;
  // A CoS viewCallsOf-style traversal; arguments and responses are never read.
  function viewCallsOf(items,turnDone=false) {
    const out=[],seen=new Set();
    function visit(source) {
      if(!Array.isArray(source))return;
      for(const item of source) {
        if(out.length>=MAX_STEPS)break;
        if(!publicItem(item))continue;
        if(item.type==='chatgpt-reasoning-group') {
          visit(item.items);
          continue;
        }
        if(item.type!=='mcp-tool-call'&&item.type!=='dynamic-tool-call')continue;
        const id=item.callId;
        if(!nativeId(id)||seen.has(id))continue;seen.add(id);
        if(item.type==='dynamic-tool-call') {
          if(item.tool==='exec')out.push({kind:'exec',label:'代码执行',done:item.completed===true||turnDone});
          continue;
        }
        const server=safe(item.invocation?.server),tool=displayTool(item.invocation?.tool);
        // A visible tool name may be shown; unknown/malformed fields never become labels.
        if(!tool)continue;
        const isSearch=/search|browse|web\.run/i.test(tool)||/web|search/i.test(server??'');
        const isImage=/image|text2im|generate_picture/i.test(tool);
        const label=(server?server+' · ':'')+tool;
        if(label.length>160)continue;
        out.push({kind:isImage?'image':isSearch?'search':'tool',label,done:item.completed===true||turnDone});
      }
    }
    visit(items);
    return out;
  }
  // Adapted CoS shellTurnTrace: preserve native step order and public status
  // booleans but do not expose reasoning/preamble/recap text or private thoughts.
  function shellTurnTrace(turn) {
    if(!turn||!Array.isArray(turn.items)||turn.items.length>MAX_ITEMS)return null;
    const items=turn.items, steps=viewCallsOf(items,turn.status==='complete'), known=new Set();
    let lastAssistant=null,activeThought=false,images=0;
    for(const item of items) {
      if(!publicItem(item))continue;
      if(item.type==='assistant-message' && item.phase==='final_answer' &&
         nativeId(item.messageId) && item.isVisuallyHidden!==true)lastAssistant=item;
      if(item.type==='generated-image'&&typeof item.src==='string'&&item.src.startsWith('sediment://file_')) {
        if(images++>=8)continue;
        const done=item.status==='completed'&&item.isPreview!==true;
        steps.push({kind:'image',label:'生成图片',done});
      }
      if(item.type==='chatgpt-reasoning-group'&&item.reasoningRecap?.type!=='hide_all') {
        const thought=item.activeReasoning;
        if(thought&&thought.completed!==true&&thought.isTransient!==true&&thought.presentation==='thought')activeThought=true;
      }
    }
    if(steps.length>MAX_STEPS)steps.length=MAX_STEPS;
    const running=items.length>0&&status(turn.status)==='in_progress';
    const last=steps.at(-1);
    let phase='working';
    if(last && !last.done)phase=last.kind;
    else if(activeThought&&running)phase='thinking';
    else if(last&&last.done&&running)phase='working';
    else if(lastAssistant&&lastAssistant.completed===true&&turn.status==='complete')phase='completed';
    else if(images>0&&turn.status==='complete'&&steps.filter(x=>x.kind==='image').every(x=>x.done))phase='completed';
    else if(!running&&turn.status==='complete')phase='finalizing';
    else if(running)phase='thinking';
    return {phase,steps,nativeStatus:status(turn.status)};
  }
  function statusFor(fiber) {
    for(let f=fiber,up=0;f&&up<80;up++,f=f.return) {
      const p=f.memoizedProps;
      if(Array.isArray(p?.turn?.items))return shellTurnTrace(p.turn);
      if(Array.isArray(p?.entry?.turn?.items))return shellTurnTrace(p.entry.turn);
    }
    return null;
  }
  // Public native timeline evidence only. A model's internal activeReasoning,
  // raw chain-of-thought, invocation arguments and tool results are NEVER read.
  // A "collapse" recap is folded public UI, not private chain-of-thought.
  // Analysis/private/hidden groups still must not cross this boundary.
  function visibleToolEvidence(section,callId) {
    if(!section?.querySelectorAll)return null;
    // No native invocation.arguments/output access: require an EXACT callId
    // on a visible turn-owned DOM tool card and an explicit visible field.
    const visible=node=>!!node?.getClientRects?.().length &&
      !node.closest?.('[hidden],[inert],[aria-hidden="true"]') &&
      getComputedStyle(node).display!=='none'&&getComputedStyle(node).visibility!=='hidden';
    const roots=[...section.querySelectorAll('[data-tool-call-id]')]
      .filter(n=>n.getAttribute('data-tool-call-id')===callId&&visible(n));
    if(roots.length!==1)return null;
    const root=roots[0];
    const snippet=field=>{
      const candidates=[...root.querySelectorAll('[data-testid="'+field+'"]')]
        .filter(visible);
      if(candidates.length!==1)return null;
      const value=candidates[0].innerText??candidates[0].textContent;
      if(typeof value!=='string'||!value.trim()||value.length>2048)return null;
      // Redact common credential forms even when the webpage renders them.
      return value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,'$1[REDACTED]')
        .replace(/\b((?:api[_-]?key|token|password|authorization|secret)\s*[:=]\s*)(["']?)[^\s"',};&]+/gi,'$1[REDACTED]');
    };
    const input=snippet('tool-call-input'),output=snippet('tool-call-output');
    return input||output?{...(input?{input}:{}),...(output?{output}:{})}:null;
  }
  function publicTimeline(turn,section=null) {
    if(!turn||!Array.isArray(turn.items)||turn.items.length>MAX_ITEMS)return null;
    const reasoning=[],calls=[],seen=new Set();
    let ordinal=0;
    function scan(items,depth=0,parentPosition=[]) {
      if(depth>4||!Array.isArray(items))return;
      for(const [index,item] of items.entries()) {
        const position=[...parentPosition,index];
        if(!publicItem(item))continue;
        if(item.type==='chatgpt-reasoning-group'){
          const recap=item.reasoningRecap;
          if(['show','summary','collapse'].includes(recap?.type)){
            const value=typeof recap.summary==='string'?recap.summary:
              typeof recap.text==='string'?recap.text:null;
            if(value && value.trim() && value.length<=4096 && reasoning.length<8){
              const key=nativeId(item.messageId)?item.messageId:
                nativeId(item.id)?item.id:`recap-${++ordinal}`;
              reasoning.push({id:key,text:value,position:[...position,-1]});
            }
          }
          // CoS's published recap of a round is a completed "thought".
          // Never inspect activeReasoning, raw/private analysis or tool payloads.
          if(reasoning.length<8 && recap?.type!=='hide_all'){
            for(const [stepIndex,step] of (Array.isArray(item.items)?item.items:[]).entries()){
              if(!publicItem(step)||step.type!=='reasoning'||
                 step.presentation!=='thought'||step.completed!==true)continue;
              const text=typeof step.content==='string'?step.content.trim():null;
              if(!text||text.length>4096)continue;
              const key=nativeId(step.messageId)?step.messageId:
                nativeId(step.id)?step.id:`recap-${++ordinal}`;
              if(!reasoning.some(r=>r.id===key))reasoning.push({id:key,text,position:[...position,stepIndex]});
              if(reasoning.length>=8)break;
            }
          }
          scan(item.items,depth+1,position);
          continue;
        }
        if(!['mcp-tool-call','dynamic-tool-call'].includes(item.type)||calls.length>=32)continue;
        const callId=item.callId;
        if(!nativeId(callId)||seen.has(callId))continue;
        let name=null,kind='tool';
        if(item.type==='dynamic-tool-call'){
          if(item.tool!=='exec')continue;
          name='代码执行';kind='exec';
        }else{
          const server=safe(item.invocation?.server),tool=displayTool(item.invocation?.tool);
          if(!tool)continue;
          name=(server?server+' · ':'')+tool;
          if(name.length>160)continue;
          kind=/search|browse|web\.run/i.test(tool)||/web|search/i.test(server??'')?'search':
            /image|text2im|generate_picture/i.test(tool)?'image':'tool';
        }
        // Only fixed status categories are surfaced; no native output objects.
        // A turn ChatGPT reports complete has no running calls left: history
        // reloaded from the server omits the per-call completed flag
        // (live page, 2026-10-17). An explicit failure stays a failure.
        const settled=item.status!=='failed'&&item.completed!==true&&turn.status==='complete';
        const state=item.status==='failed'?'failed':
          item.completed===true||settled?'completed':'running';
        const details=visibleToolEvidence(section,callId);
        calls.push({callId,name,kind,status:state,position,...(settled?{settled:true}:{}),...(details?{details}:{})});
        seen.add(callId);
      }
    }
    scan(turn.items);
    return {reasoning,calls};
  }
  globalThis.CIP_COS_ACTIVITY=Object.freeze({statusFor,shellTurnTrace,viewCallsOf,publicTimeline});
})();
