import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const artifactMaxBytes = 16 * 1024 * 1024;
export const artifactMaxEncoded = 4 * Math.ceil(artifactMaxBytes / 3);
export const artifactProvenanceSchema = z.enum(['native-original','visible-image-resource','rendered-preview']);
export const artifactMimeSchema = z.enum(['image/png','image/jpeg','image/webp','image/gif','application/pdf','application/zip','application/octet-stream','text/plain','text/csv','text/markdown','application/json']);
export const artifactMetadataSchema = z.object({
  digest:z.string().regex(/^[a-f0-9]{64}$/),
  bytes:z.number().int().positive().max(artifactMaxBytes),
  mimeType:artifactMimeSchema,
  width:z.number().int().positive().max(0xffffffff).optional(),
  height:z.number().int().positive().max(0xffffffff).optional(),
  name:z.string().min(1).max(180).refine(value => !/[\\/:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value) && !/^\.+$/.test(value)),
});
export type ArtifactMetadata = z.output<typeof artifactMetadataSchema>;
const identity = {
  sessionId:z.string().regex(/^[A-Za-z0-9:._-]{1,200}$/),
  sourceId:z.string().min(1).max(8192),
  sourceText:z.string(),
  conversationId:z.string().regex(/^[A-Za-z0-9-]{8,100}$/),
  messageId:z.string().regex(/^[A-Za-z0-9:._-]{1,200}$/).nullable(),
  assetId:z.string().regex(/^file_[A-Za-z0-9_-]{8,100}$/).nullable(),
  kind:z.enum(['image','file']),
  provenance:artifactProvenanceSchema,
};
export const artifactCardSchema = z.discriminatedUnion('status', [
  z.object({ ...identity, status:z.literal('available'), resource:artifactMetadataSchema }),
  z.object({ ...identity, status:z.literal('unsupported'), reason:z.enum(['native_source_unproven','capture_busy','resource_unavailable','mime_unsupported','oversized','capture_timeout','not_loaded','tainted','preview_failed']) }),
]).refine(value => value.provenance === 'native-original' ? value.messageId !== null && value.assetId !== null : value.kind === 'image', 'Invalid resource provenance');
export type ArtifactCardData = z.output<typeof artifactCardSchema>;
// Integration must resolve sessionId + sourceId + digest against persisted
// authorized history BEFORE invoking ArtifactStore.read(metadata, {offset}).
export const readArtifact = defineRpc({
  name:'bridge.artifact.read',
  input:z.object({ sessionId:identity.sessionId, sourceId:identity.sourceId, digest:artifactMetadataSchema.shape.digest,
    offset:z.number().int().min(0).max(artifactMaxEncoded).refine(value => value % 4 === 0).default(0) }),
  output:z.object({ data:z.string().min(1).max(32768), nextOffset:z.number().int().min(0).max(artifactMaxEncoded).nullable(),
    total:z.number().int().positive().max(artifactMaxEncoded), mimeType:artifactMimeSchema, digest:artifactMetadataSchema.shape.digest }),
});
