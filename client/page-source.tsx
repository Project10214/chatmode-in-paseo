import { Text, View } from 'react-native';
import type { PluginTimelineItemProps } from '@getpaseo/plugin/client';
import {
  isMediaSource, pageSourceTitle, type PageSourceData
} from '../shared/page-source.js';

/** Read-only original source card. No Markdown rendering beyond the source's
 * own text, no truncation, no inferred result, and no page action controls. */
export function PageSourceCard({ item, theme, layout }: PluginTimelineItemProps<PageSourceData>) {
  const source = item.data.source, c = theme.colors;
  const details = source.details;
  const title = pageSourceTitle(source);
  const metadata = [source.role, source.lane, source.kind].join(' · ');
  return <View style={{
    width: '100%', maxWidth: 600, gap: 6, marginVertical: 3,
    padding: layout?.compact ? 10 : 12, borderRadius: 10, borderWidth: 1,
    borderColor: c.border, backgroundColor: c.surface1
  }}>
    <Text style={{ color: c.foreground, fontWeight: '600', fontSize: 13, lineHeight: 19 }}>
      {title}
    </Text>
    {source.sourceKind !== undefined && <Text selectable style={{
      color: c.foregroundMuted, fontSize: 11, lineHeight: 17
    }}>{`原类型：${source.sourceKind}`}</Text>}
    <Text selectable style={{ color: c.foreground, fontSize: 13, lineHeight: 20 }}>
      {source.text}
    </Text>
    {details?.input !== undefined && <View style={{ gap: 2 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 17 }}>网页可见输入（原文）</Text>
      <Text selectable style={{ color: c.foreground, fontSize: 12, lineHeight: 19 }}>{details.input}</Text>
    </View>}
    {details?.output !== undefined && <View style={{ gap: 2 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 17 }}>网页可见输出（原文）</Text>
      <Text selectable style={{ color: c.foreground, fontSize: 12, lineHeight: 19 }}>{details.output}</Text>
    </View>}
    {isMediaSource(source) && <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 17 }}>
      来源信息，预览/下载尚未确认
    </Text>}
    <Text selectable style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 17 }}>
      {`来源：${metadata}`}
    </Text>
    {source.nativeMessageId !== undefined && <Text selectable style={{
      color: c.foregroundMuted, fontSize: 11, lineHeight: 17
    }}>{`原生消息：${source.nativeMessageId}`}</Text>}
  </View>;
}
