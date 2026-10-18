/* Independent observation-lease media lane. observe() never awaits RPC/capture
 * and never reads page state, Stop controls, approvals or turn outcome. */
(() => {
  'use strict';
  const fail = code => { throw Object.assign(new Error(code),{code}); };
  const nativeId = value => typeof value === 'string' && /^[A-Za-z0-9:._-]{1,200}$/.test(value) &&
    !/^fallback-turn-/i.test(value) && !/:(?:user|assistant)$/.test(value);
  const reasons = new Set(['native_source_unproven','capture_busy','resource_unavailable','mime_unsupported','oversized','capture_timeout','not_loaded','tainted','preview_failed']);
  const canonical = value => Array.isArray(value) ? '['+value.map(canonical).join(',')+']' :
    value && typeof value === 'object' ? '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}' : JSON.stringify(value ?? null);
  const pause = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds));

  function create({rpc,guard,binding}) {
    if (typeof rpc !== 'function' || typeof guard !== 'function' || !binding || !['object','function'].includes(typeof binding)) fail('ARTIFACT_CONFIG_INVALID');
    const records = new Map(); let disposed = false, running = null, active = null;
    function currentBinding() {
      if (disposed || guard() === false) fail('ARTIFACT_BINDING_LOST');
      const value = typeof binding === 'function' ? binding() : binding;
      if (!value || typeof value.sessionId !== 'string' || typeof value.observationLease !== 'string' ||
          !Number.isInteger(value.tabId) || value.tabId < 0 || typeof value.documentKey !== 'string' || typeof value.url !== 'string') fail('ARTIFACT_BINDING_INVALID');
      let url; try { url = new URL(value.url); } catch { fail('ARTIFACT_BINDING_INVALID'); }
      const conversationId = /^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9-]{8,100})(?:\/|$)/.exec(url.pathname)?.[1];
      if (url.origin !== 'https://chatgpt.com' || !conversationId ||
          (value.conversationId !== undefined && value.conversationId !== conversationId)) fail('ARTIFACT_BINDING_INVALID');
      const envelope = {sessionId:value.sessionId,observationLease:value.observationLease,tabId:value.tabId,documentKey:value.documentKey,url:value.url};
      return {envelope,conversationId,key:canonical([value.sessionId,value.observationLease,value.tabId,value.documentKey,conversationId])};
    }
    function descriptor(item,bound) {
      const sourceId = item?.sourceId ?? item?.id, media = item?.media;
      if (typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 8192 || sourceId.includes('\0') ||
          (item.sourceId !== undefined && item.id !== undefined && item.sourceId !== item.id) ||
          !media || !['image','file'].includes(item.kind) || media.kind !== item.kind ||
          !['native-original','visible-image-resource','rendered-preview'].includes(media.provenance)) return null;
      const messageId=media.messageId ?? null,assetId=media.assetId ?? null;
      if ((messageId !== null && !nativeId(messageId)) || (assetId !== null && (typeof assetId !== 'string' || !/^file_[A-Za-z0-9_-]{8,100}$/.test(assetId))) ||
          (item.nativeMessageId != null && messageId !== null && item.nativeMessageId !== messageId) ||
          (media.provenance === 'native-original' ? messageId === null || assetId === null : media.kind !== 'image')) return null;
      const capture={sourceId,conversationId:bound.conversationId,messageId,assetId,kind:media.kind,provenance:media.provenance,resourceRevision:media.resourceRevision ?? null};
      return {sourceId,capture,visible:media.visible!==false,fingerprint:canonical([bound.key,sourceId,media.kind,media.provenance,messageId,assetId,
        media.src ?? null,media.url ?? null,media.href ?? null,media.resourceUrl ?? null,media.uriScheme ?? null,media.resourceRevision ?? null])};
    }
    function jobGuard(record,bound) {
      const now = currentBinding();
      if (now.key !== bound.key) fail('ARTIFACT_BINDING_LOST');
      if (records.get(record.sourceId) !== record) fail('ARTIFACT_SOURCE_CHANGED');
    }
    async function send(record,bound,type,payload) {
      const event = Object.freeze({type,...bound.envelope,sourceId:record.sourceId,...payload});
      let failure;
      for (let attempt=0;attempt<3;attempt++) {
        jobGuard(record,bound);
        try {
          const result = await rpc(event); jobGuard(record,bound); return result;
        } catch (error) {
          jobGuard(record,bound); failure = error;
          if (attempt<2) await pause(100*(attempt+1));
        }
      }
      throw failure;
    }
    function release(job) {
      if (!job?.transferId || job.released) return;
      job.released = true;
      try { job.media.releaseOriginal(job.transferId); } catch { /* Local release is best-effort, never a success receipt. */ }
    }
    function identityMatches(row,record,bound) {
      const data = row?.data, capture = record.capture;
      return row?.type === 'plugin' && row.kind === 'generated-file' && row.version === 1 && row.id === 'artifact:'+record.sourceId &&
        data?.sessionId === bound.envelope.sessionId && data.sourceId === record.sourceId && data.conversationId === bound.conversationId &&
        data.messageId === capture.messageId && data.assetId === capture.assetId && data.kind === capture.kind &&
        (data.provenance === capture.provenance || (capture.kind === 'image' && data.provenance === 'rendered-preview'));
    }
    function backoff(record) {
      record.attempts = Math.min(6,record.attempts+1);
      record.nextAt = Date.now()+Math.min(30000,1000*2**(record.attempts-1));
    }
    async function transfer(record) {
      const bound = record.bound, media = globalThis.CIP_MEDIA;
      if (!media || !['captureOriginal','readOriginal','releaseOriginal'].every(key=>typeof media[key] === 'function')) fail('ARTIFACT_CAPTURE_UNAVAILABLE');
      const job = active = {media,transferId:null,released:false}, check = () => jobGuard(record,bound);
      try {
        check(); if (!record.visible) fail('ARTIFACT_SOURCE_NOT_VISIBLE');
        const captured = await media.captureOriginal(record.capture,check);
        if (captured?.status === 'available') job.transferId = captured.transferId;
        check();
        if (captured?.status === 'unsupported' && reasons.has(captured.reason)) {
          const row = await send(record,bound,'artifact-unsupported',{reason:captured.reason});
          if (identityMatches(row,record,bound) && row.data.status === 'available') { record.result='available'; record.attempts=0; }
          else { record.result='unsupported'; backoff(record); }
          return;
        }
        if (captured?.status !== 'available' || typeof job.transferId !== 'string' ||
            typeof captured.digest !== 'string' || !/^[a-f0-9]{64}$/.test(captured.digest) ||
            !Number.isSafeInteger(captured.bytes) || captured.bytes < 1 || captured.bytes > 16*1024*1024 ||
            typeof captured.mimeType !== 'string' || typeof captured.name !== 'string') fail('ARTIFACT_CAPTURE_INVALID');
        if (captured.provenance !== record.capture.provenance && !(record.capture.kind === 'image' && captured.provenance === 'rendered-preview')) fail('ARTIFACT_PROVENANCE_INVALID');
        const metadata = Object.freeze({digest:captured.digest,bytes:captured.bytes,mimeType:captured.mimeType,name:captured.name});
        const begun = await send(record,bound,'artifact-begin',{metadata,provenance:captured.provenance});
        if (typeof begun?.uploadId !== 'string' || !/^[A-Za-z0-9:._-]{1,200}$/.test(begun.uploadId)) fail('ARTIFACT_RECEIPT_INVALID');
        const total = 4*Math.ceil(metadata.bytes/3); let offset = 0;
        while (offset<total) {
          check(); const chunk = await media.readOriginal(job.transferId,offset,check); check();
          const end = offset+(chunk?.data?.length ?? 0), nextOffset = end<total?end:null;
          if (chunk?.total !== total || typeof chunk.data !== 'string' || chunk.data.length !== Math.min(32768,total-offset) ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data) || (end<total && chunk.data.includes('=')) || chunk.nextOffset !== nextOffset) fail('ARTIFACT_CHUNK_INVALID');
          const receipt = await send(record,bound,'artifact-chunk',{uploadId:begun.uploadId,offset,data:chunk.data});
          if (receipt?.uploadId !== begun.uploadId || receipt.offset !== offset || receipt.total !== total || receipt.nextOffset !== nextOffset) fail('ARTIFACT_RECEIPT_INVALID');
          offset=end;
        }
        const row = await send(record,bound,'artifact-commit',{uploadId:begun.uploadId});
        if (!identityMatches(row,record,bound) || row.data.status !== 'available') fail('ARTIFACT_RECEIPT_INVALID');
        const quality={'native-original':3,'visible-image-resource':2,'rendered-preview':1};
        const retained=quality[row.data.provenance]>quality[captured.provenance];
        if (!retained && (row.data.provenance !== captured.provenance || row.data.resource?.digest !== metadata.digest ||
            row.data.resource.bytes !== metadata.bytes || row.data.resource.mimeType !== metadata.mimeType)) fail('ARTIFACT_RECEIPT_INVALID');
        record.result=retained || captured.provenance === record.capture.provenance?'available':'preview';
        if (record.result === 'preview') backoff(record); else record.attempts=0;
      } finally { release(job); if (active===job) active=null; }
    }
    function schedule() {
      if (disposed || running) return;
      running = Promise.resolve().then(async () => {
        while (!disposed) {
          const record = [...records.values()].find(value=>value.queued && value.visible);
          if (!record) break;
          record.queued=false;
          try { await transfer(record); }
          catch { if (records.get(record.sourceId)===record) { record.result='error'; backoff(record); } }
        }
      }).catch(()=>{}).finally(()=>{running=null;if(!disposed&&[...records.values()].some(value=>value.queued&&value.visible))schedule();});
    }
    function observe(items) {
      if (disposed || !Array.isArray(items)) return;
      let bound; try { bound=currentBinding(); } catch { return; }
      const visible = new Map(), conflicts = new Set();
      for (const item of items) {
        let value; try { value=descriptor(item,bound); } catch { continue; }
        if (!value) continue; // Existing source projection remains; never invent an ID/card.
        if (visible.has(value.sourceId) && visible.get(value.sourceId).fingerprint!==value.fingerprint) conflicts.add(value.sourceId);
        visible.set(value.sourceId,value);
      }
      for (const id of conflicts) visible.delete(id);
      for (const record of records.values()) { record.wasVisible=record.visible;record.visible=false; }
      for (const value of visible.values()) {
        let record = records.get(value.sourceId);
        if (!record || record.fingerprint!==value.fingerprint) {
          record={...value,bound,queued:true,attempts:0,nextAt:0,result:null};records.set(value.sourceId,record);
        } else {
          record.visible=value.visible;
          if (record.result!=='available' && record.result!==null && (!record.wasVisible || Date.now()>=record.nextAt)) record.queued=true;
        }
      }
      schedule();
    }
    function dispose() {
      if (!disposed) { disposed=true;release(active);records.clear(); }
      return running ?? Promise.resolve();
    }
    return Object.freeze({observe,dispose});
  }
  globalThis.CIP_ARTIFACT_TRANSFER = Object.freeze({create});
})();
