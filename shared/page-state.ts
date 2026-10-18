import { z } from 'zod';

const controlSchema = z.object({ visible: z.boolean(), enabled: z.boolean() }).strict();
export const pageStateSchema = z.object({
  state: z.enum(['running', 'standby', 'abnormal']),
  controls: z.object({ stop: controlSchema, send: controlSchema, voice: controlSchema }).strict(),
  observedAt: z.number().int().positive().max(8640000000000000),
  readable: z.boolean(),
  // Keep the page's issue metadata, not just the fields understood by this UI.
  issues: z.array(z.object({ code: z.string().min(1) }).catchall(z.json()))
}).strict();
export type PageStateData = z.infer<typeof pageStateSchema>;
export type PageState = PageStateData['state'];

/** enabled, content delivery, approvals and run outcomes never select state.
 * An unreadable sample cannot confirm that a Stop button is absent.
 */
export function pageStateFromControls(page: Pick<PageStateData, 'readable' | 'controls'>): PageState {
  if (page.controls.stop.visible) return 'running';
  if (!page.readable) return 'abnormal';
  return page.controls.send.visible || page.controls.voice.visible ? 'standby' : 'abnormal';
}
export const pageStateLabel: Record<PageState, string> = {
  running: '运行中', standby: '待命', abnormal: '异常／状态无法确认'
};
const controlIssues = new Set([
  'CONTROLS_READ_FAILED', 'CONTROLS_METADATA_TOO_LARGE', 'PAGE_STATUS_INVALID',
  'OBSERVATION_UNAVAILABLE', 'PAGE_OBSERVER_UNAVAILABLE'
]);
export const isSourceIssue = (issue: { code: string }) => !controlIssues.has(issue.code);

const count = z.number().int().nonnegative();
export const observationHealthSchema = z.object({
  bound: count, running: count, standby: count, abnormal: count, sourceIssues: count,
  lastObservedAt: z.number().int().positive().max(8640000000000000).nullable()
}).strict().refine(value => value.running + value.standby + value.abnormal === value.bound,
  'Every bound conversation has exactly one page-state bucket.');
export type ObservationHealth = z.infer<typeof observationHealthSchema>;
