import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9:._-]{1,200}$/);
export const imageCardSchema = z.object({
  sessionId:id,turnId:id,messageId:id,assetId:z.string().regex(/^file_[A-Za-z0-9_-]{8,100}$/),
  conversationId:z.string().regex(/^[A-Za-z0-9-]{8,100}$/),status:z.enum(['available','unavailable']),
  width:z.number().int().positive().max(30000).optional(),height:z.number().int().positive().max(30000).optional(),
  previewWidth:z.number().int().positive().max(1600).optional(),previewHeight:z.number().int().positive().max(1600).optional(),
  digest:z.string().regex(/^[a-f0-9]{64}$/).optional(),mimeType:z.literal('image/webp').optional(),bytes:z.number().int().positive().max(384000).optional(),
  error:z.enum(['not_loaded','not_rendered','oversized','tainted','capture_failed']).optional(),
}).refine(x=>x.status!=='available'||Boolean(x.digest&&x.previewWidth&&x.previewHeight&&x.bytes),'Missing image preview identity');
export type ImageCardData = z.output<typeof imageCardSchema>;
export const readImage = defineRpc({name:'bridge.image.read',
  input:z.object({sessionId:id,turnId:id,digest:z.string().regex(/^[a-f0-9]{64}$/),offset:z.number().int().min(0).max(512000).default(0)}),
  output:z.object({data:z.string().max(32768),nextOffset:z.number().int().nullable(),total:z.number().int().max(512000),mimeType:z.literal('image/webp')})});
