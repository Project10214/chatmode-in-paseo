// ChatGPT's own tool approval card ("Allow ChatGPT to use …?") mirrored as a
// Paseo permission request. Only the user's explicit choice in Paseo answers
// it, and only the same card on the same page. "Always allow" is not offered.
import { invariant } from './protocol.mjs';

const KEY = /^[a-z0-9-]{8,64}$/;
const APP = /^[\p{L}\p{N}_.: ·()-]{1,80}$/u;
const TOOL = /^[A-Za-z0-9_.:-]{1,80}$/;
export const APPROVAL_CHOICES = Object.freeze(['allow-once', 'deny', 'allow-auto']);

/** Strict shape of the page's report; anything else is an error, never a request. */
export function approvalEvent(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'APPROVAL_INVALID');
  invariant(['open', 'closed'].includes(value.state) && typeof value.key === 'string' && KEY.test(value.key), 'APPROVAL_INVALID');
  if (value.state === 'closed') {
    invariant(Object.keys(value).every(k => ['state', 'key'].includes(k)), 'APPROVAL_INVALID');
    return { state: 'closed', key: value.key };
  }
  invariant(Object.keys(value).every(k => ['state', 'key', 'app', 'tool', 'input', 'clickable', 'allowLabel', 'denyLabel', 'labels', 'text', 'autoEligible', 'autoTier'].includes(k)), 'APPROVAL_INVALID');
  // Button captions as the page shows them (UI text only); shown on the
  // Paseo actions so the user sees exactly which page button is clicked.
  const caption = v => typeof v === 'string' && v.length > 0 && v.length <= 40 && !/[\n\u0000]/.test(v);
  const clickable = value.clickable === undefined ? true : value.clickable;
  invariant(typeof clickable === 'boolean', 'APPROVAL_INVALID');
  invariant(clickable ? (value.allowLabel === undefined || caption(value.allowLabel)) && (value.denyLabel === undefined || caption(value.denyLabel))
    : value.allowLabel === undefined && value.denyLabel === undefined, 'APPROVAL_INVALID');
  invariant(value.labels === undefined || (Array.isArray(value.labels) && value.labels.length <= 16 && value.labels.every(caption)), 'APPROVAL_INVALID');
  invariant(value.autoEligible === undefined || typeof value.autoEligible === 'boolean', 'APPROVAL_INVALID');
  invariant(value.autoTier === undefined || ['persistent','once','confirm',null].includes(value.autoTier), 'APPROVAL_INVALID');
  invariant(value.text === undefined || (typeof value.text === 'string' && value.text.isWellFormed() && !value.text.includes('\u0000')), 'APPROVAL_INVALID');
  invariant((typeof value.app === 'string' && APP.test(value.app)) || (value.app === null && value.text?.trim()), 'APPROVAL_INVALID');
  invariant(value.tool === null || (typeof value.tool === 'string' && TOOL.test(value.tool)), 'APPROVAL_INVALID');
  invariant(value.input === null || (typeof value.input === 'string' && value.input.length <= 4096 &&
    value.input.isWellFormed() && !value.input.includes('\u0000')), 'APPROVAL_INVALID');
  return { state: 'open', key: value.key, app: value.app, tool: value.tool, input: value.input, clickable,
    ...(value.allowLabel ? { allowLabel: value.allowLabel } : {}), ...(value.denyLabel ? { denyLabel: value.denyLabel } : {}),
    autoEligible: value.autoEligible === true,
    ...(value.autoTier ? { autoTier: value.autoTier } : {}),
    labels: value.labels ?? [], ...(value.text !== undefined ? {text:value.text} : {}) };
}

/** The Paseo request, built only from what the card showed (its "See details" JSON). */
export function permissionRequest(approval) {
  let args = null;
  try {
    const parsed = JSON.parse(approval.input ?? '');
    if (parsed?.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)) args = parsed.args;
  } catch { /* The page may truncate the payload; show it as text instead. */ }
  const app = approval.app ?? '网页授权请求';
  const name = approval.tool ? `${app} · ${approval.tool}` : app;
  const command = typeof args?.command === 'string' && args.command.length <= 4096 ? args.command : null;
  const detail = command
    ? { type: 'shell', command, ...(typeof args.cwd === 'string' && args.cwd.length <= 1024 ? { cwd: args.cwd } : {}) }
    : { type: 'plain_text', label: name, text: approval.text ?? approval.input ?? '网页未提供调用详情。' };
  const clickable = approval.clickable !== false;
  const page = label => label ? `（${label}）` : '';
  return {
    id: approval.key, name, kind: 'tool',
    title: approval.app ? `允许 ChatGPT 使用 ${approval.app}？` : '网页授权请求',
    description: clickable
      ? '你的选择将同步到此网页授权框，不会自动批准。'
      : '无法识别网页按钮，请到 ChatGPT 网页处理。',
    ...(args ? { input: args } : {}),
    detail,
    actions: [
      { id: 'allow-once', label: '允许' + page(approval.allowLabel), behavior: 'allow', variant: 'primary' },
      { id: 'deny', label: '拒绝' + page(approval.denyLabel), behavior: 'deny', variant: 'danger' }
    ]
  };
}

/** Paseo's answer → the card button. Anything but allow-once/deny is refused. */
export function approvalChoice(response) {
  invariant(response && typeof response === 'object', 'APPROVAL_INVALID');
  if (response.behavior === 'deny') return 'deny';
  invariant(response.behavior === 'allow' && [undefined, 'allow-once'].includes(response.selectedActionId) &&
    !response.updatedPermissions?.length && response.updatedInput === undefined, 'APPROVAL_UNSUPPORTED');
  return 'allow-once';
}
