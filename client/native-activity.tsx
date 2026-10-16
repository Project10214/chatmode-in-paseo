import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import type { ActivityCardData } from '../shared/activity.js';

const names:Record<ActivityCardData['phase'],string>={
  working:'网页正在处理',thinking:'ChatGPT 正在思考',
  tool:'正在调用工具',search:'正在搜索资料',exec:'正在执行代码',
  image:'正在生成图片',approval:'等待网页授权',
  finalizing:'正在确认最终回答',completed:'本轮已完成',canceled:'本轮已取消',failed:'本轮跟踪已停止'
};
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
  const state=finished?'已完成':stopped?'已停止':
    data.nativeStatus==='complete'?'网页已结束 · 等待回执':
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
      }}>{names[data.phase]}</Text>
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
      请到对应 ChatGPT 网页决定是否授权；本插件不会替你点击。
    </Text>}
  </View>;
}
