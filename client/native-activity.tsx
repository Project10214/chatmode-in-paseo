import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import type { ActivityCardData, ActivityCardDataV2 } from '../shared/activity.js';
import { phaseLabel, approvalHint } from '../shared/ui-copy.mjs';
const symbols={tool:'Wrench',search:'Search',exec:'Code2',image:'Image'} as const;

/** A compact native progress summary, not a second copy of every tool card.
 * Keep the full observed step list available on demand, in source order.
 */
export function NativeActivity({item,theme}:PluginTimelineItemProps<ActivityCardData>) {
  const data=item.data,c=theme.colors;
  const [expanded,setExpanded]=useState(false);
  const hasSteps=data.steps.length>0;
  const finished=data.phase==='completed',waiting=data.phase==='approval';
  const stopped=data.phase==='failed'||data.phase==='canceled';
  const statusColor=waiting?c.statusWarning:stopped?c.statusDanger:
    finished?c.statusSuccess:c.foregroundMuted;
  const state=finished?'已结束':data.phase==='failed'?'跟踪中断':data.phase==='canceled'?'已取消':
    data.nativeStatus==='complete'?'网页已结束 · 待确认':
    data.nativeStatus==='in_progress'?'运行中':'状态待确认';

  return <View style={{
    width:'100%',maxWidth:600,borderRadius:10,borderWidth:1,
    borderColor:c.border,backgroundColor:c.surface1,
    paddingHorizontal:12,paddingVertical:9,marginVertical:3,gap:6
  }}>
    <Pressable
      disabled={!hasSteps}
      accessibilityRole={hasSteps?'button':undefined}
      accessibilityLabel={hasSteps?(expanded?'收起工具步骤':'展开工具步骤'):undefined}
      onPress={()=>setExpanded(value=>!value)}
      style={{flexDirection:'row',alignItems:'center',minHeight:24,gap:8}}
    >
      <Icon
        name={finished?'CircleCheck':waiting?'ShieldAlert':stopped?'AlertCircle':'Activity'}
        size={15} color={statusColor}
      />
      <Text numberOfLines={1} style={{
        color:c.foreground,fontWeight:'600',fontSize:12.5,flex:1
      }}>{phaseLabel(data.phase)}</Text>
      <Text style={{color:c.foregroundMuted,fontSize:11}}>{state}</Text>
      {hasSteps&&<Text style={{color:c.foregroundMuted,fontSize:11}}>{data.steps.length} 步</Text>}
      {hasSteps&&<Icon name={expanded?'ChevronUp':'ChevronDown'} size={14} color={c.foregroundMuted}/>}
    </Pressable>
    {expanded&&hasSteps&&<View style={{
      gap:9,borderTopWidth:1,borderTopColor:c.border,paddingTop:10
    }}>
      {data.steps.map((step,i)=><View
        key={i} style={{flexDirection:'row',alignItems:'center',gap:8}}
      >
        <Icon name={symbols[step.kind]} size={13} color={c.foregroundMuted}/>
        <Text numberOfLines={3} style={{
          fontSize:12,lineHeight:18,color:c.foregroundMuted,flex:1
        }}>{step.label}</Text>
        <Icon name={step.done?'Check':'Clock3'} size={13}
          color={step.done?c.statusSuccess:c.foregroundMuted}/>
      </View>)}
    </View>}
    {waiting&&<Text style={{color:c.statusWarning,fontSize:12,lineHeight:18}}>
      {approvalHint}
    </Text>}
  </View>;
}

const scopes={turn:'本轮',page:'网页',sidebar:'侧栏'} as const;
const clock=(at:number)=>new Date(at).toLocaleTimeString();

/** v2: native page facts, Paseo tracking and CIP sync health shown separately.
 * Page notices are the page's own words; buttons are shown, never pressed.
 * Still one card per turn, updated in place.
 */
export function NativeActivityV2({item,theme}:PluginTimelineItemProps<ActivityCardDataV2>) {
  const data=item.data,c=theme.colors,page=data.page;
  const [expanded,setExpanded]=useState(false);
  const hasSteps=data.steps.length>0;
  const blocked=data.sync.state==='blocked',partial=data.sync.state==='partial';
  const ended=data.outcome!==null,waiting=data.phase==='approval'||page?.controls.approval===true;
  const statusColor=waiting||blocked||partial||page?.notices.length?c.statusWarning:
    data.outcome==='completed'?c.statusSuccess:ended?c.statusDanger:c.foregroundMuted;
  const seen=data.native.observedAt??page?.observedAt??null;
  // Rendered age, not live: the card is re-rendered when the row is updated.
  const stale=seen!==null&&Date.now()-seen>90000;
  const native=data.native.status==='in_progress'?'运行中':data.native.status==='complete'?'回答已结束':'未确认';
  const tracking=data.outcome==='completed'?'已完成':data.outcome==='canceled'?'已取消':
    data.outcome==='failed'?`已中断（${data.error??'原因未知'}）`:'进行中';
  const open=data.sync.issues.filter(x=>x.resolvedAt===null).map(x=>x.code);
  const sync=blocked?`正文同步受阻：${open.join('、')}`:partial?`部分内容未同步：${open.join('、')}`:'未发现异常';
  const line=(label:string,value:string,color=c.foregroundMuted)=><Text selectable style={{fontSize:12,lineHeight:18,color}}>
    <Text style={{color:c.foreground,fontWeight:'600'}}>{label}</Text>{value}</Text>;
  return <View style={{
    width:'100%',maxWidth:600,borderRadius:10,borderWidth:1,
    borderColor:c.border,backgroundColor:c.surface1,
    paddingHorizontal:12,paddingVertical:9,marginVertical:3,gap:6
  }}>
    <Pressable
      disabled={!hasSteps}
      accessibilityRole={hasSteps?'button':undefined}
      accessibilityLabel={hasSteps?(expanded?'收起工具步骤':'展开工具步骤'):undefined}
      onPress={()=>setExpanded(value=>!value)}
      style={{flexDirection:'row',alignItems:'center',minHeight:24,gap:8}}
    >
      <Icon name={data.outcome==='completed'?'CircleCheck':waiting?'ShieldAlert':blocked||ended?'AlertCircle':'Activity'}
        size={15} color={statusColor}/>
      <Text numberOfLines={1} style={{color:c.foreground,fontWeight:'600',fontSize:12.5,flex:1}}>{phaseLabel(data.phase)}</Text>
      {hasSteps&&<Text style={{color:c.foregroundMuted,fontSize:11}}>{data.steps.length} 步</Text>}
      {hasSteps&&<Icon name={expanded?'ChevronUp':'ChevronDown'} size={14} color={c.foregroundMuted}/>}
    </Pressable>
    {line('网页：',native+(seen!==null?` · 更新于 ${clock(seen)}${stale?'（可能已过期）':''}`:'')+
      (page&&!page.readable?' · 页面暂不可读':'')+
      (page?.controls.stop?` · 停止按钮${page.controls.stop.visible?(page.controls.stop.enabled?'可见':'可见但不可用'):'不可见'}`:''))}
    {line('Paseo 跟踪：',tracking+(data.outcome==='failed'?' · 网页任务是否停止未确认':''),
      data.outcome==='failed'?c.statusDanger:c.foregroundMuted)}
    {line('内容同步：',sync+(data.recoveries?` · 已恢复跟踪 ${data.recoveries} 次`:''),
      blocked||partial?c.statusWarning:c.foregroundMuted)}
    {page?.notices.map((notice,i)=><View key={i} style={{gap:4,borderTopWidth:1,borderTopColor:c.border,paddingTop:6}}>
      <Text style={{fontSize:11,color:c.statusWarning}}>{`${scopes[notice.scope]}提示（${[notice.redacted?'已脱敏':'',notice.clipped?'已截断':''].filter(Boolean).join('、')||'原文'}）`}</Text>
      <Text selectable style={{fontSize:12,lineHeight:18,color:c.foreground}}>{notice.text}</Text>
      {notice.buttons.length>0&&<Text style={{fontSize:11,color:c.foregroundMuted}}>
        {'网页按钮（仅展示）：'+notice.buttons.map(b=>`${b.label}（${b.enabled?'可用':'不可用'}）`).join('、')}
      </Text>}
    </View>)}
    {page?.truncated&&<Text style={{fontSize:11,color:c.foregroundMuted}}>仅显示部分提示，完整内容请查看 ChatGPT 网页。</Text>}
    {data.native.status==='complete'&&<Text style={{fontSize:11,color:c.foregroundMuted}}>回答结束不代表远程工具或后台任务已结束。</Text>}
    {expanded&&hasSteps&&<View style={{gap:9,borderTopWidth:1,borderTopColor:c.border,paddingTop:10}}>
      {data.steps.map((step,i)=><View key={i} style={{flexDirection:'row',alignItems:'center',gap:8}}>
        <Icon name={symbols[step.kind]} size={13} color={c.foregroundMuted}/>
        <Text numberOfLines={3} style={{fontSize:12,lineHeight:18,color:c.foregroundMuted,flex:1}}>{step.label}</Text>
        <Icon name={step.done?'Check':'Clock3'} size={13} color={step.done?c.statusSuccess:c.foregroundMuted}/>
      </View>)}
    </View>}
    {waiting&&<Text style={{color:c.statusWarning,fontSize:12,lineHeight:18}}>
      {approvalHint}
    </Text>}
  </View>;
}
