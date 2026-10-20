/* Chat On Steroids (MIT), function-level adaptation of extension/usage.js
 * @ e40562640361ca8f74158b2262ca8c555b00abed: noteSendModel,
 * installFetchObserver. Only a precisely armed native Send is examined.
 * The original fetch/response are returned unmodified. No prompt, secrets,
 * headers, cookies, model, or tool data cross worlds.
 */
(() => {
  'use strict';
  const KEY='__CIP_COS_SEND_EVIDENCE_V1__',MAX_TEXT=256000,MAX_REQUEST_BYTES=2_000_000;
  // The POST must START within 12 seconds of authorization; its SSE headers
  // can legitimately arrive later during long-running model/tool work.
  const RESPONSE_WAIT_MS=70000;
  if (globalThis[KEY]) return;
  const nativePost=window.postMessage.bind(window);
  const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const NONCE=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const SHA=/^[a-f0-9]{64}$/;
  // Native app chips may have non-Latin or underscored labels. Omit only
  // explicit app:// links for this turn's already-authorized selection.
  const APPID=/^asdk_app_[A-Za-z0-9_-]{1,160}$/;
  const MENTION=/[ \t]*\[([$@][\p{L}\p{N}_. -]{1,100})\]\(app:\/\/(asdk_app_[A-Za-z0-9_-]{1,160})\)[ \t]*/gu;
  const isSendURL=value=>{
    try { const u=new URL(value,location.origin);
      return u.origin===location.origin&&/^\/backend-api\/(?:f\/)?conversation$/.test(u.pathname);
    } catch {return false;}
  };
  const hash=async str=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(str))))
    .map(n=>n.toString(16).padStart(2,'0')).join('');
  const normalize=(str,apps)=>{
    let unknown=false;
    const clean=str.replace(MENTION,(whole,_label,id)=>{
      if(!apps.has(id)){unknown=true;return whole;}
      return ' ';
    }).trim();
    return unknown?null:clean;
  };
  // One native Markdown unescape, as in CoS receipt text; never fuzzy-match.
  const unescapeMarkdown=str=>str.replace(/\\\r?\n/g,'\n').replace(/\\([!-/:-@[-\x60{-~])/g,'$1')
    .replace(/(^|\n)&#x20;/g,'$1 ');
  const CONVERSATION_PATH=/^\/(?:g\/[^/]+\/)?c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i;
  const freshTarget=(from,next)=>{
    if(!CONVERSATION_PATH.test(next))return false;
    if(from==='/')return next.startsWith('/c/');
    const group=/^\/g\/([^/]+)\/?$/.exec(from);
    return !!group&&next.startsWith('/g/'+group[1]+'/c/');
  };
  // Both forms name the same route; never normalize a conversation or group ID.
  const routeKey=path=>CONVERSATION_PATH.test(path)||/^\/g\/[^/]+\/$/.test(path)
    ?path.replace(/\/$/,''):path;
  function routeOf(current){
    const path=routeKey(location.pathname),start=routeKey(current.path);
    if(current.revoked)return false;
    if(path===start){if(current.elected){current.revoked=true;return false;}return true;}
    if(current.elected){
      if(current.elected!==path){current.revoked=true;return false;}
      return true;
    }
    if(freshTarget(start,path)){current.elected=path;return true;}
    // Even a non-conversation detour must revoke this arm permanently.
    // Otherwise '/' -> '/search' -> '/c/...' can borrow the pending POST.
    current.revoked=true;
    return false;
  }
  let active=true,arm=null,observedFetch=null;
  const progress=(current,stage)=>{
    if(!active||arm!==current||current.stage===stage)return;
    current.stage=stage;
    // Operational diagnostic only: no prompt, tool arguments or request URL.
    nativePost({source:'cip-send-evidence-progress',v:1,nonce:current.nonce,stage},location.origin);
  };
  async function bodyOf(input,init){
    if(init&&Object.prototype.hasOwnProperty.call(init,'body'))
      return typeof init.body==='string'&&init.body.length<=MAX_REQUEST_BYTES?init.body:null;
    if(!(input instanceof Request))return null;
    let clone;try{clone=input.clone();}catch{return null;}
    const reader=clone.body?.getReader();if(!reader)return null;
    const decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,value='';
    try{
      while(true){const part=await reader.read();if(part.done)break;
        bytes+=part.value.byteLength;if(bytes>MAX_REQUEST_BYTES)return null;
        value+=decoder.decode(part.value,{stream:true});
      }
      return value+decoder.decode();
    }catch{return null;}finally{void reader.cancel().catch(()=>{});}
  }
  const extract=async (args,current)=>{
    try {
      const input=args[0],init=args[1];
      const method=String(init?.method || input?.method || 'GET').toUpperCase();
      const url=typeof input==='string'?input:input instanceof URL?input.href:input?.url;
      if(method!=='POST'||!isSendURL(url))return null;
      progress(current,'request');
      const raw=await bodyOf(input,init);if(!raw)return null;
      const body=JSON.parse(raw),users=Array.isArray(body?.messages)?body.messages
        .filter(m=>m?.author?.role==='user'):null;
      // Never cherry-pick a valid UUID from a request containing another user
      // message. A native Send must name exactly one user message.
      if(!users||users.length!==1||!UUID.test(users[0].id)){progress(current,'shape');return null;}
      const content=users[0].content;
      const chunks=Array.isArray(content?.parts)?content.parts:
        typeof content?.text==='string'?[content.text]:
        typeof users[0].message==='string'?[users[0].message]:null;
      if(!chunks||!chunks.length||chunks.length>64){progress(current,'shape');return null;}
      const parts=[],serializedApps=new Set();
      const noteMentions=text=>{
        // A DOM chip is NOT proof that the real ChatGPT POST included an app.
        // Inspect only the already-armed user's app:// references. No prompt
        // content, tool arguments or IDs leave this isolated verifier.
        for(const match of text.matchAll(MENTION))serializedApps.add(match[2]);
      };
      for(const part of chunks){
        if(typeof part==='string'){parts.push(part);noteMentions(part);continue;}
        if(!part||typeof part!=='object'||Array.isArray(part)){progress(current,'shape');return null;}
        const keys=Object.keys(part);
        // Unknown rich parts, attachments and tool payloads must fail closed.
        if(part.type==='app_mention'&&APPID.test(part.app_id)&&current.apps.has(part.app_id)&&
           keys.every(k=>k==='type'||k==='app_id')){
          serializedApps.add(part.app_id);continue;
        }
        if((part.type==='text'||part.content_type==='text')&&typeof part.text==='string'&&
           keys.every(k=>['type','content_type','text'].includes(k))){
          parts.push(part.text);noteMentions(part.text);continue;
        }
        progress(current,'shape');return null;
      }
      if(!parts.length){progress(current,'shape');return null;}
      const appMatched=serializedApps.size===current.apps.size &&
        [...serializedApps].every(id=>current.apps.has(id));
      const variants=[...new Set([parts.join('\n'),parts.join('')])];
      if(variants.some(s=>s.length>MAX_TEXT)){progress(current,'shape');return null;}
      progress(current,'parsed');
      return {id:users[0].id,variants,appMatched};
    }catch{progress(current,'shape');return null;}
  };
  const install=()=>{
    if(!active||typeof window.fetch!=='function'||window.fetch===observedFetch)return;
    const downstream=window.fetch;
    observedFetch=function(...args){
      const current=arm,when=Date.now();
      const request=current&&!current.used&&when>=current.at&&when-current.at<=12000 &&
        routeOf(current)?extract(args,current):null;
      let reply;
      try {reply=downstream.apply(this,args);}catch(e){throw e;}
      if(request&&reply&&typeof reply.then==='function') {
        // Match the request body BEFORE awaiting the asynchronous SSE headers.
        // This distinguishes a slow response from malformed/unrelated content.
        const responsePromise=Promise.resolve(reply);
        void responsePromise.catch(()=>{});
        void request.then(async submission=>{
          if(!submission||!active||arm!==current||current.used)return;
          if(!routeOf(current)){progress(current,'route');return;}
          let matched=false;
          for(const raw of submission.variants){
            const text=normalize(raw,current.apps);
            if(text===null)continue;
            for(const candidate of new Set([text,unescapeMarkdown(text)])){
              if(candidate&&await hash(candidate)===current.hash){matched=true;break;}
            }
            if(matched)break;
          }
          if(!active||arm!==current||current.used)return;
          if(!routeOf(current)){progress(current,'route');return;}
          if(!matched){progress(current,'mismatch');return;}
          if(!submission.appMatched){
            // The exact authored body was sent, but the configured app was
            // absent from this POST. Never infer tool access or retry Send.
            progress(current,'apps');return;
          }
          progress(current,'body');
          const response=await responsePromise;
          if(!active||arm!==current||current.used)return;
          if(!routeOf(current)){progress(current,'route');return;}
          if(!response?.ok||!isSendURL(response.url)||
             !response.headers?.get('content-type')?.includes('text/event-stream')){
            progress(current,'response');return;
          }
          if(Date.now()-when>RESPONSE_WAIT_MS){progress(current,'late');return;}
          current.used=true;
          progress(current,'accepted');
          nativePost({source:'cip-send-evidence-observed',v:1,nonce:current.nonce,
            id:submission.id,observedAt:when,path:current.path},location.origin);
        }).catch(()=>{});
      }
      return reply;
    };
    window.fetch=observedFetch;
  };
  function armRequest(event) {
    if(!active||event.source!==window||event.origin!==location.origin)return;
    const data=event.data;
    if(data?.source==='cip-send-evidence-arm'&&data.v===1&&NONCE.test(data.nonce)&&
       SHA.test(data.sha256)&&data.path===location.pathname&&
       Array.isArray(data.appIds)&&data.appIds.length<=8&&
       data.appIds.every(id=>typeof id==='string'&&APPID.test(id))&&
       new Set(data.appIds).size===data.appIds.length&&
       typeof data.path==='string'&&data.path.length<=180) {
      // A second arming cannot silently steal the first click's identity.
      if(arm&&!arm.used&&Date.now()-arm.at<12000){
        nativePost({source:'cip-send-evidence-armed',v:1,nonce:data.nonce,ok:false},location.origin);
        return;
      }
      install();
      arm={nonce:data.nonce,hash:data.sha256,apps:new Set(data.appIds),path:data.path,at:Date.now(),used:false,elected:null,revoked:false,stage:'armed'};
      nativePost({source:'cip-send-evidence-armed',v:1,nonce:data.nonce,ok:true,path:data.path},location.origin);
    } else if(data?.source==='cip-send-evidence-disarm'&&NONCE.test(data.nonce)&&arm?.nonce===data.nonce) {
      arm=null;
    }
  }
  window.addEventListener('message',armRequest);
  const noticeRoute=()=>{if(arm&&!arm.used)routeOf(arm);};
  globalThis.navigation?.addEventListener('currententrychange',noticeRoute);
  window.addEventListener('popstate',noticeRoute);
  window.addEventListener('hashchange',noticeRoute);
  window.addEventListener('pagehide',()=>{arm=null;});
  install();
  if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',install,{once:true});
  globalThis[KEY]=Object.freeze({version:1,refresh:install});
})();
