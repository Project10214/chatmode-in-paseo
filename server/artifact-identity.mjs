// Shared identity fence for capture and later source projection.
// Captions/order/visibility are not byte revisions. No source text is hashed.
import {createHash} from 'node:crypto';
export function artifactSourceIdentity(session,source) {
  const media=source.media ?? {};
  return {sessionId:session.id,sourceId:source.id,conversationId:session.conversationId,
    messageId:media.messageId ?? null,assetId:media.assetId ?? null,kind:source.kind,provenance:media.provenance};
}
export function artifactSourceRevision(session,source) {
  const media=source.media ?? {};
  return createHash('sha256').update(JSON.stringify([artifactSourceIdentity(session,source),
    media.src ?? null,media.url ?? null,media.href ?? null,media.resourceUrl ?? null,
    media.uriScheme ?? null,media.resourceRevision ?? null])).digest('hex');
}
