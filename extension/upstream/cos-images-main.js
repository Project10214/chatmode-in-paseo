/* Chat On Steroids — MIT, Copyright (c) 2026 Chat On Steroids contributors.
 * Sources @ e40562640361ca8f74158b2262ca8c555b00abed:
 * extension/fiber.js generatedImagesOf (784–880), shellTurnSource image branch (2222–2274);
 * extension/content.js nativeImageNode/captureNativeImage (4062–4217).
 * CIP: bounded public descriptors and already-rendered WebP pixels only; no URLs,
 * credentials, tool arguments or original-file requests cross worlds. Native image
 * identity and native completion remain separate from successful preview capture.
 */
(() => {
  'use strict';
  const ASSET = /^sediment:\/\/(file_[A-Za-z0-9_-]{8,100})$/;
  const IMAGES = '[class~="group/imagegen-image"] img, [class~="group/generated-image-preview"] img';
  const OWN = '.clf-stream,.clf-stage,.clf-composer,.clf-boot,[hidden],[aria-hidden="true"],[inert]';
  const id = v => typeof v === 'string' && /^[A-Za-z0-9:._-]{1,200}$/.test(v) && !/^fallback-turn-/i.test(v) && !/:(user|assistant)$/.test(v) ? v : null;
  const visible = n => {
    if (!n?.isConnected || n.closest(OWN)) return false;
    for (let p = n; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden') return false; }
    return true;
  };
  globalThis.CIP_createCoSImages = ({ fiberOf, core }) => {
    let records = new Map(), scanPath = '', finalId = null, mediaError = null;
    const keyOf = x => `${x.userMessageId}\u0000${x.messageId}\u0000${x.assetId}`;
    function begin() { records = new Map(); scanPath = location.pathname; finalId = null; mediaError = null; }
    function ownerOf(fiber) {
      for (let f = fiber, up = 0; f && up < 80; f = f.return, up++) {
        const p = f.memoizedProps;
        if (Array.isArray(p?.entry?.turn?.items)) return { turn: p.entry.turn, entry: p.entry };
        if (Array.isArray(p?.turn?.items)) return { turn: p.turn, entry: null };
      }
      return null;
    }
    function generatedImagesOf(messages) {
      const out = [], seen = new Set(); let userMessageId = null;
      for (const m of messages) {
        if(m?.author?.role==='user'){userMessageId=id(m.id);continue;}
        if(!userMessageId)continue;
        if (core.hiddenMessage(m) || core.channelOf(m) === 'analysis' || !['tool','assistant'].includes(m?.author?.role) || m.recipient !== 'all' || !['final',null,''].includes(core.channelOf(m))) continue;
        if (!id(m.id) || m.content?.content_type !== 'multimodal_text' || !Array.isArray(m.content.parts)) continue;
        for (const part of m.content.parts.slice(0,32)) {
          if (part?.content_type !== 'image_asset_pointer') continue;
          const assetId = typeof part.asset_pointer === 'string' ? ASSET.exec(part.asset_pointer)?.[1] : null;
          if (!assetId) continue;
          const key = `${m.id}\u0000${assetId}`; if (seen.has(key)) continue; seen.add(key);
          const row = { userMessageId, messageId: m.id, assetId, completed: m.status === 'finished_successfully' };
          for (const k of ['width','height']) if (Number.isInteger(part[k]) && part[k] > 0 && part[k] <= 30000) row[k] = part[k];
          out.push(row);
        }
      }
      return out;
    }
    function add({ fiber, section, messages, scope }) {
      const conversation = /^\/(?:g\/[^/]+\/)?c\/([^/]+)/.exec(location.pathname)?.[1];
      if (scope?.conflict || scope?.conversationId !== conversation) return;
      mediaError = null;
      const owner = ownerOf(fiber), shellImages = new Map();
      let native = messages || [], lastAnswer = null, imageEnd = null, invalid = false;
      if (owner) {
        native = [...native]; const turn = owner.turn;
        if (turn.items.length > 400) return;
        const user = turn.items.filter(x => x?.type === 'user-message').at(-1);
        const userId = id(user?.messageId) || id(user?.serverMessageId);
        if (!userId || (user.messageId && user.serverMessageId && user.messageId !== user.serverMessageId)) return;
        for (const item of turn.items) {
          if (item?.type === 'assistant-message' && item.phase === 'final_answer') lastAnswer = item;
          if (item?.type !== 'generated-image') continue;
          lastAnswer = item;
          const messageId = id(item.chatGptMessageId), assetId = typeof item.src === 'string' && ASSET.exec(item.src)?.[1];
          if (!messageId || !assetId || !Array.isArray(turn.messageIds) || !turn.messageIds.includes(messageId)) { invalid = true; continue; }
          shellImages.set(item, assetId);
          native.push({ id: messageId, author: {role:'tool'}, recipient:'all', channel:'final',
            status: item.status === 'completed' && item.isPreview !== true ? 'finished_successfully' : 'in_progress',
            content: { content_type:'multimodal_text', parts:[{content_type:'image_asset_pointer',asset_pointer:item.src,width:item.width,height:item.height}] } });
        }
        if (lastAnswer?.type === 'generated-image' && turn.status === 'complete') {
          if (invalid) mediaError = 'IMAGE_IDENTITY_UNPROVEN';
          if (!invalid && shellImages.has(lastAnswer) && turn.items.filter(x=>x?.type==='generated-image').every(x=>shellImages.has(x)&&x.status==='completed'&&x.isPreview!==true)) imageEnd = lastAnswer.chatGptMessageId;
        }
      }
      const userId = native.filter(m => m?.author?.role === 'user').at(-1)?.id;
      if (!id(userId)) return;
      const descriptors = generatedImagesOf(native, userId);
      if (descriptors.length > 8) { mediaError = 'IMAGE_COUNT_LIMIT'; return; }
      if (!owner && descriptors.length) {
        const last = native.at(-1);
        if (last?.author?.role === 'assistant' && last.end_turn === true && last.status === 'finished_successfully' && descriptors.some(x=>x.messageId===last.id)) imageEnd = last.id;
      }
      // Later sources without image completion retire older completion evidence.
      finalId = imageEnd;
      for (const descriptor of descriptors) {
        const key = keyOf(descriptor), previous = records.get(key);
        if (previous && JSON.stringify(previous.descriptor) !== JSON.stringify(descriptor)) { mediaError = 'IMAGE_IDENTITY_UNPROVEN'; continue; }
        const record = previous || { descriptor, nodes: [] };
        for (const node of document.querySelectorAll(IMAGES)) {
          if (!visible(node)) continue;
          let url; try { url = new URL(node.currentSrc || node.src, location.href); } catch { continue; }
          if (url.origin !== location.origin) continue;
          let inOwner = section.contains(node), matchedAsset = null, control = null;
          for (let f = fiberOf(node), up = 0; f && up < 80; f = f.return, up++) {
            const p = f.memoizedProps;
            if (owner && (p?.entry === owner.entry && owner.entry || p?.turn === owner.turn)) inOwner = true;
            if (p?.imageId && !control) control = p;
            if (shellImages.has(p?.item)) {
              if (control?.imageId === p.item.id && control.isComplete === true && control.isPreview === false) matchedAsset = shellImages.get(p.item);
              inOwner = true;
            }
          }
          const exactUrl = url.protocol === 'https:' && url.pathname === '/backend-api/estuary/content' && url.searchParams.get('id') === descriptor.assetId;
          const exactBlob = url.protocol === 'blob:' && matchedAsset === descriptor.assetId;
          if (inOwner && (exactUrl || exactBlob) && !record.nodes.includes(node)) record.nodes.push(node);
        }
        records.set(key, record);
      }
    }
    function project() {
      return { images: [...records.values()].map(x=>x.descriptor), imageFinalId: finalId, mediaError };
    }
    function nativeImageNode(record) {
      const nodes = record.nodes.filter(visible);
      const loaded = n => n.complete && n.naturalWidth > 0 && n.naturalHeight > 0 ? 1 : 0;
      const area = n => { const r = n.getBoundingClientRect(); return Math.max(0,r.width)*Math.max(0,r.height); };
      nodes.sort((a,b)=>loaded(b)-loaded(a)||area(b)-area(a));
      return nodes[0] || null;
    }
    async function captureNativeImage(image) {
      const key = keyOf(image), record = records.get(key), path = scanPath;
      if (!record || path !== location.pathname || !record.descriptor.completed) return { previewStatus:'unavailable', previewError:'not_rendered' };
      const node = nativeImageNode(record);
      if (!node) return { previewStatus:'unavailable', previewError:'not_rendered' };
      const sourceWidth = node.naturalWidth, sourceHeight = node.naturalHeight, sourceUrl = node.currentSrc || node.src;
      if (!node.complete || !(sourceWidth > 0 && sourceHeight > 0)) return { previewStatus:'unavailable', previewError:'not_loaded' };
      if (sourceWidth * sourceHeight > 30000000) return { previewStatus:'unavailable', previewError:'oversized' };
      const current = () => path === location.pathname && visible(node) && node.complete && node.naturalWidth === sourceWidth && node.naturalHeight === sourceHeight && (node.currentSrc || node.src) === sourceUrl && records.get(key)?.descriptor.completed === true && records.get(key)?.nodes.includes(node);
      const scale = Math.min(1,1600/Math.max(sourceWidth,sourceHeight));
      const width = Math.max(1,Math.round(sourceWidth*scale)), height = Math.max(1,Math.round(sourceHeight*scale));
      try {
        const canvas = document.createElement('canvas'); canvas.width=width;canvas.height=height;
        const context=canvas.getContext('2d');if(!context)throw new Error('tainted');context.drawImage(node,0,0,width,height);
        const blob=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('capture_failed')),5000);canvas.toBlob(b=>{clearTimeout(timer);resolve(b)},'image/webp',0.8)});
        if(!current())return {error:'IMAGE_OWNER_CHANGED'};
        if(!blob||blob.type!=='image/webp'||blob.size<=0||blob.size>384000)throw new Error('oversized');
        const bytes=new Uint8Array(await blob.arrayBuffer());if(!current())return {error:'IMAGE_OWNER_CHANGED'};
        let binary='';for(let at=0;at<bytes.length;at+=0x8000)binary+=String.fromCharCode(...bytes.subarray(at,at+0x8000));
        return {previewStatus:'available',previewDataUrl:`data:image/webp;base64,${btoa(binary)}`,previewWidth:width,previewHeight:height};
      } catch(e) { return {previewStatus:'unavailable',previewError:['oversized','capture_failed'].includes(e.message)?e.message:'tainted'}; }
    }
    return {begin,add,project,captureNativeImage};
  };
})();
