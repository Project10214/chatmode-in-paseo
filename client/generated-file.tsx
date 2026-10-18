import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useRpc, type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Icon, Modal } from '@getpaseo/plugin/client/react-native';
import { readArtifact, type ArtifactCardData, type ArtifactMetadata } from '../shared/artifacts.js';

// BEGIN STANDARD WEB ARTIFACT DOWNLOAD
// Capability-gated standard Web APIs only. No DOM library, host API, bridge URL,
// credential, Node module or network fetch. This block is transpiled verbatim by
// tests/artifact-browser.py; that test does NOT emulate a real Paseo client.
interface DownloadAnchor {
  href: string; download: string; rel: string;
  style: { display: string };
  click(): void; remove(): void;
}
interface DownloadBlob { readonly size: number; readonly type: string }
export interface ArtifactBrowserEnvironment {
  document?: { body?: { appendChild(node: DownloadAnchor): unknown }; createElement(tag: 'a'): DownloadAnchor };
  Blob?: new (parts: Uint8Array[], options: { type: string }) => DownloadBlob;
  URL?: { createObjectURL(blob: DownloadBlob): string; revokeObjectURL(url: string): void };
  crypto?: { subtle?: { digest(algorithm: string, bytes: Uint8Array): Promise<ArrayBuffer> } };
  navigator?: { userActivation?: { isActive: boolean } };
  frameElement?: { getAttribute(name: string): string|null }|null;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
}
export interface PreparedArtifactDownload {
  readonly name: string; readonly url: string;
  readonly environment: ArtifactBrowserEnvironment;
  disposed: boolean;
}
const artifactBrowserGlobal = () => globalThis as unknown as ArtifactBrowserEnvironment;
export function supportsArtifactBrowserDownload(_platform: string, environment = artifactBrowserGlobal()): boolean {
  // Keep the platform argument for callers, but never use platform, UA or frame
  // identity as a capability proxy. Unknown hosts may explicitly try download.
  try {
    const sandbox = environment.frameElement?.getAttribute('sandbox');
    if (sandbox !== undefined && sandbox !== null && !sandbox.toLowerCase().split(/\s+/).includes('allow-downloads')) return false;
  } catch { /* Uninspectable policy is unknown; the browser still enforces it. */ }
  try {
    if (typeof environment.navigator?.userActivation?.isActive !== 'boolean' ||
        !environment.document?.body || typeof environment.document.body.appendChild !== 'function' ||
        typeof environment.document.createElement !== 'function' || typeof environment.Blob !== 'function' ||
        typeof environment.URL?.createObjectURL !== 'function' || typeof environment.URL.revokeObjectURL !== 'function' ||
        typeof environment.crypto?.subtle?.digest !== 'function' || typeof environment.setTimeout !== 'function') return false;
    const anchor = environment.document.createElement('a');
    return 'download' in anchor && typeof anchor.click === 'function' && typeof anchor.remove === 'function';
  } catch { return false; }
}
function artifactReadError(code: string): never { throw Object.assign(new Error(code), { code }); }
export function decodeArtifactBase64(encoded: string, expectedBytes: number): Uint8Array {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 16 * 1024 * 1024 ||
      encoded.length !== 4 * Math.ceil(expectedBytes / 3) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) artifactReadError('ARTIFACT_DATA_INVALID');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bytes = new Uint8Array(expectedBytes);
  let bits = 0, count = 0, offset = 0;
  for (const character of encoded) {
    if (character === '=') break;
    bits = (bits << 6) | alphabet.indexOf(character); count += 6;
    if (count >= 8) {
      count -= 8; if (offset >= bytes.length) artifactReadError('ARTIFACT_SIZE_MISMATCH');
      bytes[offset++] = (bits >>> count) & 255; bits &= (1 << count) - 1;
    }
  }
  if (offset !== bytes.length || bits !== 0) artifactReadError('ARTIFACT_DATA_INVALID');
  return bytes;
}
interface ArtifactReadChunk { data: string; nextOffset: number|null; total: number; mimeType: string; digest: string }
export async function collectArtifactBase64(metadata: ArtifactMetadata, read: (offset: number) => Promise<ArtifactReadChunk>, current: () => boolean): Promise<string> {
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > 16 * 1024 * 1024) artifactReadError('ARTIFACT_SIZE_INVALID');
  const total = 4 * Math.ceil(metadata.bytes / 3), parts: string[] = []; let offset = 0;
  while (offset < total) {
    if (!current()) artifactReadError('ARTIFACT_READ_CANCELLED');
    const chunk = await read(offset);
    if (!current()) artifactReadError('ARTIFACT_READ_CANCELLED');
    if (chunk.digest !== metadata.digest || chunk.mimeType !== metadata.mimeType || chunk.total !== total ||
        chunk.data.length !== Math.min(32768,total-offset) || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data) ||
        (offset + chunk.data.length < total && chunk.data.includes('='))) artifactReadError('ARTIFACT_DATA_INVALID');
    parts.push(chunk.data); offset += chunk.data.length;
    if (chunk.nextOffset !== (offset < total ? offset : null)) artifactReadError('ARTIFACT_OFFSET_INVALID');
  }
  return parts.join('');
}
export async function prepareArtifactBrowserDownload(metadata: ArtifactMetadata, encoded: string, platform: string, environment = artifactBrowserGlobal()): Promise<PreparedArtifactDownload> {
  if (!supportsArtifactBrowserDownload(platform,environment)) artifactReadError('ARTIFACT_DOWNLOAD_UNSUPPORTED');
  // Snapshot identity before the asynchronous digest; never trust mutable labels.
  const { name, bytes: length, digest, mimeType } = metadata;
  if (!/^[a-f0-9]{64}$/.test(digest) || typeof name !== 'string' || name.length < 1 || name.length > 180 ||
      /[\\/:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name) || /^\.+$/.test(name) ||
      !['image/png','image/jpeg','image/webp','image/gif','application/pdf','application/zip','application/octet-stream','text/plain','text/csv','text/markdown','application/json'].includes(mimeType)) artifactReadError('ARTIFACT_METADATA_INVALID');
  const bytes = decodeArtifactBase64(encoded,length);
  const actual = [...new Uint8Array(await environment.crypto!.subtle!.digest('SHA-256',bytes))].map(n => n.toString(16).padStart(2,'0')).join('');
  if (actual !== digest) artifactReadError('ARTIFACT_HASH_MISMATCH');
  if (!supportsArtifactBrowserDownload(platform,environment)) artifactReadError('ARTIFACT_DOWNLOAD_UNSUPPORTED');
  const blob = new environment.Blob!([bytes],{type:mimeType});
  if (blob.size !== length || blob.type !== mimeType) artifactReadError('ARTIFACT_DATA_INVALID');
  const url = environment.URL!.createObjectURL(blob);
  if (!url.startsWith('blob:')) { environment.URL!.revokeObjectURL(url); artifactReadError('ARTIFACT_DOWNLOAD_UNSUPPORTED'); }
  return { name, url, environment, disposed:false };
}
export function disposeArtifactBrowserDownload(prepared: PreparedArtifactDownload|null): void {
  if (!prepared || prepared.disposed) return;
  prepared.disposed = true; prepared.environment.URL!.revokeObjectURL(prepared.url);
}
export function requestArtifactBrowserDownload(prepared: PreparedArtifactDownload): { status:'requested'|'unsupported'|'failed' } {
  const environment = prepared.environment;
  if (prepared.disposed || !prepared.url.startsWith('blob:') || !supportsArtifactBrowserDownload('web',environment) || !environment.navigator?.userActivation?.isActive) return { status:'unsupported' };
  let anchor: DownloadAnchor|undefined;
  try {
    anchor = environment.document!.createElement('a');
    anchor.href = prepared.url; anchor.download = prepared.name; anchor.rel = 'noopener noreferrer'; anchor.style.display = 'none';
    environment.document!.body!.appendChild(anchor);
    // Synchronous user-click path: no RPC, await, opener or network navigation.
    anchor.click();
    prepared.disposed = true;
    // Allow the browser to consume the blob even if this card unmounts now.
    environment.setTimeout!(() => environment.URL!.revokeObjectURL(prepared.url),30000);
    // Standard <a download> has no portable completion acknowledgement.
    return { status:'requested' };
  } catch { disposeArtifactBrowserDownload(prepared); return { status:'failed' }; }
  finally { anchor?.remove(); }
}
// END STANDARD WEB ARTIFACT DOWNLOAD

function decodeText(encoded: string, bytes: number) {
  let escaped = '';
  for (const byte of decodeArtifactBase64(encoded,bytes)) escaped += '%' + byte.toString(16).padStart(2,'0');
  return decodeURIComponent(escaped);
}

/** Register with artifactCardSchema as kind generated-file, version 1.
 * Public SDK audit: @getpaseo/plugin 0.12.0-beta.2 client/index.d.ts declares
 * openExternalUrl for HTTP(S) only, not saving bytes; no cross-platform save API.
 * https://paseo.sh/docs/plugins/reference.md#external-links-and-workspace-browsers
 * Optional download above uses standard capabilities, activation and observable
 * sandbox policy only, never host identity. Real Paseo/mobile/WebView behavior
 * remains unvalidated by isolated Chromium. Never report "download complete".
 */
export function GeneratedFile({ item, theme, layout }: PluginTimelineItemProps<ArtifactCardData>) {
  const artifact = item.data, c = theme.colors, read = useRpc(readArtifact);
  const resource = artifact.status === 'available' ? artifact.resource : null;
  const resourceLabel = artifact.provenance === 'native-original' ? '原文件' : artifact.provenance === 'visible-image-resource' ? '网页显示图片' : '预览图';
  const [content,setContent] = useState<string|null>(null), [busy,setBusy] = useState(false);
  const [error,setError] = useState(''), [expanded,setExpanded] = useState(false), [notice,setNotice] = useState('');
  const [download,setDownload] = useState<PreparedArtifactDownload|null>(null);
  const epoch = useRef(0), prepared = useRef<PreparedArtifactDownload|null>(null);
  const downloadable = supportsArtifactBrowserDownload(layout.platform);
  useEffect(() => {
    epoch.current++; setContent(null); setError(''); setBusy(false); setExpanded(false); setNotice(''); setDownload(null);
    disposeArtifactBrowserDownload(prepared.current); prepared.current = null;
    return () => { epoch.current++; disposeArtifactBrowserDownload(prepared.current); prepared.current = null; };
  }, [artifact.sessionId, artifact.sourceId, resource?.digest, resource?.mimeType, resource?.bytes, resource?.name, layout.platform]);
  const image = Boolean(resource?.mimeType.startsWith('image/'));
  const text = Boolean(resource && (resource.mimeType.startsWith('text/') || resource.mimeType === 'application/json'));
  const boundedImage = Boolean(resource?.width && resource.height && resource.width <= 30000 && resource.height <= 30000 && resource.width * resource.height <= 30000000);
  const previewable = Boolean(resource && ((image && boundedImage && resource.bytes <= 4 * 1024 * 1024) || (text && resource.bytes <= 1024 * 1024)));
  const load = (generation: number) => collectArtifactBase64(resource!, offset => read({sessionId:artifact.sessionId,sourceId:artifact.sourceId,digest:resource!.digest,offset}), () => epoch.current === generation);
  const preview = async () => {
    if (!resource || !previewable || busy) return;
    if (content !== null) { setExpanded(true); return; }
    const generation = epoch.current; setBusy(true); setError('');
    try {
      const encoded = await load(generation);
      if (generation !== epoch.current) return;
      setContent(image ? `data:${resource.mimeType};base64,${encoded}` : decodeText(encoded,resource.bytes)); setExpanded(true);
    } catch { if (generation === epoch.current) setError('读取失败，请重试。'); }
    finally { if (generation === epoch.current) setBusy(false); }
  };
  const prepare = async () => {
    if (!resource || !downloadable || busy) return;
    const generation = epoch.current; setBusy(true); setError(''); setNotice('');
    try {
      const encoded = await load(generation);
      if (generation !== epoch.current) return;
      const value = await prepareArtifactBrowserDownload(resource,encoded,layout.platform);
      if (generation !== epoch.current) { disposeArtifactBrowserDownload(value); return; }
      disposeArtifactBrowserDownload(prepared.current); prepared.current = value; setDownload(value);
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : null;
      if (generation === epoch.current) setError(code === 'ARTIFACT_DOWNLOAD_UNSUPPORTED' ? '当前环境不支持文件下载。' :
        code === 'ARTIFACT_HASH_MISMATCH' ? '资源校验失败，未发起下载。' : '下载准备失败，请重试。');
    } finally { if (generation === epoch.current) setBusy(false); }
  };
  const save = () => {
    if (!download) return;
    const result = requestArtifactBrowserDownload(download);
    if (result.status === 'requested') { prepared.current = null; setDownload(null); setNotice('已请求浏览器下载，保存结果由客户端决定。'); }
    else {
      disposeArtifactBrowserDownload(download); prepared.current = null; setDownload(null);
      setError(result.status === 'unsupported' ? '当前环境无法发起下载。' : '无法发起下载，请重试。');
    }
  };
  const reasons: Record<string,string> = {
    native_source_unproven:'无法确认可读取的资源。', capture_busy:'资源读取繁忙，尚未缓存。',
    resource_unavailable:'资源暂不可读取。', mime_unsupported:'暂不支持此资源格式。',
    oversized:'资源超过大小限制，尚未缓存。', capture_timeout:'读取超时，尚未缓存。',
    not_loaded:'图片尚未加载。', tainted:'浏览器禁止读取此图片的像素。', preview_failed:'预览图读取失败。',
  };
  return <View style={{padding:16,gap:12,borderWidth:1,borderColor:c.border,borderRadius:12,backgroundColor:c.surface1,marginVertical:8}}>
    <View style={{flexDirection:'row',gap:8,alignItems:'center'}}><Icon name={artifact.kind === 'image' ? 'Image' : 'File'} size={18} color={c.foreground}/><Text style={{color:c.foreground,fontWeight:'600',flex:1}}>{resource?.name ?? (artifact.kind === 'image' ? '图片' : '文件')}</Text></View>
    {!!artifact.sourceText && <Text selectable style={{color:c.foreground,lineHeight:20}}>{artifact.sourceText}</Text>}
    <Text style={{color:c.foregroundMuted}}>{resource ? `${resourceLabel}已缓存 · ${resource.bytes} 字节` : reasons[artifact.status === 'unsupported' ? artifact.reason : 'resource_unavailable']}</Text>
    {previewable && <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void preview(); }} style={{minHeight:44,justifyContent:'center'}}><Text style={{color:c.foreground}}>{busy ? '正在读取…' : image ? `查看${resourceLabel}` : '预览文件'}</Text></Pressable>}
    {resource && !previewable && <Text style={{color:c.foregroundMuted}}>此资源暂不支持内嵌预览。</Text>}
    {resource && (downloadable ? <Pressable accessibilityRole="button" disabled={busy} onPress={download ? save : () => { void prepare(); }} style={{minHeight:44,justifyContent:'center'}}><Text style={{color:c.foreground}}>{busy ? '正在读取…' : download ? `下载${resourceLabel}` : '准备下载'}</Text></Pressable> : <Text style={{color:c.foregroundMuted}}>当前环境不支持文件下载。</Text>)}
    {!!notice && <Text accessibilityLiveRegion="polite" style={{color:c.foregroundMuted}}>{notice}</Text>}
    {!!error && <Text accessibilityRole="alert" style={{color:c.statusWarning}}>{error}</Text>}
    <Modal title={resource?.name ?? '资源预览'} open={expanded} onOpenChange={setExpanded}><Modal.Content>
      {content !== null && (image ? <Image source={{uri:content}} resizeMode="contain" style={{width:'100%',height:420}} onError={() => setError('此图片无法显示。')}/> : <ScrollView style={{maxHeight:420}}><Text selectable style={{color:c.foreground}}>{content}</Text></ScrollView>)}
    </Modal.Content></Modal>
  </View>;
}
