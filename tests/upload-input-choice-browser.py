"""CIP 0.2.13 regression: multiple native file inputs (isolated real Chrome only)."""
import base64
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YkCvYoAAAAASUVORK5CYII=')
PDF=b'%PDF-1.7\n1 0 obj << /Type /Catalog >>\n%%EOF\n'
DATA=[
    {'name':'sample.png','type':'image/png','bytes':list(PNG)},
    {'name':'report.pdf','type':'application/pdf','bytes':list(PDF)},
]
HTML="""
<!doctype html><html><body>
<form data-chatgpt-composer>
  <div id="prompt-textarea" contenteditable></div>
  <section data-composer-attachments></section>
  <div id="pickers"></div>
  <button type="button" data-composer-navigation-target="add-context" aria-label="添加文件等内容">+</button>
  <button type="button" id="send">Send</button>
</form>
<form id="profile"><input id="avatar" type="file" accept="image/*"></form>
<div id="portal"></div>
<script>
window.changed=[];window.nativeSends=0;
document.querySelector('#send').addEventListener('click',()=>window.nativeSends++);
window.setup=(mode)=>{
 const pickers=document.querySelector('#pickers'),portal=document.querySelector('#portal');
 const add=(target,id,accept,multiple=true)=>{
   const input=document.createElement('input');input.type='file';input.id=id;
   if(accept!==null)input.setAttribute('accept',accept);
   input.multiple=multiple;target.append(input);
   input.addEventListener('change',async()=>{
     const root=document.querySelector('[data-composer-attachments]');
     for(const f of input.files){
       window.changed.push({picker:input.id,name:f.name,type:f.type,bytes:[...new Uint8Array(await f.arrayBuffer())]});
       const chip=document.createElement('span');chip.textContent=f.name;root.append(chip);
     }
   });
 };
 if(mode==='image-first'){add(pickers,'generic',null);add(pickers,'image','image/*');}
 if(mode==='split'){add(pickers,'images','image/*');add(pickers,'documents','application/pdf');}
 if(mode==='tie'){add(pickers,'genericA',null);add(pickers,'genericB',null);}
  if(mode==='tie-native'){
    add(pickers,'genericA','image/png');add(pickers,'genericB','image/png');
    document.querySelector('[data-composer-navigation-target]').addEventListener('click',()=>{
      const item=document.createElement('button');
      item.setAttribute('role','menuitem');item.textContent='Upload files';
      document.body.append(item);
      item.addEventListener('click',()=>document.querySelector('#genericB').click());
    },{once:true});
  }
 if(mode==='unrelated'){add(document.querySelector('#profile'),'avatar2','image/*');}
 if(mode==='portal'){
   document.querySelector('[data-composer-navigation-target]').addEventListener('click',()=>{
     add(portal,'composerPortal','image/png');
   },{once:true});
 }
};
</script>
</body></html>
"""
SCRIPT="""async ({data})=>{
 const samples=data.map(x=>new Uint8Array(x.bytes));
 const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
    .map(v=>v.toString(16).padStart(2,'0')).join('');
 const files=[];
 for(const d of data)files.push({fileName:d.name,mimeType:d.type,
   size:d.bytes.length,sha256:await hash(new Uint8Array(d.bytes))});
 const read=async ({index,offset})=>{
   const bytes=samples[index].subarray(offset,offset+131072);
   return {data:btoa(String.fromCharCode(...bytes)),offset,
     total:files[index].size,sha256:files[index].sha256};
 };
 try{
  const proof=await CIP_UPLOAD.attach({id:'test-command',lease:'test',documentKey:'test',payload:{files}},
     document.querySelector('#prompt-textarea'),read,()=>{},Date.now()+60000);
  await new Promise(resolve=>setTimeout(resolve,30));
  return {success:proof(),changed:window.changed,error:null,nativeSends:window.nativeSends};
 }catch(error){
  return {success:false,changed:window.changed,error:error.code||error.message,nativeSends:window.nativeSends};
 }
}"""
checks=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    for mode,parts in [('image-first',DATA[:1]),('split',DATA),('tie',DATA[:1]),('tie-native',DATA[:1]),('portal',DATA[:1])]:
        page=browser.new_page()
        native_filechoosers=[]
        page.on('filechooser',lambda chooser:native_filechoosers.append(chooser))
        page.route('http://127.0.0.1:18783/**',
            lambda route:route.fulfill(status=200,content_type='text/html',body=HTML))
        page.goto('http://127.0.0.1:18783/fixture')
        page.evaluate('(mode)=>window.setup(mode)',mode)
        page.add_script_tag(path=str(ROOT/'extension/file-upload.js'))
        result=page.evaluate(SCRIPT,{'data':parts})
        assert result['nativeSends']==0,(mode,result)
        assert len(native_filechoosers)==0,(mode,'unexpected native file dialog')
        if mode=='tie':
            assert result['error']=='ATTACHMENT_INPUT_AMBIGUOUS' and not result['changed'],result
            checks.append('true equal-composer ambiguity fails closed before any upload')
        else:
            assert result['success'] is True,(mode,result)
            assert [v['name'] for v in result['changed']]==[d['name'] for d in parts],(mode,result)
            assert [bytes(v['bytes']) for v in result['changed']]==[PNG,PDF][:len(parts)],(mode,result)
            if mode=='tie-native':
                assert [v['picker'] for v in result['changed']]==['genericB'],result
                checks.append('two identical inputs: use the exact picker activated by the ChatGPT upload action')
            if mode=='image-first':
                assert [v['picker'] for v in result['changed']]==['image'],result
                checks.append('native image-specific picker wins over generic picker')
            if mode=='split':
                assert [v['picker'] for v in result['changed']]==['images','documents'],result
                checks.append('PNG and PDF use independent owned native pickers')
            if mode=='portal':
                assert [v['picker'] for v in result['changed']]==['composerPortal'],result
                checks.append('localized + control creates one owned portal picker; unrelated avatar ignored')
        page.close()
    browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'isolated Chrome, no production pages/messages'},
    ensure_ascii=False))
