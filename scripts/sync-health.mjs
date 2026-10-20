// Read-only health report for the ChatGPT page -> Paseo sync path.
//
// Reads the local runtime state and reports, per session, whether the three
// sync defects are showing up. It prints LENGTHS AND COUNTS ONLY: no chat
// text, no message bodies, no tokens.
//
//   node scripts/sync-health.mjs                # the most recent sessions
//   node scripts/sync-health.mjs --session <id> # one session
//   node scripts/sync-health.mjs --limit 5
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf('--limit') + 1]) || 8;
const only = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;
const directory = process.env.CIP_STATE_DIR || path.join(os.homedir(), '.chatmode-in-paseo');
const statePath = path.join(directory, 'state.json');

const state = JSON.parse(await readFile(statePath, 'utf8'));
const sessions = Object.values(state.sessions || {})
  .filter(session => only ? session.id === only : true)
  .sort((a, b) => (b.observation?.lastObservedAt ?? 0) - (a.observation?.lastObservedAt ?? 0))
  .slice(0, only ? undefined : limit);

const issuesOf = session => (session.history || []).find(row => row.kind === 'page-state')?.data?.issues || [];
const count = (list, code) => list.filter(issue => issue.code === code).length;

const rows = [];
for (const session of sessions) {
  const sources = session.sources || [];
  const history = session.history || [];
  const outputs = sources.filter(source => source.role === 'assistant' &&
    source.kind === 'message' && source.lane === 'output');

  // 1. Projection lag: the ledger is the delivered truth, the history is what
  //    the host timeline received. A short history row is a frozen body.
  let lagging = 0;
  for (const source of outputs) {
    const row = history.find(item => item.type === 'assistant_message' && item.messageId === source.nativeMessageId) ||
      history.find(item => item.id === 'page:' + source.id);
    if (row && row.text.length < (source.text || '').length) lagging++;
  }

  // 2. The preceding-user reference moved. On the fixed build this is reported
  //    as SOURCE_USER_MESSAGE_REVISED; the old build dropped the whole update
  //    and reported SOURCE_IDENTITY_CONFLICT.
  const issues = issuesOf(session);
  const revised = count(issues, 'SOURCE_USER_MESSAGE_REVISED');
  const conflicts = count(issues, 'SOURCE_IDENTITY_CONFLICT');

  // 3. Position churn. A rewrite whose text is byte-identical to the current
  //    text is the signature of a DOM path shift read as a content rewrite.
  let churn = 0;
  for (const source of sources) for (const rewrite of source.rewrites || [])
    if (rewrite.text === source.text) churn++;

  rows.push({
    id: session.id,
    status: session.status,
    conversation: session.conversationId,
    observedAt: session.observation?.lastObservedAt ?? null,
    frames: session.observation?.lastSequence ?? 0,
    sources: sources.length,
    outputs: outputs.length,
    referenced: outputs.filter(source => source.userMessageId).length,
    lagging,
    revised,
    conflicts,
    churn,
    domLocal: count(issues, 'DOM_LOCAL_IDENTITY')
  });
}

const pad = (value, width) => String(value).padEnd(width);
const line = (...cells) => cells.join('  ');
console.log(line(pad('session', 38), pad('status', 9), pad('conv', 38),
  pad('frames', 7), pad('src', 5), pad('out', 4), pad('ref', 4), pad('lag', 4),
  pad('rev', 4), pad('cfl', 4), pad('churn', 6), pad('dom', 4)));
console.log('-'.repeat(128));
for (const row of rows) {
  console.log(line(pad(row.id, 38), pad(row.status, 9), pad(String(row.conversation), 38),
    pad(row.frames, 7), pad(row.sources, 5), pad(row.outputs, 4), pad(row.referenced, 4),
    pad(row.lagging, 4), pad(row.revised, 4), pad(row.conflicts, 4), pad(row.churn, 6),
    pad(row.domLocal, 4)));
}
console.log();
const total = rows.reduce((sum, row) => sum + row.churn, 0);
const lagging = rows.reduce((sum, row) => sum + row.lagging, 0);
console.log('lag      = 账本文本比已投递的历史更长 -> 正文被冻结/落后（修复 1）');
console.log('rev      = 前一条用户消息引用发生漂移（修复 1 的触发条件，新诊断码）');
console.log('cfl      = 来源身份冲突（修复 1 修复前的症状，修复后不应出现）');
console.log('churn    = 正文一字未改却被记为 rewrite 的次数（修复 2 的历史指纹，修复后应为 0）');
console.log('dom      = DOM 本地身份（没有稳定 native id，位移风险高）');
console.log(`\n合计：位置抖动 churn=${total}，正文落后 lagging=${lagging}`);
console.log(`状态文件：${statePath}`);
