// Project already-public, individually identified page items, not whole Work
// containers. Collection, approval requests, ordering and host turns belong to
// the caller; none of their lifecycle state is an input to this projection.
import { invariant, nativeMessageId } from './protocol.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.trim().length > 0;
const TOOL_STATUSES = new Set(['running', 'completed', 'failed']);
const LEVELS = new Set(['info', 'warning', 'error']);
const invalid = condition => invariant(condition, 'PAGE_ITEM_INVALID');

function validate(item) {
  invalid(record(item));
  invalid(identity(item.id));
  invalid(item.userMessageId === null || identity(item.userMessageId));
  invalid(['user', 'assistant', 'page'].includes(item.role));
  invalid(['process', 'output'].includes(item.lane));
  // Future kinds are intentionally accepted as page-source cards.
  invalid(identity(item.kind));
  // No coercion, default empty string, truncation or content-based classification.
  invalid(typeof item.text === 'string');
  invalid(['text', 'markdown'].includes(item.format));
  invalid(Array.isArray(item.order) && Array.from(item.order).every(Number.isFinite));
  invalid(item.nativeMessageId === undefined || identity(item.nativeMessageId));
  // DOM-local source IDs remain valid, but cannot masquerade as native IDs.
  if (item.nativeMessageId !== undefined) nativeMessageId(item.nativeMessageId);
  for (const key of ['callId', 'name', 'status'])
    invalid(item[key] === undefined || typeof item[key] === 'string');
  if (item.details !== undefined) {
    invalid(record(item.details));
    invalid(Object.keys(item.details).every(key => ['input', 'output'].includes(key)));
    for (const key of ['input', 'output'])
      invalid(item.details[key] === undefined || typeof item.details[key] === 'string');
  }
  if (item.media !== undefined) {
    invalid(record(item.media));
    try { structuredClone(item.media); } catch { invalid(false); }
  }
}

function sourceIdentityOf(item) {
  const source = {
    id: item.id, userMessageId: item.userMessageId,
    role: item.role, lane: item.lane, kind: item.kind,
    format: item.format, order: [...item.order],
    ...(item.sourceKind !== undefined ? { sourceKind: item.sourceKind } : {}),
  };
  for (const key of ['nativeMessageId', 'callId', 'name', 'status'])
    if (item[key] !== undefined) source[key] = item[key];
  return source;
}

function sourceOf(item) {
  const source = { ...sourceIdentityOf(item), text: item.text };
  if (item.details !== undefined) {
    source.details = {};
    for (const key of ['input', 'output'])
      if (item.details[key] !== undefined) source.details[key] = item.details[key];
  }
  if (item.media !== undefined) source.media = structuredClone(item.media);
  return source;
}

function visibleContent(item) {
  const parts = [item.text];
  if (item.details?.input !== undefined)
    parts.push('网页可见输入（原文）：\n' + item.details.input);
  if (item.details?.output !== undefined)
    parts.push('网页可见输出（原文）：\n' + item.details.output);
  if (item.media !== undefined)
    parts.push('media（来源数据）：\n' + JSON.stringify(item.media));
  return parts.join('\n\n');
}

const isMedia = item => item.kind === 'image' || item.kind === 'file' || item.media !== undefined;

/**
 * Pure projection of one normalized public source item. Approvals use the
 * separate permission-request channel, not this source-item protocol.
 *
 * Native host kinds keep their native identity: user, formal assistant output,
 * public reasoning and confirmed tool calls. Everything else is a stable
 * page-source v1 plugin card whose data contains a whitelist copy of the source
 * item. That includes ordinary process commentary, page notices/errors,
 * unknown or unconfirmed tools and media descriptions. A media source uses an
 * artifact:<sourceId> id so a later generated-file card can replace it in place.
 *
 * The page-source card is a correction for host behavior that strips ordinary
 * notification ids and repeats partial updates; it is not a replacement for
 * native formal assistant responses and never contains ledger history/ACK data.
 *
 * Throws PAGE_ITEM_INVALID for malformed source fields. The caller must catch
 * per item so one invalid item cannot discard other items in the batch.
 *
 * @param {object} item
 * @param {{notificationLevel?: 'info'|'warning'|'error'}} [options]
 * @returns {import('@getpaseo/plugin/server/provider').ProviderTimelineItem}
 */
export function projectPageItem(item, options = {}) {
  validate(item);
  invalid(record(options));
  // Retained for callers that still pass a presentation hint; page-source
  // cards have no notification level and this option never selects behavior.
  invalid(options.notificationLevel === undefined || LEVELS.has(options.notificationLevel));
  const pageId = `page:${item.id}`;
  const messageId = item.nativeMessageId === undefined ? {} : { messageId: item.nativeMessageId };

  if (item.kind === 'message' && item.role === 'user')
    return { type: 'user_message', id: pageId, text: item.text, ...messageId };
  if (item.kind === 'message' && item.role === 'assistant' && item.lane === 'output')
    return { type: 'assistant_message', id: pageId, text: item.text, ...messageId };
  if (item.role === 'assistant' && item.lane === 'process' && item.kind === 'reasoning')
    return { type: 'reasoning', id: pageId, text: item.text };
  if (item.role !== 'user' && item.lane === 'process' && item.kind === 'tool_call' &&
      identity(item.callId) && identity(item.name) && TOOL_STATUSES.has(item.status)) {
    return {
      type: 'tool_call', id: pageId, callId: item.callId, name: item.name,
      status: item.status,
      detail: { type: 'plain_text', label: item.name, text: visibleContent(item) },
      // A visible failed caption is not a fabricated diagnostic/tool result.
      error: item.status === 'failed' ? { message: item.text } : null,
      metadata: { source: sourceIdentityOf(item) },
    };
  }

  return {
    type: 'plugin', id: isMedia(item) ? `artifact:${item.id}` : pageId,
    pluginId: 'chatmode-in-paseo', kind: 'page-source', version: 1,
    data: { source: sourceOf(item) },
  };
}
