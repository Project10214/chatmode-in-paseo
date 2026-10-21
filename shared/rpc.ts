import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { observationHealthSchema } from './page-state.js';
const choice = z.object({ id: z.string(), label: z.string() });
const selection = z.object({ model: z.string().optional(), thinkingOption: z.string().nullable().optional(), appIds: z.array(z.string()).max(32) });
const catalog = z.object({ models: z.array(choice.extend({ thinkingOptions: z.array(choice), defaultThinkingOptionId: z.string().nullable().optional() })),
  apps: z.array(choice), defaultModel: z.string(), observedAt: z.number() });
export const snapshot = defineRpc({ name: 'bridge.snapshot', input: z.object({ refresh: z.boolean().default(false) }),
  output: z.object({ checkedAt: z.number(), refreshError: z.string().nullable(),
    refreshing: z.boolean(), refreshStartedAt: z.number().nullable(),
    lastCatalogAttempt: z.object({ phase: z.string(), at: z.number(), error: z.string().nullable(), diagnostic: z.object({ stage: z.string(), editorCount: z.number().optional(), panelCount: z.number().optional(), rowCount: z.number().optional(), nativeProbeAttempted: z.boolean().optional(), hintRequestSeen: z.boolean().optional(), observerReplySeen: z.boolean().optional() }).nullable() }).nullable(),
    capacity: z.object({ limit: z.number().int().min(1).max(8), active: z.number().int().nonnegative(), waiting: z.number().int().nonnegative() }).optional(),
    status: z.object({ address: z.string(), connected: z.boolean(), paired: z.boolean(), protocol: z.number(), lastSeenAt: z.number().optional() }),
    // The build the RUNNING extension reported. The installed builds are
    // inlined into the client bundle, which is compiled from the same package.
    extensionVersion: z.string().nullable(),
    observation: observationHealthSchema.optional(),
    catalog: catalog.nullable(), defaults: selection, autoAllow: z.boolean(), blocked: z.array(z.object({ id: z.string(), error: z.string() })) }) });
export const saveDefaults = defineRpc({ name: 'bridge.defaults', input: selection, output: selection });
export const pair = defineRpc({ name: 'bridge.pair', input: z.object({}), output: z.object({ address: z.string(), code: z.string(), expiresAt: z.number() }) });

export const abandon = defineRpc({ name: 'bridge.abandon', input: z.object({ sessionId: z.string(), confirmed: z.literal(true) }), output: z.object({ abandoned: z.literal(true) }) });

export const saveConcurrency = defineRpc({ name: 'bridge.concurrency', input: z.object({ maxConcurrent: z.number().int().min(1).max(8) }), output: z.object({ maxConcurrent: z.number().int().min(1).max(8) }) });

export const saveAutoAllow = defineRpc({ name: 'bridge.auto-allow', input: z.object({ enabled: z.boolean() }), output: z.object({ enabled: z.boolean() }) });
