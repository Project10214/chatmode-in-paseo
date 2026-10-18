import {z} from 'zod';
// Ordered transport evidence only. Not page content, an ACK, or a task result.
export const sourceCheckpointSchema=z.object({
  sessionId:z.string().min(1),bindingGeneration:z.string().min(1),hostEpoch:z.string().min(1),
  sourceId:z.string().min(1),phase:z.enum(['anchor','after-body']),
  batch:z.number().int().nonnegative(),through:z.number().int().nonnegative(),
  attemptId:z.string().nullable(),probeId:z.string().min(1)
});
