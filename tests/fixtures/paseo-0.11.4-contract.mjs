/**
 * Narrow, independently written compatibility model for Paseo 0.11.4.
 *
 * Ground truth inspected read-only on 2026-10-16:
 * daemon: app.asar/node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js
 *   mapTimelineItem at lines 1338-1380, translateTimeline at 1126-1139,
 *   PluginAgentSession constructor at 856-879 and accept at 1060-1065.
 * renderer: app-dist/_expo/static/js/web/index-72553504501f81e1c6b8473200a1c78b.js
 *   Metro reducer 3661 (applyStreamEvent, A, V, G, Ie, fe).
 *
 * This is NOT a vendored Paseo runtime and does not claim to cover its entire
 * timeline implementation. A separate opt-in parity run executes the original
 * installed daemon mapper and web reducer against every test sequence. The
 * default portable tests NEVER skip or require a proprietary app installation.
 */
export const PASEO_0114 = Object.freeze({
  appVersion: '0.11.4',
  sdkVersion: '0.11.2',
  daemonArchiveEntry: 'node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js',
  daemonFileSha256: 'dc9948ca942d2aeef10a48c4ef1fc625819005ef28296bb386cfb9737502d475',
  daemonMappingLines: '1338-1380',
  webBundleName: 'index-72553504501f81e1c6b8473200a1c78b.js',
  webBundleSha256: 'f420d2f7bf85d22207ea62dc54b5593e9dee8b4261874a83fa8e37f938872486',
  webMetroReducerId: 3661
});

export function createHostConverter() {
  // The installed daemon owns this Map per PluginAgentSession, not per tool
  // card or turn. New sessions/reopens use their own new Map.
  const snapshots = new Map();
  let currentTurnId = null;
  function translate(event) {
    if (event.type === 'session.turn') {
      if (event.state === 'started') currentTurnId = event.turnId;
      else if (currentTurnId === event.turnId) currentTurnId = null;
      return [{type: 'turn_'+event.state, provider: 'chatmode', turnId: event.turnId}];
    }
    if (event.type !== 'timeline.item') return [];
    const item = mapTimelineItem(event.item, snapshots);
    return item ? [{
      type: 'timeline', provider: 'chatmode', item,
      turnId: currentTurnId ?? undefined, timestamp: event.timestamp
    }] : [];
  }
  return {snapshots,translate};
}

/** Behavior subset from installed daemon's mapTimelineItem, independently coded. */
export function mapTimelineItem(item, snapshots) {
  const before = snapshots.get(item.id);
  snapshots.set(item.id, item);
  if (item.type === 'assistant_message' || item.type === 'reasoning') {
    const old = before?.type === item.type ? before.text : '';
    const chunk = item.text.startsWith(old) ? item.text.substring(old.length) : item.text;
    if (chunk.length === 0) return null;
    return item.type === 'assistant_message'
      ? {type: 'assistant_message', text: chunk, messageId: item.messageId ?? item.id}
      : {type: 'reasoning', text: chunk};
  }
  if (item.type === 'plugin') return {
    type: 'plugin', id: item.id, pluginId: item.pluginId, kind: item.kind,
    version: item.version, data: item.data
  };
  if (item.type === 'user_message') {
    if (before?.type === 'user_message' && before.text === item.text) return null;
    return {type: 'user_message',text:item.text,messageId:item.messageId??item.id,
      clientMessageId:item.clientMessageId};
  }
  const {id,revertToken,...rest} = item;
  return rest;
}

/**
 * Public stream projection of the relevant Metro 3661 operations.
 * It models the head/tail flush around plugin/tool cards, assistant chunk
 * concatenation and plugin/tool identity upserts. Only these are tested here.
 * It intentionally allows multiple assistant rows; exact overall displayed
 * text is the invariant, not an imposed single-row layout.
 */
export function portableRender(events) {
  let tail=[], head=[], sequence=0;
  function flush() {
    if (!head.length) return;
    const existing=new Set(tail.map(x=>x.id));
    tail=[...tail,...head.filter(x=>!existing.has(x.id))];
    head=[];
  }
  for (const event of events) {
    if (event.type.startsWith('turn_')) { flush(); continue; }
    if (event.type !== 'timeline') continue;
    const item=event.item;
    if (item.type === 'assistant_message') {
      if (head.length && head.at(-1).kind !== 'assistant_message') flush();
      if (!head.length && tail.at(-1)?.kind==='assistant_message' &&
          tail.at(-1).messageId===item.messageId) {
        head=[tail.at(-1)];
        tail=tail.slice(0,-1);
      }
      const previous=head.at(-1);
      if(previous?.kind==='assistant_message' && previous.messageId===item.messageId){
        head[head.length-1]={...previous,text:previous.text+item.text};
      }else{
        const alreadyUsed=new Set([...tail,...head].map(x=>x.id));
        const id=alreadyUsed.has(item.messageId) ? item.messageId+':segment:'+sequence++ : item.messageId;
        head.push({kind:'assistant_message',id,messageId:item.messageId,text:item.text});
      }
      continue;
    }
    flush();
    if(item.type==='plugin'){
      const key=item.pluginId+'/'+item.id;
      const n=tail.findIndex(x=>x.kind==='plugin'&&x.key===key);
      const row={kind:'plugin',key,id:key,itemKind:item.kind,pluginId:item.pluginId,
        data:item.data,version:item.version};
      if(n<0)tail.push(row);else tail[n]=row;
    } else if(item.type==='tool_call'){
      const key=(event.turnId??'')+':'+item.callId;
      const n=tail.findIndex(x=>x.kind==='tool_call'&&x.key===key);
      const row={kind:'tool_call',key,id:'agent_tool_'+key,callId:item.callId,status:item.status};
      if(n<0)tail.push(row);else tail[n]=row;
    } else if(item.type==='user_message'){
      tail.push({kind:'user_message',id:item.messageId,text:item.text});
    }
  }
  return [...tail,...head];
}
