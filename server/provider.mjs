import { BridgeError, invariant, validateSelection, sameSelection } from './protocol.mjs';
import { createHash } from 'node:crypto';
import { phaseLabel } from './activity.mjs';
import { catalogService } from './catalog.mjs';
import { createChromeWake } from './chrome-wake.mjs';

const wakeChrome = createChromeWake();

export const CAPABILITIES = ['prompt.message', 'prompt.image', 'session.configure', 'session.persistence', 'timeline.plugin'];
const errorOf = e => ({ message: e instanceof BridgeError ? e.message : 'Chatmode operation failed; inspect the bridge status.', code: e.code ?? 'BRIDGE_FAILURE' });
/** @returns {import('@getpaseo/plugin/server/provider').ProviderRegistration} */
export function createProvider(runtime, validateEvent = value => value) {
  return {
    id: 'chatmode', label: 'Chatmode', icon: 'icon.svg',
    description: 'ChatGPT browser conversations, using already-authorized ChatGPT apps',
    async status() { const s=runtime.status();return s.connected||s.paired ? { available: true } : { available: false, diagnostic: 'Pair the Chatmode in Paseo Chrome extension on this daemon host.' }; },
    async getCatalogCacheKey(options) {
      const data = runtime.store.read();
      return JSON.stringify({ scope: options.scope, cwd: options.cwd ?? '', defaults: data.defaults,
        models: data.catalog?.models, apps: data.catalog?.apps, defaultModel: data.catalog?.defaultModel });
    },
    async connect(request) {
      invariant(request.versions.includes(1), 'PROTOCOL_UNSUPPORTED');
      const capabilities = [...new Set(request.capabilities.filter(x => CAPABILITIES.includes(x)))];
      return createConnection(runtime, capabilities, validateEvent);
    }
  };
}
// Internal nulls are not wire defaults: Paseo's model schema accepts strings or omission.
export function wireModels(catalog, defaults = {}) {
  return catalog.models.map(m => {
    const def = m.id === defaults.model && defaults.thinkingOption != null
      ? defaults.thinkingOption : m.defaultThinkingOptionId;
    return { id: m.id, label: m.label, thinkingOptions: m.thinkingOptions.map(t => ({ id: t.id, label: t.label })),
      ...(def != null ? { defaultThinkingOptionId: def } : {}) };
  });
}
export function hostMcpNotice(servers = {}) {
  const entries = Object.entries(servers);
  for (const [name, config] of entries) {
    let internal = false;
    try {
      const url = new URL(config.url);
      // A deliberately narrow compatibility exception, not permission to ignore all MCP.
      internal = name === 'paseo' && config.type === 'http' && url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        /^\/mcp\/agents\/?$/.test(url.pathname) && !url.username && !url.password && !url.hash;
    } catch {}
    invariant(internal, 'MCP_CONFIG_UNSUPPORTED', 'This browser provider cannot import Paseo MCP entries. Use apps already authorized in ChatGPT. Only the host-shaped loopback paseo entry is excluded, with a visible warning.');
  }
  return entries.length ? { id: 'host-mcp-not-imported', severity: 'warning', title: 'Paseo 内置工具未导入网页会话',
    description: '已识别并排除宿主形状的本地 paseo MCP 配置。此 Provider 不执行该配置，也不转发其凭据；开发机工具须通过 ChatGPT 已授权的 @ 应用。网页模型不能因此自动创建 Paseo 子 Agent。' } : null;
}
export function configState(session, catalog, defaults = {}) {
  const effective=session.pendingConfig??session.config;
  const chosen=effective.appIds, saved=defaults.appIds??[];
  const same=(a,b)=>a.length===b.length&&a.every(id=>b.includes(id));
  const selected=chosen.length===0?'none'
    : chosen.length===1?'app:'+chosen[0]
    : saved.length>1&&same(chosen,saved)?'defaults'
    : chosen.length===catalog.apps.length?'all':'keep';
  // One native Paseo select, not a custom popover or one slider per app.
  const tools=[
    {label:'无工具（普通对话 / 生图）',value:'none'},
    ...catalog.apps.map(app=>({label:'@ '+app.label,value:'app:'+app.id})),
    ...(saved.length>1?[{label:'常用多工具组合（'+saved.length+'）',value:'defaults'}]:[]),
    ...(catalog.apps.length>1?[{label:'所有已授权应用',value:'all'}]:[]),
    ...(selected==='keep'?[{label:'保留当前组合（'+chosen.length+'）',value:'keep'}]:[])
  ];
  return {model:effective.model,...(effective.thinkingOption?{thinkingOption:effective.thinkingOption}:{}),
    models:wireModels(catalog),modes:[],thinkingOptions:catalog.models.find(m=>m.id===effective.model)?.thinkingOptions??[],
    settings:[{type:'select',id:'app:quick',label:'工具',value:selected,options:tools,
      description:'在这里直接切换已授权的 ChatGPT 应用；不会替你授予 MCP 权限。多工具常用组合在 Chatmode 设置页维护。'}]};
}
export function selectionFrom(config, catalog, defaults) {
  invariant(catalog, 'CATALOG_REQUIRED', 'Refresh the browser catalog before creating an agent.');
  const options = config.providerOptions ?? {};
  invariant(!options || Object.keys(options).every(k => k === 'appIds'), 'UNKNOWN_PROVIDER_OPTION');
  const chosen = options.appIds ?? defaults.appIds ?? [];
  invariant(Array.isArray(chosen), 'INVALID_APPS');
  const appIds = new Set(chosen);
  const settings=config.settings??{};
  for (const [key, value] of Object.entries(settings)) {
    if(key==='app:quick')continue;
    // Legacy per-app toggles remain accepted; the native select owns the visible UI.
    invariant(key.startsWith('app:') && typeof value === 'boolean', 'SETTING_UNSUPPORTED');
    const id = key.slice(4); invariant(catalog.apps.some(a => a.id === id), 'APP_UNAVAILABLE');
    value ? appIds.add(id) : appIds.delete(id);
  }
  if(Object.prototype.hasOwnProperty.call(settings,'app:quick')){
    const quick=settings['app:quick'];
    invariant(typeof quick==='string','SETTING_UNSUPPORTED');
    if(quick==='none')appIds.clear();
    else if(quick==='all'){
      invariant(catalog.apps.length>1,'SETTING_UNSUPPORTED');
      appIds.clear();for(const app of catalog.apps)appIds.add(app.id);
    }else if(quick==='defaults'){
      invariant(Array.isArray(defaults.appIds)&&defaults.appIds.length>1,'SETTING_UNSUPPORTED');
      appIds.clear();for(const id of defaults.appIds)appIds.add(id);
    }else if(quick==='keep'){
      invariant(appIds.size>1,'SETTING_UNSUPPORTED');
    }else if(quick.startsWith('app:')){
      const id=quick.slice(4);invariant(catalog.apps.some(a=>a.id===id),'APP_UNAVAILABLE');
      appIds.clear();appIds.add(id);
    }else invariant(false,'SETTING_UNSUPPORTED');
  }
  const model = config.model ?? defaults.model ?? catalog.defaultModel;
  const thinkingOption = config.thinkingOption !== undefined ? config.thinkingOption : model === defaults.model ? defaults.thinkingOption : undefined;
  return validateSelection({ model, thinkingOption, appIds: [...appIds] }, catalog);
}
export function promptContent(prompt) {
  invariant(prompt.delivery !== 'steer' && prompt.input.type === 'message' && prompt.outputSchema === undefined, 'PROMPT_UNSUPPORTED');
  invariant(Array.isArray(prompt.input.content) && prompt.input.content.length > 0, 'PROMPT_UNSUPPORTED');
  const texts=[],attachments=[];
  for(const part of prompt.input.content){
    invariant(part && typeof part==='object','ATTACHMENT_UNSUPPORTED');
    if(part.type==='text' && typeof part.text==='string') texts.push(part.text);
    else if(part.type==='image' && typeof part.data==='string' && typeof part.mimeType==='string') attachments.push(part);
    else if(part.type==='uploaded_file' && typeof part.path==='string' && typeof part.fileName==='string') attachments.push(part);
    else invariant(false,'ATTACHMENT_UNSUPPORTED');
  }
  invariant(attachments.length<=4,'ATTACHMENT_COUNT_UNSUPPORTED');
  const text=texts.join('\n');
  invariant(text.trim().length>0 || attachments.length>0,'PROMPT_UNSUPPORTED');
  return {text,attachments};
}
export const promptText = prompt => promptContent(prompt).text;
function createConnection(runtime, capabilities, validateEvent) {
  const { broker, store } = runtime;
  const listeners = new Set(), sessions = new Map(), opening = new Set(), promptResults = new Map(), startedTurns = new Set(), endedTurns = new Set();
  let closed = false, closing = false;
  const controller = new AbortController();
  const emit = value => {
    if(value.type==='timeline.item' && value.item?.type==='plugin' && !capabilities.includes('timeline.plugin')) {
      const item=value.item;
      if(item.kind==='native-activity') {
        value={type:'session.notice',sessionId:value.sessionId,notice:{id:'native-status',severity:'info',
          title:phaseLabel(item.data.phase),dismissed:['completed','failed','canceled'].includes(item.data.phase)}};
      } else value={...value,item:{type:'assistant_message',id:item.id,text:`图片已生成。此客户端未协商图片卡片，请在 ChatGPT 查看：https://chatgpt.com/c/${item.data.conversationId}`}};
    }
    let event;
    try { event = validateEvent(value); }
    catch {
      const error = { code: 'PROVIDER_EVENT_INVALID', message: 'Provider output did not match the installed Paseo SDK. No success was confirmed.' };
      event = value.requestId ? { type: 'request.failed', requestId: value.requestId, error }
        : { type: 'session.runtime_failed', sessionId: value.sessionId, error };
      event = validateEvent(event);
    }
    if (!closed) for (const fn of listeners) { try { fn(event); } catch {} }
  };
  const end = (hostId, turnId, state, error) => {
    const key = `${hostId}:${turnId}`; if (endedTurns.has(key)) return; endedTurns.add(key);
    const snapshot=(()=>{try{const s=sessions.get(hostId);return s&&broker.snapshot(s.id);}catch{return null;}})();
    const discarded = snapshot?.turn?.id === turnId && snapshot.turn.discarded === true;
    const unconfirmed = !discarded && error === 'RECEIPT_UNCONFIRMED';
    const link = snapshot?.conversationId;
    const message = discarded ? '本条消息确认未发送，已作废，不会自动重试。请提交一条新消息。'
      : unconfirmed ? link ? '此条消息的送达结果无法确认，但已保留 ChatGPT 对话绑定。不会自动重发；你可以继续发送一条新的消息。'
        : '网页可能已收到消息，但发送回执尚未确认。不会自动重发；请勿重复发送原消息。'
      : error;
    emit({type:'session.notice',sessionId:hostId,notice:{id:'native-permission',severity:'info',title:'授权等待已结束',dismissed:true}});
    emit({type:'session.notice',sessionId:hostId,notice:{id:'native-delivery',severity:unconfirmed||discarded?'warning':'info',
      title:discarded?'消息未发送，已作废；不会自动重试':unconfirmed?'已尝试发送，回执未确认；并非仍在排队':'本轮投递已结束；以回执或错误为准',dismissed:!unconfirmed&&!discarded}});
    // Settle native tool cards before the turn terminal without inventing a
    // successful tool result when its webpage status was not confirmed.
    try {
      const session=sessions.get(hostId);
      const turn=session&&broker.snapshot(session.id).turn;
      if(turn?.id===turnId)for(const item of turn.nativeTerminalItems??[])
        emit({type:'timeline.item',sessionId:hostId,item});
    }catch{}
    emit({ type: 'session.turn', sessionId: hostId, turnId, state, ...(error ? { error: { code: error, message } } : {}) });
  };
  // Paseo may receive a NEW user message while Chrome is recovering an older
  // native turn. Hold only that new request until the old turn is settled.
  // This is not a replay, does not reserve a Send lease, and aborts on Stop.
  async function waitForPriorTurn(id, signal) {
    if (!['sending','running','stopping'].includes(broker.snapshot(id).status)) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = error => {
        if (settled) return; settled = true;
        unsubscribe(); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const abort = () => done(new BridgeError('SEND_CANCELLED'));
      const inspect = () => {
        try {
          if (!['sending','running','stopping'].includes(broker.snapshot(id).status)) done();
        } catch (error) { done(error); }
      };
      const unsubscribe = broker.subscribe(id, inspect);
      signal.addEventListener('abort', abort, { once:true });
      if (signal.aborted) abort();
      else inspect();
    });
  }
  const buffered = new Map();
  const observe = (hostId, event) => {
    const key = `${hostId}:${event.turnId}`;
    if(event.state==='external-gap'){
      emit({type:'session.notice',sessionId:hostId,notice:{id:'external-transcript-gap',severity:'warning',
        title:'ChatGPT 网页存在多轮尚未同步的消息',
        description:'无法安全证明遗漏轮次的顺序。已保留会话绑定；不会自动回放或再次发送，请在原网页核对。'}});
      return;
    }
    // Paseo 0.11.2 treats a provider-created started turn as an autonomous
    // native run. No Paseo-origin prompt disposition or outbound Send exists.
    if (event.state === 'external-started') {
      if (startedTurns.has(key)) return;
      startedTurns.add(key);
      emit({type:'session.turn',sessionId:hostId,turnId:event.turnId,state:'started'});
      emit({type:'timeline.item',sessionId:hostId,item:event.item});
      for(const pending of buffered.get(key)??[])observe(hostId,pending);
      buffered.delete(key);
      return;
    }
    if (!startedTurns.has(key) && event.state !== 'receipt') { const list = buffered.get(key) ?? []; list.push(event); buffered.set(key, list); return; }
    if (event.state === 'bound') emit({type:'session.notice',sessionId:hostId,notice:{
      id:'native-conversation-bound',severity:'info',
      title:'已绑定 ChatGPT 对话链接',description:'绑定不代表这条消息已投递成功；即使单轮出错，链接仍会保留。'
    }});
    else if (event.state === 'receipt-pending') emit({type:'session.notice',sessionId:hostId,notice:{
      id:'native-delivery',severity:'warning',title:'发送回执暂不可读，正在观察同一 ChatGPT 对话',
      description:'网页可能已接收并正在执行；不会因固定时间结束跟踪，不会重发消息。只有确认原生用户消息身份后才回传回答。'
    }});
    else if (event.state === 'receipt') {
      emit({type:'session.notice',sessionId:hostId,notice:{id:'native-delivery',severity:'info',title:'网页已确认接收',dismissed:true}});
      if(event.appNetworkEvidence==='omitted')emit({type:'session.notice',sessionId:hostId,notice:{
        id:'native-app-evidence',severity:'warning',title:'所选 @ 应用缺少网络提交证据',
        description:'正文已确认送达，但在本桥接支持解析的消息内容中未找到所选应用的完整引用；实际工具可用性未证实。不会重发消息。'
      }});
      else if(event.appNetworkEvidence==='included')emit({type:'session.notice',sessionId:hostId,notice:{
        id:'native-app-evidence',severity:'info',title:'应用提交证据正常',dismissed:true
      }});
    }
    else if (event.state === 'snapshot' || event.state === 'image' ||
      event.state === 'activity' || event.state === 'native-timeline') {
      emit({type:'timeline.item',sessionId:hostId,item:event.item});
      emit({type:'session.notice',sessionId:hostId,notice:{id:'native-tracking-gap',
        severity:'info',title:'网页原生消息已恢复',dismissed:true}});
      if(event.state==='activity' && event.item.data.phase!=='approval')
        emit({type:'session.notice',sessionId:hostId,notice:{id:'native-permission',severity:'info',title:'授权等待已结束',dismissed:true}});
    }
    else if(event.state==='waiting'){
      const gap=event.reason==='transcript-unavailable';
      emit({type:'session.notice',sessionId:hostId,notice:{
        id:gap?'native-tracking-gap':'native-permission',severity:gap?'info':'warning',
        title:gap?'网页正在运行，等待消息状态恢复':event.reason==='final-unconfirmed'?
          '网页回答的结束状态尚未确认':'在 ChatGPT 网页中确认所需授权',
        description:gap?'保留已绑定对话；不会因为暂时读不到消息就断开，也不会自动重发。':
          '此桥接不会自动点击授权或扩大 MCP 权限。'
      }});
    }
    else if (['completed', 'failed', 'canceled'].includes(event.state)) {
      if(event.activityItem)emit({type:'timeline.item',sessionId:hostId,item:event.activityItem});
      end(hostId, event.turnId, event.state, event.error);
    }
  };
  const host = id => { const s = sessions.get(id); invariant(s, 'SESSION_UNKNOWN'); return s; };
  const configEvent = (hostId, sid) => emit({ type: 'session.config', sessionId: hostId, config: configState(broker.snapshot(sid), store.read().catalog,store.read().defaults) });
  const disposition = (hostId, clientMessageId, result) => {
    const key = `${hostId}:${clientMessageId}`;
    const prior = promptResults.get(key);
    if (prior?.result) return;
    promptResults.set(key, { ...(prior ?? {}), result }); emit({ type: 'session.prompt_result', sessionId: hostId, clientMessageId, result });
  };
  async function dispatch(input) {
    invariant(!closed && !closing, 'CONNECTION_CLOSED');
    switch (input.type) {
      case 'catalog': {
        if(runtime.status().paired && !runtime.status().connected)
          await (runtime.chromeWake ?? wakeChrome)({status:()=>runtime.status(),signal:controller.signal});
        const { catalog } = await catalogService(runtime).forForm({ signal: controller.signal });
        const saved = store.read().defaults;
        const defaults = validateSelection(saved, catalog);
        emit({ type: 'catalog', requestId: input.requestId, catalog: { models: wireModels(catalog, defaults), modes: [], defaultModel: defaults.model,
          ...(defaults.thinkingOption != null ? { defaultThinkingOption: defaults.thinkingOption } : {}) } }); return;
      }
      case 'session.open': {
        invariant(!opening.has(input.sessionId) && !sessions.has(input.sessionId), 'SESSION_EXISTS'); opening.add(input.sessionId);
        let binding;
        try {
          invariant(!input.config.mode, 'MODE_UNSUPPORTED');
          invariant(!input.config.toolPolicy, 'TOOL_POLICY_UNSUPPORTED');
          const mcpNotice = hostMcpNotice(input.config.mcpServers);
          const data = store.read(); const selection = selectionFrom(input.config, data.catalog, data.defaults);
          let s;
          if (input.persistence) {
            invariant(capabilities.includes('session.persistence') && input.persistence.version === 1 && typeof input.persistence.data?.id === 'string', 'INVALID_PERSISTENCE');
            s = broker.snapshot(input.persistence.data.id);
            invariant(![...sessions.values()].some(x => x.id === s.id), 'SESSION_ALREADY_ATTACHED');
            // Legacy runtimes could strand a first-page, unsent editor error
            // as blocked. No previous Send exists: restore only this case.
            if (s.status === 'blocked' && s.error === 'CONTROL_UNCONFIRMED' &&
                s.tabId === null && !s.conversationId && !s.turn) {
              await broker.recoverUnboundControl(s.id);
              s = broker.snapshot(s.id);
            }
            invariant(s.status==='idle'||(s.status==='blocked'&&s.conversationId&&s.turn?.outcome)||
              (s.conversationId&&s.turn?.lease&&!s.turn.outcome&&
                (['running','stopping'].includes(s.status)||(s.status==='sending'&&s.turn.receiptPending))),
              'SESSION_REQUIRES_INSPECTION');
          } else s = await broker.create(selection, { cwd: input.config.cwd, systemPrompt: input.config.systemPrompt ?? '' });
          invariant(!closed && !closing, 'CONNECTION_CLOSED');
          invariant(!broker.owners.has(s.id), 'SESSION_ALREADY_ATTACHED');
          binding = { id: s.id, controller: new AbortController(), unsubscribe: broker.subscribe(s.id, e => observe(input.sessionId, e)) };
          broker.owners.set(s.id, binding); sessions.set(input.sessionId, binding);
          // An unbound preparatory tab has no durable ChatGPT conversation yet.
          // Only those ephemeral tab IDs may be dropped during restoration.
          // Once /c/<id> is recorded, keep its tab/document/link intact.
          if(input.persistence && !s.conversationId)
            await store.transaction(d=>{d.sessions[s.id].tabId=null;d.sessions[s.id].documentKey=null;});
          const resumingActive = s.turn && !s.turn.outcome &&
            (['running','stopping'].includes(s.status)||(s.status==='sending'&&s.turn.receiptPending));
          if(resumingActive){
            if(!sameSelection(selection,s.pendingConfig??s.config))
              await broker.stageConfiguration(s.id,selection);
            // Delay any new context until the next user prompt; never mutate
            // a turn whose native browser operation is still active.
            binding.pendingContext={cwd:input.config.cwd,systemPrompt:input.config.systemPrompt??''};
          } else {
            await broker.deferConfigure(s.id, selection);
            invariant(!closed && !closing, 'CONNECTION_CLOSED');
            await broker.updateContext(s.id, { cwd: input.config.cwd, systemPrompt: input.config.systemPrompt ?? '' });
          }
          s = broker.snapshot(s.id);
          emit({ type: 'session.opened', requestId: input.requestId, sessionId: input.sessionId, capabilities, restoration: 'core',
            persistence: { version: 1, data: { id: s.id } }, cwd: s.cwd, ...(input.config.title ? { title: input.config.title } : {}) });
          if (mcpNotice) emit({ type: 'session.notice', sessionId: input.sessionId, notice: mcpNotice });
          emit({ type: 'session.notice', sessionId: input.sessionId, notice: { id: 'native-config-pending', severity: 'info',
            title: resumingActive ? '已恢复仍在运行的 ChatGPT 对话监控' :
              s.conversationId ? '已恢复已绑定的 ChatGPT 对话；下一条消息将验证原网页' : '配置已保存；首次发送时打开 ChatGPT 并核验配置',
            description: resumingActive ? '保留原轮次及绑定，继续观察；不会重发之前的消息。' :
              s.conversationId ? '旧消息不会自动重发；网页与配置将在下一次新消息时重新核验。' : '当前尚未声称网页已应用这些选项。' } });
          configEvent(input.sessionId, s.id);
          if(s.externalGap)observe(input.sessionId,{state:'external-gap'});
          if (input.history === 'replay') for (const item of broker.snapshot(s.id).history) emit({ type: 'timeline.item', sessionId: input.sessionId, item });
          emit({ type: 'session.ready', requestId: input.requestId, sessionId: input.sessionId });
          if(resumingActive){
            const key=`${input.sessionId}:${s.turn.id}`;
            startedTurns.add(key);
            emit({type:'session.turn',sessionId:input.sessionId,turnId:s.turn.id,state:'started'});
            if(s.turn.origin==='browser' && input.history!=='replay'){
              const user=s.history.find(item=>item.id===`user:${s.turn.id}`);
              if(user)emit({type:'timeline.item',sessionId:input.sessionId,item:user});
            }
            for(const event of buffered.get(key)??[])observe(input.sessionId,event);
            buffered.delete(key);
            if(s.turn.receiptPending)observe(input.sessionId,{turnId:s.turn.id,state:'receipt-pending'});
          }
        } catch (e) { binding?.unsubscribe(); if (binding && broker.owners.get(binding.id) === binding) broker.owners.delete(binding.id); sessions.delete(input.sessionId); throw e; }
        finally { opening.delete(input.sessionId); }
        return;
      }
      case 'session.prompt': {
        // Reserve the ID before any await, including a concurrent duplicate or a failed admission.
        const promptKey = `${input.sessionId}:${input.prompt.clientMessageId}`;
        const fingerprint = createHash('sha256').update(JSON.stringify(input.prompt)).digest('hex');
        const previous = promptResults.get(promptKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) emit({ type: 'session.notice', sessionId: input.sessionId,
            notice: { id: 'message-id-conflict', severity: 'error', title: '消息 ID 已被使用；修改内容重试须使用新 ID' } });
          return;
        }
        invariant(promptResults.size < 4000, 'PROMPT_HISTORY_LIMIT');
        promptResults.set(promptKey, { fingerprint, result: null });
        invariant(capabilities.includes('prompt.message'), 'CAPABILITY_NOT_NEGOTIATED');
        const binding = host(input.sessionId); const { id } = binding;
        const {text:value,attachments}=promptContent(input.prompt);
        invariant(!attachments.some(p=>p.type==='image')||capabilities.includes('prompt.image'),'CAPABILITY_NOT_NEGOTIATED');
        invariant(!binding.preparing, 'SESSION_BUSY');
        const preparing = new AbortController(); binding.preparing = preparing;
        let result, slot;
        try {
          const signal = AbortSignal.any([controller.signal, binding.controller.signal, preparing.signal]);
          if (['sending','running','stopping'].includes(broker.snapshot(id).status)) {
            emit({type:'session.notice',sessionId:input.sessionId,notice:{
              id:'native-prior-turn',severity:'info',
              title:'上一轮 ChatGPT 仍在运行，新消息等待发送',
              description:'正在恢复原绑定对话。旧消息不会重发；本条新消息将在上一轮真正结束后发送。'
            }});
            // Browser must be woken BEFORE waiting for the existing turn to
            // settle; otherwise a Chrome-quit/active-turn case deadlocks.
            await (runtime.chromeWake ?? wakeChrome)({status:()=>runtime.status(),signal});
            await waitForPriorTurn(id,signal);
          }
          let before=broker.snapshot(id);
          if(before.status==='blocked' && before.error==='CONTROL_UNCONFIRMED' &&
             before.tabId===null && !before.conversationId && !before.turn){
            await broker.recoverUnboundControl(id);
            before=broker.snapshot(id);
          }
          if(binding.pendingContext && before.status==='idle'){
            await broker.updateContext(id,binding.pendingContext);
            binding.pendingContext=null;
          }
          if(before.status==='blocked'&&before.conversationId&&before.turn?.outcome){
            await broker.prepareContinuation(id);
            emit({type:'session.notice',sessionId:input.sessionId,notice:{
              id:'native-recovered-link',severity:'warning',
              title:'继续已绑定对话',description:'上一条结果不明，保留原始消息记录；此次仅发送你新输入的消息，不重发旧消息。'
            }});
          }
          slot = await broker.slots.acquire(id, { signal, onPosition: position => emit({type:'session.notice',sessionId:input.sessionId,notice:{id:'native-queue',severity:'info',title:position?`等待并发名额 · 队列第 ${position} 位（尚未发送）`:'已取得名额，正在核验网页',dismissed:position===0}}) });
          // A bound Agent is sufficient user intent to bring Chrome back.
          // Do this BEFORE queuing any Send, so a failed OS wake is not a
          // failed/duplicate ChatGPT message.
          await (runtime.chromeWake ?? wakeChrome)({status:()=>runtime.status(),signal});
          const pending=broker.snapshot(id).pendingConfig;
          if(pending){
            await broker.configure(id,pending,{signal});
            configEvent(input.sessionId,id);
          }
          if (broker.snapshot(id).tabId === null) {
            await broker.configure(id, broker.snapshot(id).config, { signal });
            invariant(!signal.aborted, 'SEND_CANCELLED');
            configEvent(input.sessionId, id);
            emit({ type: 'session.notice', sessionId: input.sessionId, notice: { id: 'native-config-pending', severity: 'info',
              title: '网页配置已核验', dismissed: true } });
          } else await broker.ensurePage(id, { signal });
          invariant(!signal.aborted && !closed && !closing, 'SEND_CANCELLED');
          result = await broker.prompt(id, input.prompt.clientMessageId, value, { signal, attachments });
        } finally {
          slot?.release(); if (binding.preparing === preparing) binding.preparing = null;
          emit({type:'session.notice',sessionId:input.sessionId,notice:{id:'native-prior-turn',severity:'info',title:'上一轮等待已结束',dismissed:true}});
          emit({type:'session.notice',sessionId:input.sessionId,notice:{id:'native-queue',severity:'info',title:'排队已结束',dismissed:true}});
        }
        const delivery = broker.snapshot(id).turn;
        emit({type:'session.notice',sessionId:input.sessionId,notice:{id:'native-delivery',severity:'info',
          title:delivery?.receivedAt?'网页已确认接收':'消息已排队，等待网页接收',dismissed:Boolean(delivery?.receivedAt)}});
        const key = `${input.sessionId}:${result.turnId}`;
        disposition(input.sessionId, input.prompt.clientMessageId, { type: 'turn', turnId: result.turnId });
        if (!startedTurns.has(key)) {
          startedTurns.add(key);
          emit({ type: 'timeline.item', sessionId: input.sessionId, item: { type: 'user_message', id: `user:${result.turnId}`, text: value, clientMessageId: input.prompt.clientMessageId } });
          emit({ type: 'session.turn', sessionId: input.sessionId, turnId: result.turnId, state: 'started' });
          for (const event of buffered.get(key) ?? []) observe(input.sessionId, event); buffered.delete(key);
          if (result.outcome) end(input.sessionId, result.turnId, result.outcome);
          const turn = broker.snapshot(id).turn;
          if (turn.id === result.turnId && turn.outcome) end(input.sessionId, turn.id, turn.outcome);
        }
        return;
      }
      case 'session.configure': {
        invariant(capabilities.includes('session.configure'), 'CAPABILITY_NOT_NEGOTIATED');
        const binding = host(input.sessionId); const { id } = binding; const old = broker.snapshot(id); const change = input.changes;
        invariant(change.mode == null, 'MODE_UNSUPPORTED');
        const desired=old.pendingConfig??old.config;
        const selection = selectionFrom({ model: change.model ?? desired.model,
          thinkingOption: change.thinkingOption === undefined ? (change.model && change.model !== desired.model ? undefined : desired.thinkingOption) : change.thinkingOption,
          settings: change.settings ?? {}, providerOptions: { appIds: desired.appIds } }, store.read().catalog, store.read().defaults);
        invariant(!binding.preparing, 'SESSION_BUSY');
        if(['sending','running','stopping'].includes(old.status)){
          await broker.stageConfiguration(id,selection);
          emit({type:'session.notice',sessionId:input.sessionId,notice:{id:'deferred-config',severity:'info',
            title:'工具与模型已保存，将在下一轮发送前应用'}});
        }else if(old.tabId===null) await broker.deferConfigure(id, selection);
        else {
          const signal=AbortSignal.any([controller.signal,binding.controller.signal]);
          await (runtime.chromeWake ?? wakeChrome)({status:()=>runtime.status(),signal});
          await broker.configure(id, selection, { signal });
        }
        configEvent(input.sessionId, id); emit({ type: 'request.completed', requestId: input.requestId }); return;
      }
      case 'session.interrupt': {
        const binding = host(input.sessionId); binding.preparing?.abort(); const { id } = binding; await broker.interrupt(id); emit({ type: 'request.completed', requestId: input.requestId }); return;
      }
      case 'session.close': {
        const binding = host(input.sessionId); binding.controller.abort();
        let failure;
        try { await broker.interrupt(binding.id); }
        catch (e) { failure = errorOf(e); }
        finally {
          binding.unsubscribe(); if (broker.owners.get(binding.id) === binding) broker.owners.delete(binding.id); sessions.delete(input.sessionId);
          emit({ type: 'session.closed', sessionId: input.sessionId, ...(failure ? { error: failure } : {}) });
        }
        if (failure) emit({ type: 'request.failed', requestId: input.requestId, error: failure });
        else emit({ type: 'request.completed', requestId: input.requestId });
        return;
      }
      default: throw new BridgeError('CAPABILITY_UNSUPPORTED');
    }
  }
  return {
    version: 1, capabilities,
    async send(input) {
      invariant(!closed && !closing, 'CONNECTION_CLOSED');
      // Do not await a browser roundtrip here: acceptance is separate from lifecycle events.
      invariant(['catalog', 'session.open', 'session.prompt', 'session.configure', 'session.interrupt', 'session.close'].includes(input.type), 'CAPABILITY_UNSUPPORTED');
      queueMicrotask(() => dispatch(input).catch(e => {
        if (input.type === 'session.prompt') disposition(input.sessionId, input.prompt.clientMessageId, { type: 'failed', error: errorOf(e) });
        else if ('requestId' in input) emit({ type: 'request.failed', requestId: input.requestId, error: errorOf(e) });
      }));
    },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async close() {
      if (closed || closing) return; closing = true; controller.abort();
      // Closing the Provider connection is not a user's Stop command. Keep
      // live browser turns for a later connection/restart to reattach safely.
      for (const [hostId, binding] of sessions) {
        binding.controller.abort();
        binding.unsubscribe();
        if (broker.owners.get(binding.id) === binding) broker.owners.delete(binding.id);
        emit({ type: 'session.closed', sessionId: hostId });
      }
      closed = true; sessions.clear(); listeners.clear();
    }
  };
}
