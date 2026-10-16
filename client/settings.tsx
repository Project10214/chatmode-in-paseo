import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View, Text, Pressable, Switch } from 'react-native';
import { useRpc, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, TextInput, copyText } from '@getpaseo/plugin/client/react-native';
import type { RpcOutput } from '@getpaseo/plugin';
import { snapshot, saveDefaults, saveConcurrency, pair, abandon } from '../shared/rpc.js';

type State = RpcOutput<typeof snapshot>;
const ERROR_LABELS: Record<string,string> = {
  EXTENSION_OFFLINE:'Chrome 扩展暂未在线，请检查浏览器和 Paseo 都在运行。',
  COMPOSER_READY_TIMEOUT:'ChatGPT 输入框尚未就绪，请在网页完成登录或验证。',
  APP_CATALOG_UNAVAILABLE:'本次未取得完整应用列表。上次确认的选项仍可使用，发送前会再次核验。',
  APP_LIST_LOGIN_REQUIRED:'请先在 ChatGPT 网页登录，并完成应用授权。',
  APP_LIST_RATE_LIMITED:'网页暂时限制请求，已停止自动重试。',
  PAGE_RELOAD_REQUIRED:'网页正在运行旧版脚本，请刷新空闲的 ChatGPT 页面。',
  NAVIGATION_CHANGED:'读取期间网页发生跳转，本次同步已取消。',
  APP_PROBE_INTERRUPTED:'读取被网页操作打断，你的草稿已保留。',
};
const effortLabel:Record<string,string>={low:'轻量',medium:'适中',high:'深入',xhigh:'最高',standard:'标准',extended:'延长'};
export function SettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const read=useRpc(snapshot),save=useRpc(saveDefaults),setLimit=useRpc(saveConcurrency),makePair=useRpc(pair),endTracking=useRpc(abandon);
  const [limit,setLimitValue]=useState<number|null>(null),[limitNotice,setLimitNotice]=useState('');
  async function persistLimit(){setBusy(true);mutationEpoch.current++;try{const saved=await setLimit({maxConcurrent:limit??state?.capacity?.limit??2});mutationEpoch.current++;if(mounted.current){setLimitValue(null);setState(s=>s?{...s,capacity:{limit:saved.maxConcurrent,active:s.capacity?.active??0,waiting:s.capacity?.waiting??0}}:s);setLimitNotice('已应用并保存。降低上限不会停止正在运行的任务。');}}catch{mutationEpoch.current++;if(mounted.current)setLimitNotice('保存失败，未修改并发上限。');}finally{if(mounted.current)setBusy(false);}}
  const [state,setState]=useState<State|null>(null),[model,setModel]=useState(''),[thinking,setThinking]=useState<string|null>(null),[apps,setApps]=useState<string[]>([]);
  const [busy,setBusy]=useState(false),[changed,setChanged]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState(''),[query,setQuery]=useState('');
  const [pairing,setPairing]=useState<RpcOutput<typeof pair>|null>(null),[pairOpen,setPairOpen]=useState(false),[diagnostics,setDiagnostics]=useState(false),[confirmAbandon,setConfirmAbandon]=useState<string|null>(null);
  const dirty=useRef(false),mounted=useRef(true),lastChecked=useRef(0),mutationEpoch=useRef(0),reader=useRef(read);reader.current=read;
  const c=theme.colors,compact=layout?.compact??false;
  function defaults(s:State){const selected=s.defaults.model??s.catalog?.defaultModel??'';setModel(selected);setThinking(s.defaults.thinkingOption??s.catalog?.models.find(m=>m.id===selected)?.defaultThinkingOptionId??null);setApps(s.defaults.appIds);}
  function apply(s:State){if(!mounted.current||s.checkedAt<lastChecked.current)return;lastChecked.current=s.checkedAt;setState(s);if(!dirty.current)defaults(s);}
  function edit(fn:()=>void){dirty.current=true;setChanged(true);setNotice('');fn();}
  useEffect(()=>{
    mounted.current=true;let alive=true,flight=false;
    const poll=async()=>{if(flight)return;flight=true;const epoch=mutationEpoch.current;try{const s=await reader.current({refresh:false});if(alive&&epoch===mutationEpoch.current){apply(s);setError('');}}catch{if(alive&&epoch===mutationEpoch.current)setError('暂时无法读取 Paseo 状态。不会因此重发消息。');}finally{flight=false;}};
    void poll();const timer=setInterval(()=>void poll(),2000);
    return()=>{alive=false;mounted.current=false;clearInterval(timer);};
  },[]);
  async function sync(){setBusy(true);setNotice('');try{apply(await reader.current({refresh:true}));}catch{setError('同步请求失败，请检查连接。');}finally{if(mounted.current)setBusy(false);}}
  async function persist(){setBusy(true);setNotice('');mutationEpoch.current++;try{const saved=await save({model,thinkingOption:thinking,appIds:apps});mutationEpoch.current++;if(!mounted.current)return;dirty.current=false;setChanged(false);setState(s=>s?{...s,defaults:saved}:s);setNotice('已保存。仅对新会话生效，现有会话保持不变。');}catch{mutationEpoch.current++;if(mounted.current)setNotice('保存失败，未保存的选择仍在，请检查连接后重试。');}finally{if(mounted.current)setBusy(false);}}
  async function generatePair(){setBusy(true);try{const p=await makePair({});if(mounted.current){setPairing(p);setPairOpen(true);}}catch{setNotice('配对码未能生成。现有配对不会被替换。');}finally{if(mounted.current)setBusy(false);}}
  async function copy(value:string){try{await copyText(value);setNotice('已复制到当前设备。');}catch{setNotice('无法自动复制，请长按文字手动复制。');}}
  const button=(title:string,onPress:()=>void,options:{primary?:boolean;disabled?:boolean;icon?:string;danger?:boolean}={})=><Pressable accessibilityRole="button" accessibilityState={{disabled:options.disabled??busy}} disabled={options.disabled??busy} onPress={onPress} style={({pressed})=>({minHeight:44,paddingHorizontal:16,paddingVertical:12,borderRadius:10,backgroundColor:options.primary?c.accent:c.surface2,opacity:(options.disabled??busy)?0.45:pressed?0.75:1,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8})}>{options.icon&&<Icon name={options.icon} size={16} color={options.primary?c.accentForeground:options.danger?c.statusDanger:c.foreground}/>}<Text style={{fontSize:13,fontWeight:'600',color:options.primary?c.accentForeground:options.danger?c.statusDanger:c.foreground}}>{title}</Text></Pressable>;
  const section=(number:string,title:string,subtitle:string,children:ReactNode)=><View style={{gap:12}}><View style={{flexDirection:'row',gap:10,alignItems:'center'}}><Text style={{color:c.foregroundMuted,fontSize:11,fontWeight:'700'}}>{number}</Text><Text style={{color:c.foreground,fontSize:16,fontWeight:'600'}}>{title}</Text></View><Text style={{color:c.foregroundMuted,fontSize:13,lineHeight:20}}>{subtitle}</Text><View style={{borderWidth:1,borderColor:c.border,borderRadius:14,backgroundColor:c.surface1,padding:compact?16:20,gap:16}}>{children}</View></View>;
  const connected=!!state?.status.connected;
  const selectedModel=state?.catalog?.models.find(m=>m.id===model),expires=pairing?Math.max(0,Math.ceil((pairing.expiresAt-(state?.checkedAt??Date.now()))/1000)):0;
  const failed=!state?.refreshing&&state?.refreshError;
  const filtered=state?.catalog?.apps.filter(a=>a.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))??[];
  return <View style={{padding:compact?16:24,gap:26,width:'100%',maxWidth:800,alignSelf:'center',backgroundColor:c.surface0}}>
    <View style={{gap:8}}><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:12}}><Text style={{color:c.foreground,fontSize:27,fontWeight:'700',letterSpacing:-.6}}>Chatmode</Text><Text style={{color:c.foregroundMuted,fontSize:11}}>Chatmode in Paseo · alpha.3.15</Text></View><Text style={{color:c.foregroundMuted,fontSize:14,lineHeight:21}}>让 Paseo 与你的 ChatGPT 网页保持同步。</Text></View>
    <View style={{borderWidth:1,borderColor:c.border,borderRadius:16,padding:18,backgroundColor:c.surface1,gap:14}}>
      <View style={{flexDirection:'row',alignItems:'center',gap:12}}><View style={{width:40,height:40,borderRadius:12,backgroundColor:c.surface2,alignItems:'center',justifyContent:'center'}}><Icon name="Link" size={20} color={connected?c.statusSuccess:c.foregroundMuted}/></View><View style={{flex:1,gap:3}}><Text style={{color:c.foreground,fontWeight:'600',fontSize:15}}>{!state?'正在检查连接…':connected?'Chrome 已连接':state.status.paired?'已配对 · 等待 Chrome':'尚未配对'}</Text><Text selectable style={{color:c.foregroundMuted,fontSize:12}}>{state?.status.address??'本机连接 · 配对信息仅保存在此电脑'}</Text></View></View>
      <View style={{flexDirection:'row',gap:16,flexWrap:'wrap'}}><Text style={{color:c.foregroundMuted,fontSize:12}}>文字流式回传</Text><Text style={{color:c.foregroundMuted,fontSize:12}}>图片预览与放大</Text><Text style={{color:c.foregroundMuted,fontSize:12}}>无需 CoS 主程序</Text></View>
      {!!error&&<Text accessibilityRole="alert" style={{color:c.statusWarning,fontSize:13}}>{error}</Text>}
    </View>
    {section('01','连接与同步','正常使用不需要反复配对。目录同步与会话发送相互独立。',<>
      <View style={{flexDirection:compact?'column':'row',gap:8}}>{button(state?.refreshing?'正在同步…':'同步网页选项',()=>void sync(),{icon:'RefreshCw',disabled:busy||!!state?.refreshing||!connected})}{button(pairOpen?'收起配对':'连接 Chrome 扩展',()=>setPairOpen(v=>!v),{icon:'Link'})}</View>
      {state?.refreshing&&<Text accessibilityLiveRegion="polite" style={{color:c.foregroundMuted,fontSize:13}}>正在读取网页，已等待 {Math.max(0,Math.floor(((state.checkedAt)-(state.refreshStartedAt??state.checkedAt))/1000))} 秒。结果会自动更新。</Text>}
      {!!failed&&<Text accessibilityRole="alert" style={{color:c.statusWarning,fontSize:13,lineHeight:20}}>{ERROR_LABELS[String(failed)]??'网页选项读取未完成，请展开诊断查看原因。'}</Text>}
      {state?.catalog&&<Text style={{color:c.foregroundMuted,fontSize:12}}>{failed?'上次确认':'已确认'} {state.catalog.models.length} 个模型 · {state.catalog.apps.length} 个应用</Text>}
      {pairOpen&&<View style={{gap:12,borderTopWidth:1,borderColor:c.border,paddingTop:16}}><Text style={{color:c.foregroundMuted,fontSize:13,lineHeight:20}}>生成配对码，在同一电脑的 Chrome 扩展中输入本地地址和配对码。不要分享配对码。</Text>{button('生成一次性配对码',()=>void generatePair(),{icon:'KeyRound'})}{pairing&&<View style={{gap:10}}><Text selectable style={{color:c.foreground,fontSize:12}}>{pairing.address}</Text><Text selectable style={{color:expires?c.foreground:c.foregroundMuted,fontSize:13,lineHeight:20}}>{expires?pairing.code:'配对码已过期，请重新生成。'}</Text><Text style={{color:c.foregroundMuted,fontSize:12}}>剩余 {Math.floor(expires/60)} 分 {expires%60} 秒</Text>{button('复制配对码',()=>void copy(pairing.code),{icon:'Copy',disabled:!expires||busy})}</View>}</View>}
    </>)}
    {section('02','并发标签页','限制同时执行的对话轮数，不限制已打开的闲置标签页。建议先用 4 路。',<>
      <Text style={{color:c.foregroundMuted,fontSize:13}}>正在执行 {state?.capacity?.active??0} · 等待 {state?.capacity?.waiting??0} · 当前上限 {state?.capacity?.limit??2}</Text>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{Array.from({length:8},(_,i)=>i+1).map(n=><Pressable key={n} accessibilityRole="radio" accessibilityLabel={`并发 ${n} 路`} accessibilityState={{checked:(limit??state?.capacity?.limit??2)===n}} aria-checked={(limit??state?.capacity?.limit??2)===n} disabled={busy} onPress={()=>{setLimitValue(n);setLimitNotice('');}} style={{minWidth:44,minHeight:44,padding:12,borderRadius:9,alignItems:'center',backgroundColor:(limit??state?.capacity?.limit??2)===n?c.accent:c.surface2}}><Text style={{color:(limit??state?.capacity?.limit??2)===n?c.accentForeground:c.foreground}}>{n}</Text></Pressable>)}</View>
      {button('应用并发上限',()=>void persistLimit(),{primary:true,disabled:busy||!state?.capacity})}
      <Text style={{color:c.foregroundMuted,fontSize:12,lineHeight:19}}>保存后立即生效。超额请求按顺序等待，可在对话中停止；重载插件会取消尚未发送的等待请求，不会自动补发。关闭已完成的网页后，再发送新消息会重开原对话。</Text>
      {!!limitNotice&&<Text accessibilityLiveRegion="polite" style={{color:c.foreground,fontSize:13}}>{limitNotice}</Text>}
    </>)}
    {section('03','新会话默认配置','以下设置只影响新建 Agent。已有会话请在对话内调整。',<>
      <Text style={{color:c.foreground,fontSize:13,fontWeight:'600'}}>模型</Text>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{state?.catalog?.models.map(m=><Pressable key={m.id} accessibilityRole="radio" accessibilityLabel={m.label} accessibilityState={{checked:model===m.id}} aria-checked={model===m.id} disabled={busy} onPress={()=>edit(()=>{setModel(m.id);setThinking(m.defaultThinkingOptionId??null);})} style={{minHeight:44,padding:12,borderRadius:10,borderWidth:1,borderColor:model===m.id?c.accent:c.border,backgroundColor:model===m.id?c.surface2:c.surface1,flexDirection:'row',alignItems:'center',gap:8}}><Icon name={model===m.id?'CircleCheck':'Circle'} size={15} color={model===m.id?c.accent:c.foregroundMuted}/><Text style={{color:c.foreground,fontSize:13,fontWeight:model===m.id?'600':'400'}}>{m.label}</Text></Pressable>)}</View>
      {!state?.catalog&&<Text style={{color:c.foregroundMuted,fontSize:13}}>连接扩展后，这里会显示网页实际可用的模型。</Text>}
      <Text style={{color:c.foreground,fontSize:13,fontWeight:'600'}}>思考强度</Text>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{selectedModel?.thinkingOptions.map(t=><Pressable key={t.id} accessibilityRole="radio" accessibilityLabel={t.label} accessibilityState={{checked:thinking===t.id}} aria-checked={thinking===t.id} disabled={busy} onPress={()=>edit(()=>setThinking(t.id))} style={{minHeight:44,borderRadius:9,paddingHorizontal:16,paddingVertical:12,backgroundColor:thinking===t.id?c.accent:c.surface2}}><Text style={{color:thinking===t.id?c.accentForeground:c.foreground,fontSize:13}}>{effortLabel[t.id]??t.label}</Text></Pressable>)}</View>
      {selectedModel&&!selectedModel.thinkingOptions.length&&<Text style={{color:c.foregroundMuted,fontSize:13}}>此模型没有独立的思考强度选项。</Text>}
      <View style={{height:1,backgroundColor:c.border}}/>
      <View style={{flexDirection:'row',justifyContent:'space-between'}}><Text style={{color:c.foreground,fontSize:13,fontWeight:'600'}}>ChatGPT 应用</Text><Text style={{color:c.foregroundMuted,fontSize:12}}>已选 {apps.length} 项</Text></View>
      <TextInput accessibilityLabel="搜索应用" value={query} onChangeText={setQuery} placeholder="搜索已授权的应用" placeholderTextColor={c.foregroundMuted} style={{minHeight:44,borderWidth:1,borderColor:c.border,borderRadius:9,paddingHorizontal:12,color:c.foreground,backgroundColor:c.surface2,fontSize:13}}/>
      <View>{filtered.map(app=><View key={app.id} style={{minHeight:52,flexDirection:'row',alignItems:'center',gap:12,borderBottomWidth:1,borderColor:c.border}}><Icon name="Blocks" size={16} color={c.foregroundMuted}/><Text style={{color:c.foreground,fontSize:14,flex:1}}>{app.label}</Text><Switch accessibilityLabel={app.label} disabled={busy} value={apps.includes(app.id)} onValueChange={v=>edit(()=>setApps(old=>v?[...old,app.id]:old.filter(id=>id!==app.id)))}/></View>)}{!filtered.length&&<Text style={{color:c.foregroundMuted,fontSize:13,paddingVertical:8}}>没有匹配的应用。</Text>}</View>
      <Text style={{color:c.foregroundMuted,fontSize:12,lineHeight:19}}>Paseo 对话输入区只显示一个「工具」下拉菜单，可直接切换单个已授权应用、无工具或常用组合。本页仍可组合多个应用，保存后作为新会话默认配置；切换不会自动授予权限。</Text>
      <View style={{gap:10,backgroundColor:c.surface2,padding:14,borderRadius:10}}><Text style={{color:c.foreground,fontSize:13}}>{selectedModel?.label??'尚未选择模型'} · {thinking?(effortLabel[thinking]??thinking):'默认强度'} · {apps.length} 个应用{changed?' · 未保存':''}</Text>{button(busy?'正在处理…':'保存默认配置',()=>void persist(),{primary:true,icon:'Check',disabled:busy||!!state?.refreshing||!connected||!state?.catalog||!model})}{changed&&button('撤销未保存的修改',()=>{if(state){dirty.current=false;setChanged(false);defaults(state);setNotice('已恢复保存的配置。');}},{icon:'Undo2'})}</View>
      {!!notice&&<Text accessibilityLiveRegion="polite" selectable style={{color:c.foreground,fontSize:13,lineHeight:20}}>{notice}</Text>}
    </>)}
    <Pressable accessibilityRole="button" accessibilityState={{expanded:diagnostics}} onPress={()=>setDiagnostics(v=>!v)} style={{minHeight:44,flexDirection:'row',alignItems:'center',gap:8}}><Icon name={diagnostics?'ChevronDown':'ChevronRight'} size={16} color={c.foregroundMuted}/><Text style={{color:c.foregroundMuted,fontSize:13}}>诊断与历史异常{state?.blocked.length?` · ${state.blocked.length}`:''}</Text></Pressable>
    {diagnostics&&<View style={{padding:16,gap:14,borderWidth:1,borderColor:c.border,borderRadius:12}}><Text selectable style={{color:c.foregroundMuted,fontSize:12,lineHeight:19}}>最近同步：{state?.lastCatalogAttempt?.phase??'尚无记录'}{state?.lastCatalogAttempt?.error?` · ${state.lastCatalogAttempt.error}`:''}</Text><Text style={{color:c.foregroundMuted,fontSize:12,lineHeight:19}}>下方仅结束本地跟踪，不会停止网页或 MCP 工作，也不会删除历史。请先确认网页任务已结束，并在 Paseo 关闭对应 Agent。</Text>{state?.blocked.map(s=><View key={s.id} style={{gap:8}}><Text selectable style={{color:c.foregroundMuted,fontSize:12}}>{s.id} · {s.error}</Text>{button(confirmAbandon===s.id?'再次确认：仅结束本地跟踪':'结束此会话的本地跟踪',()=>{if(confirmAbandon!==s.id){setConfirmAbandon(s.id);return;}setBusy(true);endTracking({sessionId:s.id,confirmed:true}).then(()=>{setConfirmAbandon(null);return reader.current({refresh:false});}).then(apply).catch(()=>setNotice('未能结束跟踪，请先在 Paseo 关闭对应 Agent。')).finally(()=>setBusy(false));},{danger:true,icon:'Unplug'})}</View>)}</View>}
    <Text style={{color:c.foregroundMuted,fontSize:11,lineHeight:18}}>本机桥接 · 不自动点击授权 · 不重发结果不明的消息 · 图片原图仍在 ChatGPT 网页</Text>
  </View>;
}
