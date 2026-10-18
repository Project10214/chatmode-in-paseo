import { Text, View } from 'react-native';
import type { PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { isSourceIssue, pageStateFromControls, pageStateLabel, type PageStateData } from '../shared/page-state.js';

/** Read-only page-state v1. No commands, timers, native turn status or recovery mode. */
export function PageStateCard({ item, theme, layout }: PluginTimelineItemProps<PageStateData>) {
  const data = item.data, c = theme.colors, state = pageStateFromControls(data);
  const sourceIssues = data.issues.filter(isSourceIssue);
  const statusIssues = data.issues.filter(issue => !isSourceIssue(issue));
  const action = state === 'running'
    ? (data.controls.stop.enabled ? '可停止' : '停止不可用')
    : state === 'standby'
      ? (data.controls.send.visible ? '可发送' : data.controls.voice.visible ? '可开始语音' : '待命')
      : '按钮状态未确认';
  const time = new Date(data.observedAt).toLocaleTimeString(undefined, { hour12: false });
  return <View style={{
    width: '100%', maxWidth: 600, gap: 5, marginVertical: 3,
    padding: layout?.compact ? 10 : 12, borderRadius: 10, borderWidth: 1,
    borderColor: c.border, backgroundColor: c.surface1
  }}>
    <Text accessibilityLiveRegion="polite" style={{
      color: state === 'abnormal' ? c.statusWarning : c.foreground,
      fontWeight: '600', fontSize: 13, lineHeight: 19
    }}>网页：{pageStateLabel[state]}</Text>
    <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{action}</Text>
    {sourceIssues.length > 0 && <Text selectable style={{ color: c.statusWarning, fontSize: 12, lineHeight: 18 }}>
      {`采集提示 ${sourceIssues.length} 条`}
    </Text>}
    {statusIssues.length > 0 && <Text selectable style={{ color: c.statusWarning, fontSize: 12, lineHeight: 18 }}>
      {`状态提示 ${statusIssues.length} 条`}
    </Text>}
    <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{`最近观测 ${time}`}</Text>
  </View>;
}
