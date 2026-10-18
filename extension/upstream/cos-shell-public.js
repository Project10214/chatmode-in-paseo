/* Chat On Steroids — MIT, Copyright (c) 2026 Chat On Steroids contributors.
 * Public-only transplant from extension/fiber.js @ e40562640361ca8f74158b2262ca8c555b00abed:
 * shellTurnSource, shellItemText, turnViewOf,
 * messagesFromTurnView, shellQueries and shellConversation.
 * CIP adaptations: explicit bounds/refusals; no tool/media/analysis payloads;
 * sourceFor connects the existing committed Fiber reader to these source readers.
 * Message-level completion and the raw public representation are forwarded.
 * One-shot DIL decoding lives in shared/public-prose.mjs on the receiver.
 * This does not send messages or infer receipts from a URL, elapsed time or button.
 */
(() => {
  'use strict';
  const MAX_CLIMB = 80, MAX_ROOT_DEPTH = 2048, MAX_ROWS = 400, MAX_RENDERED_TEXT = 256000;
  const str = value => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
  const reject = code => { throw new Error(code); };
  const boundedText = text => { if (typeof text === 'string' && text.length > MAX_RENDERED_TEXT) reject('TRANSCRIPT_LIMIT'); return text; };
  const ONLY_CONTENT_REFERENCES = /^\s*(?:::chatgpt-content-reference\{[^}\n]*\}\s*)+$/;

  // Read an owned public representation; do not decode or retain prose here.
  // The receiver performs one-shot format adaptation after message completion.
  function shellItemText(item) {
    const content=typeof item?.content==='string'?boundedText(item.content):null;
    if(content!==null&&!ONLY_CONTENT_REFERENCES.test(content))
      return {text:content,format:'text',readable:true};
    const id=str(item?.messageId),refs=Array.isArray(item?.contentReferences)?item.contentReferences:[];
    if(refs.length>MAX_ROWS)return {text:'',format:'dil',readable:false};
    const dil=refs.filter(r=>r?.type==='dil');
    const own=dil.filter(r=>r.source_message_id===id&&
      typeof r.model_dil_v2?.fallbackMarkdown==='string'&&r.model_dil_v2.fallbackMarkdown.trim());
    if(own.length===1)return {text:boundedText(own[0].model_dil_v2.fallbackMarkdown),format:'dil',readable:true};
    // A media-only reference is not an unreadable prose body.
    if(content!==null&&ONLY_CONTENT_REFERENCES.test(content)&&dil.length===0)
      return {text:'',format:'text',readable:true};
    return {text:'',format:dil.length?'dil':'text',readable:false};
  }
  function projectProse(item,complete){
    try{
      const result=shellItemText(item);
      return {...result,issue:complete&&!result.readable?'ANSWER_CONTENT_UNAVAILABLE':null};
    }catch(error){
      if(error?.message!=='TRANSCRIPT_LIMIT')throw error;
      return {text:'',format:'text',readable:false,issue:'ANSWER_CONTENT_LIMIT'};
    }
  }
  function shellQueries(fiber) {
    try {
      for (let at = fiber, up = 0; at && up < MAX_ROOT_DEPTH; up++, at = at.return) {
        const client = at.memoizedProps?.client;
        if (typeof client?.getQueryCache !== 'function') continue;
        const queries = client.getQueryCache()?.getAll();
        return Array.isArray(queries) && queries.length <= 512 ? queries : [];
      }
    } catch { /* No cached guess if the mounted native owner cannot be read. */ }
    return [];
  }
  function shellConversation(queries, localId, evidence) {
    if (evidence.conflict || !localId?.startsWith('local-chatgpt:')) return evidence;
    let found = evidence.conversationId;
    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key.length !== 2 || key[0] !== 'chatgpt-conversation-details' || key[1]?.clientConversationId !== localId) continue;
      const server = key[1].serverConversationId;
      if (typeof server !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(server)) continue;
      if (found && found !== server) return { conversationId: null, conflict: true };
      found = server;
    }
    return { conversationId: found, conflict: false };
  }
  function turnViewOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn;
      if (turn && typeof turn === 'object' && Array.isArray(turn.items)) return turn;
    }
    return null;
  }
  const publicProseItem=item=>item&&typeof item==='object'&&!Array.isArray(item)&&
    item.isVisuallyHidden!==true&&item.isTransient!==true&&
    (item.recipient==null||item.recipient==='all')&&
    !['analysis','private'].includes(item.channel)&&!['analysis','private'].includes(item.phase)&&
    item.reasoningRecap?.type!=='hide_all'&&
    item.metadata?.is_visually_hidden!==true&&item.metadata?.is_visually_hidden_from_conversation!==true&&
    item.metadata?.is_visually_hidden_reasoning_group!==true&&
    item.metadata?.summary_type!=='raw_cot';
  function projectTurnMessages(turn,source){
    if(!turn||!Array.isArray(turn.items))return null;
    if(turn.items.length>MAX_ROWS)reject('TRANSCRIPT_LIMIT');
    const messages=[],seen=new Set();
    const topLevel=new Set(turn.items.filter(x=>publicProseItem(x)&&x.type==='assistant-message')
      .map(x=>str(x.messageId)||str(x.latestMessageId)).filter(Boolean));
    let work=0,lastAnswer=null;
    function scan(items,position=[],nested=false){
      if(position.length>4||!Array.isArray(items)||items.length>MAX_ROWS)reject('TRANSCRIPT_LIMIT');
      for(const [index,item] of items.entries()){
        if(++work>MAX_ROWS)reject('TRANSCRIPT_LIMIT');
        if(!publicProseItem(item))continue;
        const at=[...position,index];
        if(item.type==='chatgpt-reasoning-group'){scan(item.items??[],at,true);continue;}
        if(!nested&&item.type==='generated-image'){lastAnswer=item;continue;}
        if(!['user-message','assistant-message'].includes(item.type))continue;
        const user=item.type==='user-message';
        if(nested&&user)continue;
        const id=str(item.messageId)||(user?str(item.serverMessageId):str(item.latestMessageId));
        if(!id)continue;
        // Proved subordinate copies are excluded BEFORE touching the parser.
        if(nested&&topLevel.has(id))continue;
        if(seen.has(id)||(user&&item.serverMessageId&&item.messageId&&item.serverMessageId!==item.messageId))
          reject('TRANSCRIPT_CONFLICT');
        seen.add(id);
        const final=!user&&!nested&&item.phase==='final_answer';
        // Message readiness is independent of channel and task completion.
        // Only the terminal flag below also requires the native turn to end.
        const messageDone=item.completed===true;
        const {text,issue,format='text',readable=true}=user?{text:boundedText(item.message),issue:null}:
          projectProse({messageId:id,content:item.content,contentReferences:item.contentReferences},messageDone);
        if(final)lastAnswer=item;
        const terminal=final&&item.completed===true&&turn.status==='complete'&&!issue;
        messages.push({id,author:{role:user?'user':'assistant'},recipient:'all',
          channel:user?null:final?'final':'commentary',
          status:terminal?'finished_successfully':'in_progress',end_turn:terminal,
          content:{content_type:'text',parts:[typeof text==='string'?text:'']},
          metadata:{cipPosition:at,cipProseFormat:format,cipProseReadable:readable,
            cipMessageState:user||messageDone?'complete':'pending',...(issue?{cipProseIssue:issue}:{})}});
      }
    }
    scan(turn.items);
    if(lastAnswer?.type==='generated-image')for(const row of messages){row.end_turn=false;row.status='in_progress';}
    return messages;
  }
  function messagesFromTurnView(turn) { return projectTurnMessages(turn,'view'); }
  function shellEntryOf(fiber) {
    for (let at = fiber, up = 0; at && up < 16; up++, at = at.return) {
      if (Array.isArray(at.memoizedProps?.entry?.turn?.items)) return at.memoizedProps.entry;
    }
    return null;
  }
  function shellTurnSource(fiber, section, turnId) {
    const entry=shellEntryOf(fiber);
    if(!entry||!turnId||entry.id!==turnId)return null;
    const messages=projectTurnMessages(entry.turn,'shell');
    return {entry,messages,endMessageId:globalThis.CIP_COS_PUBLIC_CORE.turnEndMessageId(messages)};
  }
  // Integration only: prefer the exact native typed model to legacy DOM captions.
  function sourceFor(fiber, section, evidence) {
    // CoS turnsOf: a search-user anchor uses turnViewOf even when its Fiber
    // also inherits a shell entry. That anchor has no shell turn marker, so
    // shellTurnSource would discard the real user message (receipt stays empty).
    // This is native turn.items evidence, not layout-key or visible-text proof.
    if (section.matches?.('[data-chatgpt-search-unit-key$=\":user\"]')) {
      const candidate=section.closest?.('article');
      const anchors=candidate?.querySelectorAll?.('[data-chatgpt-search-unit-key$=\":user\"]');
      const toolSurface=anchors?.length===1 && anchors[0]===section ? candidate : section;
      const view = turnViewOf(fiber);
      const messages = messagesFromTurnView(view);
      return { recognized: true, kind: 'view', scope: evidence, messages,
        terminal: globalThis.CIP_COS_PUBLIC_CORE.turnEndMessageId(messages),
        activity: globalThis.CIP_COS_ACTIVITY?.shellTurnTrace(view) ?? null,
        timeline: globalThis.CIP_COS_ACTIVITY?.publicTimeline(view,toolSurface) ?? null };
    }
    const entry = shellEntryOf(fiber);
    if (entry) {
      const anchor = section.closest('[data-turn-key]') || section;
      const marker = anchor.querySelector('[data-content-search-turn-key]');
      const turnId = marker?.getAttribute('data-content-search-turn-key') || anchor.getAttribute('data-turn-id') || anchor.getAttribute('data-turn-key');
      const scope = shellConversation(shellQueries(fiber), entry.conversationId, evidence);
      const source = shellTurnSource(fiber, anchor, turnId);
      return { recognized: true, kind: 'shell', scope, messages: source?.messages ?? null, terminal: source?.endMessageId ?? null,
        activity: source ? globalThis.CIP_COS_ACTIVITY?.shellTurnTrace(source.entry.turn) ?? null : null,
        timeline: source ? globalThis.CIP_COS_ACTIVITY?.publicTimeline(source.entry.turn,section) ?? null : null };
    }
    const view = turnViewOf(fiber);
    if (view) {
      const messages = messagesFromTurnView(view);
      return { recognized: true, kind: 'view', scope: evidence, messages, terminal: globalThis.CIP_COS_PUBLIC_CORE.turnEndMessageId(messages),
        activity: globalThis.CIP_COS_ACTIVITY?.shellTurnTrace(view) ?? null,
        timeline: globalThis.CIP_COS_ACTIVITY?.publicTimeline(view,section) ?? null };
    }
    return { recognized: false };
  }
  globalThis.CIP_COS_SHELL_PUBLIC = Object.freeze({ sourceFor });
})();
