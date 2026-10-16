/* Chat On Steroids — MIT, Copyright (c) 2026 Chat On Steroids contributors.
 * Public-only transplant from extension/fiber.js @ e40562640361ca8f74158b2262ca8c555b00abed:
 * shellTurnSource, shellItemText, unescapeFallbackMarkdown, turnViewOf,
 * messagesFromTurnView, shellQueries and shellConversation.
 * CIP adaptations: explicit bounds/refusals; no tool/media/analysis payloads;
 * sourceFor connects the existing committed Fiber reader to these source readers.
 * This does not send messages or infer receipts from a URL, elapsed time or button.
 */
(() => {
  'use strict';
  const MAX_CLIMB = 80, MAX_ROOT_DEPTH = 2048, MAX_ROWS = 400, MAX_RENDERED_TEXT = 256000;
  const MAX_FORMULA_LINES = 400;
  const str = value => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
  const reject = code => { throw new Error(code); };
  const boundedText = text => { if (typeof text === 'string' && text.length > MAX_RENDERED_TEXT) reject('TRANSCRIPT_LIMIT'); return text; };
  const ONLY_CONTENT_REFERENCES = /^\s*(?:::chatgpt-content-reference\{[^}\n]*\}\s*)+$/;

  function unescapeFallbackMarkdown(markdown) {
    const lines = markdown.split('\n');
    const out = [];
    let fence = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = null;
        out.push(line); continue;
      }
      if (marker && !(marker[0] === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`'))) { fence = marker; out.push(line); continue; }
      if (line.trim() === '\\[') {
        let close = -1;
        for (let at = index + 1; at < lines.length && at <= index + MAX_FORMULA_LINES; at++) if (lines[at].trim() === '\\]') { close = at; break; }
        if (close > index) { for (; index <= close; index++) out.push(lines[index]); index--; continue; }
      }
      let text = '';
      for (let at = 0; at < line.length;) {
        const char = line[at];
        if (char === '\\' && line[at + 1] === '(') {
          const close = line.indexOf('\\)', at + 2);
          if (close >= 0) { text += line.slice(at, close + 2); at = close + 2; continue; }
        }
        if (char === '\\' && /[!-\/:-@[-`{-~]/.test(line[at + 1] || '')) { text += line[at + 1]; at += 2; continue; }
        if (char === '`') {
          const run = /^`+/.exec(line.slice(at))[0];
          const close = new RegExp(`(?<!\`)${run}(?!\`)`).exec(line.slice(at + run.length));
          if (close) { const end = at + run.length + close.index + run.length; text += line.slice(at, end); at = end; continue; }
          text += run; at += run.length; continue;
        }
        text += char; at++;
      }
      out.push(text);
    }
    return out.join('\n');
  }
  function shellItemText(item) {
    const content = typeof item?.content === 'string' ? boundedText(item.content) : '';
    if (!ONLY_CONTENT_REFERENCES.test(content)) return content;
    const id = str(item.messageId);
    if (Array.isArray(item.contentReferences) && item.contentReferences.length > MAX_ROWS) reject('TRANSCRIPT_LIMIT');
    const own = (Array.isArray(item.contentReferences) ? item.contentReferences : []).filter(reference =>
      reference?.type === 'dil' && id && reference.source_message_id === id &&
      typeof reference.model_dil_v2?.fallbackMarkdown === 'string' && reference.model_dil_v2.fallbackMarkdown.trim());
    return own.length === 1 ? unescapeFallbackMarkdown(boundedText(own[0].model_dil_v2.fallbackMarkdown)) : content;
  }
  function shellQueries(fiber) {
    try {
      for (let at = fiber, up = 0; at && up < MAX_ROOT_DEPTH; up++, at = at.return) {
        const client = at.memoizedProps?.client;
        if (typeof client?.getQueryCache !== 'function') continue;
        const queries = client.getQueryCache()?.getAll();
        return Array.isArray(queries) && queries.length <= 512 ? queries : [];
      }
    } catch { /* No cached guess if the mounted native owner cannot be read. */ }
    return [];
  }
  function shellConversation(queries, localId, evidence) {
    if (evidence.conflict || !localId?.startsWith('local-chatgpt:')) return evidence;
    let found = evidence.conversationId;
    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key.length !== 2 || key[0] !== 'chatgpt-conversation-details' || key[1]?.clientConversationId !== localId) continue;
      const server = key[1].serverConversationId;
      if (typeof server !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(server)) continue;
      if (found && found !== server) return { conversationId: null, conflict: true };
      found = server;
    }
    return { conversationId: found, conflict: false };
  }
  function turnViewOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn;
      if (turn && typeof turn === 'object' && Array.isArray(turn.items)) return turn;
    }
    return null;
  }
  function messagesFromTurnView(turn) {
    if (!turn || typeof turn !== 'object' || !Array.isArray(turn.items)) return null;
    if (turn.items.length > MAX_ROWS) reject('TRANSCRIPT_LIMIT');
    const out = [], seen = new Set();
    for (const item of turn.items) {
      if (!item || !['user-message', 'assistant-message'].includes(item.type)) continue;
      const user = item.type === 'user-message';
      const id = str(item.messageId) || (user ? str(item.serverMessageId) : str(item.latestMessageId));
      if (!id) continue;
      if (seen.has(id) || (user && item.serverMessageId && item.messageId && item.serverMessageId !== item.messageId)) reject('TRANSCRIPT_CONFLICT');
      if (item.channel === 'analysis' || item.phase === 'analysis' || item.isVisuallyHidden === true) continue;
      const text = user ? boundedText(item.message) : shellItemText(item);
      const final = !user && item.phase === 'final_answer';
      const terminal = final && item.completed === true && turn.status === 'complete';
      seen.add(id);
      out.push({ id, author: { role: user ? 'user' : 'assistant' }, recipient: 'all',
        channel: user ? null : final ? 'final' : 'commentary',
        status: terminal ? 'finished_successfully' : 'in_progress', end_turn: terminal,
        content: { content_type: 'text', parts: [typeof text === 'string' ? text : ''] }, metadata: {} });
    }
    return out;
  }
  function shellEntryOf(fiber) {
    for (let at = fiber, up = 0; at && up < 16; up++, at = at.return) {
      if (Array.isArray(at.memoizedProps?.entry?.turn?.items)) return at.memoizedProps.entry;
    }
    return null;
  }
  function shellTurnSource(fiber, section, turnId) {
    const entry = shellEntryOf(fiber);
    if (!entry || !turnId || entry.id !== turnId) return null;
    if (entry.turn.items.length > MAX_ROWS) reject('TRANSCRIPT_LIMIT');
    const messages = [], seen = new Set();
    const remember = id => { if (!id || seen.has(id)) return false; seen.add(id); return true; };
    const topLevel = new Set(entry.turn.items.filter(item => item?.type === 'assistant-message').map(item => str(item.messageId)).filter(Boolean));
    let work = 0, lastAnswer = null;
    for (const item of entry.turn.items) {
      if (++work > MAX_ROWS) reject('TRANSCRIPT_LIMIT');
      if (item?.type === 'user-message' || item?.type === 'assistant-message') {
        const user = item.type === 'user-message', id = str(item.messageId) || (user ? str(item.serverMessageId) : null);
        if (!id) continue;
        if (!remember(id) || (user && item.serverMessageId && item.messageId && item.serverMessageId !== item.messageId)) reject('TRANSCRIPT_CONFLICT');
        if (item.channel === 'analysis' || item.phase === 'analysis' || item.isVisuallyHidden === true) continue;
        const role = user ? 'user' : 'assistant', text = user ? boundedText(item.message) : shellItemText(item);
        const final = !user && item.phase === 'final_answer';
        if (final) lastAnswer = item;
        const completed = final && item.completed === true && entry.turn.status === 'complete';
        messages.push({ id, author: { role }, content: { content_type: 'text', parts: [typeof text === 'string' ? text : ''] },
          channel: user ? null : final ? 'final' : 'commentary', end_turn: completed,
          status: completed ? 'finished_successfully' : 'in_progress', metadata: {} });
      } else if (item?.type === 'generated-image') {
        lastAnswer = item; // No image payload support; an older text final cannot end this output.
      } else if (item?.type === 'chatgpt-reasoning-group' && Array.isArray(item.items) && item.reasoningRecap?.type !== 'hide_all') {
        if (item.items.length > MAX_ROWS) reject('TRANSCRIPT_LIMIT');
        for (const step of item.items) {
          if (++work > MAX_ROWS) reject('TRANSCRIPT_LIMIT');
          if (step?.type !== 'assistant-message' || step.channel === 'analysis' || step.phase === 'analysis' || step.isVisuallyHidden === true) continue;
          const id = str(step.messageId), text = shellItemText(step);
          if (!id || topLevel.has(id) || !remember(id) || !text || ONLY_CONTENT_REFERENCES.test(text)) continue;
          messages.push({ id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] },
            channel: 'commentary', end_turn: false, status: step.completed === true ? 'finished_successfully' : 'in_progress', metadata: {} });
        }
      }
    }
    return { entry, messages, endMessageId: lastAnswer?.type === 'generated-image' ? null : globalThis.CIP_COS_PUBLIC_CORE.turnEndMessageId(messages) };
  }
  // Integration only: prefer the exact native typed model to legacy DOM captions.
  function sourceFor(fiber, section, evidence) {
    // CoS turnsOf: a search-user anchor uses turnViewOf even when its Fiber
    // also inherits a shell entry. That anchor has no shell turn marker, so
    // shellTurnSource would discard the real user message (receipt stays empty).
    // This is native turn.items evidence, not layout-key or visible-text proof.
    if (section.matches?.('[data-chatgpt-search-unit-key$=\":user\"]')) {
      const candidate=section.closest?.('article');
      const anchors=candidate?.querySelectorAll?.('[data-chatgpt-search-unit-key$=\":user\"]');
      const toolSurface=anchors?.length===1 && anchors[0]===section ? candidate : section;
      const view = turnViewOf(fiber);
      const messages = messagesFromTurnView(view);
      return { recognized: true, kind: 'view', scope: evidence, messages,
        terminal: globalThis.CIP_COS_PUBLIC_CORE.turnEndMessageId(messages),
        activity: globalThis.CIP_COS_ACTIVITY?.shellTurnTrace(view) ?? null,
        timeline: globalThis.CIP_COS_ACTIVITY?.publicTimeline(view,toolSurface) ?? null };
    }
    const entry = shellEntryOf(fiber);
    if (entry) {
      const anchor = section.closest('[data-turn-key]') || section;
      const marker = anchor.querySelector('[data-content-search-turn-key]');
      const turnId = marker?.getAttribute('data-content-search-turn-key') || anchor.getAttribute('data-turn-id') || anchor.getAttribute('data-turn-key');
      const scope = shellConversation(shellQueries(fiber), entry.conversationId, evidence);
      const source = shellTurnSource(fiber, anchor, turnId);
      return { recognized: true, kind: 'shell', scope, messages: source?.messages ?? null, terminal: source?.endMessageId ?? null,
        activity: source ? globalThis.CIP_COS_ACTIVITY?.shellTurnTrace(source.entry.turn) ?? null : null,
        timeline: source ? globalThis.CIP_COS_ACTIVITY?.publicTimeline(source.entry.turn,section) ?? null : null };
    }
    const view = turnViewOf(fiber);
    if (view) {
      const messages = messagesFromTurnView(view);
      return { recognized: true, kind: 'view', scope: evidence, messages, terminal: globalThis.CIP_COS_PUBLIC_CORE.turnEndMessageId(messages),
        activity: globalThis.CIP_COS_ACTIVITY?.shellTurnTrace(view) ?? null,
        timeline: globalThis.CIP_COS_ACTIVITY?.publicTimeline(view,section) ?? null };
    }
    return { recognized: false };
  }
  globalThis.CIP_COS_SHELL_PUBLIC = Object.freeze({ sourceFor });
})();
