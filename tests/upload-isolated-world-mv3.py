"""Real Chrome MV3 isolated-world upload gesture regression; no production Chrome/profile/account."""
import json
import shutil
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
HTML=r"""
<!doctype html><html><body><form data-chatgpt-composer>
 <div id="prompt-textarea" contenteditable></div>
 <section data-composer-attachments></section><div id="pickers"></div>
 <button type="button" id="plus" data-composer-navigation-target="add-context">+</button>
 <button type="button" id="send">Send</button></form>
 <form id="other"><input type="file" accept="image/png"></form>
 <script>
 window.changed=[];window.nativeSends=0;window.dialogClickEvents=0;
 document.querySelector('#send').addEventListener('click',()=>window.nativeSends++);
 const mode=new URLSearchParams(location.search).get('mode');
 const group=document.querySelector('#pickers'),add=(id)=>{
   const input=document.createElement('input');input.type='file';input.accept='image/png';input.id=id;group.append(input);
   input.addEventListener('click',()=>window.dialogClickEvents++);
   input.addEventListener('change',async()=>{
     const root=document.querySelector('[data-composer-attachments]');
     for(const f of input.files){
       window.changed.push({picker:id,bytes:[...new Uint8Array(await f.arrayBuffer())]});
       const node=document.createElement('span');node.textContent=f.name;root.append(node);
     }
   });
 };
 add('pickerA');add('pickerB');
 if(mode==='tie-label')document.querySelector('#plus').addEventListener('click',()=>{
   const label=document.createElement('label');label.role='menuitem';
   label.setAttribute('for','pickerB');label.textContent='Upload files';
   document.body.append(label);
 },{once:true});
 if(mode==='tie-native')document.querySelector('#plus').addEventListener('click',()=>{
   const option=document.createElement('button');option.type='button';option.role='menuitem';option.textContent='Upload files';
   option.addEventListener('click',()=>document.querySelector('#pickerB').click());
   document.body.append(option);
 },{once:true});
 window.fixtureReady=false;window.fixtureReply=null;
 window.addEventListener('message',e=>{
   if(e.origin!==location.origin)return;
   if(e.data?.source==='cip-probe-ready')window.fixtureReady=true;
   if(e.data?.source==='cip-probe-finished')window.fixtureReply=e.data.value;
 });
 </script></body></html>
"""
PROBE=r"""
(()=> {
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YkCvYoAAAAASUVORK5CYII=';
const fail=e=>({ok:false,error:e?.code||'UNKNOWN_ERROR',diagnostic:e?.diagnostic??null});
window.addEventListener('message',async e=>{
 if(e.source!==window||e.origin!==location.origin||e.data?.source!=='cip-probe-start')return;
 const bytes=Uint8Array.from(atob(PNG),x=>x.charCodeAt(0));
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
   .map(x=>x.toString(16).padStart(2,'0')).join('');
 const file={fileName:'sample.png',mimeType:'image/png',size:bytes.length,sha256:hash};
 const read=async ({index,offset})=>({
   data:PNG,offset:0,total:bytes.length,sha256:hash
 });
 let value;
 try {
   const box=document.querySelector('#prompt-textarea');
   const confirmation=await CIP_UPLOAD.attach({
     id:'probe-command',lease:'probe-lease',documentKey:'probe-doc',
     payload:{files:[file]}
   },box,read,()=>{},Date.now()+60000);
   value={ok:confirmation()};
 }catch(err){value=fail(err);}
 window.postMessage({source:'cip-probe-finished',value},location.origin);
});
window.postMessage({source:'cip-probe-ready'},location.origin);
})();
"""
with tempfile.TemporaryDirectory(prefix='cip-isolated-upload-') as tmp:
  ext=Path(tmp)/'ext';ext.mkdir()
  shutil.copy2(ROOT/'extension/file-upload.js',ext/'file-upload.js')
  (ext/'probe.js').write_text(PROBE)
  (ext/'manifest.json').write_text(json.dumps({
    'manifest_version':3,'name':'CIP Upload Isolated Fixture','version':'0.0.1',
    'content_scripts':[{'matches':['https://chatgpt.com/*'],
      'js':['file-upload.js','probe.js'],'run_at':'document_idle'}]
  }))
  checks=[]
  with sync_playwright() as pw:
    context=pw.chromium.launch_persistent_context(str(Path(tmp)/'profile'),headless=True,
       executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       args=['--enable-unsafe-extension-debugging','--no-proxy-server','--disable-background-networking'],
       ignore_default_args=['--disable-extensions'])
    devtools=context.browser.new_browser_cdp_session()
    installed=devtools.send('Extensions.loadUnpacked',{'path':str(ext)})
    def route(handler):
      if handler.request.resource_type=='document':
        handler.fulfill(status=200,body=HTML,content_type='text/html; charset=utf-8')
      else:handler.abort()
    context.route('https://chatgpt.com/**',route)
    for mode in ('tie-native','tie-label','tie-no-proof'):
      page=context.new_page()
      dialogs=[]
      page.on('filechooser',lambda chooser:dialogs.append(chooser))
      page.goto('https://chatgpt.com/?mode='+mode)
      page.wait_for_function('window.fixtureReady===true',timeout=15000)
      page.evaluate('window.postMessage({source:"cip-probe-start"},location.origin)')
      page.wait_for_function('window.fixtureReply!==null',timeout=15000)
      val=page.evaluate('({reply:window.fixtureReply,changed:window.changed,nativeSends:window.nativeSends,dialogClickEvents:window.dialogClickEvents})')
      assert not dialogs,(mode,'unexpected native OS file chooser')
      assert val['nativeSends']==0,(mode,val)
      if mode in ('tie-native','tie-label'):
        assert val['reply']=={'ok':True},val
        assert len(val['changed'])==1 and val['changed'][0]['picker']=='pickerB',val
        assert val['dialogClickEvents']==0,val
        checks.append('MAIN-world '+('label' if mode=='tie-label' else 'synthetic click')+' selects exact input from isolated content script without OS picker')
      else:
        assert val['reply']['error']=='ATTACHMENT_INPUT_AMBIGUOUS' and not val['changed'],val
        assert val['reply']['diagnostic']=={
          'stage':'composer','panelCount':2,'rowCount':0,'matchingUserCount':2
        },val
        checks.append('equal input controls without activation evidence must fail without any attachment or Send')
      page.close()
    context.close()
  print(json.dumps({'passed':len(checks),'checks':checks,
    'scope':'real Chrome MV3 isolated content script; offline ChatGPT fixture, disposable profile'},ensure_ascii=False))
