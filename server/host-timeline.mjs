// Read-only public SDK adapter for native-delivery. Never Send/commands/append.
// One unbounded retained-window fetch avoids assembling different-time pages.
// This is projected, in-memory evidence, not canonical events or a durable ACK.
import { normalizeProjectedView } from './native-delivery.mjs';
const fail = code => { throw Object.assign(new Error(code), {code}); };
const text = value => typeof value === 'string' && value.length > 0;
const seq = value => Number.isSafeInteger(value) && value >= 0;

export function createHostTimelineReader({agent,sessionId,bindingGeneration,isCurrent}) {
  if (!text(agent?.id) || typeof agent.timeline?.refetch !== 'function' ||
      !text(sessionId) || !text(bindingGeneration) || typeof isCurrent !== 'function')
    fail('HOST_READER_CONFIG_INVALID');
  const agentId = agent.id;
  return async () => {
    if (!isCurrent()) fail('HOST_BINDING_EXPIRED');
    const page = await agent.timeline.refetch({direction:'tail',limit:0,projection:'projected'});
    if (!isCurrent()) fail('HOST_BINDING_EXPIRED');
    if (agent.id !== agentId || page?.agentId !== agentId || (page.agent && page.agent.id !== agentId))
      fail('HOST_AGENT_MISMATCH');
    if (page.error) fail('HOST_READ_FAILED');
    if (page.projection !== 'projected' || page.direction !== 'tail' ||
        !text(page.epoch) || !Array.isArray(page.entries)) fail('HOST_VIEW_INVALID');
    const w = page.window;
    if (!w || !seq(w.minSeq) || !seq(w.maxSeq) ||
        !seq(w.nextSeq) || w.nextSeq < 1 || w.maxSeq !== w.nextSeq - 1 ||
        w.minSeq > w.nextSeq ||
        ['reset','staleCursor','gap','hasOlder','hasNewer'].some(key=>typeof page[key] !== 'boolean'))
      fail('HOST_COVERAGE_UNAVAILABLE');
    for (const cursor of [page.startCursor,page.endCursor]) {
      if (cursor !== null && (!cursor || cursor.epoch !== page.epoch ||
          !seq(cursor.seq) || cursor.seq < w.minSeq || cursor.seq > w.maxSeq))
        fail('HOST_CURSOR_INVALID');
    }
    const startSeq = page.startCursor?.seq ?? null, endSeq = page.endCursor?.seq ?? null;
    if ((startSeq === null) !== (endSeq === null) || (startSeq !== null && startSeq > endSeq))
      fail('HOST_CURSOR_INVALID');
    const view = normalizeProjectedView({
      sessionId,bindingGeneration,hostEpoch:page.epoch,
      coverage:{complete:(w.minSeq === 1 || (w.minSeq === 0 && w.nextSeq === 1 && page.entries.length === 0)) && !page.reset && !page.staleCursor && !page.gap &&
        !page.hasOlder && !page.hasNewer,startSeq,endSeq,nextSeq:w.nextSeq},
      rows:page.entries.map(row=>({item:row.item,seqStart:row.seqStart,seqEnd:row.seqEnd,
        sourceSeqRanges:row.sourceSeqRanges}))
    });
    // Capability-filtered rows / retained windows can lack facts despite the
    // host reporting no further pages. The range union, not that flag, decides.
    view.coverage.complete = view.fullCoverage;
    return view;
  };
}
