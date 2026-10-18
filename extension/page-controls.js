/* Visible composer controls only. No native turn metadata, prose, permission
 * state, delivery receipts, network calls or clicks participate in this view.
 * Binding/observation lifetime is owned by the continuous observer, not here.
 */
(() => {
  'use strict';
  const OWN='.clf-stream,.clf-stage,.clf-composer,.clf-boot,[data-cip-owned]';
  const COMPOSER='#prompt-textarea,form [contenteditable="true"][role="textbox"],form[data-chatgpt-composer] textarea';
  const STOP_LABEL=/^(?:Stop(?: streaming| generating| answering)?|停止(?:生成|回答|输出)?)$/i;
  const SEND_LABEL=/^(?:Send(?: message| prompt)?|发送(?:消息|信息)?)$/i;
  const VOICE_LABEL=/^(?:Start Voice(?: mode)?|开始语音(?:模式|对话)?|启动语音(?:模式|对话)?)$/i;
  // Public square-stop glyph used by the current composer. Unrecognized
  // unlabeled icons are not guessed to be Send (an empty composer uses Voice).
  const STOP_SQUARE=/^\s*M4\.5 5\.75/;
  function visible(node) {
    if(!node?.isConnected||!node.getClientRects().length||node.closest(`${OWN},[hidden],[aria-hidden="true"],[inert]`))return false;
    for(let at=node;at;at=at.parentElement){
      const style=getComputedStyle(at);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||
        style.opacity==='0'||style.contentVisibility==='hidden')return false;
    }
    return true;
  }
  function composerForm() {
    const forms=[...new Set([...document.querySelectorAll(COMPOSER)]
      .filter(node=>visible(node)&&!node.closest('[data-turn-key],article,[data-codex-approval-surface]'))
      .map(node=>node.closest('form')).filter(Boolean))];
    return forms.length===1?forms[0]:null;
  }
  function kind(button) {
    const label=(button.getAttribute('aria-label')||'').trim();
    const testId=button.getAttribute('data-testid');
    if(['stop-button','composer-stop-button'].includes(testId)||STOP_LABEL.test(label))return 'stop';
    if(['send-button','composer-submit-button'].includes(testId)||SEND_LABEL.test(label))return 'send';
    if(VOICE_LABEL.test(label))return 'voice';
    if(button.classList.contains('size-token-button-composer')&&button.classList.contains('bg-composer-primary')){
      const paths=button.querySelectorAll('svg path');
      if(paths.length===1&&STOP_SQUARE.test(paths[0].getAttribute('d')||''))return 'stop';
    }
    return null;
  }
  function button(type) {
    const form=composerForm();
    if(!form)return null;
    const matches=[...form.querySelectorAll('button')].filter(node=>visible(node)&&
      node.closest('form')===form&&kind(node)===type);
    return matches.length===1?matches[0]:null;
  }
  function classify(controls,readable=true) {
    if(controls.stop?.visible)return 'running';
    if(!readable)return 'abnormal';
    if(controls.send?.visible||controls.voice?.visible)return 'standby';
    return 'abnormal';
  }
  function read() {
    const controls={stop:{visible:false,enabled:false},send:{visible:false,enabled:false},voice:{visible:false,enabled:false}};
    let readable=true;
    try {
      const form=composerForm();
      if(form)for(const button of form.querySelectorAll('button')){
        if(!visible(button)||button.closest('form')!==form)continue;
        const type=kind(button);if(!type)continue;
        controls[type].visible=true;
        controls[type].enabled ||= !button.disabled&&button.getAttribute('aria-disabled')!=='true';
      }
    } catch { readable=false; }
    return {observedAt:Date.now(),state:classify(controls,readable),controls,readable};
  }
  globalThis.CIP_PAGE_CONTROLS=Object.freeze({read,classify,visible,composerForm,button});
})();
