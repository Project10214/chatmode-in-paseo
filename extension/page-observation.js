/* Read-only visible page facts. Independent of prose decoding and Send/Stop.
 * No credentials, hidden analysis, other tabs or native invocation payloads.
 */
(() => {
  'use strict';
  const EXCLUDED='.clf-stream,.clf-stage,.clf-composer,.clf-boot,.markdown,pre,code,[contenteditable="true"],[hidden],[inert],[aria-hidden="true"],.sr-only';
  const controlLabel=n=>(n.getAttribute('aria-label')||n.innerText||n.textContent||'').trim();
  const enabled=n=>!n.disabled&&n.getAttribute('aria-disabled')!=='true';
  function visible(node){
    if(!node?.isConnected||!node.getClientRects().length||node.closest(EXCLUDED))return false;
    for(let n=node;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse')return false;}
    return true;
  }
  globalThis.CIP_createPageObservation=C=>(transcript,anchorId)=>{
    const current=transcript?.path===location.pathname?transcript:null;
    const rows=current?.messages??[],at=rows.findIndex(x=>x.role==='user'&&x.id===anchorId);
    const end=at<0?-1:rows.findIndex((x,i)=>i>at&&x.role==='user');
    const owned=new Set(at<0?[]:rows.slice(at,end<0?undefined:end).map(x=>x.id));
    const activity=current?.activity?.userMessageId===anchorId?current.activity:null;
    const issues=(current?.issues??[]).filter(x=>x.userMessageId===anchorId)
      .map(x=>({messageId:x.messageId,code:x.code}));
    if(current?.error)issues.push({messageId:null,code:current.error});
    const value={observedAt:Date.now(),readable:!!current?.available&&at>=0&&!current?.error,
      nativeStatus:activity?.nativeStatus??null,controls:{stop:null,approval:null},notices:[],issues,truncated:false};
    try{
      const stop=[...new Set([...(C.stopControls?.()??[]),...(C.nativeComposerControls?.('button[aria-label="Stop"]')??[])])].filter(visible);
      value.controls.stop={visible:stop.length>0,enabled:stop.some(enabled)};
      value.controls.approval=C.approvalWaiting();
    }catch{ /* Unreadable is not a negative control observation. */ }
    try{
      const scope=node=>{
        if(node.closest('aside,nav,[data-sidebar],[data-testid*="sidebar"]'))return 'sidebar';
        const owner=node.closest('[data-message-id],[data-chatgpt-search-message-ids]');
        if(owner){
          const ids=(owner.getAttribute('data-message-id')||owner.getAttribute('data-chatgpt-search-message-ids')||'').split(/\s+/);
          return ids.some(id=>owned.has(id))?'turn':null;
        }
        return 'page';
      };
      const roots=[...document.querySelectorAll('[role="alert"],[role="status"],[data-testid="conversation-error"],[data-testid="error-message"]')].filter(visible);
      // Error-only pages do not necessarily have an alert role. Observe a
      // visible retry control's immediate surface, never click it or classify
      // the whole document by matching arbitrary error words in assistant text.
      for(const button of document.querySelectorAll('button,[role="button"]')){
        if(!visible(button)||!/^(?:Retry|Try again|重试|再试一次)$/i.test(controlLabel(button)))continue;
        const surface=button.parentElement;
        if(surface&&surface!==document.body&&visible(surface)&&!roots.some(n=>n.contains(button)))roots.push(surface);
      }
      let remaining=24000;
      for(const node of roots.filter(n=>!roots.some(other=>other!==n&&other.contains(n)))){
        const ownerScope=scope(node);if(!ownerScope||node.contains(C.composer?.()))continue;
        const raw=node.innerText;if(typeof raw!=='string'||!raw.trim())continue;
        if(value.notices.length>=16||remaining<=0){value.truncated=true;break;}
        const limit=Math.min(8192,remaining),text=raw; // Server redacts and marks it explicitly.
        if(text.length>limit)value.truncated=true;
        const buttons=[];
        for(const b of node.querySelectorAll('button,[role="button"]')){
          if(!visible(b))continue;
          const label=controlLabel(b);if(!label||label.length>160){value.truncated=true;continue;}
          if(buttons.length>=8){value.truncated=true;break;}
          buttons.push({label,enabled:enabled(b)});
        }
        value.notices.push({scope:ownerScope,text:text.slice(0,limit),buttons});remaining-=Math.min(limit,text.length);
      }
    }catch{value.issues.push({messageId:null,code:'PAGE_SIGNALS_UNAVAILABLE'});}
    return value;
  };
})();
