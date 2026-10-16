import type { PluginClientContext } from '@getpaseo/plugin/client';
import { SettingsScreen } from './client/settings.js';
import { GeneratedImage } from './client/generated-image.js';
import { imageCardSchema } from './shared/images.js';
import { NativeActivity } from './client/native-activity.js';
import { activityCardSchema } from './shared/activity.js';
export default function contribute(client: PluginClientContext) {
  const settings = client.addSettingsScreen({ id: 'chatmode', title: 'Chatmode 配置', icon: 'MessagesSquare', Component: SettingsScreen });
  const images = client.addTimelineRenderer({ kind: 'generated-image', version: 1, schema: imageCardSchema, Component: GeneratedImage });
  const activity = client.addTimelineRenderer({ kind: 'native-activity', version: 1, schema: activityCardSchema, Component: NativeActivity });
  return () => { settings(); images(); activity(); };
}
