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