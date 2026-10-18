import { z } from 'zod';

/** Stable plugin kinds. The source item itself remains the only content. */
export const pageSourcePluginId = 'chatmode-in-paseo';
export const pageSourceKind = 'page-source';
export const pageSourceVersion = 1;

export const pageSourceItemSchema = z.object({
  // A source id is opaque and may itself be a JSON-shaped string. It is never
  // parsed into a host turn, native message or Paseo run identity.
  id: z.string().min(1).max(8192),
  userMessageId: z.string().min(1).max(8192).nullable(),
  role: z.enum(['user', 'assistant', 'page']),
  lane: z.enum(['process', 'output']),
  kind: z.string().min(1),
  text: z.string(),
  format: z.enum(['text', 'markdown']),
  order: z.array(z.number()),
  // Never filled from a display fallback. Only a source that actually supplied
  // a native id may carry one.
  nativeMessageId: z.string().min(1).max(8192).optional(),
  callId: z.string().optional(),
  name: z.string().optional(),
  // Raw source status is retained even when a fallback tool card could not
  // prove one of the protocol statuses.
  status: z.string().optional(),
  details: z.object({
    input: z.string().optional(),
    output: z.string().optional()
  }).strict().optional(),
  media: z.record(z.string(), z.json()).optional(),
  // Original unknown page kind retained for source labelling.
  sourceKind: z.string().optional()
}).strict();

/** Data stored in a page-source v1 plugin item. No ledger history or ACK state. */
export const pageSourceSchema = z.object({ source: pageSourceItemSchema }).strict();
export type PageSourceItem = z.infer<typeof pageSourceItemSchema>;
export type PageSourceData = z.infer<typeof pageSourceSchema>;
export type PageSourceTitle = '工作过程' | '网页内容' | '网页提示';

export function isMediaSource(source: PageSourceItem): boolean {
  return source.kind === 'image' || source.kind === 'file' || source.media !== undefined;
}

export function pageSourceTitle(source: PageSourceItem): PageSourceTitle {
  const pageFacing = source.role === 'page' || source.kind === 'notice';
  if (!pageFacing) return '工作过程';
  return source.kind === 'notice' || source.status === 'failed' ? '网页提示' : '网页内容';
}
