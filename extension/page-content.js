/* Read-only, classic content script. DOM evidence only: no React fields, cache,
 * network, clicks, expansion, completion inference or Paseo run identifiers.
 *
 * Identity: native data-message-id / deduplicated search-message-ids first;
 * otherwise turn + search-unit key, then a DOM-local source path. Layout keys
 * are NEVER advertised as native message IDs. Unkeyed paths cannot promise
 * continuity across arbitrary React remounts/reordering (reported in issues).
 *
 * Folded public DOM is readable only behind a native Work disclosure: details
 * with a Work summary, or an exact aria-controls panel of a Work button. Only
 * that panel's hiding is exempt; hidden/private descendants stay excluded.
 * Unmounted content cannot be read. No private reasoning fallback exists.
 */
(() => {
  'use strict';
  const APPROVAL = '[data-codex-approval-surface="true"]';
  const EXCLUDE = 'script,style,template,noscript,svg,canvas,iframe,nav,aside,[role="navigation"],'+
    '[role="complementary"],textarea,input,select,[contenteditable="true"],[role="textbox"],'+
    '#prompt-textarea,form[data-chatgpt-composer],form:has(#prompt-textarea),form:has(textarea),'+
    'form:has([contenteditable="true"]),.clf-stream,.clf-stage,.clf-composer,.clf-boot,[data-cip-owned],'+
    '[data-clf-user-text],[role="toolbar"],.sr-only,.visually-hidden,[data-is-visually-hidden="true"],[data-message-channel="analysis"],'+
    '[data-message-channel="private"],[data-channel="analysis"],[data-channel="private"],'+
    '[data-private="true"],[data-reasoning-visibility="private"],[data-summary-type="raw_cot"]';
  const IDENTITY = '[data-message-id],[data-chatgpt-search-unit-key],[data-content-search-unit-key]';
  const PROSE = '[data-message-author-role],[data-markdown-text-style],[data-markdown-text-tone="user-message"],.markdown';
  const SPECIAL = '[data-tool-call-id],[role="alert"],[role="status"],[data-public-reasoning-summary]';
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|LI|UL|OL|PRE|BLOCKQUOTE|H[1-6]|TABLE|TR|DETAILS|SUMMARY)$/;
  const WORK = /^(?:Work(?:\s+for\s+.+)?|Worked\s+for\s+.+|Previous activity|工作(?:过程|记录)?|思考过程|之前的活动)$/i;
  // Exact one-time/persistent confirmation captions. No substring matching:
  // "Always allow", "Allow all" and "Trust" are persistent and intentionally
  // separate from an ordinary one-time Allow.
  const APPROVAL_LABELS = {
    persistent: new Set([
      'always allow','allow always','allow all','always approve','approve always','approve all',
      'allow for this chat','allow for this conversation','allow for this session','allow for all chats',
      'allow and remember','remember my choice','remember this choice',"don't ask again",'do not ask again',
      'trust this app','trust this tool','trust','always',
      '始终允许','总是允许','永久允许','一直允许','全部允许','允许全部','始终批准','全部批准',
      '在此对话中始终允许','在此会话中始终允许','记住我的选择','记住选择','不再询问','不再提示',
      '信任此应用','信任此工具','信任'
    ]),
    once: new Set([
      'allow','allow once','approve','approve once','accept','accept once','authorize','authorize once',
      '允许','允许一次','允許','允許一次','批准','批准一次','通过','通過','授权','授權','确认授权','確認授權'
    ]),
    confirm: new Set([
      'continue','yes','ok','okay','proceed','confirm','i understand','got it',
      '继续','繼續','是','好','确定','確定','确认','確認','明白','我知道了'
    ]),
    reconnect: new Set([
      'reconnect','connect','重新连接','重新連結','重新连接应用','重新連結應用','连接','連接'
    ]),
    deny: new Set([
      'deny','reject','cancel','no','close','dismiss','not now','later',
      '拒绝','拒絕','取消','否','关闭','關閉','稍后','稍後','不允许','不允許'
    ])
  };
  const approvalKey = value => typeof value === 'string' ?
    value.replace(/\s+/g,' ').trim().replace(/[.!。！]+$/u,'').toLocaleLowerCase('en-US') : '';
  const approvalTier = value => {
    const key = approvalKey(value);
    for (const tier of ['persistent','once','confirm','reconnect','deny'])
      if (APPROVAL_LABELS[tier].has(key)) return tier;
    return null;
  };
  const APPROVAL_CONTEXT = /Allow\s+ChatGPT\s+to\s+use|允许\s*ChatGPT\s*使用|授\s*权|permission|authorize|approve/i;
  const APPROVAL_RECONNECT = /reconnect|connection\s+has\s+expired|重新连接|重新連結|连接.*过期|連接.*過期|过期|過期/i;
  const keys = new WeakMap(), mediaRevisions = new WeakMap();
  let mediaNodes = new Map(), mediaSequence = 0;
  let keySequence = 0;
  const documentKey = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const approvalTracking = new Map(), parentObservers = new Map(), confirmedClosed = new Set();
  let approvalPath = location.pathname;
  const attr = (node, name) => node.getAttribute(name);
  const unit = node => attr(node, 'data-chatgpt-search-unit-key') || attr(node, 'data-content-search-unit-key');
  const pathOf = (node, root) => {
    const result = [];
    for (let at = node; at && at !== root; at = at.parentElement)
      result.unshift([...at.parentElement.children].indexOf(at));
    return result;
  };
  function conversationId() {
    return /\/(?:c|conversation)\/([^/?#]+)/.exec(location.pathname)?.[1] || null;
  }
  function excluded(node) { return Boolean(node.closest(EXCLUDE)); }
  // ChatGPT's DIL renderer leaves freshly streamed words at opacity:0 until
  // the reveal animation runs. A never-painted tab never runs it, so public
  // assistant text is laid out but lost to the generic opacity rule. Allow
  // only the word-level span, inside a native assistant message, and never in
  // a Work disclosure/private region.
  function revealWord(node, panels) {
    if (!node?.matches?.('[data-d-text-flow="word"],[data-d-stream-word]')) return false;
    if (!node.closest('[data-markdown-text-style="assistant-message"],[data-message-author-role="assistant"]')) return false;
    const owner = node.closest(IDENTITY);
    if (!owner || !nativeIds(owner).length || workOf(node, panels)) return false;
    return true;
  }
  function readable(node, panels = new Set()) {
    if (!node?.isConnected || excluded(node)) return false;
    const cid = conversationId();
    for (let at = node; at; at = at.parentElement) {
      const ownConversation = attr(at, 'data-conversation-id');
      if (cid && ownConversation && ownConversation !== cid) return false;
      const style = getComputedStyle(at);
      if (!panels.has(at) && (at.hidden || at.hasAttribute('inert') || attr(at, 'aria-hidden') === 'true' ||
          style.display === 'none' || style.contentVisibility === 'hidden' || style.clip !== 'auto' ||
          ['hidden', 'collapse'].includes(style.visibility) || (style.opacity === '0' && !(at === node && revealWord(node, panels))))) return false;
      if (!panels.has(at) && /hidden|clip/.test(`${style.overflowX} ${style.overflowY}`)) {
        const box = at.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
      }
      if (at.tagName === 'DETAILS' && !at.open && !panels.has(at)) {
        const summary = at.querySelector(':scope > summary');
        if (node !== at && !summary?.contains(node)) return false;
      }
    }
    return true;
  }
  const visible = node => readable(node) && node.getClientRects().length > 0;
  function roots(issues) {
    const candidates = [...document.querySelectorAll('main,[role="main"],[data-app-shell-main-surface]')]
      .filter(node => readable(node));
    const outer = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)));
    if (outer.length > 1) {
      issues.push({ code: 'AMBIGUOUS_MAIN_SURFACE' });
      return []; // Never mix two visible conversations.
    }
    return outer.length ? outer : document.body ? [document.body] : [];
  }
  // This serializer preserves rendered words and block boundaries, not original
  // Markdown source. Callers must respect format:text rather than reinterpret it.
  function textOf(root, accept = () => true) {
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!accept(node)) return '';
        return node.parentElement.closest('pre') ? node.nodeValue : node.nodeValue.replace(/[\t\r\n ]+/g, ' ');
      }
      if (node.nodeType !== Node.ELEMENT_NODE || !accept(node)) return '';
      if (node.tagName === 'BR') return '\n';
      let result = '';
      for (const child of node.childNodes) {
        const value = visit(child);
        if (!value) continue;
        const block = child.nodeType === Node.ELEMENT_NODE && BLOCK.test(child.tagName);
        if (block && result && !result.endsWith('\n')) result += '\n';
        result += value;
        if (block && !result.endsWith('\n')) result += '\n';
      }
      return result;
    }
    return visit(root).trim();
  }
  function caption(button, panels = new Set()) {
    return textOf(button, node => node.nodeType === Node.TEXT_NODE ||
      (!node.matches('kbd,svg,script,style') && readable(node, panels)));
  }
  function disclosures(root, issues) {
    const panels = new Set();
    for (const control of root.querySelectorAll('summary,button')) {
      if (!readable(control, panels) || control.closest(APPROVAL) ||
          control.closest('.markdown,[data-markdown-text-style],[data-markdown-text-tone="user-message"],[data-message-author-role="user"]') ||
          !WORK.test(caption(control, panels))) continue;
      if (control.tagName === 'SUMMARY') {
        if (control.parentElement.tagName === 'DETAILS') panels.add(control.parentElement);
      } else {
        const ids = (attr(control, 'aria-controls') || '').trim().split(/\s+/);
        if (ids.length !== 1 || !ids[0]) {
          issues.push({ code: 'WORK_PANEL_UNIDENTIFIED', order: pathOf(control, root) });
          continue;
        }
        const target = document.getElementById(ids[0]);
        // An accessible disclosure must stay in this conversation and outside
        // authored prose. A quoted button must not grant access to hidden DOM.
        if (target && root.contains(target) && !excluded(target) &&
            !target.contains(control) && target !== root) panels.add(target);
        else issues.push({ code: 'WORK_PANEL_UNIDENTIFIED', order: pathOf(control, root) });
      }
    }
    return panels;
  }
  function nativeIds(node) {
    const direct = attr(node, 'data-message-id');
    const raw = attr(node, 'data-chatgpt-search-message-ids');
    let values = [];
    if (raw) {
      if (raw.trim().startsWith('[')) {
        try { values = JSON.parse(raw); } catch { values = [raw]; }
        if (!Array.isArray(values)) values = [raw];
      } else values = raw.trim().split(/\s+/);
    }
    if (direct) values.unshift(direct);
    return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  }
  function roleOf(node) {
    const role = attr(node, 'data-message-author-role') || /:(user|assistant)$/.exec(unit(node) || '')?.[1];
    if (role) return ['user', 'assistant'].includes(role) ? role : 'page';
    if (attr(node, 'data-markdown-text-tone') === 'user-message') return 'user';
    if (attr(node, 'data-markdown-text-style') === 'assistant-message') return 'assistant';
    return 'page';
  }
  function workOf(node, panels) {
    for (let at = node; at; at = at.parentElement) if (panels.has(at)) return at;
    return null;
  }
  // Find source ownership, not one giant turn string. A Work boundary blocks
  // inheritance of the outer final's identity. Nested search wrappers with the
  // same key are aliases; distinct message/search keys remain distinct sources.
  function ownerOf(node, root, panels) {
    let owner = null, identity = null;
    for (let at = node; at && at !== root.parentElement; at = at.parentElement) {
      if (panels.has(at)) break;
      if (at.matches(SPECIAL)) return owner && identity ? owner : at;
      if (at.matches(IDENTITY)) {
        if (identity) {
          const innerIds = nativeIds(identity), outerIds = nativeIds(at);
          const sameUnit = unit(identity) && unit(identity) === unit(at);
          const sameIds = innerIds.length && outerIds.length && innerIds.join('\0') === outerIds.join('\0');
          if (!sameUnit && !sameIds) break;
          if (innerIds.length && outerIds.length && !sameIds) break;
        }
        owner = identity = at;
      } else if (!owner && at.matches(PROSE)) owner = at;
      if (at === root) break;
    }
    if (owner) return owner;
    // Unknown visible content is collected rather than lost to a whitelist.
    return node.closest('p,pre,li,h1,h2,h3,h4,h5,h6,blockquote,div,section,article,summary') || node;
  }
  // Site/citation favicons are UI chrome, not conversation media. They are
  // cross-origin and would only produce tainted/unsupported artifact cards.
  function uiImage(node) {
    const src = attr(node, 'src') || '';
    return /(?:^|\/\/)(?:[a-z0-9-]+\.)*google\.[a-z.]+\/s2\/favicons|\/favicon(?:\?|\.|$)/i.test(src);
  }
  function collect(root, panels, approvalDetails, issues) {
    const records = new Map(), assignments = new WeakMap();
    const record = owner => {
      if (!records.has(owner)) records.set(owner, { node: owner, order: pathOf(owner, root) });
      return records.get(owner);
    };
    function walk(node) {
      try {
        if (node.nodeType === Node.TEXT_NODE) {
          const owner = ownerOf(node.parentElement, root, panels);
          assignments.set(node, owner); record(owner); return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE || !readable(node, panels) || node.matches(APPROVAL) || approvalDetails.has(node))
          return;
        // Image cards (generated images, attachments, lightboxes) are often
        // wrapped in a button. The button itself is control chrome, but the
        // visible <img> inside is conversation media and must still be read.
        if (node.matches('button,[role="button"]')) {
          for (const image of node.querySelectorAll('img')) {
            if (!readable(image, panels) || uiImage(image)) continue;
            record(image).media = { src: attr(image, 'src'), alt: attr(image, 'alt') || '' };
            record(image).mediaKind = 'image';
          }
          return;
        }
        if (node.matches('img,a[download],[data-file-id]')) {
          if (node.tagName === 'IMG' && uiImage(node)) return;
          record(node).media = node.tagName === 'IMG' ? { src: attr(node, 'src'), alt: attr(node, 'alt') || '' } :
            { href: attr(node, 'href'), name: attr(node, 'download'), fileId: attr(node, 'data-file-id') };
          record(node).mediaKind = node.tagName === 'IMG' ? 'image' : 'file';
          if (node.tagName !== 'IMG') record(node).mediaText = textOf(node, n =>
            n.nodeType === Node.TEXT_NODE || readable(n, panels));
          return;
        }
      } catch {
        issues.push({ code: 'SOURCE_READ_FAILED', order: pathOf(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement, root) });
        return;
      }
      for (const child of node.childNodes) walk(child);
    }
    walk(root);
    for (const row of records.values()) {
      try {
        row.text = row.media ? (row.mediaText ?? row.media.alt ?? '') : textOf(row.node, node =>
          node.nodeType === Node.TEXT_NODE ? assignments.get(node) === row.node :
            readable(node, panels) && !approvalDetails.has(node) && !node.matches(`${APPROVAL},button,[role="button"]`));
      } catch { row.text = ''; issues.push({ code: 'SOURCE_TEXT_FAILED', order: row.order }); }
    }
    return [...records.values()].filter(row => row.text || row.media);
  }
  function mediaEvidence(node, kind) {
    const raw = kind === 'image' ? (node.currentSrc || node.src) : (node.href || attr(node, 'href'));
    let url; try { if (raw) url = new URL(raw, location.href); } catch {}
    const owner = node.closest('[data-message-id],[data-chatgpt-search-message-ids]');
    const ids = owner ? nativeIds(owner) : [];
    const messageId = ids.length === 1 && /^[A-Za-z0-9:._-]{1,200}$/.test(ids[0]) ? ids[0] : null;
    const candidate = url?.searchParams.get('id');
    const nativeShape = kind === 'image' ?
      node.matches('[class~="group/imagegen-image"] img,[class~="group/generated-image-preview"] img') :
      node.matches('a[download][data-file-id]') && attr(node,'data-file-id') === candidate &&
        !node.closest('.markdown,[data-markdown-text-style]');
    const native = messageId && nativeShape && !node.closest('[data-message-author-role="user"]') &&
      /^file_[A-Za-z0-9_-]{8,100}$/.test(candidate ?? '') && url.origin === location.origin &&
      url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      url.pathname === '/backend-api/estuary/content' && [...url.searchParams.keys()].length === 1;
    const assetId = native ? candidate : null;
    const fields = [kind, raw, attr(node,'src'), attr(node,'srcset'), attr(node,'href'),
      JSON.stringify(ids), attr(node,'data-file-id')];
    let revision = mediaRevisions.get(node);
    if (!revision || fields.some((field,i)=>field !== revision.fields[i])) {
      revision = {fields, id:documentKey+'-media-'+(++mediaSequence)};
      mediaRevisions.set(node,revision);
    }
    const provenance = native ? 'native-original' : kind !== 'image' ? null :
      (url?.protocol === 'data:' && /^data:image\/(?:png|jpeg|webp|gif)(?:;[^,\r\n]*)?,/i.test(raw)) ||
      (url?.protocol === 'blob:' && url.origin === location.origin) ? 'visible-image-resource' : 'rendered-preview';
    return {kind,messageId,assetId,resourceRevision:revision.id,provenance,uriScheme:url?.protocol ?? null};
  }
  function classify(row, panels) {
    const node = row.node, work = workOf(node, panels);
    const role = roleOf(node);
    const callId = attr(node, 'data-tool-call-id'), name = attr(node, 'data-tool-name');
    const channel = attr(node, 'data-message-channel') || attr(node, 'data-channel');
    const tones = [...node.querySelectorAll('[data-markdown-text-tone]')]
      .filter(child => readable(child, panels) && ownerOf(child, node, panels) === node)
      .map(child => attr(child, 'data-markdown-text-tone'));
    const tertiary = attr(node, 'data-markdown-text-tone') === 'tertiary' ||
      (tones.length > 0 && tones.every(tone => tone === 'tertiary'));
    let kind = 'notice', lane = 'output';
    if (callId && name) { kind = 'tool_call'; lane = 'process'; }
    else if (node.hasAttribute('data-public-reasoning-summary') ||
        (work && tertiary && role === 'assistant')) {
      kind = 'reasoning'; lane = 'process';
    } else if (role !== 'page' && !node.matches('[role="alert"],[role="status"]')) {
      // A formal assistant answer must carry exactly one native message id.
      // Work summaries/commentary without one are process content, not answers.
      const nativeAssistant = role === 'assistant' && nativeIds(node).length === 1;
      kind = 'message';
      lane = work || channel === 'commentary' || (role === 'assistant' && !nativeAssistant)
        ? 'process' : 'output';
    }
    if (row.media) kind = row.mediaKind;
    const result = { role, lane, kind, text: row.text, format: 'text', order: row.order };
    // Keep an explicit public source type even when this reader cannot classify
    // it. Never substitute a guessed type for absent DOM metadata.
    const typeAttribute = ['data-item-type', 'data-message-type', 'data-content-type', 'data-kind', 'data-type']
      .find(attribute => node.hasAttribute(attribute));
    if (typeAttribute) result.sourceType = attr(node, typeAttribute);
    if (row.media) {
      result.media = {...row.media,...mediaEvidence(node,row.mediaKind),visible:visible(node)};
      // Resource bytes stay in the page. An opaque revision and the exact-node
      // resolver fence capture; large data URLs must not fill observation frames.
      if (['data:','blob:'].includes(result.media.uriScheme)) {
        delete result.media.src; delete result.media.href;
      }
    }
    if (kind === 'tool_call') {
      result.callId = callId; result.name = name;
      const status = attr(node, 'data-tool-status');
      if (['running', 'completed', 'failed'].includes(status)) result.status = status;
      const details = {};
      for (const field of ['input', 'output']) {
        const fields = [...node.querySelectorAll(`[data-testid="tool-call-${field}"]`)]
          .filter(n => readable(n, panels) && n.closest('[data-tool-call-id]') === node);
        if (fields.length === 1) details[field] = textOf(fields[0], n => n.nodeType === Node.TEXT_NODE ||
          (readable(n, panels) && !n.matches('button,script,style')));
      }
      if (Object.keys(details).length) result.details = details;
    }
    return result;
  }
  function sourceId(row, cid, issues) {
    const node = row.node, ids = nativeIds(node), turn = node.closest('[data-turn-key]');
    const base = cid || location.pathname;
    if (ids.length === 1 && !row.media) return { id: JSON.stringify([base, 'message', ids[0]]), nativeMessageId: ids[0] };
    if (ids.length > 1) issues.push({ code: 'AMBIGUOUS_MESSAGE_ID', order: row.order });
    if (unit(node)) return { id: JSON.stringify([base, 'unit', turn?.getAttribute('data-turn-key') || null, unit(node)]) };
    if (attr(node, 'data-tool-call-id')) return { id: JSON.stringify([base, 'call', attr(node, 'data-tool-call-id')]) };
    // React-generated overlay IDs are not native IDs, but can identify mounted
    // public fragments more precisely than positions. No text hashing/guessing.
    const overlay = attr(node, 'data-selected-text-overlay-target');
    issues.push({ code: 'DOM_LOCAL_IDENTITY', order: row.order });
    return { id: JSON.stringify([base, 'dom', turn?.getAttribute('data-turn-key') || null,
      overlay || pathOf(node, turn || document.body), row.mediaKind || 'text']) };
  }
  function approvalButtons(card) {
    const buttons = [...card.querySelectorAll('button')].filter(button =>
      button.closest(APPROVAL) === card && visible(button) && !button.disabled &&
      !button.matches(':disabled') && attr(button, 'aria-disabled') !== 'true' && !button.hasAttribute('aria-haspopup'));
    const groups = {persistent:[], once:[], confirm:[], reconnect:[], deny:[]};
    for (const button of buttons) {
      const value = caption(button), tier = approvalTier(value);
      if (tier) groups[tier].push({button, label:value});
    }
    const tier = groups.persistent.length ? 'persistent' : groups.once.length ? 'once' :
      groups.confirm.length ? 'confirm' : null;
    const cardText = textOf(card, node => node.nodeType === Node.TEXT_NODE ||
      (readable(node) && visible(node)));
    const context = APPROVAL_CONTEXT.test(cardText);
    const reconnect = groups.reconnect.length === 1 && groups.deny.length === 1 &&
      APPROVAL_RECONNECT.test(cardText);
    const autoEligible = Boolean(tier && groups.deny.length > 0 &&
      (tier !== 'confirm' || context));
    const clickable = (groups.once.length === 1 || reconnect) && groups.deny.length === 1;
    const manualAllow = groups.once.length === 1 ? groups.once[0] : reconnect ? groups.reconnect[0] : null;
    return {
      allow: clickable ? manualAllow.button : null,
      deny: clickable ? groups.deny[0].button : null,
      labels: buttons.map(button => caption(button)).filter(Boolean),
      groups, tier, autoEligible, reconnect
    };
  }
  function linkedApprovalPanels(card) {
    const panels = new Set();
    for (const control of card.querySelectorAll('button[aria-controls][aria-haspopup="dialog"][aria-expanded="true"]')) {
      if (!visible(control)) continue;
      const ids = attr(control, 'aria-controls').trim().split(/\s+/);
      if (ids.length !== 1) continue;
      const panel = document.getElementById(ids[0]);
      if (panel && visible(panel) && !panel.contains(card) && panel.matches('[role="dialog"]')) panels.add(panel);
    }
    return panels;
  }
  function approvalApp(card) {
    // The first native alert row is the app header in the captured cards.
    // Do not fabricate a provider/app name when a different layout lacks it.
    const headers = [...card.querySelectorAll('[role="alert"] > div > div:first-child > span')].filter(visible);
    if (headers.length === 1) return caption(headers[0]);
    const alerts = [...card.querySelectorAll('[role="alert"]')].filter(visible);
    if (alerts.length === 1) {
      const match = /^Allow ChatGPT to use (?:your )?([^?\n]+)\?$/i.exec(caption(alerts[0]));
      if (match) return match[1]; // Exact substring of the displayed title.
    }
    return null;
  }
  function trackApproval(key, card, root) {
    const parent = card.parentElement;
    approvalTracking.set(key, { card, parent, root });
    if (!parentObservers.has(parent)) {
      const watched = { records: [], observer: null };
      watched.observer = new MutationObserver(records => watched.records.push(...records));
      watched.observer.observe(parent, { childList: true });
      parentObservers.set(parent, watched);
    }
  }
  function closedApprovals(scopes) {
    if (approvalPath !== location.pathname) {
      for (const watched of parentObservers.values()) watched.observer.disconnect();
      parentObservers.clear(); approvalTracking.clear(); confirmedClosed.clear();
      approvalPath = location.pathname;
      return [];
    }
    const changes = new Map();
    for (const [parent, watched] of parentObservers) {
      changes.set(parent, [...watched.records, ...watched.observer.takeRecords()]);
      watched.records.length = 0;
    }
    for (const [key, source] of approvalTracking) {
      const { card, parent, root } = source, records = changes.get(parent) || [];
      // Require exact card removal from a still-live parent, not disappearance
      // of its page/turn/panel, a replacement render, a fold or disabled buttons.
      // This proves removal only; it NEVER proves Allow or Deny.
      const replaced = records.some(record => record.addedNodes.length > 0);
      const removed = records.some(record => [...record.removedNodes].includes(card));
      let folded = Boolean(parent.closest('details:not([open])'));
      for (const control of root.querySelectorAll('[aria-controls][aria-expanded="false"]')) {
        const ids = (attr(control, 'aria-controls') || '').trim().split(/\s+/);
        if (ids.some(id => document.getElementById(id)?.contains(parent))) folded = true;
      }
      if (removed && !replaced && !folded && !card.isConnected && scopes.includes(root) &&
          root.isConnected && parent.isConnected && visible(parent)) confirmedClosed.add(key);
      if (!card.isConnected) approvalTracking.delete(key);
    }
    for (const [parent, watched] of parentObservers) {
      if (![...approvalTracking.values()].some(source => source.parent === parent)) {
        watched.observer.disconnect(); parentObservers.delete(parent);
      }
    }
    return [...confirmedClosed]; // Replay confirmed closures until navigation; transport may retry.
  }
  // Integration: retain raw `text` separately when projecting to the strict
  // server approvalEvent({state:'open', ...requestWithoutText}) envelope. An
  // unknown app stays null and is reported, not renamed to pass that validator.
  function approvalsIn(scopes, issues, detailsPanels = new Set()) {
    const result = [];
    for (const root of scopes) for (const card of root.querySelectorAll(APPROVAL)) {
      try {
        if (!visible(card)) continue;
        const buttons = approvalButtons(card);
        // A disabled historical card is not a currently actionable request.
        if (!buttons.labels.length) continue;
        const publicText = node => textOf(node, n => n.nodeType === Node.TEXT_NODE ||
          (readable(n) && !n.matches('button,script,style,svg')));
        const panels = [...linkedApprovalPanels(card)];
        for (const panel of panels) detailsPanels.add(panel);
        const fields = panels.flatMap(panel => [...panel.querySelectorAll('pre')].filter(visible));
        const input = fields.length === 1 ? publicText(fields[0]) : null;
        const text = [publicText(card), ...panels.filter(panel => !card.contains(panel)).map(publicText)].filter(Boolean).join('\n');
        const fingerprint = JSON.stringify([conversationId(), text, buttons.labels, input]);
        let saved = keys.get(card);
        if (!saved || saved.fingerprint !== fingerprint) {
          saved = { key: `${documentKey}-${++keySequence}`, fingerprint };
          keys.set(card, saved);
        }
        const clickable = Boolean(buttons.allow && buttons.deny), app = approvalApp(card);
        trackApproval(saved.key, card, root);
        result.push({ key: saved.key, text, app, tool: null, input, clickable, labels: buttons.labels,
          autoEligible: buttons.autoEligible, autoTier: buttons.tier,
          ...(clickable ? { allowLabel: caption(buttons.allow), denyLabel: caption(buttons.deny) } : {}) });
        if (!clickable) issues.push({ code: 'APPROVAL_ACTIONS_UNRECOGNIZED', key: saved.key });
        // Preserve out-of-contract source values rather than truncate/rename
        // them to satisfy approvalEvent. Integration must surface these issues.
        if (!app || !/^[\p{L}\p{N}_.: ·()-]{1,80}$/u.test(app))
          issues.push({ code: 'APPROVAL_APP_UNCONFIRMED', key: saved.key });
        if ((input !== null && (input.length > 4096 || input.includes('\0') || !input.isWellFormed())) ||
            buttons.labels.length > 16 || buttons.labels.some(label => label.length > 40 || /[\n\0]/.test(label)))
          issues.push({ code: 'APPROVAL_SERVER_SHAPE_UNSUPPORTED', key: saved.key });
      } catch { issues.push({ code: 'APPROVAL_READ_FAILED' }); }
    }
    return result;
  }
  function read() {
    const issues = [], items = [], cid = conversationId(), scopes = roots(issues);
    mediaNodes = new Map();
    // Approval reading is deliberately independent of prose availability.
    const approvalDetails = new Set();
    let closed = [];
    try { closed = closedApprovals(scopes); }
    catch { issues.push({ code: 'APPROVAL_CLOSURE_UNCONFIRMED' }); }
    const approvals = approvalsIn(scopes, issues, approvalDetails), seen = new Map();
    let userMessageId = null;
    for (const root of scopes) {
      let panels, rows;
      try {
        panels = disclosures(root, issues);
        rows = collect(root, panels, approvalDetails, issues).sort((a, b) => {
          const position = a.node.compareDocumentPosition(b.node);
          return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
        });
      } catch {
        issues.push({ code: 'CONTENT_LANE_READ_FAILED' });
        continue; // A content-lane failure must not veto independently read approvals.
      }
      for (const row of rows) {
        try {
          const item = { ...sourceId(row, cid, issues), userMessageId: null, ...classify(row, panels) };
          const previous = seen.get(item.id);
          if (previous) {
            mediaNodes.delete(item.id); // An ambiguous alias cannot authorize a resource capture.
            if (['text', 'role', 'lane', 'kind'].every(field => previous[field] === item[field]) &&
                JSON.stringify(previous.media) === JSON.stringify(item.media)) continue;
            issues.push({ code: 'SOURCE_ID_CONFLICT', id: item.id, order: item.order });
            item.id = JSON.stringify([item.id, 'conflict', item.order]);
            delete item.nativeMessageId; // Cannot attribute a conflicting copy to a native message.
          }
          if (item.role === 'user') userMessageId = item.nativeMessageId || item.id;
          const inTurn = row.node.closest('[data-turn-key],section[data-testid^="conversation-turn"]');
          // The composer disclaimer is fixed UI chrome, not a page notice. It has
          // no turn/native identity; keep all other page errors and notices.
          if (item.role === 'page' && item.kind === 'notice' && !inTurn &&
              item.nativeMessageId === undefined &&
              (/ChatGPT can make mistakes|ChatGPT 可能会犯错|ChatGPT 可能會出錯/i.test(item.text) ||
               /^(?:Worked|Thought) for\b/i.test(item.text.trim()) ||
               /^(?:已工作|已用时)\b/.test(item.text.trim())))
            continue;
          item.userMessageId = item.role === 'page' && item.kind === 'notice' && !inTurn ? null : userMessageId;
          if (row.media) {
            mediaNodes.set(item.id,{node:row.node,kind:row.mediaKind,cid});
            if (!item.media.provenance) issues.push({code:'MEDIA_SOURCE_UNSUPPORTED',sourceId:item.id});
          }
          seen.set(item.id, item); items.push(item);
        } catch { issues.push({ code: 'SOURCE_CLASSIFICATION_FAILED', order: row.order }); }
      }
    }
    return { conversationId: cid, observedAt: Date.now(), items, approvals, closedApprovals: closed, issues };
  }
  function resolveApproval(key, choice) {
    if (choice !== 'allow-once' && choice !== 'deny') return null;
    const issues = [], scopes = roots(issues);
    const requests = approvalsIn(scopes, issues);
    if (!requests.some(request => request.key === key && request.clickable)) return null;
    for (const root of scopes) for (const card of root.querySelectorAll(APPROVAL)) {
      if (keys.get(card)?.key !== key || !visible(card)) continue;
      const buttons = approvalButtons(card);
      if (buttons.allow && buttons.deny) return choice === 'deny' ? buttons.deny : buttons.allow;
    }
    return null;
  }
  function resolveApprovalAuto(key) {
    const issues = [], scopes = roots(issues);
    const requests = approvalsIn(scopes, issues);
    if (!requests.some(request => request.key === key && request.autoEligible)) return null;
    for (const root of scopes) for (const card of root.querySelectorAll(APPROVAL)) {
      if (keys.get(card)?.key !== key || !visible(card)) continue;
      const buttons = approvalButtons(card);
      if (!buttons.autoEligible || !buttons.tier) continue;
      const group = buttons.groups[buttons.tier];
      if (group.length) return {tier: buttons.tier, buttons: group.map(value => value.button)};
    }
    return null;
  }
  function resolveMedia(id) {
    const known = mediaNodes.get(id);
    if (!known || known.cid !== conversationId() || !known.node.isConnected) return null;
    const scopes = roots([]), root = scopes.find(scope=>scope.contains(known.node));
    if (!root || !readable(known.node,disclosures(root,[]))) return null;
    // Re-read ownership and resource selection NOW, not the previous frame.
    return {node:known.node,...mediaEvidence(known.node,known.kind)};
  }
  globalThis.CIP_PAGE_CONTENT = Object.freeze({ read, resolveApproval, resolveApprovalAuto, resolveMedia });
})();
