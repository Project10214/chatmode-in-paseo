import { Text, View } from 'react-native';
import type { PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { isSourceIssue, pageStateFromControls, pageStateLabel, type PageStateData } from '../shared/page-state.js';

/** Read-only page-state v1. No commands, timers, native turn status or recovery mode. */
export function PageStateCard({ item, theme, layout }: PluginTimelineItemProps<PageStateData>) {
  const data = item.data, c = theme.colors, state = pageStateFromControls(data);
  const sourceIssues = data.issues.filter(isSourceIssue);
  const statusIssues = data.issues.filter(issue => !isSourceIssue(issue));
  const controls = (['stop', 'send', 'voice'] as const).map(key => {
    const name = { stop: '停止', send: '发送', voice: '语音' }[key];
    const button = data.controls[key];
    return `${name}：${button.visible ? !data.readable ? '已见，可用性待确认' : button.enabled ? '可用' : '不可用' : data.readable ? '未见' : '未确认'}`;
  }).join(' · ');
  return <View style={{
    width: '100%', maxWidth: 600, gap: 5, marginVertical: 3,
    padding: layout?.compact ? 10 : 12, borderRadius: 10, borderWidth: 1,
    borderColor: c.border, backgroundColor: c.surface1
  }}>
    <Text accessibilityLiveRegion="polite" style={{
      color: state === 'abnormal' ? c.statusWarning : c.foreground,
      fontWeight: '600', fontSize: 13, lineHeight: 19
    }}>网页：{pageStateLabel[state]}</Text>
    <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
      {data.readable || data.controls.stop.visible ? controls : '按钮状态未确认'}
    </Text>
    {sourceIssues.length > 0 && <Text selectable style={{ color: c.statusWarning, fontSize: 12, lineHeight: 18 }}>
      {`源采集问题 ${sourceIssues.length}：${[...new Set(sourceIssues.map(issue => issue.code))].join('、')}`}
    </Text>}
    {statusIssues.length > 0 && <Text selectable style={{ color: c.statusWarning, fontSize: 12, lineHeight: 18 }}>
      {`状态提示：${[...new Set(statusIssues.map(issue => issue.code))].join('、')}`}
    </Text>}
    <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 16 }}>
      {`观测于 ${new Date(data.observedAt).toLocaleTimeString()}`}
    </Text>
  </View>;
}
