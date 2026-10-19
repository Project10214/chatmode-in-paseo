import { BridgeError, invariant, validateSelection, sameSelection } from './protocol.mjs';
import { createHash } from 'node:crypto';
import { catalogService } from './catalog.mjs';
import { createChromeWake } from './chrome-wake.mjs';
import { sessionIdFromPersistence } from './wake.mjs';
import { createProviderDelivery } from './provider-delivery.mjs';
import { permissionRequest, approvalChoice } from './approval.mjs';
import { errorLabel } from '../shared/ui-copy.mjs';

const wakeChrome = createChromeWake();

export const CAPABILITIES = ['prompt.message', 'prompt.image', 'permission', 'session.configure', 'session.persistence', 'session.archive', 'session.unarchive', 'timeline.plugin'];
const errorOf = e => ({ message: errorLabel(e.code ?? 'BRIDGE_FAILURE'), code: e.code ?? 'BRIDGE_FAILURE' });
/**
 * `hostObservation` (server/host-observation.mjs) is optional and explicit.
 * commands() proves subscription, not delivery. Production also supplies
 * readTimeline for the binding-owned native delivery coordinator. Host-neutral
 * callers without that adapter get one-shot output, never delivery confirmation.
 * @param {any} runtime
 * @param {(value: any) => any} [validateEvent]
 * @param {{ hostObservation?: ReturnType<typeof import('./host-observation.mjs').createHostObservation> | null }} [options]
 * @returns {import('@getpaseo/plugin/server/provider').ProviderRegistration}
 */
export function createProvider(runtime, validateEvent = value => value, { hostObservation = runtime.hostObservation ?? null } = {}) {
  return {
    id: 'chatmode', label: 'Chatmode', icon: 'icon.svg',
    description: '在 Paseo 收发 ChatGPT 网页消息，使用已授权应用。',
    async status() { const s=runtime.status();return s.connected||s.paired ? { available: true } : { available: false, diagnostic: '请在 Paseo 所在电脑配对 Chatmode Chrome 扩展。' }; },
    async getCatalogCacheKey(options) {
      const data = runtime.store.read();
      return JSON.stringify({ scope: options.scope, cwd: options.cwd ?? '', defaults: data.defaults,
        models: data.catalog?.models, apps: data.catalog?.apps, defaultModel: data.catalog?.defaultModel });
    },
    async connect(request) {
      invariant(request.versions.includes(1), 'PROTOCOL_UNSUPPORTED');
      const capabilities = [...new Set(request.capabilities.filter(x => CAPABILITIES.includes(x)))];
      return createConnection(runtime, capabilities, validateEvent, hostObservation);
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
  return entries.length ? { id: 'host-mcp-not-imported', severity: 'warning', title: 'Paseo 内置工具不会进入网页',
    description: '请使用 ChatGPT 已授权应用。' } : null;
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
    {label:'不使用应用',value:'none'},
    ...catalog.apps.map(app=>({label:'@ '+app.label,value:'app:'+app.id})),
    ...(saved.length>1?[{label:'默认组合（'+saved.length+'）',value:'defaults'}]:[]),
    ...(catalog.apps.length>1?[{label:'全部已授权应用',value:'all'}]:[]),
    ...(selected==='keep'?[{label:'当前组合（'+chosen.length+'）',value:'keep'}]:[])
  ];
  return {model:effective.model,...(effective.thinkingOption?{thinkingOption:effective.thinkingOption}:{}),
    models:wireModels(catalog),modes:[],thinkingOptions:catalog.models.find(m=>m.id===effective.model)?.thinkingOptions??[],
    settings:[{type:'select',id:'app:quick',label:'工具',value:selected,options:tools,
      description:'选择 ChatGPT 已授权应用，不新增权限。默认组合可在 Chatmode 设置中修改。'}]};
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
// Plain-text card summary for clients that did not negotiate timeline.plugin.
// Page notices are quoted verbatim; button states are reported, never clicked.
export function activityText(data) {
  const lines = [];
  if (data.sync?.state === 'blocked') lines.push('正文同步受阻：' + data.sync.issues.filter(x => x.blocking && x.resolvedAt === null).map(x => x.code).join('、'));
  else if (data.sync?.state === 'partial') lines.push('部分内容未同步：' + data.sync.issues.filter(x => x.resolvedAt === null).map(x => x.code).join('、'));
  if (data.outcome === 'failed' && data.error) lines.push('Paseo 跟踪中断：' + data.error + '；网页任务是否停止未确认');
  for (const notice of data.page?.notices ?? []) {
    lines.push('网页提示（' + ([notice.redacted ? '已脱敏' : '', notice.clipped ? '已截断' : ''].filter(Boolean).join('、') || '原文') + '）：' + notice.text);
    if (notice.buttons.length) lines.push('网页按钮（仅展示）：' + notice.buttons.map(b => `${b.label}（${b.enabled ? '可用' : '不可用'}）`).join('、'));
  }
  return lines.join('\n');
}
const BARRIER_RETRY_MS=5000;
function createConnection(runtime,capabilities,validateEvent,observation=null) {
  const {broker,store}=runtime;
  const listeners=new Set(),sessions=new Map(),opening=new Set(),promptResults=new Map();
  const startedTurns=new Set(),endedTurns=new Set();
  const controller=new AbortController();
  let closed=false,closing=false;
  const emit=value=>{
    if(value.type==='timeline.item'&&value.item.type==='plugin'&&!capabilities.includes('timeline.plugin')) {
      const item=value.item;
      if(item.kind==='page-state')value={type:'session.notice',sessionId:value.sessionId,notice:{
        id:item.id,severity:item.data.state==='abnormal'?'warning':'info',
        title:({running:'运行中',standby:'待命',abnormal:'状态无法确认'})[item.data.state]}};
      else value={...value,item:{type:'notification',id:item.id,level:'info',
        message:item.kind==='native-activity'?activityText(item.data):
          '当前客户端无法显示此网页资源卡片。\n'+JSON.stringify(item.data)}};
    }
    let event,valid=true;
    try {event=validateEvent(value);}
    catch {
      valid=false;
      const error={code:'PROVIDER_EVENT_INVALID',message:errorLabel('PROVIDER_EVENT_INVALID')};
      event=validateEvent(value.requestId?{type:'request.failed',requestId:value.requestId,error}:
        {type:'session.notice',sessionId:value.sessionId,notice:{
          id:'source-projection-error',severity:'error',title:'CIP 内容投影失败',description:error.message}});
    }
    let forwarded=valid&&!closed&&!closing&&listeners.size>0;
    if(!closed)for(const fn of listeners)try {fn(event);}catch {forwarded=false;}
    return forwarded;
  };
  const host=id=>{const binding=sessions.get(id);invariant(binding,'SESSION_UNKNOWN');return binding;};
  // Continuous page observation emits many DOM-local process/media sources for
  // one Work panel. Present them as one compact activity card per turn instead
  // of hundreds of page-source cards. The source ledger remains untouched.
  const WORK_STEP_LIMIT=12;
  const workLabel=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,160):'';
  const workKind=source=>source?.kind==='image'?'image':
    /image|图片|图像/i.test(source?.text??'')?'image':
    /search|搜索|浏览/i.test(source?.text??'')?'search':
    /exec|code|运行|下载/i.test(source?.text??'')?'exec':'tool';
  const workPhase=source=>{
    if(source?.kind==='image')return 'image';
    if(source?.kind==='reasoning'||/thinking|思考|分析/i.test(source?.text??''))return 'thinking';
    if(/search|搜索|浏览/i.test(source?.text??''))return 'search';
    if(/exec|code|运行|下载/i.test(source?.text??''))return 'exec';
    return 'tool';
  };
  function workActivity(binding,key){
    if(!binding.work)binding.work=new Map();
    let activity=binding.work.get(key);
    if(!activity){activity={type:'plugin',id:'activity:'+key,pluginId:'chatmode-in-paseo',
      kind:'native-activity',version:1,data:{turnId:key,phase:'working',nativeStatus:null,steps:[]}};
      binding.work.set(key,activity);}
    return activity;
  }
  function addWorkStep(binding,source){
    const key=typeof source.userMessageId==='string'&&source.userMessageId?source.userMessageId:'page';
    const activity=workActivity(binding,key),data=activity.data;
    const snapshot=broker.snapshot(binding.id);
    const active=Boolean(snapshot.observation?.run?.active)||snapshot.status==='running';
    const label=workLabel(source.text);
    if(source.kind==='image'&&!source.nativeMessageId){
      const existing=data.steps.find(step=>step.kind==='image');
      const count=existing?(Number(/(\d+)/.exec(existing.label)?.[1])||1)+1:1;
      const step={kind:'image',label:`网页图片（${count} 张）`,done:!active};
      if(existing)Object.assign(existing,step);else data.steps.push(step);
    } else if(label){
      const existing=data.steps.find(step=>step.label===label);
      if(!existing){
        if(data.steps.length<WORK_STEP_LIMIT-1)data.steps.push({kind:workKind(source),label,done:!active});
        else {
          const overflow=data.steps.find(step=>step.label.startsWith('其余 '));
          const count=overflow?(Number(/(\d+)/.exec(overflow.label)?.[1])||0)+1:1;
          const summary={kind:'tool',label:`其余 ${count} 步已省略`,done:!active};
          if(overflow)Object.assign(overflow,summary);else data.steps.push(summary);
        }
      } else existing.done=!active;
    }
    data.phase=active?workPhase(source):'completed';
    data.nativeStatus=active?'in_progress':'complete';
    if(!active)for(const step of data.steps)step.done=true;
    return activity;
  }
  const keyFor=event=>event.item?'item:'+event.item.id:event.state==='approval'?'approval:'+event.approval.key:
    event.state==='approval-closed'?'approval-close:'+event.key:event.state+':'+(event.turnId??'conversation');
  const hold=(queue,event)=>queue.set(keyFor(event),event);
  const emitItem=(hostId,item)=>{
    const binding=sessions.get(hostId);if(!binding)return;
    // Anonymous Work rows have no exact native tool identity. Keep their raw
    // source in the ledger, but show one compact activity card per turn.
    if(item.type==='plugin'&&item.kind==='page-source'&&item.data?.source){
      const source=item.data.source;
      const anonymousProcess=source.lane==='process'&&source.nativeMessageId==null&&source.role!=='user';
      const anonymousPageImage=source.role==='page'&&source.kind==='image'&&source.nativeMessageId==null;
      if(anonymousProcess||anonymousPageImage){
        const activity=addWorkStep(binding,source);
        // addWorkStep mutates the retained activity; emit a snapshot so the
        // binding.items comparison sees the new steps and updates the card.
        return emitItem(hostId,structuredClone(activity));
      }
    }
    const before=binding.items.get(item.id);
    if(before&&JSON.stringify(before)===JSON.stringify(item))return;
    if(item.type==='assistant_message'&&binding.delivery){
      binding.items.set(item.id,item);binding.delivery.submit(item);return;
    }
    if(before&&['assistant_message','reasoning'].includes(item.type)&&before.type===item.type&&
      !item.text.startsWith(before.text)) {
      // This is a concrete non-prefix source revision, not Work expansion.
      // Keep the new original in the source ledger; do not concatenate it to
      // the old native answer or silently convert formal output to plugin text.
      emit({type:'session.notice',sessionId:hostId,notice:{id:'source-revision:'+item.id,
        severity:'warning',title:'CIP：正文修订无法原位同步',
        description:'新原文已保存；当前宿主的原生文本接口只支持追加，未把新旧正文错误拼接。'}});
      return;
    }
    binding.items.set(item.id,item);
    // Host-neutral callers without a read adapter retain unconfirmed one-shot
    // emission only. Production installs the adapter before opening sessions.
    emit({type:'timeline.item',sessionId:hostId,item});
  };
  const announce=(hostId,turnId)=>{
    const key=hostId+':'+turnId;
    if(startedTurns.has(key)||endedTurns.has(key))return;
    startedTurns.add(key);
    emit({type:'session.turn',sessionId:hostId,turnId,state:'started'});
  };
  const end=(hostId,turnId,state,error)=>{
    const key=hostId+':'+turnId;
    if(!startedTurns.has(key)||endedTurns.has(key))return;
    endedTurns.add(key);
    emit({type:'session.turn',sessionId:hostId,turnId,state,
      ...(error?{error:{code:error,message:errorLabel(error)}}:{})});
  };
  const publish=(hostId,event)=>{
    const binding=sessions.get(hostId);if(!binding)return;
    if(event.state==='source'||event.state==='artifact'||event.state==='page-status') {
      if(event.item)emitItem(hostId,event.item);
      binding.delivery?.kick();
      return;
    }
    if(event.state==='page-running') {
      const run=broker.snapshot(binding.id).observation?.run;
      if(run?.active&&run.id===event.turnId)announce(hostId,event.turnId);
      return;
    }
    if(event.state==='page-standby') {
      if(binding.work)for(const activity of binding.work.values()){
        if(activity.data.phase==='completed')continue;
        activity.data.phase='completed';activity.data.nativeStatus='complete';
        for(const step of activity.data.steps)step.done=true;
        emitItem(hostId,structuredClone(activity));
      }
      end(hostId,event.turnId,'completed');binding.delivery?.kick();return;
    }
    if(event.state==='approval') {
      if(!capabilities.includes('permission')) {
        // Without permission UI this card is a notice; track it so an external
        // close can retire that same notice instead of leaving it stale.
        binding.permissions.set(event.approval.key,'open');
        emit({type:'session.notice',sessionId:hostId,notice:{id:'approval:'+event.approval.key,
          severity:'warning',title:'请在网页处理授权',description:event.approval.text??'当前客户端不支持授权操作。'}});
        return;
      }
      const signature=JSON.stringify(event.approval);
      if(binding.permissionSignatures.get(event.approval.key)===signature)return;
      binding.permissionSignatures.set(event.approval.key,signature);
      binding.permissions.set(event.approval.key,'open');
      emit({type:'session.permission',sessionId:hostId,request:permissionRequest(event.approval)});
      const actual=store.read().sessions[binding.id]?.approvals?.[event.approval.key];
      const auto=store.read().runtimeSettings?.autoAllowApprovals===true &&
        event.approval.autoEligible===true && Boolean(event.approval.autoTier) &&
        !actual?.manualRequested&&!actual?.manualVeto&&!actual?.autoSuppressed&&!actual?.clickUncertain &&
        !binding.autoApprovals?.has(event.approval.key);
      if(auto) {
        binding.autoApprovals ??= new Set();
        binding.autoApprovals.add(event.approval.key);
        binding.respondingPermissions.set(event.approval.key,'allow-auto');
        void broker.answerApproval(binding.id,event.approval.key,'allow-auto').then(()=>{
          const conflict=Boolean(binding.manualConflict?.has(event.approval.key) ||
            store.read().sessions[binding.id]?.approvals?.[event.approval.key]?.manualVeto);
          emit({type:'session.notice',sessionId:hostId,notice:{id:'auto-approval:'+event.approval.key,
            severity:conflict?'warning':'info',
            title:conflict?'自动授权与人工选择发生冲突':'已自动允许网页授权',
            description:conflict?'网页允许可能已经执行，后到的人工选择未确认生效；请核对 ChatGPT 页面。':
              `${event.approval.app??'网页'}${event.approval.tool?' · '+event.approval.tool:''}`}});
        }).catch(error=>{
          if(binding.respondingPermissions.get(event.approval.key)==='allow-auto')
            binding.respondingPermissions.delete(event.approval.key);
          binding.autoApprovals.delete(event.approval.key);
          const superseded=['APPROVAL_SUPERSEDED','AUTO_APPROVAL_DISABLED'].includes(error?.code);
          emit({type:'session.notice',sessionId:hostId,notice:{id:'auto-approval-failed:'+event.approval.key,
            severity:superseded?'info':'warning',
            title:superseded?'自动授权已撤销':'自动允许未完成',
            description:superseded?'不会再执行已取消的自动授权；可人工选择。':
              errorLabel(error?.code??'APPROVAL_UNCONFIRMED')}});
        });
      }
      return;
    }
    if(event.state==='approval-uncertain') {
      emit({type:'session.notice',sessionId:hostId,notice:{
        id:'approval-uncertain:'+event.key,severity:'warning',
        title:'网页授权操作结果未确认',
        description:'可能已经点击了网页按钮，已阻止对此请求再次点击。请核对 ChatGPT 页面。'
      }});
      return;
    }
    if(event.state==='approval-closed') {
      if(binding.permissions.get(event.key)!=='open')return;
      if(!capabilities.includes('permission')) {
        binding.permissions.set(event.key,'resolved');
        emit({type:'session.notice',sessionId:hostId,notice:{
          id:'approval-withdrawn:'+event.key,severity:'warning',
          title:'网页授权提示已失效',
          description:'当前客户端没有可清理的权限卡；页面操作结果未知，请到 ChatGPT 核对。'
        }});
        return;
      }
      if(event.answered==='allow-auto'&&
        (binding.manualConflict?.has(event.key)||
          store.read().sessions[binding.id]?.approvals?.[event.key]?.manualVeto)) {
        // Paseo may have cached a user Deny after automatic Allow was already
        // claimed. Sending permission_resolved here would translate the
        // webpage Allow into a false Deny. Keep the request stale instead.
        binding.permissions.set(event.key,'stale');
        emit({type:'session.notice',sessionId:hostId,notice:{
          id:'approval-conflict:'+event.key,severity:'warning',
          title:'自动授权与人工选择未对齐',
          description:'自动允许可能已在网页生效，但人工选择未确认生效。请先核对网页；旧卡只能显式本地清理。'
        }});
        return;
      }
      if(event.answered&&binding.respondingPermissions.get(event.key)===event.answered) {
        binding.permissions.set(event.key,'resolved');
        emit({type:'session.permission_resolved',sessionId:hostId,permissionId:event.key});
      } else {
        // The current Paseo SDK has no neutral "dismiss without Deny" event:
        // an unpaired permission_resolved is translated into false Deny.
        // Mark stale locally and keep the native request until the user
        // explicitly chooses its Deny action to clear it.
        binding.permissions.set(event.key,'stale');
        const replaced=event.reason==='REQUEST_CHANGED';
        emit({type:'session.notice',sessionId:hostId,notice:{
          id:'approval-withdrawn:'+event.key,severity:'warning',
          title:replaced?'授权内容已更新，原请求失效':'网页授权框已离开或关闭',
          description:'网页允许/拒绝结果未知。原 Paseo 卡片不能再操作网页；如需清理该卡片，可点击原卡的「拒绝」（仅本地清理）。'
        }});
      }
      return;
    }
    if(event.state==='bound')emit({type:'session.notice',sessionId:hostId,notice:{
      id:'native-conversation-bound',severity:'info',title:'已关联 ChatGPT 对话'}});
    else if(event.state==='receipt-pending')emit({type:'session.notice',sessionId:hostId,notice:{
      id:'native-delivery',severity:'warning',title:'消息送达待确认',
      description:'继续读取原对话并核对发送回执，不会重发。'}});
    else if(event.state==='receipt') {
      emit({type:'session.notice',sessionId:hostId,notice:{id:'native-delivery',
        severity:'info',title:'网页已确认接收',dismissed:true}});
      if(event.appNetworkEvidence==='omitted')emit({type:'session.notice',sessionId:hostId,notice:{
        id:'native-app-evidence',severity:'warning',title:'所选 @ 应用是否提交尚未确认',
        description:'正文已送达，但未读到完整应用引用。不会重发消息。'}});
    } else if(['failed','canceled'].includes(event.state)) {
      const turn=broker.snapshot(binding.id).turn;
      if(event.state==='failed' && turn?.id===event.turnId && turn.authorized &&
          !turn.notSent && !turn.discarded && !turn.receivedAt) {
        emit({type:'session.notice',sessionId:hostId,notice:{id:'native-delivery',
          severity:'warning',title:'已尝试发送，送达未确认',dismissed:false,
          description:'没有收到可核实的网页回执，网页任务是否继续尚未确认；不会自动重发。'}});
      }
      end(hostId,event.turnId,event.state,event.error);
    }
  };
  const requestBarrier=(hostId,binding)=>{
    if(!binding.ready||(binding.confirmed&&(!binding.delivery||binding.agentId))||binding.barrierInflight||sessions.get(hostId)!==binding)return;
    if(!observation) {binding.confirmed=true;flushBinding(hostId,binding);return;}
    binding.barrierInflight=true;binding.barrierAt=Date.now();
    void observation.request(binding.id).then(result=>{
      binding.barrierInflight=false;
      if(result?.woken!==true||sessions.get(hostId)!==binding||!binding.ready)return;
      // Subscription only, never acknowledgement of a native timeline item.
      binding.agentId=result.agentId;
      binding.confirmed=true;flushBinding(hostId,binding);
      binding.delivery?.kick();
    },()=>{binding.barrierInflight=false;});
  };
  function flushBinding(hostId,binding) {
    if(!binding.ready||!binding.confirmed||binding.deferred)return;
    const held=binding.held;binding.held=new Map();
    for(const event of held.values())publish(hostId,event);
    binding.delivery?.kick();
  }
  const observe=(hostId,event)=>{
    const binding=sessions.get(hostId);if(!binding)return;
    if(binding.deferred) {hold(binding.deferred,event);return;}
    if(!binding.ready||!binding.confirmed) {
      hold(binding.held,event);
      if(Date.now()-(binding.barrierAt??0)>=BARRIER_RETRY_MS)requestBarrier(hostId,binding);
      return;
    }
    publish(hostId,event);
  };
  const stopConfirmations=observation?.onHostAvailable(()=>{
    for(const [hostId,binding] of sessions)requestBarrier(hostId,binding);
  })??(()=>{});
  const releaseDeferred=(hostId,binding,failed)=>{
    if(!binding?.deferred||binding.releasing)return;
    const deliver=()=>{
      const queue=binding.deferred;binding.deferred=null;binding.releasing=false;
      if(sessions.get(hostId)!==binding)return;
      for(const event of queue?.values()??[])observe(hostId,event);
      flushBinding(hostId,binding);
    };
    // This handles failures AFTER Provider entry, not a host pre-Provider race.
    if(failed){binding.releasing=true;setImmediate(deliver);}else deliver();
  };
  async function waitForPriorTurn(id,signal) {
    if(!['sending','running','stopping'].includes(broker.snapshot(id).status))return;
    await new Promise((resolve,reject)=>{
      let settled=false;
      const done=error=>{if(settled)return;settled=true;unsubscribe();signal.removeEventListener('abort',abort);
        error?reject(error):resolve();};
      const abort=()=>done(new BridgeError('SEND_CANCELLED'));
      const inspect=()=>{try {if(!['sending','running','stopping'].includes(broker.snapshot(id).status))done();}
        catch(error){done(error);}};
      const unsubscribe=broker.subscribe(id,inspect);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else inspect();
    });
  }
  const configEvent=(hostId,sid)=>emit({type:'session.config',sessionId:hostId,
    config:configState(broker.snapshot(sid),store.read().catalog,store.read().defaults)});
  const disposition=(hostId,clientMessageId,result)=>{
    const key=hostId+':'+clientMessageId,prior=promptResults.get(key);
    if(prior?.result)return;
    promptResults.set(key,{...(prior??{}),result});
    emit({type:'session.prompt_result',sessionId:hostId,clientMessageId,result});
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
            invariant(s.status!=='abandoned'&&!s.archiveIntent,'SESSION_REQUIRES_INSPECTION');
          } else s = await broker.create(selection, { cwd: input.config.cwd, systemPrompt: input.config.systemPrompt ?? '' });
          invariant(!closed && !closing, 'CONNECTION_CLOSED');
          invariant(!broker.owners.has(s.id), 'SESSION_ALREADY_ATTACHED');
          const hostId = input.sessionId;
          binding={id:s.id,controller:new AbortController(),unsubscribe:broker.subscribe(s.id,e=>observe(hostId,e)),
            held:new Map(),items:new Map(),permissions:new Map(),permissionSignatures:new Map(),
            respondingPermissions:new Map(),manualConflict:new Set(),ready:false,confirmed:false};
          broker.owners.set(s.id, binding); sessions.set(input.sessionId, binding);
          if(typeof observation?.readTimeline==='function') {
            const active=()=>!closed&&!closing&&!broker.closed&&sessions.get(hostId)===binding&&
              !binding.controller.signal.aborted&&broker.owners.get(binding.id)===binding;
            binding.delivery=createProviderDelivery({sessionId:s.id,hostId,store,isCurrent:active,
              // A reopened/cold binding may have no new source event for an
              // answer whose delivery stopped at a confirmed prefix. Seed ONLY
              // unfinished durable sources so a suffix batch can be repaired;
              // fully confirmed history is never replayed.
              initialSources:(()=>{const prior=broker.snapshot(s.id).nativeDelivery?.durable;
                return (prior?.sources??[]).filter(source=>{
                  const row=prior.deliveries?.find(item=>item.sourceId===source.id);
                  return row&&(row.pending||row.confirmedText!==source.text);
                }).map(source=>({id:source.id,messageId:source.messageId,text:source.text}));})(),
              isReady:()=>binding.ready&&binding.confirmed&&!binding.deferred&&!binding.releasing,
              readHost:async(bindingGeneration,isCurrent)=>{
                if(!binding.agentId){requestBarrier(hostId,binding);throw new BridgeError('HOST_AGENT_UNAVAILABLE');}
                const agentId=binding.agentId;
                const view=await observation.readTimeline(binding.id,{agentId,hostId,bindingGeneration,isCurrent});
                return {agentId,view};
              },
              emit:event=>{
                if(!capabilities.includes('timeline.plugin'))return false;
                return emit(event);
              },
              notice:codes=>emit({type:'session.notice',sessionId:hostId,notice:{id:'native-content-delivery',
                severity:codes.length?'warning':'info',title:codes.length?'正文同步待确认':'正文同步已恢复',
                description:codes.length?'原文已保留，稍后自动重试。':undefined,
                dismissed:codes.length===0}})
            });
          }
          // An unbound preparatory tab has no durable ChatGPT conversation yet.
          // Only those ephemeral tab IDs may be dropped during restoration.
          // Once /c/<id> is recorded, keep its tab/document/link intact.
          if(input.persistence && !s.conversationId)
            await store.transaction(d=>{d.sessions[s.id].tabId=null;d.sessions[s.id].documentKey=null;});
          const resumingActive=['sending','running','stopping'].includes(s.status);
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
            title: resumingActive ? '已恢复网页跟踪' :
              s.conversationId ? '已恢复对话关联' : '配置已保存，待发送时应用',
            description: resumingActive ? '继续读取原对话；不会重发消息。' :
              s.conversationId ? '不会重发旧消息。' : '首次发送时生效。' } });
          configEvent(input.sessionId, s.id);
          if(input.history==='replay')for(const item of broker.snapshot(s.id).history)emitItem(input.sessionId,item);
          emit({type:'session.ready',requestId:input.requestId,sessionId:input.sessionId});
          binding.ready=true;
          binding.delivery?.kick();
          const current=broker.snapshot(s.id),run=current.observation?.run;
          if(run?.active)observe(input.sessionId,{state:'page-running',turnId:run.id});
          for(const approval of Object.values(current.approvals??{})) {
            if(approval.state==='open')observe(input.sessionId,{state:'approval',approval});
            else if(approval.state==='resolved'&&!approval.answered) {
              binding.permissions.set(approval.key,'stale');
              emit({type:'session.notice',sessionId:input.sessionId,notice:{
                id:'approval-withdrawn:'+approval.key,severity:'warning',
                title:'网页授权请求已失效',
                description:'不能确定网页是否允许。旧卡片仅能通过人工「拒绝」清理本地待办，不会点击网页。'
              }});
            }
          }
          if(current.turn?.receiptPending)observe(input.sessionId,{state:'receipt-pending',turnId:current.turn.id});
          requestBarrier(input.sessionId,binding);
        } catch (e) { binding?.delivery?.close(); binding?.unsubscribe(); if (binding && broker.owners.get(binding.id) === binding) broker.owners.delete(binding.id); sessions.delete(input.sessionId); throw e; }
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
            notice: { id: 'message-id-conflict', severity: 'error', title: '消息标识已使用，请新建一条消息' } });
          return;
        }
        invariant(promptResults.size < 4000, 'PROMPT_HISTORY_LIMIT');
        promptResults.set(promptKey, { fingerprint, result: null });
        invariant(capabilities.includes('prompt.message'), 'CAPABILITY_NOT_NEGOTIATED');
        const binding = host(input.sessionId); const { id } = binding;
        // A host prompt comes from a registered, subscribed host session.
        binding.confirmed = true;
        const {text:value,attachments}=promptContent(input.prompt);
        invariant(!attachments.some(p=>p.type==='image')||capabilities.includes('prompt.image'),'CAPABILITY_NOT_NEGOTIATED');
        // Its own failure is reported on that request; the prompt then checks the page itself.
        if (binding.configuring) await binding.configuring.catch(() => {});
        invariant(!binding.preparing, 'SESSION_BUSY');
        const preparing = new AbortController(); binding.preparing = preparing;
        binding.deferred ??= new Map();
        let result, slot;
        try {
          const signal = AbortSignal.any([controller.signal, binding.controller.signal, preparing.signal]);
          if (['sending','running','stopping'].includes(broker.snapshot(id).status)) {
            emit({type:'session.notice',sessionId:input.sessionId,notice:{
              id:'native-prior-turn',severity:'info',
              title:'上一轮尚未结束，新消息等待发送',
              description:'正在恢复原对话跟踪。本条新消息将在上一轮结束后发送，旧消息不会重发。'
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
              title:'继续原 ChatGPT 对话',description:'上一条结果未确认。本次仅发送新消息，不重发旧消息。'
            }});
          }
          slot = await broker.slots.acquire(id, { signal, onPosition: position => emit({type:'session.notice',sessionId:input.sessionId,notice:{id:'native-queue',severity:'info',title:position?`排队第 ${position} 位 · 尚未发送`:'正在核对网页',dismissed:position===0}}) });
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
          // The user's own message is already durably admitted. Echo it now so
          // the Paseo timeline does not wait for the native click/receipt; the
          // later prompt_result and turn events still gate host execution.
          emitItem(input.sessionId,{type:'user_message',id:'user:'+result.turnId,text:value,
            clientMessageId:input.prompt.clientMessageId});
          // Accept once a frame from after the one-shot dispatch is observed,
          // or its command result arrives. Do not hold authorization/content
          // for a slow message receipt; the page controls still end the run.
          if(!result.replay)await broker.waitForSendObservation(broker.snapshot(id).turn.commandId);
        } finally {
          slot?.release(); if (binding.preparing === preparing) binding.preparing = null;
          emit({type:'session.notice',sessionId:input.sessionId,notice:{id:'native-prior-turn',severity:'info',title:'上一轮等待已结束',dismissed:true}});
          emit({type:'session.notice',sessionId:input.sessionId,notice:{id:'native-queue',severity:'info',title:'排队已结束',dismissed:true}});
        }
        const delivery = broker.snapshot(id).turn;
        emit({type:'session.notice',sessionId:input.sessionId,notice:{id:'native-delivery',severity:'info',
          title:delivery?.receivedAt?'网页已确认接收':'正在发送，等待送达确认',dismissed:Boolean(delivery?.receivedAt)}});
        const current=broker.snapshot(id),run=current.observation?.run;
        const wire=current.turn?.id===result.turnId&&current.turn.observedRunId?
          current.turn.observedRunId:run?.active?run.id:result.turnId;
        disposition(input.sessionId,input.prompt.clientMessageId,{type:'turn',turnId:wire});
        announce(input.sessionId,wire);
        releaseDeferred(input.sessionId,binding,false);
        if(current.turn?.id===result.turnId&&current.turn.outcome)
          end(input.sessionId,wire,current.turn.outcome);
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
            title:'新配置已保存，下轮发送前应用'}});
        }else if(old.tabId===null) await broker.deferConfigure(id, selection);
        else {
          // A prompt sent right after this (Paseo applies the composer's
          // model first) waits for it instead of failing CONFIGURATION_BUSY.
          const work=(async()=>{
            const signal=AbortSignal.any([controller.signal,binding.controller.signal]);
            await (runtime.chromeWake ?? wakeChrome)({status:()=>runtime.status(),signal});
            await broker.configure(id, selection, { signal });
          })();
          binding.configuring=work;
          try { await work; } finally { if(binding.configuring===work) binding.configuring=null; }
        }
        configEvent(input.sessionId, id); emit({ type: 'request.completed', requestId: input.requestId }); return;
      }
      case 'session.permission': {
        const binding = host(input.sessionId), permissions = (binding.permissions ??= new Map());
        const state=permissions.get(input.permissionId);
        if(state!=='open'&&state!=='stale')return;
        try {
          const choice=approvalChoice(input.response);
          if(state==='stale') {
            // The user chose Deny on an already-gone page request. This only
            // clears the old Paseo card; it is NOT an additional webpage click.
            if(choice!=='deny')throw new BridgeError('APPROVAL_GONE');
            permissions.set(input.permissionId,'resolved');
            emit({type:'session.permission_resolved',sessionId:input.sessionId,permissionId:input.permissionId});
            emit({type:'session.notice',sessionId:input.sessionId,notice:{
              id:'approval-local-dismiss:'+input.permissionId,severity:'info',
              title:'已清理旧授权卡',description:'只清理 Paseo 待处理提示，网页选择仍未知。'}});
            return;
          }
          await broker.answerApproval(binding.id,input.permissionId,choice,{
            onQueued:()=>{
              binding.respondingPermissions.set(input.permissionId,choice);
              binding.manualConflict?.delete(input.permissionId);
            }
          });
          if (permissions.get(input.permissionId) === 'open') {
            permissions.set(input.permissionId, 'resolved');
            emit({ type: 'session.permission_resolved', sessionId: input.sessionId, permissionId: input.permissionId });
          }
        } catch (e) {
          if(e?.code==='APPROVAL_IN_FLIGHT')binding.manualConflict?.add(input.permissionId);
          // Nothing was clicked, or the click was not confirmed. The request
          // stays open in Paseo; the page card is still the source of truth.
          emit({ type: 'session.notice', sessionId: input.sessionId, notice: { id: 'native-permission-answer', severity: 'warning',
            title: '授权操作未确认', description: `请先核对网页授权状态，再决定是否重试。错误码：${errorOf(e).code}` } });
        }
        return;
      }
      case 'session.interrupt': {
        const binding=host(input.sessionId),preparing=Boolean(binding.preparing);
        binding.preparing?.abort();
        const current=broker.snapshot(binding.id),command=current.turn&&store.read().commands[current.turn.commandId];
        const unsent=command?.kind==='send'&&['queued','claimed'].includes(command.phase)&&!current.turn.authorized;
        if(!preparing||unsent||current.observation?.page?.controls.stop.visible)
          await broker.interrupt(binding.id);
        emit({type:'request.completed',requestId:input.requestId});return;
      }
      case 'session.archive': {
        // Paseo sends persistence even when the Agent has no open Provider session.
        // The record stays in state.json until the close has actually settled.
        const id = sessionIdFromPersistence(input.persistence);
        if (id) await broker.archiveSession(id);
        emit({ type: 'request.completed', requestId: input.requestId });
        return;
      }
      case 'session.unarchive': {
        const id = sessionIdFromPersistence(input.persistence);
        if (id) await broker.unarchiveSession(id);
        emit({ type: 'request.completed', requestId: input.requestId });
        return;
      }
      case 'session.close': {
        const binding=host(input.sessionId);binding.delivery?.close();binding.controller.abort();binding.unsubscribe();
        if(broker.owners.get(binding.id)===binding)broker.owners.delete(binding.id);
        sessions.delete(input.sessionId);
        // Detaching a host is neither Stop nor unbinding the webpage.
        emit({type:'session.closed',sessionId:input.sessionId});
        emit({type:'request.completed',requestId:input.requestId});return;
      }
      default: throw new BridgeError('CAPABILITY_UNSUPPORTED');
    }
  }
  return {
    version: 1, capabilities,
    async send(input) {
      invariant(!closed && !closing, 'CONNECTION_CLOSED');
      // Do not await a browser roundtrip here: acceptance is separate from lifecycle events.
      invariant(['catalog', 'session.open', 'session.prompt', 'session.configure', 'session.interrupt', 'session.permission', 'session.archive', 'session.unarchive', 'session.close'].includes(input.type), 'CAPABILITY_UNSUPPORTED');
      queueMicrotask(() => dispatch(input).catch(e => {
        if (input.type === 'session.prompt') {
          disposition(input.sessionId, input.prompt.clientMessageId, { type: 'failed', error: errorOf(e) });
          const binding = sessions.get(input.sessionId);
          if (!binding?.preparing) releaseDeferred(input.sessionId, binding, true);
        }
        else if ('requestId' in input) emit({ type: 'request.failed', requestId: input.requestId, error: errorOf(e) });
      }));
    },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async close() {
      if (closed || closing) return; closing = true; controller.abort(); stopConfirmations();
      // Closing the Provider connection is not a user's Stop command. Keep
      // live browser turns for a later connection/restart to reattach safely.
      for (const [hostId, binding] of sessions) {
        binding.delivery?.close();
        binding.controller.abort();
        binding.unsubscribe();
        if (broker.owners.get(binding.id) === binding) broker.owners.delete(binding.id);
        emit({ type: 'session.closed', sessionId: hostId });
      }
      closed = true; sessions.clear(); listeners.clear();
    }
  };
}
