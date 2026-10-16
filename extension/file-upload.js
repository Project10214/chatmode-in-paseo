/* CIP outbound attachments. Only a currently claimed Send can read its own
 * server-staged bytes; no file paths, prompt bodies or tokens are logged. */
(() => {
  'use strict';
  const MAX_FILES=4,MAX_EACH=12*1024*1024,CHUNK=128*1024;
  const fail=code=>{throw Object.assign(new Error(code),{code,notSent:true});};
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const hex=bytes=>[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
  const ownedForm=box=>box?.closest('form')||fail('COMPOSER_UNAVAILABLE');
  // ChatGPT can mount separate image and document pickers, plus unrelated
  // profile/other-chat inputs. Select an exact native picker; never use DOM
  // ordering or an arbitrary "first input" to resolve a genuine tie.
  const inputReady=n=>n && !n.disabled && n.isConnected!==false;
  const inputScore=(n,file)=>{
    const accept=(n.getAttribute('accept')||'').toLowerCase().trim();
    if(!accept)return 1; // Generic picker is a fallback, not equal to image/*.
    const mime=file.mimeType.toLowerCase(),extension='.'+file.fileName.split('.').at(-1).toLowerCase();
    let score=0;
    for(const part of accept.split(',').map(x=>x.trim())){
      if(part===mime)score=Math.max(score,50);
      else if(part===extension)score=Math.max(score,45);
      else if(part===mime.split('/')[0]+'/*')score=Math.max(score,30);
      else if(part==='*/*')score=Math.max(score,5);
    }
    return score;
  };
  const uniqueInput=(inputs,file)=>{
    const matched=inputs.filter(inputReady).map(node=>({node,score:inputScore(node,file)}))
      .filter(x=>x.score>0);
    if(!matched.length)return null;
    const best=Math.max(...matched.map(x=>x.score));
    const winners=matched.filter(x=>x.score===best);
    if(winners.length!==1)fail('ATTACHMENT_INPUT_AMBIGUOUS');
    return winners[0].node;
  };
  const localInputs=form=>[...form.querySelectorAll('input[type="file"]')];
  const portalInputs=form=>[...document.querySelectorAll('input[type="file"]')]
    .filter(n=>!form.contains(n) && !n.closest('[data-message-author-role],[data-turn-key],section[data-testid^="conversation-turn"]') &&
      (!n.closest('form') || n.closest('form')===form) &&
      (!n.form || n.form===form));
  const findInput=(form,file,portals=null)=>{
    // The exact composer form outranks all other inputs on the page.
    const local=uniqueInput(localInputs(form),file);
    if(local)return local;
    // Only open the global fallback after following THIS composer's native
    // attachment control. "portals" is the set exposed by that interaction.
    return portals ? uniqueInput(portals,file) : null;
  };
  const attachmentRoot=form=>form.querySelector('[data-composer-attachments]') ||
    form.querySelector('[data-testid="composer-attachments"]');
  function evidence(form,files) {
    const root=attachmentRoot(form);
    if(!root || !root.isConnected || root.children.length===0)return false;
    if(form.querySelector('[data-inline-file-uploading],[data-testid="file-uploading"],[data-uploading="true"]'))return false;
    const rendered=(root.textContent+' '+[...root.querySelectorAll('[aria-label],[title],[alt]')]
      .map(n=>[n.getAttribute('aria-label'),n.getAttribute('title'),n.getAttribute('alt')].join(' ')).join(' '));
    const names=files.filter(f=>rendered.includes(f.fileName));
    // Image-only native previews often have no filename. A thumbnail supplies
    // a bounded count, but never stands in for a named document attachment.
    const images=files.filter(f=>f.mimeType.startsWith('image/'));
    const unnamedImages=images.filter(f=>!names.includes(f));
    const thumbs=[...root.querySelectorAll('img,[data-testid*="image-thumbnail"],[data-testid*="image-preview"]')]
      .filter(n=>n.getClientRects().length>0);
    return names.length+Math.min(thumbs.length,unnamedImages.length)>=files.length &&
      root.children.length>=files.length;
  }
  async function loadFile(command,file,index,read,guard) {
    if(!Number.isInteger(file.size)||file.size<=0||file.size>MAX_EACH||
       typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||
       typeof file.mimeType!=='string'||!/^[-\w.+]+\/[-\w.+]+$/.test(file.mimeType)||
       typeof file.fileName!=='string'||!/^[^\\/\x00-\x1f]{1,150}$/.test(file.fileName))fail('ATTACHMENT_INVALID');
    const buffer=new Uint8Array(file.size);
    for(let offset=0;offset<file.size;offset+=CHUNK){
      guard();
      const part=await read({type:'input-chunk',id:command.id,lease:command.lease,
        documentKey:command.documentKey,index,offset});
      if(part?.offset!==offset||part?.total!==file.size||part?.sha256!==file.sha256||
         typeof part.data!=='string')fail('ATTACHMENT_CHUNK_MISMATCH');
      const binary=atob(part.data);
      const length=Math.min(CHUNK,file.size-offset);
      if(binary.length!==length)fail('ATTACHMENT_CHUNK_MISMATCH');
      for(let i=0;i<length;i++)buffer[offset+i]=binary.charCodeAt(i);
    }
    guard();
    if(hex(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)))!==file.sha256)
      fail('ATTACHMENT_INTEGRITY_FAILED');
    return new File([buffer],file.fileName,{type:file.mimeType,lastModified:Date.now()});
  }
  async function inputFor(form,file,guard){
    // Only bounded counts cross into error diagnostics. Never include file
    // names, paths, element attributes, selected UI text or user content.
    const pickerFail=code=>{
      const owned=localInputs(form),portal=portalInputs(form);
      throw Object.assign(new Error(code),{code,notSent:true,diagnostic:{
        stage:'composer',panelCount:Math.min(128,owned.length),
        rowCount:Math.min(128,portal.length),
        matchingUserCount:Math.min(128,owned.filter(n=>inputReady(n)&&inputScore(n,file)>0).length)
      }});
    };
    let localAmbiguous=false;
    const local=()=>{
      try{return findInput(form,file);}
      catch(e){
        if(e.code==='ATTACHMENT_INPUT_AMBIGUOUS'){localAmbiguous=true;return null;}
        throw e;
      }
    };
    const direct=local();
    if(direct)return direct;
    // With two equally suitable native inputs, only the ChatGPT-owned upload
    // gesture can establish which one its React handler actually activates.
    // Capture the synthetic input click and cancel ONLY its default file
    // chooser; the selected File is inserted through native change below.
    let chosen=null,conflict=false,actionActive=false;
    const before=new Set(portalInputs(form));
    const observe=event=>{
      const input=event.target;
      if(!(input instanceof HTMLInputElement)||input.type!=='file' ||
         !inputReady(input)||!inputScore(input,file))return;
      const otherForm=input.form||input.closest('form');
      if(otherForm && otherForm!==form)return;
      if(!form.contains(input) && !portalInputs(form).includes(input))return;
      // UA-generated file-input events from a label can be trusted. Accept
      // them only during the exact native composer action we initiated;
      // never intercept an independent human click outside that action.
      if(event.isTrusted&&!actionActive)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if(chosen && chosen!==input)conflict=true;
      else chosen=input;
    };
    const selected=portals=>{
      if(conflict)pickerFail('ATTACHMENT_INPUT_AMBIGUOUS');
      if(chosen)return chosen;
      if(localAmbiguous)return null;
      try{return findInput(form,file,portals);}
      catch(e){
        if(e.code==='ATTACHMENT_INPUT_AMBIGUOUS'){localAmbiguous=true;return null;}
        throw e;
      }
    };
    document.addEventListener('click',observe,true);
    try{
      const buttons=[...form.querySelectorAll(
        'button[data-testid="composer-plus-btn"],button[data-composer-navigation-target="add-context"],button[aria-label*="Attach" i],button[aria-label*="Add files" i],button[aria-label*="添加文件"],button[data-testid="upload-button"]')]
        .filter(b=>!b.disabled&&b.getClientRects().length>0);
      if(buttons.length!==1)pickerFail(localAmbiguous?'ATTACHMENT_INPUT_AMBIGUOUS':'ATTACHMENT_INPUT_UNAVAILABLE');
      guard();actionActive=true;
      try{buttons[0].click();}finally{actionActive=false;}
      // A native plus button may directly activate a mounted input, or open
      // a menu first. Never choose the first of several tied file pickers.
      for(let retry=0;retry<5;retry++){
        guard();
        const input=selected(portalInputs(form).filter(n=>!before.has(n)));
        if(input)return input;
        await delay(100);
      }
      const actions=[...document.querySelectorAll('[role="menuitem"],[role="option"]')]
        .filter(n=>/^(?:upload|add)\s+(?:(?:photos?|images?)\s+(?:and|&)\s+)?files?|^upload\s+from\s+(?:computer|device)|上传(照片和)?文件|从(电脑|设备)上传|照片和文件/i
          .test((n.textContent||'').trim())&&n.getClientRects().length>0);
      if(actions.length!==1)pickerFail(localAmbiguous?'ATTACHMENT_INPUT_AMBIGUOUS':'ATTACHMENT_INPUT_UNAVAILABLE');
      guard();actionActive=true;
      try{actions[0].click();}finally{actionActive=false;}
      for(let retry=0;retry<20;retry++){
        guard();
        const input=selected(portalInputs(form));
        if(input)return input;
        await delay(100);
      }
      pickerFail(localAmbiguous?'ATTACHMENT_INPUT_AMBIGUOUS':'ATTACHMENT_INPUT_UNAVAILABLE');
    }finally{
      document.removeEventListener('click',observe,true);
    }
  }
  async function attach(command,box,read,guard,deadline){
    const files=command?.payload?.files;
    if(!Array.isArray(files)||!files.length)return ()=>true;
    if(files.length>MAX_FILES)fail('ATTACHMENT_COUNT_UNSUPPORTED');
    const form=ownedForm(box);
    if(attachmentRoot(form)?.children.length||form.querySelector('[data-inline-file-uploading]'))
      fail('ATTACHMENT_DRAFT_CONFLICT');
    const blobs=[];
    for(let i=0;i<files.length;i++)blobs.push(await loadFile(command,files[i],i,read,guard));
    guard();
    // Separate native image/document controls are normal. Build a stable plan
    // before changing any file picker; each file must choose one owned input.
    const groups=new Map();
    for(let i=0;i<files.length;i++){
      guard();
      const input=await inputFor(form,files[i],guard);
      const group=groups.get(input)??[];
      group.push(blobs[i]);groups.set(input,group);
    }
    for(const [input,group] of groups){
      guard();
      if(input.isConnected===false||input.disabled)fail('ATTACHMENT_INPUT_UNAVAILABLE');
      if(group.length>1 && !input.multiple)fail('ATTACHMENT_MULTIPLE_UNSUPPORTED');
    }
    for(const [input,group] of groups){
      guard();
      const transfer=new DataTransfer();
      for(const file of group)transfer.items.add(file);
      input.files=transfer.files;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    const remaining=Number.isFinite(deadline)?deadline-Date.now()-25000:20000;
    const end=Date.now()+Math.min(25000,Math.max(1000,remaining));
    do{
      guard();
      if(!box.isConnected||ownedForm(box)!==form)fail('ATTACHMENT_PAGE_CHANGED');
      if(evidence(form,files))return ()=>evidence(form,files);
      await delay(100);
    }while(Date.now()<end);
    fail('ATTACHMENT_UPLOAD_UNCONFIRMED');
  }
  globalThis.CIP_UPLOAD=Object.freeze({attach});
})();