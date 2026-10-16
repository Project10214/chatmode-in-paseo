/* CIP ISOLATED consumer of CoS native outgoing request proof.
 * MAIN observer receives only a SHA-256 of our OWN prepared draft. It returns
 * a single server-accepted user message ID, never the request body or tools.
 * This optional path cannot trigger a Send or replay any previous Send.
 */
(() => {
  'use strict';
  const ID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const digest=async str=>Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',new TextEncoder().encode(str)))).map(n=>n.toString(16).padStart(2,'0')).join('');
  const conversation=path=>/^\/(?:g\/[^/]+\/)?c\/[0-9a-f-]{8,64}(?:\/|$)/i.test(path);
  const APPID=/^asdk_app_[A-Za-z0-9_-]{1,160}$/;
  async function arm(text, appIds = []) {
    if(typeof text!=='string'||text.length>256000||!crypto?.subtle||
       !Array.isArray(appIds)||appIds.length>8||
       !appIds.every(id=>typeof id==='string'&&APPID.test(id))||
       new Set(appIds).size!==appIds.length)return null;
    const nonce=crypto.randomUUID(),path=location.pathname,sha256=await digest(text);
    let proof=null,closed=false,done=false,resolveReady,timer,stage='armed';
    const ready=new Promise(resolve=>{resolveReady=resolve;});
    const receiver=event=>{
      const d=event.data;
      if(closed||event.source!==window||event.origin!==location.origin||d?.nonce!==nonce||d.v!==1)return;
      if(d.source==='cip-send-evidence-progress'&&done&&['request','shape','apps','parsed','mismatch','body','response','route','late','accepted'].includes(d.stage)) {
        stage=d.stage;
      } else if(d.source==='cip-send-evidence-armed'&&!done){
        done=true;resolveReady(d.ok===true&&d.path===path);
      } else if(d.source==='cip-send-evidence-observed'&&done&&d.path===path&&ID.test(d.id)&&
                Number.isFinite(d.observedAt)){
        proof={id:d.id,at:d.observedAt};
      }
    };
    window.addEventListener('message',receiver);
    const close=()=>{
      if(closed)return;
      closed=true;clearTimeout(timer);window.removeEventListener('message',receiver);
      window.postMessage({source:'cip-send-evidence-disarm',nonce},location.origin);
    };
    timer=setTimeout(()=>{if(!done){done=true;resolveReady(false);}},1300);
    window.postMessage({source:'cip-send-evidence-arm',v:1,nonce,sha256,path,appIds:[...appIds]},location.origin);
    const ok=await ready;
    clearTimeout(timer);
    if(!ok){close();return null;}
    return {
      status() {return {stage,routeMoved:path!==location.pathname};},
      since(clickedAt) {
        if(closed||!proof||!Number.isFinite(clickedAt)||proof.at<clickedAt-250||
           proof.at-clickedAt>12000)return null;
        // Never borrow another opened chat. The only path change accepted is
        // the first concrete conversation route after a new-chat Send.
        if(path!==location.pathname&&(conversation(path)||!conversation(location.pathname)))return null;
        return {id:proof.id};
      },
      close
    };
  }
  globalThis.CIP_COS_SEND_RECEIPT=Object.freeze({arm});
})();
