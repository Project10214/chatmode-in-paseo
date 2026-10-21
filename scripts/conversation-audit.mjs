// Read-only sweep over every session in the local runtime state.
//
// Answers "is anything wrong with any of my conversations" without ever
// printing a conversation: only lengths, counts, error codes and hashes.
//
// Checks per session:
//   truncated   the delivered assistant body is shorter than the ledger text
//   lag         the history row and the ledger text disagree in length
//   conflict    a source identity conflict was reported
//   drift       the preceding-user reference moved
//   churn       a rewrite that changed nothing (position churn)
//   duplicate   the same body delivered more than once, or duplicated in the
//                ledger under two source ids
//   pending     a native delivery that never settled
//   stuck       a turn with no outcome and nothing in flight
//   failed      commands that failed, grouped by error code
//   collision   two sessions claiming the same tab
//
// Usage: node scripts/conversation-audit.mjs [--verbose] [--session <id>]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;
// Only anomalies seen after this moment are reported. Older residue is real
// but it is history, and mixing it with current problems hides the current
// ones.
const since = args.includes('--since') ? Date.parse(args[args.indexOf('--since') + 1]) : 0;
const sinceLabel = since ? new Date(since).toLocaleString() : '全部时间';
const directory = process.env.CIP_STATE_DIR || path.join(os.homedir(), '.chatmode-in-paseo');
const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));

const assistant = session => (session.history || []).filter(row => row.type === 'assistant_message');
const users = session => (session.history || []).filter(row => row.type === 'user_message');
const outputs = session => (session.sources || []).filter(source =>
  source.role === 'assistant' && source.kind === 'message' && source.lane === 'output');
const pageIssues = session => {
  for (const row of session.history || []) if (row.kind === 'page-state') return (row.data || {}).issues || [];
  return [];
};
const issueCodes = session => [...new Set(pageIssues(session).map(issue => issue.code))];
/** A rewrite that changed nothing. Sources whose other content can legitimately
 * change are excluded: a prose refinement or a tool status is not churn. */
const churn = session => {
  let count = 0, last = 0;
  for (const source of session.sources || []) {
    if (source.prose || source.media || source.details || source.status) continue;
    for (const rewrite of source.rewrites || []) {
      const explained = rewrite.reference !== undefined && rewrite.reference !== source.userMessageId;
      if (rewrite.text === source.text && !explained) { count++; last = Math.max(last, rewrite.at || 0); }
    }
  }
  return { count, last };
};
/**
 * The same text kept under two source ids: the DOM-local identity problem.
 * Page notices repeat under a shifted DOM path all the time and are noise; a
 * repeated USER or ASSISTANT body is the symptom that matters.
 */
const duplicatedLedgerRows = (session, kinds) => {
  const byText = new Map();
  for (const source of session.sources || []) {
    if (kinds && !kinds.includes(source.kind)) continue;
    const text = source.text || '';
    if (!text) continue;
    byText.set(text, (byText.get(text) || 0) + 1);
  }
  return [...byText.values()].filter(count => count > 1).length;
};
/** More than one forwarded attempt for the same source means the body could
 * reach the host twice. */
const duplicateDeliveries = session => {
  const durable = (session.nativeDelivery || {}).durable;
  if (!durable) return 0;
  const bySource = new Map();
  for (const attempt of durable.attempts || []) {
    if (!['sent', 'confirmed', 'uncertain'].includes(attempt.status)) continue;
    bySource.set(attempt.sourceId, (bySource.get(attempt.sourceId) || 0) + 1);
  }
  return [...bySource.values()].filter(count => count > 1).length;
};
const pendingDeliveries = session => {
  const durable = (session.nativeDelivery || {}).durable;
  if (!durable) return 0;
  return (durable.deliveries || []).filter(row => row.pending).length;
};
const inFlight = (session, commands) => Object.values(commands || {})
  .some(command => command.sessionId === session.id && ['queued', 'claimed', 'authorized'].includes(command.phase));

const commands = state.commands || {};
const sessions = Object.values(state.sessions || {})
  .filter(session => only ? session.id === only : true);

const tabs = new Map();
for (const session of sessions) {
  if (typeof session.tabId !== 'number') continue;
  tabs.set(session.tabId, (tabs.get(session.tabId) || 0) + 1);
}

const rows = [];
const failedCommands = new Map();
for (const command of Object.values(commands)) {
  if (command.phase !== 'failed') continue;
  failedCommands.set(command.error || 'UNKNOWN', (failedCommands.get(command.error || 'UNKNOWN') || 0) + 1);
}

for (const session of sessions) {
  const bodies = assistant(session);
  const ledger = outputs(session);
  const byId = new Map(bodies.map(row => [row.id, row]));
  let truncated = 0;
  for (const source of ledger) {
    const row = byId.get('page:' + source.id) ||
      bodies.find(item => item.messageId === source.nativeMessageId);
    if (!row) continue;
    if ((row.text || '').length < (source.text || '').length) truncated++;
  }
  const codes = issueCodes(session);
  const turn = session.turn || {};
  const seen = Math.max(session.updatedAt || 0, turn.createdAt || 0, session.observation?.lastObservedAt || 0);
  const churnCount = churn(session);
  const duplicates = duplicateDeliveries(session);
  const bodyDuplicates = duplicatedLedgerRows(session, ['message']);
  const noticeDuplicates = duplicatedLedgerRows(session, ['notice']);
  const pending = pendingDeliveries(session);
  const stuck = Boolean(session.status !== 'abandoned' && session.status !== 'idle' && turn.outcome === undefined);
  const anomalies = [];
  if (truncated) anomalies.push('truncated×' + truncated);
  if (codes.includes('SOURCE_IDENTITY_CONFLICT')) anomalies.push('identityConflict');
  if (codes.includes('SOURCE_USER_MESSAGE_REVISED')) anomalies.push('referenceDrift');
  if (churnCount.count && (!since || churnCount.last >= since)) anomalies.push('churn×' + churnCount.count);
  if (duplicates) anomalies.push('duplicateDelivery×' + duplicates);
  if (bodyDuplicates) anomalies.push('bodyDup×' + bodyDuplicates);
  if (noticeDuplicates) anomalies.push('noticeDup×' + noticeDuplicates);
  if (pending) anomalies.push('pending×' + pending);
  if (stuck) anomalies.push('stuck');
  if (tabs.get(session.tabId) > 1 && typeof session.tabId === 'number') anomalies.push('tabCollision');
  if (session.error) anomalies.push('sessionError');
  rows.push({
    id: session.id,
    status: session.status,
    conversation: session.conversationId,
    sources: (session.sources || []).length,
    bodies: bodies.length,
    ledger: ledger.length,
    issues: codes,
    seen,
    anomalies: since && seen < since ? [] : anomalies,
    lifetime: anomalies
  });
}

const withAnomalies = rows.filter(row => row.anomalies.length);
const historical = rows.filter(row => !row.anomalies.length && row.lifetime.length);
const pad = (value, width) => String(value).padEnd(width);
console.log('会话总数 %d   窗口内有问题 %d   仅为历史残留 %d   空会话 %d   窗口: %s',
  rows.length, withAnomalies.length, historical.length,
  rows.filter(row => row.sources === 0).length, sinceLabel);
console.log();
console.log(pad('session', 38), pad('status', 8), pad('src', 5), pad('body', 5), pad('ledger', 7), 'anomalies');
console.log('-'.repeat(110));
for (const row of withAnomalies.slice(0, verbose ? 999 : 40))
  console.log(pad(row.id, 38), pad(row.status, 8), pad(row.sources, 5), pad(row.bodies, 5), pad(row.ledger, 7),
    row.anomalies.join(' '));
if (withAnomalies.length > 40 && !verbose) console.log('... 还有 ' + (withAnomalies.length - 40) + ' 个，用 --verbose 全列');
if (historical.length) {
  console.log('\n=== 仅为历史残留的会话（窗口之前发生）===');
  const past = new Map();
  for (const row of historical) for (const anomaly of row.lifetime) {
    const key = anomaly.replace(/×\d+$/, '');
    past.set(key, (past.get(key) || 0) + 1);
  }
  for (const [key, count] of [...past].sort((a, b) => b[1] - a[1])) console.log('  ' + String(count).padStart(4), key);
}

const tally = new Map();
for (const row of rows) for (const anomaly of row.anomalies) {
  const key = anomaly.replace(/×\d+$/, '');
  tally.set(key, (tally.get(key) || 0) + 1);
}
console.log('\n=== 异常分布 ===');
for (const [key, count] of [...tally].sort((a, b) => b[1] - a[1])) console.log('  ' + String(count).padStart(4), key);
console.log('\n=== 失败命令（按错误码）===');
for (const [code, count] of [...failedCommands].sort((a, b) => b[1] - a[1])) console.log('  ' + String(count).padStart(4), code);
const allIssues = new Map();
for (const row of rows) for (const code of row.issues) allIssues.set(code, (allIssues.get(code) || 0) + 1);
console.log('\n=== 页面采集问题（按出现会话数）===');
for (const [code, count] of [...allIssues].sort((a, b) => b[1] - a[1])) console.log('  ' + String(count).padStart(4), code);
console.log('\n状态文件：' + path.join(directory, 'state.json') + '（未打印任何对话内容）');
