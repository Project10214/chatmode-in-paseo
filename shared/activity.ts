import { z } from 'zod';
export const activityCardSchema=z.object({
  turnId:z.string().min(1).max(120),
  phase:z.enum(['working','thinking','tool','search','exec','image','approval','finalizing','completed','canceled','failed']),
  nativeStatus:z.enum(['complete','in_progress']).nullable(),
  steps:z.array(z.object({
    kind:z.enum(['tool','search','exec','image']),
    label:z.string().min(1).max(160),
    done:z.boolean()
  }).strict()).max(12)
}).strict();
export type ActivityCardData=z.infer<typeof activityCardSchema>;
// v2 keeps the v1 headline and adds independent facts. Unknown is null; a
// confirmed absence is an explicit value (e.g. stop {visible:false}).
const code=z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
export const pageStatusSchema=z.object({
  observedAt:z.number().int().positive(),
  readable:z.boolean(),
  nativeStatus:z.enum(['in_progress','complete']).nullable(),
  controls:z.object({
    stop:z.object({visible:z.boolean(),enabled:z.boolean()}).strict().nullable(),
    approval:z.boolean().nullable()
  }).strict(),
  notices:z.array(z.object({
    scope:z.enum(['turn','page','sidebar']),
    text:z.string().min(1).max(8192),
    buttons:z.array(z.object({label:z.string().min(1).max(160),enabled:z.boolean()}).strict()).max(8),
    redacted:z.boolean(),
    clipped:z.boolean()
  }).strict()).max(16),
  issues:z.array(z.object({messageId:z.string().min(1).max(200).nullable(),code}).strict()).max(64),
  truncated:z.boolean()
}).strict();
export const activityCardSchemaV2=z.object({
  turnId:z.string().min(1).max(120),
  phase:z.enum(['working','thinking','tool','search','exec','image','approval','finalizing','completed','canceled','failed','observing']),
  nativeStatus:z.enum(['complete','in_progress']).nullable(),
  steps:activityCardSchema.shape.steps,
  native:z.object({
    phase:z.enum(['working','thinking','tool','search','exec','image','approval','finalizing']).nullable(),
    status:z.enum(['complete','in_progress']).nullable(),
    observedAt:z.number().int().positive().nullable()
  }).strict(),
  sync:z.object({
    state:z.enum(['ok','blocked','partial']),
    issues:z.array(z.object({code,messageId:z.string().min(1).max(200).nullable(),count:z.number().int().min(1),
      at:z.number().int().positive(),resolvedAt:z.number().int().positive().nullable(),blocking:z.boolean()}).strict()).max(8)
  }).strict(),
  outcome:z.enum(['completed','failed','canceled']).nullable(),
  error:z.string().max(160).nullable(),
  recoveries:z.number().int().min(0).max(8),
  page:pageStatusSchema.nullable()
}).strict();
export type ActivityCardDataV2=z.infer<typeof activityCardSchemaV2>;
export type PageStatusData=z.infer<typeof pageStatusSchema>;
