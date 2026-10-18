import type { PluginClientContext } from '@getpaseo/plugin/client';
import { SettingsScreen } from './client/settings.js';
import { GeneratedImage } from './client/generated-image.js';
import { imageCardSchema } from './shared/images.js';
import { GeneratedFile } from './client/generated-file.js';
import { artifactCardSchema } from './shared/artifacts.js';
import { PageStateCard } from './client/page-state.js';
import { pageStateSchema } from './shared/page-state.js';
import { PageSourceCard } from './client/page-source.js';
import { pageSourceSchema } from './shared/page-source.js';
import { SourceCheckpoint } from './client/source-checkpoint.js';
import { sourceCheckpointSchema } from './shared/source-checkpoint.js';
import { NativeActivity, NativeActivityV2 } from './client/native-activity.js';
import { activityCardSchema, activityCardSchemaV2 } from './shared/activity.js';
export default function contribute(client: PluginClientContext) {
  const settings = client.addSettingsScreen({ id: 'chatmode', title: 'Chatmode 配置', icon: 'MessagesSquare', Component: SettingsScreen });
  const images = client.addTimelineRenderer({ kind: 'generated-image', version: 1, schema: imageCardSchema, Component: GeneratedImage });
  const artifacts = client.addTimelineRenderer({kind:'generated-file',version:1,schema:artifactCardSchema,Component:GeneratedFile});
  const pageState = client.addTimelineRenderer({kind:'page-state',version:1,schema:pageStateSchema,Component:PageStateCard});
  const sources = client.addTimelineRenderer({kind:'page-source',version:1,schema:pageSourceSchema,Component:PageSourceCard});
  const checkpoints = client.addTimelineRenderer({kind:'source-checkpoint',version:1,schema:sourceCheckpointSchema,Component:SourceCheckpoint});
  // Read-only legacy renderers keep previously stored history visible.
  const activity = client.addTimelineRenderer({ kind: 'native-activity', version: 1, schema: activityCardSchema, Component: NativeActivity });
  const activityV2 = client.addTimelineRenderer({ kind: 'native-activity', version: 2, schema: activityCardSchemaV2, Component: NativeActivityV2 });
  return () => { settings(); images(); artifacts(); pageState(); sources(); checkpoints(); activity(); activityV2(); };
}
