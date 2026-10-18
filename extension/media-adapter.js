/* CIP transport for CoS public image descriptors/pixels. No URLs or credentials. */
(() => {
  'use strict';
  const fail = code => { throw Object.assign(new Error(code), {code}); };
  const id = x => typeof x === 'string' && /^[A-Za-z0-9:._-]{1,200}$/.test(x) && !/^fallback-turn-/i.test(x) && !/:(user|assistant)$/.test(x);
  const errors = new Set(['not_loaded','not_rendered','oversized','tainted','capture_failed']);
  function project(value) {
    const list = value.images ?? []; if (!Array.isArray(list) || list.length > 96) fail('IMAGE_COUNT_LIMIT');
    const seen = new Set();
    const images = list.map(row => {
      if (!id(row?.userMessageId) || !id(row?.messageId) || typeof row.assetId !== 'string' || !/^file_[A-Za-z0-9_-]{8,100}$/.test(row.assetId) || typeof row.completed !== 'boolean') fail('IMAGE_IDENTITY_UNPROVEN');
      const key = `${row.userMessageId}:${row.messageId}:${row.assetId}`; if(seen.has(key))fail('IMAGE_IDENTITY_UNPROVEN');seen.add(key);
      const out = {userMessageId:row.userMessageId,messageId:row.messageId,assetId:row.assetId,completed:row.completed};
      for(const k of ['width','height'])if(row[k]!==undefined){if(!Number.isInteger(row[k])||row[k]<1||row[k]>30000)fail('IMAGE_DIMENSIONS_INVALID');out[k]=row[k]}
      return out;
    });
    const imageFinalId=value.imageFinalId??null;
    if(imageFinalId!==null && (!id(imageFinalId)||!images.some(x=>x.messageId===imageFinalId&&x.completed)))fail('IMAGE_IDENTITY_UNPROVEN');
    const mediaError=['IMAGE_IDENTITY_UNPROVEN','IMAGE_COUNT_LIMIT'].includes(value.mediaError)?value.mediaError:null;
    return {images,imageFinalId,mediaError};
  }
  async function capture(image,guard) {
    guard();const pathname=location.pathname,nonce=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);removeEventListener('message',receive);error?reject(error):resolve(value)};
      const receive=e=>{
        const d=e.data;if(e.source!==window||e.origin!==location.origin||d?.source!=='cip-cos-image-reply'||d.v!==1||d.nonce!==nonce)return;
        try {
          guard();if(pathname!==location.pathname)fail('IMAGE_OWNER_CHANGED');
          const v=d.value;if(v?.error)fail('IMAGE_CAPTURE_FAILED');
          if(v?.previewStatus==='unavailable' && errors.has(v.previewError))return finish(null,{previewStatus:v.previewStatus,previewError:v.previewError});
          if(v?.previewStatus!=='available'||typeof v.previewDataUrl!=='string'||v.previewDataUrl.length>512100||!/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(v.previewDataUrl))fail('IMAGE_DATA_INVALID');
          if(![v.previewWidth,v.previewHeight].every(n=>Number.isInteger(n)&&n>0&&n<=1600))fail('IMAGE_DIMENSIONS_INVALID');
          finish(null,{previewStatus:'available',previewDataUrl:v.previewDataUrl,previewWidth:v.previewWidth,previewHeight:v.previewHeight});
        }catch(e){finish(e)}
      };
      const timer=setTimeout(()=>finish(null,{previewStatus:'unavailable',previewError:'capture_failed'}),6500);
      addEventListener('message',receive);
      window.postMessage({source:'cip-cos-image-ask',nonce,image:{userMessageId:image.userMessageId,messageId:image.messageId,assetId:image.assetId}},location.origin);
    });
  }
  // Original-resource transport is separate from the lossy canvas preview above.
  // No text URL discovery, private React/cache access, token/cookie extraction,
  // synthetic clicks, cross-origin fetching or backend URL construction.
  const originalLimit = 16 * 1024 * 1024, originalChunk = 32768;
  const originalMimes = new Set(['image/png','image/jpeg','image/webp','image/gif','application/pdf','application/zip','application/octet-stream','text/plain','text/csv','text/markdown','application/json']);
  const originals = new Map(); let fetchingOriginals = 0;
  const excludedOriginal = '.clf-stream,.clf-stage,.clf-composer,.clf-boot,[data-cip-owned],.sr-only,.visually-hidden,[data-is-visually-hidden="true"],nav,aside,form,[contenteditable="true"],[data-message-channel="analysis"],[data-message-channel="private"],[data-channel="analysis"],[data-channel="private"],[data-private="true"],[data-reasoning-visibility="private"],[data-summary-type="raw_cot"]';
  function originalVisible(node) {
    if (!node?.isConnected || node.closest(excludedOriginal)) return false;
    for (let at = node; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (at.hidden || at.hasAttribute('inert') || at.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' || ['hidden','collapse'].includes(style.visibility) || style.opacity === '0' || style.contentVisibility === 'hidden' ||
          (at.tagName === 'DETAILS' && !at.open)) return false;
    }
    return node.getClientRects().length > 0;
  }
  function originalOwner(node) {
    const owner = node.closest('[data-message-id],[data-chatgpt-search-message-ids]');
    if (!owner) return null;
    const direct = owner.getAttribute('data-message-id'), raw = owner.getAttribute('data-chatgpt-search-message-ids');
    let ids = [];
    if (raw) { try { ids = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.trim().split(/\s+/); } catch { return null; } }
    if (!Array.isArray(ids)) return null;
    if (direct) ids.push(direct);
    ids = [...new Set(ids)]; return ids.length === 1 && id(ids[0]) ? ids[0] : null;
  }
  function originalSource(descriptor) {
    const cid = /^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9-]{8,100})\/?$/.exec(location.pathname)?.[1];
    if (location.origin !== 'https://chatgpt.com' || !cid || descriptor?.conversationId !== cid ||
        !id(descriptor.messageId) || !/^file_[A-Za-z0-9_-]{8,100}$/.test(descriptor.assetId) || !['image','file'].includes(descriptor.kind)) return null;
    const roots = [...document.querySelectorAll('main,[role="main"],[data-app-shell-main-surface]')].filter(originalVisible);
    const outer = roots.filter(node => !roots.some(other => other !== node && other.contains(node)));
    if (outer.length !== 1) return null;
    const selector = descriptor.kind === 'image' ? '[class~="group/imagegen-image"] img,[class~="group/generated-image-preview"] img' : 'a[download][data-file-id]';
    const matches = [];
    for (const node of outer[0].querySelectorAll(selector)) {
      if (!originalVisible(node) || originalOwner(node) !== descriptor.messageId) continue;
      let conflict = false;
      for (let at = node; at; at = at.parentElement) {
        if ((at.hasAttribute('data-conversation-id') && at.getAttribute('data-conversation-id') !== cid) || at.getAttribute('data-message-author-role') === 'user') { conflict = true; break; }
      }
      if (conflict) continue;
      if (descriptor.kind === 'file' && (node.getAttribute('data-file-id') !== descriptor.assetId || node.closest('.markdown,[data-markdown-text-style]'))) continue;
      let url; try { url = new URL(descriptor.kind === 'image' ? node.currentSrc || node.src : node.href, location.href); } catch { continue; }
      // Only an already-displayed native, exact asset endpoint, without size,
      // thumbnail, URL-proxy or redirect parameters. Blob/sandbox/CDN sources
      // without a separately proven original resource are unsupported.
      if (url.origin !== location.origin || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
          url.pathname !== '/backend-api/estuary/content' || url.searchParams.get('id') !== descriptor.assetId ||
          [...url.searchParams.keys()].length !== 1) continue;
      matches.push({ node, url: url.href });
    }
    return matches.length === 1 ? matches[0] : null;
  }
  const raster = new Set(['image/png','image/jpeg','image/webp','image/gif']);
  const provenance = new Set(['native-original','visible-image-resource','rendered-preview']);
  const conversationHere = () => location.origin === 'https://chatgpt.com' ?
    /^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9-]{8,100})(?:\/|$)/.exec(location.pathname)?.[1] : null;
  function resolvedImage(descriptor, visible = true) {
    if (descriptor.kind !== 'image' || descriptor.conversationId !== conversationHere() ||
        typeof descriptor.sourceId !== 'string' || !descriptor.sourceId || descriptor.sourceId.length > 8192) return null;
    const value = globalThis.CIP_PAGE_CONTENT?.resolveMedia?.(descriptor.sourceId), node = value?.node;
    if (value?.kind !== 'image' || node?.tagName !== 'IMG' || !node.isConnected ||
        (value.messageId ?? null) !== descriptor.messageId || (value.assetId ?? null) !== descriptor.assetId ||
        (value.resourceRevision ?? null) !== descriptor.resourceRevision ||
        node.closest(excludedOriginal) || (visible && !originalVisible(node))) return null;
    const roots = [...document.querySelectorAll('main,[role="main"],[data-app-shell-main-surface]')].filter(originalVisible);
    const outer = roots.filter(root => !roots.some(other => other !== root && other.contains(root)));
    if (visible && (outer.length !== 1 || !outer[0].contains(node))) return null;
    for (let at=node;at;at=at.parentElement) {
      if (at.hasAttribute('data-conversation-id') && at.getAttribute('data-conversation-id') !== descriptor.conversationId) return null;
    }
    const owner = originalOwner(node);
    if (descriptor.messageId !== null && owner !== null && owner !== descriptor.messageId) return null;
    const asset = node.getAttribute('data-file-id');
    if (asset && descriptor.assetId !== null && asset !== descriptor.assetId) return null;
    const url = node.currentSrc || node.src;
    return typeof url === 'string' && url ? {node,url,owner} : null;
  }
  function expireOriginals() { for (const [key,row] of originals) if (Date.now() - row.created > 60000) originals.delete(key); }
  // Retained transport name, NOT a claim of originality: provenance declares
  // whether these are native bytes, a displayed image resource, or a preview.
  async function captureOriginal(input, guard) {
    if (typeof guard !== 'function') fail('ARTIFACT_GUARD_REQUIRED'); guard(); expireOriginals();
    const descriptor = {sourceId:input?.sourceId,conversationId:input?.conversationId,messageId:input?.messageId ?? null,
      assetId:input?.assetId ?? null,kind:input?.kind,provenance:input?.provenance,resourceRevision:input?.resourceRevision ?? null};
    if (!provenance.has(descriptor.provenance) || descriptor.conversationId !== conversationHere() ||
        (descriptor.messageId !== null && !id(descriptor.messageId)) ||
        (descriptor.assetId !== null && (typeof descriptor.assetId !== 'string' || !/^file_[A-Za-z0-9_-]{8,100}$/.test(descriptor.assetId))) ||
        (descriptor.provenance === 'native-original' ? !descriptor.messageId || !descriptor.assetId : descriptor.kind !== 'image'))
      return {status:'unsupported',reason:'native_source_unproven'};
    // A page-reader revision mismatch is asset replacement, not a reason to
    // capture a new image under an old ledger/source identity.
    if (descriptor.kind === 'image' && typeof globalThis.CIP_PAGE_CONTENT?.resolveMedia === 'function' && !resolvedImage(descriptor))
      return {status:'unsupported',reason:'native_source_unproven'};
    const source = descriptor.provenance === 'native-original' ? originalSource(descriptor) : resolvedImage(descriptor);
    // Native original retrieval keeps its old strict endpoint/owner proof.
    // Only a DOM resolver can authorize displayed pixels or an image fallback.
    const fallback = descriptor.kind === 'image' ? resolvedImage(descriptor) : null;
    if (!source && !fallback) return {status:'unsupported',reason:'native_source_unproven'};
    if (originals.size + fetchingOriginals >= 2) return {status:'unsupported',reason:'capture_busy'};
    const initial = source || fallback, url = initial.url, node = initial.node, owner = originalOwner(node);
    if (descriptor.provenance !== 'native-original' && (!node.complete || !node.naturalWidth || !node.naturalHeight)) return {status:'unsupported',reason:'not_loaded'};
    const current = () => {
      guard(); if (descriptor.conversationId !== conversationHere()) fail('ARTIFACT_OWNER_CHANGED');
      // Once captured, hiding/folding/unmounting is not asset replacement.
      if ((node.currentSrc || node.src || node.href) !== url) fail('ARTIFACT_OWNER_CHANGED');
      if (node.isConnected && originalOwner(node) !== owner) fail('ARTIFACT_OWNER_CHANGED');
      const exposed = descriptor.kind === 'image' ? globalThis.CIP_PAGE_CONTENT?.resolveMedia?.(descriptor.sourceId) : null;
      const now = exposed ? resolvedImage(descriptor,false) : null;
      if (exposed && (!now || now.url !== url)) fail('ARTIFACT_OWNER_CHANGED');
    };
    const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),15000); fetchingOriginals++;
    const unsupported = reason => ({status:'unsupported',reason});
    async function readResource(resourceUrl,native) {
      const response = await fetch(resourceUrl,{method:'GET',credentials:native?'same-origin':'omit',
        redirect:'error',mode:'same-origin',signal:controller.signal});
      current();
      if (!response.ok || response.redirected || response.url !== resourceUrl) return unsupported('resource_unavailable');
      const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!originalMimes.has(mimeType) || (descriptor.kind === 'image' && !raster.has(mimeType))) return unsupported('mime_unsupported');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length)>originalLimit)) return unsupported('oversized');
      if (!response.body) return unsupported('resource_unavailable');
      const reader=response.body.getReader();let size=0,storage=new Uint8Array(65536);
      try {
        while (true) {
          const part=await reader.read();current();if(part.done)break;
          const next=size+part.value.length;if(next>originalLimit)return unsupported('oversized');
          if(next>storage.length){const grown=new Uint8Array(Math.min(originalLimit,Math.max(next,storage.length*2)));grown.set(storage);storage=grown;}
          storage.set(part.value,size);size=next;
        }
      } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      return size?{bytes:storage.subarray(0,size),mimeType}:unsupported('resource_unavailable');
    }
    async function preview() {
      if (!fallback || fallback.url !== url) return unsupported('native_source_unproven');
      if (!node.complete || !node.naturalWidth || !node.naturalHeight) return unsupported('not_loaded');
      if (node.naturalWidth*node.naturalHeight>30000000) return unsupported('oversized');
      current();
      try {
        const scale=Math.min(1,1600/Math.max(node.naturalWidth,node.naturalHeight));
        const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(node.naturalWidth*scale));canvas.height=Math.max(1,Math.round(node.naturalHeight*scale));
        const context=canvas.getContext('2d');if(!context)return unsupported('preview_failed');
        // drawImage consumes already-loaded pixels. It never initiates fetch.
        context.drawImage(node,0,0,canvas.width,canvas.height);
        const blob=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('preview_failed')),5000);canvas.toBlob(value=>{clearTimeout(timeout);resolve(value)},'image/webp',0.8)});
        current();
        if(!blob||!raster.has(blob.type)||!blob.size||blob.size>384000)return unsupported('oversized');
        const bytes=new Uint8Array(await blob.arrayBuffer());current();return {bytes,mimeType:blob.type};
      } catch(error) {current();return unsupported(error?.name==='SecurityError'?'tainted':'preview_failed');}
    }
    try {
      let value,actual=descriptor.provenance;
      if (source && descriptor.provenance === 'native-original') {
        try {value=await readResource(url,true);} catch(error) {current();value=unsupported(error?.name==='AbortError'?'capture_timeout':'resource_unavailable');}
      } else if (descriptor.provenance === 'visible-image-resource') {
        let parsed;try{parsed=new URL(url,location.href);}catch{return unsupported('native_source_unproven');}
        const localBlob=parsed.protocol==='blob:' && parsed.origin===location.origin;
        const localData=/^data:image\/(?:png|jpeg|webp|gif)(?:;[^,\r\n]*)?,/i.test(url);
        // No HTTP(S)/CDN/localhost URL, even when the caller supplied one.
        if (parsed.protocol==='data:'&&!localData)return unsupported('mime_unsupported');
        if(localData&&url.length>originalLimit*3+128)value=unsupported('oversized');
        else if(localBlob||localData)try{value=await readResource(url,false);}catch(error){current();value=unsupported(error?.name==='AbortError'?'capture_timeout':'resource_unavailable');}
        else value=unsupported('native_source_unproven');
      }
      if (!value?.bytes && fallback) {
        const previous=value;
        value=await preview();actual='rendered-preview';
        if(!value.bytes && value.reason==='not_loaded' && previous)return previous;
      }
      if (!value?.bytes) return value || unsupported('native_source_unproven');
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',value.bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');current();
      let binary='';for(let at=0;at<value.bytes.length;at+=0x8000)binary+=String.fromCharCode(...value.bytes.subarray(at,at+0x8000));
      const extensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','application/pdf':'pdf','application/zip':'zip','text/plain':'txt','text/csv':'csv','text/markdown':'md','application/json':'json'};
      const proposed=actual==='native-original'?node.getAttribute('download'):null;
      const stem=actual==='native-original'?descriptor.assetId:actual==='visible-image-resource'?'web-image':'preview';
      const name=proposed&&proposed.length<=180&&!/[\\/:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(proposed)&&!/^\.+$/.test(proposed)?proposed:stem+'.'+(extensions[value.mimeType]||'bin');
      const transferId=crypto.randomUUID();originals.set(transferId,{encoded:btoa(binary),current,created:Date.now()});
      return {status:'available',provenance:actual,messageId:descriptor.messageId,assetId:descriptor.assetId,transferId,
        digest,mimeType:value.mimeType,bytes:value.bytes.length,name};
    } finally {clearTimeout(timer);controller.abort();fetchingOriginals--;}
  }
  function readOriginal(transferId, offset = 0, guard) {
    if(typeof guard!=='function')fail('ARTIFACT_GUARD_REQUIRED');guard();expireOriginals();
    const row=originals.get(transferId);if(!row)fail('ARTIFACT_TRANSFER_UNKNOWN');
    try{row.current();}catch(error){originals.delete(transferId);throw error;}
    if(!Number.isSafeInteger(offset)||offset<0||offset%4||offset>=row.encoded.length)fail('ARTIFACT_OFFSET_INVALID');
    const end=Math.min(row.encoded.length,offset+originalChunk);
    return {data:row.encoded.slice(offset,end),nextOffset:end<row.encoded.length?end:null,total:row.encoded.length};
  }
  function releaseOriginal(transferId) {originals.delete(transferId);}
  globalThis.CIP_MEDIA=Object.freeze({project,capture,captureOriginal,readOriginal,releaseOriginal});
})();
