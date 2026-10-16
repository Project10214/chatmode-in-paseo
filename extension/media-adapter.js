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
  globalThis.CIP_MEDIA = Object.freeze({project,capture});
})();
