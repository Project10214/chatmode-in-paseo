"""Attachment paste from a real Chrome MV3 isolated world, no account.
The page shape copies the logged-in ChatGPT composer of 2026-10-16; its file
inputs must stay untouched."""
import json, shutil, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
HTML=r"""<!doctype html><html><body>
<form data-chatgpt-composer>
  <div id="prompt-textarea" contenteditable></div>
  <section data-composer-attachments></section><div id="inputs"></div>
  <button type="button" data-testid="send-button" id="send">Send</button>
</form>
<form id="avatar"><input type="file"></form>
<script>
window.changed=[];window.nativeSends=0;window.nativeFileClicks=0;
document.querySelector('#send').addEventListener('click',()=>window.nativeSends++);
const mode=new URLSearchParams(location.search).get('mode');
const host=document.querySelector('#inputs');
async function tile(route,f){
 window.changed.push({picker:route,name:f.name,bytes:[...new Uint8Array(await f.arrayBuffer())]});
 const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove file: '+f.name);
 document.querySelector('[data-composer-attachments]').append(remove);
}
function add(name,accept,multiple=true){
 const n=document.createElement('input');n.type='file';n.id=name;if(accept!==null)n.accept=accept;n.multiple=multiple;host.append(n);
 n.addEventListener('click',()=>window.nativeFileClicks++);
 n.addEventListener('change',async()=>{for(const f of n.files)await tile(name,f);});
}
// MAIN-world paste handler, as ChatGPT's editor: files from an isolated-world
// ClipboardEvent must be readable here.
if(mode!=='no-handler')document.querySelector('#prompt-textarea').addEventListener('paste',async e=>{
 const files=[...(e.clipboardData?.files||[])];
 if(!files.length)return;
 e.preventDefault();
 for(const f of files)await tile('paste',f);
});
add('image-single','image/*',false);add('image-video','image/*,video/*');add('image-multi','image/*');
add('general',null);
window.fixtureReady=false;window.fixtureReply=null;
window.addEventListener('message',e=>{
 if(e.origin!==location.origin)return;
 if(e.data?.source==='cip-probe-ready')window.fixtureReady=true;
 if(e.data?.source==='cip-probe-finished')window.fixtureReply=e.data.value;
});
</script></body></html>"""
PROBE=r"""(()=>{
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YkCvYoAAAAASUVORK5CYII=';
window.addEventListener('message',async e=>{
 if(e.source!==window||e.origin!==location.origin||e.data?.source!=='cip-probe-start')return;
 const bytes=Uint8Array.from(atob(PNG),x=>x.charCodeAt(0));
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
   .map(x=>x.toString(16).padStart(2,'0')).join('');
 const data={fileName:'paseo-image-1.png',mimeType:'image/png',size:bytes.length,
   sha256:hash,uploadKind:e.data.kind};
 const read=async({offset})=>({data:PNG,offset,total:bytes.length,sha256:hash});
 let result;
 try{
  const upload=await CIP_UPLOAD.attach({id:'command',lease:'lease',documentKey:'doc',payload:{files:[data]}},
    document.querySelector('#prompt-textarea'),read,()=>{},Date.now()+60000);
  result={ok:upload.proof()};
 }catch(err){result={ok:false,error:err.code||'UNKNOWN',diagnostic:err.diagnostic??null};}
 window.postMessage({source:'cip-probe-finished',value:result},location.origin);
});
window.postMessage({source:'cip-probe-ready'},location.origin);
})();"""
with tempfile.TemporaryDirectory(prefix='cip-cos-upstream-upload-') as tmp:
    ext=Path(tmp)/'ext';ext.mkdir()
    shutil.copy2(ROOT/'extension/file-upload.js',ext/'file-upload.js')
    (ext/'probe.js').write_text(PROBE)
    (ext/'manifest.json').write_text(json.dumps({
        'manifest_version':3,'name':'CoS Upload Selection Probe','version':'0.0.1',
        'content_scripts':[{'matches':['https://chatgpt.com/*'],
            'js':['file-upload.js','probe.js'],'run_at':'document_idle'}]
    }))
    checks=[]
    with sync_playwright() as pw:
        context=pw.chromium.launch_persistent_context(str(Path(tmp)/'profile'),
            headless=True,executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            args=['--enable-unsafe-extension-debugging','--no-proxy-server',
                  '--disable-background-networking'],ignore_default_args=['--disable-extensions'])
        cdp=context.browser.new_browser_cdp_session()
        cdp.send('Extensions.loadUnpacked',{'path':str(ext)})
        def intercept(route):
            if route.request.resource_type=='document':
                route.fulfill(status=200,body=HTML,content_type='text/html; charset=utf-8')
            else:route.abort()
        context.route('https://chatgpt.com/**',intercept)
        for mode,kind,expected in [('live-image','image','paste'),
                                    ('live-file','file','paste'),
                                    ('no-handler','image',None)]:
            page=context.new_page()
            dialogs=[]
            page.on('filechooser',lambda dialog:dialogs.append(dialog))
            page.goto('https://chatgpt.com/?mode='+mode)
            page.wait_for_function('window.fixtureReady===true',timeout=15000)
            page.evaluate('(kind)=>window.postMessage({source:"cip-probe-start",kind},location.origin)',kind)
            page.wait_for_function('window.fixtureReply!==null',timeout=15000)
            result=page.evaluate('({reply:window.fixtureReply,changed:window.changed,'
                'nativeSends:window.nativeSends,nativeFileClicks:window.nativeFileClicks})')
            assert result['nativeSends']==0 and result['nativeFileClicks']==0 and not dialogs,(mode,result)
            if expected:
                assert result['reply']=={'ok':True},(mode,result)
                assert [x['picker'] for x in result['changed']]==[expected],(mode,result)
            else:
                assert result['reply']['error']=='ATTACHMENT_PASTE_UNHANDLED' and not result['changed'],(mode,result)
            checks.append(mode)
            page.close()
        context.close()
    print(json.dumps({'passed':len(checks),'checks':checks,
                      'scope':'real Chrome MV3 isolated content script pastes into a MAIN-world editor handler; no ChatGPT account'},ensure_ascii=False))
