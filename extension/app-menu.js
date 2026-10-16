/* Paseo-specific @ menu adapter. No model calls, account data or permission changes.
 * Uses native editor input and CoS's committed Fiber reader (via a bounded MAIN reply).
 * Unknown/ambiguous identities refuse rather than attaching a same-named app.
 */
(() => {
  'use strict';
  globalThis.CIP_createAppMenu = ({ composer, authored, appId, chips, insert, until, fail, visible, delay }) => {
    const panels = '[role="listbox"],[role="menu"],[role="dialog"],[cmdk-root],[data-radix-popper-content-wrapper],[data-tippy-root]';
    const rows = '[role="option"],[role="menuitem"],[role="menuitemradio"],[cmdk-item],button,[role="button"],a[href^="app://"],[data-app-id]';
    const excluded = '[hidden],[inert],[aria-hidden="true"],[data-message-author-role],.markdown,[data-turn-key],.clf-stream';
    const shown = n => visible(n) && !n.closest(excluded) && [...function*(n){for(let p=n;p;p=p.parentElement)yield p}(n)]
      .every(p => !['none'].includes(getComputedStyle(p).display) && !['hidden','collapse'].includes(getComputedStyle(p).visibility));
    const label = n => (n.getAttribute('aria-label') || n.textContent || '').replace(/\s+/g,' ').trim().slice(0,200);
    const outer = list => list.filter(n => !list.some(p => p !== n && p.contains(n)));
    const candidates = panel => outer([...panel.querySelectorAll(rows)].filter(shown));
    const dismiss = () => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    const diagnostic = (stage, panel) => ({ stage,
      editorCount: [...document.querySelectorAll('#prompt-textarea,[contenteditable="true"][role="textbox"]')].filter(shown).length,
      panelCount: outer([...document.querySelectorAll(panels)].filter(shown)).length,
      rowCount: panel?.isConnected ? Math.min(128,candidates(panel).length) : 0 });
    async function nativeRows(panel, guard) {
      const list=candidates(panel);
      if(list.length>128)fail('APP_CATALOG_TOO_LARGE');
      if (!list.length && !panel.matches('[role="listbox"],[role="menu"]') && !panel.querySelector('[role="listbox"],[role="menu"]')) fail('APP_MENU_UNRECOGNIZED');
      // The old native DOM exposes exact app IDs without a MAIN lookup.
      const direct=list.map(node=>({id:appId(node),label:label(node),node}));
      if(direct.every(row=>row.id))return direct;
      // Current native buttons may carry their ID only in committed React props.
      // Mark this exact owned portal, never search the whole account/store by name.
      const nonce=crypto.randomUUID(), route=location.pathname;
      panel.setAttribute('data-cip-app-scan',nonce);
      let reply;
      try { reply=await new Promise(resolve=>{
        let done=false;
        const finish=value=>{if(done)return;done=true;clearTimeout(timer);window.removeEventListener('message',receive);resolve(value);};
        const receive=event=>{const d=event.data;if(event.source===window&&event.origin===location.origin&&d?.source==='cip-cos-apps-reply'&&d.nonce===nonce&&d.v===1)finish(d.apps);};
        const timer=setTimeout(()=>finish(null),1500);window.addEventListener('message',receive);
        window.postMessage({source:'cip-cos-apps-ask',nonce},location.origin);
      }); } finally { panel.removeAttribute('data-cip-app-scan'); }
      guard();
      if(!panel.isConnected||location.pathname!==route)fail('APP_MENU_CHANGED');
      if(!reply||!Array.isArray(reply.rows)||reply.rows.length>128||reply.path!==route)fail('APP_ID_UNPROVEN');
      const result=[];
      for(const r of reply.rows){
        if(!Number.isInteger(r.index)||r.index<0||r.index>=list.length||!/^asdk_app_[A-Za-z0-9_-]{1,160}$/.test(r.id)||typeof r.label!=='string'||!r.label||r.label.length>200)fail('APP_ID_UNPROVEN');
        const node=list[r.index];
        if(!node.isConnected||!panel.contains(node)||node.getAttribute('data-cip-app-proof')!==`${nonce}:${r.index}`)fail('APP_MENU_CHANGED');
        result.push({id:r.id,label:r.label,node});
      }
      if(reply.unresolved!==0||result.length!==list.length)fail('APP_ID_UNPROVEN');
      return result;
    }
    async function choices(guard=()=>{}) {
      guard();const box=composer();
      if(authored(box))fail('DRAFT_CONFLICT');
      const path=location.pathname, originalApps=chips().map(c=>c.id).sort();
      const before=new Set([...document.querySelectorAll(panels)].filter(shown));
      let touched=false, panel=null, trailing=null;
      const userEdit=e=>{if(e.isTrusted)touched=true;};
      for(const event of ['keydown','beforeinput','paste','drop','pointerdown'])document.addEventListener(event,userEdit,true);
      const current=()=>{guard();if(touched||composer()!==box||!box.isConnected||location.pathname!==path)fail('APP_PROBE_INTERRUPTED');};
      const cleanup=()=>{
        // Never clear a user's draft or any pre-existing app chip. Delete just our @.
        if(touched||!box.isConnected||composer()!==box||location.pathname!==path||authored(box)!=='@'||JSON.stringify(chips().map(c=>c.id).sort())!==JSON.stringify(originalApps))return false;
        const walker=document.createTreeWalker(box,NodeFilter.SHOW_TEXT);let node,target=null;
        while(node=walker.nextNode())if(!node.parentElement?.closest('[app-mention-path],[data-prompt-link-href^="app://"]')&&node.nodeValue.includes('@')){if(target)return false;target=node;}
        if(!target)return false;
        box.focus();const range=document.createRange(),at=target.nodeValue.indexOf('@');range.setStart(target,at);range.setEnd(target,at+1);
        const selection=document.getSelection();if(!selection)return false;
        selection.removeAllRanges();selection.addRange(range);
        if(!document.execCommand('delete',false))return false;
        if(trailing?.parentNode===box && trailing.nodeValue===' ')trailing.remove();
        return composer()===box && box.isConnected && location.pathname===path &&
          authored(box)==='' && JSON.stringify(chips().map(c=>c.id).sort())===JSON.stringify(originalApps);
      };
      try {
        box.focus();
        // Some native mention plugins open on keydown, others on the resulting input.
        box.dispatchEvent(new KeyboardEvent('keydown',{key:'@',code:'Digit2',shiftKey:true,bubbles:true,cancelable:true}));
        current();if(!authored(box)){
          if(chips().length && box.lastChild?.nodeType===Node.ELEMENT_NODE &&
             box.lastChild.matches('[app-mention-path],[data-prompt-link-href^="app://"]')){
            trailing=document.createTextNode(' ');box.append(trailing);
          }
          insert('@');
        }
        box.dispatchEvent(new KeyboardEvent('keyup',{key:'@',code:'Digit2',shiftKey:true,bubbles:true}));
        current();if(authored(box)!=='@')fail('APP_PROBE_INPUT_UNCONFIRMED');
        panel=await until(()=>{
          const controlled=[box,document.activeElement].filter(Boolean).flatMap(n=>(n.getAttribute('aria-controls')||n.getAttribute('aria-owns')||'').split(/\s+/)).filter(Boolean)
            .map(id=>document.getElementById(id)).filter(n=>n&&shown(n)&&n.matches(panels)&&!before.has(n));
          const owned=outer([...new Set(controlled)]);
          if(owned.length===1)return owned[0];
          const fresh=outer([...document.querySelectorAll(panels)].filter(n=>shown(n)&&!before.has(n)));
          if(fresh.length>1)fail('AMBIGUOUS_APP_MENU');
          return fresh[0]||null;
        },15000,'APP_MENU_TIMEOUT',current);
        await until(()=>!panel.querySelector('[role="progressbar"],[aria-busy="true"]')&&panel.getAttribute('aria-busy')!=='true',10000,'APP_MENU_LOADING_TIMEOUT',current);
        await delay(250);current();if(!panel.isConnected)fail('APP_MENU_CHANGED');
        const found=await nativeRows(panel,current);
        const enabled=found.filter(r=>r.node.getAttribute('aria-disabled')!=='true'&&!r.node.disabled);
        if(enabled.length>32)fail('APP_CATALOG_TOO_LARGE');
        if(new Set(enabled.map(r=>r.id)).size!==enabled.length)fail('AMBIGUOUS_APPS');
        // Restore the exact original editor before exposing this native proof.
        // A partial cleanup is NOT permission to configure or Send.
        dismiss();if(!cleanup())fail('APP_PROBE_CLEANUP_UNCONFIRMED');
        return enabled.map(({id,label})=>({id,label}));
      } catch(error) {
        error.diagnostic=diagnostic('apps',panel);
        if(!touched&&location.pathname===path){dismiss();cleanup();}
        throw error;
      } finally {
        for(const event of ['keydown','beforeinput','paste','drop','pointerdown'])document.removeEventListener(event,userEdit,true);
      }
    }
    async function probedChoices(probe, guard=()=>{}) {
      guard();probe?.check();
      const panel=probe?.panel?.();
      if(!panel || !panel.isConnected ||
         panel.querySelector('[role="progressbar"],[aria-busy="true"]') ||
         panel.getAttribute('aria-busy')==='true')return null;
      // Read only the single portal opened by the already-owned @ probe.
      // All identities must be backed by DOM attributes or committed Fiber.
      const found=await nativeRows(panel,()=>{guard();probe.check();});
      const enabled=found.filter(r=>r.node.getAttribute('aria-disabled')!=='true'&&!r.node.disabled);
      if(enabled.length>32||new Set(enabled.map(r=>r.id)).size!==enabled.length)fail('AMBIGUOUS_APPS');
      return enabled.map(({id,label})=>({id,label}));
    }
    return { choices, probedChoices };
  };
})();
