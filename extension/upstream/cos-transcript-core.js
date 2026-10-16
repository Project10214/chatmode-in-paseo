/* CoS fiber.js function-level transplant. Copyright (c) 2026 Chat On Steroids contributors.
 * MIT; source ccd23b66cecf2f684fa3e12ca190297be02842cf. Public text / terminal proof ONLY.
 * No thought/analysis payload, tool arguments, cookies, account objects or actions exported.
 */
(() => {
  'use strict';
  const MAX_CLIMB=80,MAX_RENDERED_TEXT=256000;
  const str=value=>typeof value==='string'&&value.length>0?value.slice(0,200):null;
  function channelOf(message) { return message && typeof message === 'object' ? str(message.channel) : ''; }
  function neverTerminalChannel(message) { const channel=channelOf(message);return channel==='analysis'||channel==='commentary'; }
  function hiddenMessage(message) {
    const meta=message&&typeof message==='object'?message.metadata:null;
    return Boolean(meta&&typeof meta==='object'&&(meta.is_visually_hidden_from_conversation===true||meta.is_visually_hidden===true));
  }
  const APP_MENTION_LINK=/[ \t]*\[\$[a-z0-9][a-z0-9-]{0,80}\]\(app:\/\/asdk_app_[A-Za-z0-9_-]{1,160}\)[ \t]*/g;
  function withoutAppMentions(value) {
    if(typeof value!=='string'||!value.includes('](app://asdk_app_'))return value;
    return value.replace(APP_MENTION_LINK,' ').trim();
  }
  function authoredText(message) {
    const content=message&&typeof message==='object'?message.content:null;
    if(!content||typeof content!=='object'||content.content_type!=='text')return null;
    if(Array.isArray(content.parts)){
      let value='';
      for(let at=0;at<content.parts.length;at++){
        const part=content.parts[at];if(typeof part!=='string')continue;
        if(value)value+='\n';value+=part;if(value.length>=MAX_RENDERED_TEXT)break;
      }
      value=value.slice(0,MAX_RENDERED_TEXT);return value.length>0?value:null;
    }
    return typeof content.text==='string'&&content.text.length>0?content.text.slice(0,MAX_RENDERED_TEXT):null;
  }
  function turnEndMessageId(messages) {
    if(!Array.isArray(messages))return null;
    for(let index=messages.length-1;index>=0;index--){
      const message=messages[index];if(!message||typeof message!=='object')continue;
      const author=message.author;if(!author||author.role!=='assistant')continue;
      const content=message.content;
      if(!content||typeof content!=='object'||!['text','multimodal_text','image'].includes(content.content_type))continue;
      if(neverTerminalChannel(message))continue;
      if(message.end_turn===true&&message.status==='finished_successfully')return str(message.id);
      return null;
    }
    return null;
  }
  function turnMessagesOf(fiber) {
    let at=fiber;
    for(let up=0;at&&up<MAX_CLIMB;up++,at=at.return){
      const props=at.memoizedProps;if(!props||typeof props!=='object')continue;
      const turn=props.turn;
      if(turn&&typeof turn==='object'&&Array.isArray(turn.messages))return turn.messages;
      if(Array.isArray(props.allMessages))return props.allMessages;
    }
    return null;
  }
  function conversationEvidenceOf(fiber) {
    let found=null;const conversations=new Map();let at=fiber;
    for(let up=0;at&&up<MAX_CLIMB;up++,at=at.return){
      const props=at.memoizedProps;if(!props||typeof props!=='object')continue;
      const turn=props.turn&&typeof props.turn==='object'?props.turn:null;
      const conversation=props.conversation&&typeof props.conversation==='object'?props.conversation:null;
      if(conversation&&!conversations.has(conversation)){
        let serverId=null;
        try{const value=typeof conversation.serverId$==='function'?conversation.serverId$():null;
          if(typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))serverId=value;
        }catch{}
        conversations.set(conversation,serverId);
      }
      const values=[props.clientThreadId,props.conversationId,conversation&&conversation.id,
        Array.isArray(props.entry?.turn?.items)?props.entry.conversationId:null,
        conversations.get(conversation),turn&&turn.clientThreadId,turn&&turn.conversationId];
      for(let index=0;index<values.length;index++){
        const value=str(values[index]);if(!value||value.startsWith('WEB:')||value.startsWith('local-chatgpt:'))continue;
        if(found&&found!==value)return{conversationId:null,conflict:true};found=value;
      }
    }
    return{conversationId:found,conflict:false};
  }
  globalThis.CIP_COS_PUBLIC_CORE=Object.freeze({authoredText,withoutAppMentions,turnEndMessageId,turnMessagesOf,conversationEvidenceOf,hiddenMessage,channelOf});
})();
