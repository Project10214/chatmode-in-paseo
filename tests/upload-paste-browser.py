"""Attachments are pasted into the editor, in real isolated Chrome (no account).
The 'live' layout copies the logged-in ChatGPT composer of 2026-10-16: four
file inputs, two of them accept="image/*", one general input with no accept.
None of them may ever be touched.
"""
import base64, json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YkCvYoAAAAASUVORK5CYII=')
PDF=b'%PDF-1.7\n1 0 obj << /Type /Catalog >>\n%%EOF\n'
IM={'name':'paseo-image-1.png','type':'image/png','kind':'image','bytes':list(PNG)}
DOC={'name':'report.pdf','type':'application/pdf','kind':'file','bytes':list(PDF)}
UPLOADED_IMAGE={**IM,'name':'selected-from-disk.png','kind':'file'}
HTML="""
<!doctype html><html><body><form data-chatgpt-composer>
<div id="prompt-textarea" contenteditable></div>
<section data-composer-attachments></section><div id="pickers"></div>
<button type="button" id="add" aria-label="Add files">+</button>
<button type="button" data-testid="send-button" id="send">Send</button>
</form>
<form id="other"><input type="file"></form>
<script>
window.changed=[];window.nativeSends=0;window.nativeInputClicks=0;window.inputEvents=0;window.stall=false;
document.querySelector('#send').addEventListener('click',()=>window.nativeSends++);
const attachments=document.querySelector('[data-composer-attachments]');
async function tile(route,f){
 window.changed.push({picker:route,name:f.name,type:f.type,bytes:[...new Uint8Array(await f.arrayBuffer())]});
 const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove file: '+f.name);
 remove.addEventListener('click',()=>{remove.remove();if(!attachments.querySelector('button'))attachments.removeAttribute('aria-busy');});
 attachments.append(remove);
 if(window.stall)attachments.setAttribute('aria-busy','true');
}
window.setup=(mode)=>{
 const host=document.querySelector('#pickers');
 const input=(id,accept,multiple=true)=>{
  const n=document.createElement('input');n.type='file';n.id=id;if(accept!==null)n.accept=accept;n.multiple=multiple;host.append(n);
  n.addEventListener('click',()=>window.nativeInputClicks++);
  n.addEventListener('change',async()=>{for(const f of n.files)await tile(n.id,f);});
  n.addEventListener('input',()=>window.inputEvents++);
 };
 const pasteHandler=()=>document.querySelector('#prompt-textarea').addEventListener('paste',async e=>{
  const files=[...(e.clipboardData?.files||[])];
  if(!files.length)return;
  e.preventDefault();
  for(const f of files)await tile('paste',f);
 });
 input('image-single','image/*',false);input('image-video','image/*,video/*');
 input('image-multi','image/*');input('general',null);
 if(mode!=='no-handler')pasteHandler();
 window.stall=mode==='stall';
};
</script></body></html>
"""
SCRIPT="""async ({data,deadline})=>{
 const samples=data.map(d=>new Uint8Array(d.bytes));
 const hash=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))]
   .map(x=>x.toString(16).padStart(2,'0')).join('');
 const files=[];
 for(const d of data)files.push({
  fileName:d.name,mimeType:d.type,uploadKind:d.kind,size:d.bytes.length,
  sha256:await hash(new Uint8Array(d.bytes))
 });
 const read=async ({index,offset})=>{
  const bytes=samples[index].subarray(offset,offset+131072);
  return {data:btoa(String.fromCharCode(...bytes)),offset,total:files[index].size,sha256:files[index].sha256};
 };
 const state=()=>({changed:window.changed,clicks:window.nativeInputClicks,sends:window.nativeSends,
   inputEvents:window.inputEvents,inputFiles:[...document.querySelectorAll('input[type=file]')].reduce((n,i)=>n+i.files.length,0),
   tiles:document.querySelectorAll('[data-composer-attachments] button').length,
   editor:document.querySelector('#prompt-textarea').textContent});
 try{
  const upload=await CIP_UPLOAD.attach({id:'one-time',lease:'lease',documentKey:'doc',payload:{files}},
    document.querySelector('#prompt-textarea'),read,()=>{},Date.now()+deadline);
  await new Promise(r=>setTimeout(r,15));
  return {ok:upload.proof(),error:null,...state()};
 }catch(e){return {ok:false,error:e.code||e.message,...state()};}
}"""
checks=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    cases=[
      ('live',[IM],['paste'],None),
      ('live',[UPLOADED_IMAGE],['paste'],None),
      ('live',[DOC],['paste'],None),
      ('live',[IM,DOC],['paste','paste'],None),
      ('no-handler',[IM],None,'ATTACHMENT_PASTE_UNHANDLED'),
      ('stall',[DOC],None,'ATTACHMENT_UPLOAD_UNCONFIRMED'),
    ]
    for mode,data,expected,error in cases:
        page=browser.new_page()
        dialogs=[]
        page.on('filechooser',lambda dialog:dialogs.append(dialog))
        page.route('http://127.0.0.1:18783/**',lambda route:route.fulfill(
            status=200,content_type='text/html',body=HTML))
        page.goto('http://127.0.0.1:18783/fixture')
        page.evaluate('(mode)=>setup(mode)',mode)
        page.add_script_tag(path=str(ROOT/'extension/file-upload.js'))
        # A stalled upload gets the minimum 500 ms receipt window.
        result=page.evaluate(SCRIPT,{'data':data,'deadline':20500 if mode=='stall' else 60000})
        label=mode+':'+'+'.join(d['name'] for d in data)
        assert result['clicks']==0 and result['sends']==0 and not dialogs,(label,result)
        assert result['inputEvents']==0 and result['inputFiles']==0,(label,result)
        assert result['editor']=='',(label,result)
        if error:
            assert not result['ok'] and result['error']==error,(label,result)
            # A refused route writes nothing; a stalled upload removes its own tile.
            assert result['tiles']==0,(label,result)
            if mode=='no-handler':assert not result['changed'],(label,result)
        else:
            assert result['ok'] and not result['error'],(label,result)
            assert [d['picker'] for d in result['changed']]==expected,(label,result)
            assert [bytes(d['bytes']) for d in result['changed']]==[bytes(d['bytes']) for d in data],(label,result)
        checks.append(label)
        page.close()
    browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,
                  'scope':'real isolated Chrome; paste into the editor, live-shaped file inputs untouched; no ChatGPT account'},ensure_ascii=False))
