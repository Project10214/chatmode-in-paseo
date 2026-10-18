"""Real macOS Chrome, shipped JS and native editing; offline system_hints fixture.
No Playwright, real account, model call or user Chrome profile. Network responses are
fixtures shaped like the upstream CoS usage-observer tests; not a live-site acceptance.
"""
from pathlib import Path
import html, json, os, re, subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
R=Path(__file__).resolve().parents[1]
manifest=json.loads((R/'extension/manifest.json').read_text())
sources=[name for entry in manifest['content_scripts'] for name in entry['js'] if name!='content.js']
setup='''<script>
window.fixtureFetchCount=0;
window.fixturePointerListeners=[];
const fixtureAddListener=document.addEventListener.bind(document);
document.addEventListener=(name,fn,options)=>{
  if(name==='pointerdown')window.fixturePointerListeners.push(fn);
  return fixtureAddListener(name,fn,options);
};
window.fixtureHints={system_hints:apps.map(a=>({system_hint:'plugin:'+a.id,name:a.label,secret:'MUST_NOT_EXPORT'}))};
window.fixtureHintsUrl=window.location.origin+'/backend-api/system_hints?mode=plugins';
window.fetch=(url)=>{if(url!==fixtureHintsUrl)throw new Error('UNEXPECTED_TEST_FETCH');fixtureFetchCount++;const r=new Response(JSON.stringify(fixtureHints),{headers:{'Content-Type':'application/json'}});Object.defineProperty(r,'url',{value:url});return Promise.resolve(r)};
</script>'''
runner='''<pre id="result">PENDING</pre><script>
(async()=>{
 const checks=[];const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(ok,title)=>{if(!ok)throw new Error(title);checks.push(title)};
 try {
  await window.fetch(fixtureHintsUrl);
  const catalog=await CIP_DOM.catalog();
  check(catalog.apps.length===2&&catalog.models.length===2,'native system_hints supplies catalog with no @ popup');
  check(!document.querySelector('[role=listbox]')&&fixtureSends===0,'discovery never opens @ menu or sends a message');
  check(!JSON.stringify(catalog).includes('MUST_NOT_EXPORT'),'only app ID/name leave the response reader');
  const noApps={model:'m1',thinkingOption:'extended',appIds:[]};
  // Chrome session restore can leave a native @ mark before this document's CIP adapter owns it.
  const orphan=document.createElement('span');
  orphan.setAttribute('app-mention-path','app://'+apps[0].id);
  orphan.setAttribute('data-prompt-link-href','app://'+apps[0].id);
  orphan.textContent=apps[0].label;
  box.append(orphan);
  await CIP_DOM.configure(noApps);
  check(!box.querySelector('[app-mention-path]')&&CIP_DOM.authored(box)==='','stale app-only mark after restart does not permanently block no-tool sends');
  const config={model:'m1',thinkingOption:'extended',appIds:apps.map(a=>a.id)};
  await CIP_DOM.configure(config);
  check(box.querySelectorAll('[app-mention-path]').length===2&&CIP_DOM.authored(box)==='','CoS addAppMention inserts both native app marks without @ keystrokes');
  // A harmless native editor re-render / partial chip cleanup must not
  // invalidate untouched, previously owned native marks.
  box.append(document.createElement('br'));
  box.querySelector('[app-mention-path]').remove();
  await CIP_DOM.configure(noApps);
  check(!box.querySelector('[app-mention-path]')&&CIP_DOM.authored(box)==='','native markup re-render does not break a verified switch to no tools');
  await CIP_DOM.configure(config);
  // An unrelated native model/menu click, or merely placing the caret, does
  // not change app chip ownership. The previous pointerdown fence rejected it.
  const appTouch=fixturePointerListeners.find(fn=>String(fn).includes('editorTouchEpoch'));
  if(!appTouch)throw new Error('APP_TOUCH_LISTENER_UNAVAILABLE');
  const nativeMenu=document.createElement('div');nativeMenu.setAttribute('role','menu');
  const menuEntry=document.createElement('button');menuEntry.textContent='Unrelated thinking choice';
  nativeMenu.append(menuEntry);document.body.append(nativeMenu);
  appTouch({type:'pointerdown',isTrusted:true,target:menuEntry});
  nativeMenu.remove();
  appTouch({type:'pointerdown',isTrusted:true,target:box});
  await CIP_DOM.configure(noApps);
  check(!box.querySelector('[app-mention-path]')&&CIP_DOM.authored(box)==='',
    'unrelated native menu and caret clicks do not freeze app switching');
  await CIP_DOM.configure(config);
  const chip=box.querySelector('[app-mention-path]');
  const removeChip=document.createElement('button');removeChip.textContent='Remove';chip.append(removeChip);
  appTouch({type:'pointerdown',isTrusted:true,target:removeChip});
  let appEditError=null;
  try{await CIP_DOM.configure(noApps)}catch(e){appEditError=e.code}
  check(appEditError==='APP_SELECTION_CHANGED'&&box.querySelectorAll('[app-mention-path]').length===2,
    'a trusted app-chip removal action still blocks automatic deletion');
  box.replaceChildren();
  await CIP_DOM.configure(noApps);
  await CIP_DOM.configure(config);
  const outerChip=box.querySelector('[app-mention-path]');
  const nestedChip=document.createElement('span');
  nestedChip.setAttribute('data-prompt-link-href',outerChip.getAttribute('data-prompt-link-href'));
  nestedChip.textContent='Decorative nested app label';
  outerChip.append(nestedChip);
  await CIP_DOM.configure(config);
  check(CIP_DOM.authored(box)===''&&
    box.querySelectorAll('[app-mention-path]').length===2,
    'nested native app markup is counted as one semantic mark, not an extra app');
  nestedChip.setAttribute('data-prompt-link-href','app://asdk_app_foreign');
  let nestedConflict=null;
  try{await CIP_DOM.configure(config)}catch(e){nestedConflict=e.code}
  check(nestedConflict==='APP_ID_UNPROVEN'&&fixtureSends===0,
    'a nested mark with a different app ID is not silently trusted');
  nestedChip.remove();
  const first=await CIP_DOM.send({payload:{config,text:'first line\\nsecond line'}},async()=>true,()=>{});
  check(first.receipt===true&&fixtureSends===1,'native editor sends multiline text once and confirms a user-message receipt');
  await delay(500);
  check(CIP_DOM.state(first.nativeMessageId).answer.final===true,'only the finished native answer reports completion');
  const oldConversation=CIP_DOM.conversationId();
  const second=await CIP_DOM.send({payload:{config,text:'second message'}},async()=>true,()=>{});
  check(second.receipt===true&&fixtureSends===2&&CIP_DOM.conversationId()===oldConversation,'second message keeps the same conversation and both app choices');
  await delay(500);
  // Full native Send (not just Configure) must recover an untouched stale mark.
  const leftover=document.createElement('span');
  leftover.setAttribute('app-mention-path','app://'+apps[0].id);
  leftover.setAttribute('data-prompt-link-href','app://'+apps[0].id);
  leftover.textContent=apps[0].label;box.append(leftover);
  const noToolSend=await CIP_DOM.send({payload:{config:noApps,text:'send after restart, no tools'}},async()=>true,()=>{});
  check(noToolSend.receipt===true&&fixtureSends===3&&box.querySelectorAll('[app-mention-path]').length===0,
    'stale native app mark is safely removed before exactly one no-tool Send');
  await delay(500);
  // A previously started native turn can reappear as generating after Chrome
  // cold-start. The next new Send must WAIT instead of racing the Stop button.
  const oldBusy=document.createElement('button');
  oldBusy.setAttribute('data-testid','stop-button');
  oldBusy.textContent='Stop';box.closest('form').append(oldBusy);
  let dispatchedWhileBusy=false;
  setTimeout(()=>{dispatchedWhileBusy=fixtureSends!==3},200);
  setTimeout(()=>oldBusy.remove(),700);
  const afterBusy=await CIP_DOM.send({payload:{config:noApps,text:'new message after busy finishes'}},async()=>true,()=>{});
  check(afterBusy.receipt===true&&fixtureSends===4&&!dispatchedWhileBusy,
    'Chrome restored a busy native page: waits for idle before exactly one new Send');
  await delay(500);
  // React can reshape a contenteditable node without changing the message,
  // app IDs or authorization. HTML bytes are not a trustworthy ownership ID.
  const markupOnly=await CIP_DOM.send({payload:{config:noApps,text:'Render-only editor decoration'}},async()=>{
    const decor=document.createElement('span');decor.setAttribute('data-react-decoration','');
    decor.setAttribute('aria-hidden','true');box.append(decor);
    return true;
  },()=>{});
  check(markupOnly.receipt===true&&fixtureSends===5,
    'React-only composer markup change does not cancel an otherwise exact native Send');
  await delay(500);
  // Same document, same Conversation; harmless query metadata is not a new chat.
  const priorHref=fixtureLocation.href;
  const queryOnly=await CIP_DOM.send({payload:{config:noApps,text:'Same-path query metadata'}},async()=>{
    fixtureLocation.href=priorHref+'?ui=1';return true;
  },()=>{});
  check(queryOnly.receipt===true&&fixtureSends===6,
    'same-path query change does not cancel message authorization');
  fixtureLocation.href=priorHref;
  await delay(500);
  // Simulate the trusted Chrome event listener exactly; no browser editor
  // input occurred. Only editor mutations may revoke a draft's ownership.
  const oldAdd=document.addEventListener.bind(document);
  let trustedPointer=null,trustedBeforeinput=null;
  document.addEventListener=(type,fn,options)=>{
    if(type==='pointerdown'&&String(fn).includes('userTouched'))trustedPointer=fn;
    if(type==='beforeinput'&&String(fn).includes('userTouched'))trustedBeforeinput=fn;
    return oldAdd(type,fn,options);
  };
  const harmlessClick=await CIP_DOM.send({payload:{config:noApps,text:'Click outside editor'}},async()=>{
    if(!trustedPointer)throw new Error('TRUSTED_POINTER_LISTENER_MISSING');
    trustedPointer({type:'pointerdown',isTrusted:true,target:document.querySelector('h1')});
    return true;
  },()=>{});
  check(harmlessClick.receipt===true&&fixtureSends===7,
    'trusted click outside the editor does not cancel a pre-click native Send');
  await delay(500);
  let editError=null;
  try {
    await CIP_DOM.send({payload:{config:noApps,text:'Never overwrite human intent'}},async()=>{
      if(!trustedBeforeinput)throw new Error('TRUSTED_INPUT_LISTENER_MISSING');
      trustedBeforeinput({type:'beforeinput',isTrusted:true,target:box});
      return true;
    },()=>{});
  }catch(e){editError=e.code;}
  document.addEventListener=oldAdd;
  check(['SEND_NOT_READY','DRAFT_OR_CONFIG_CHANGED','DRAFT_CHANGED'].includes(editError)&&fixtureSends===7,
    'trusted editor input during authorization still blocks Send: '+JSON.stringify({editError,fixtureSends}));
  box.replaceChildren();
  const modelNode=document.querySelector('#model');
  let configError=null;
  try {
    await CIP_DOM.send({payload:{config:noApps,text:'Do not send with a different model'}},async()=>{
      modelNode.setAttribute('data-model-id','m2');return true;
    },()=>{});
  }catch(e){configError=e.code}
  check(configError==='DRAFT_OR_CONFIG_CHANGED'&&fixtureSends===7,
    'actual model switch before native click still cancels the Send');
  modelNode.setAttribute('data-model-id','m1');
  box.replaceChildren();
  const replacedButton=await CIP_DOM.send({payload:{config:noApps,text:'Button refreshed by React'}},async()=>{
    const previous=document.querySelector('#send');
    const current=previous.cloneNode(true);
    current.onclick=previous.onclick;
    previous.replaceWith(current);
    return true;
  },()=>{});
  check(replacedButton.receipt===true&&fixtureSends===8,
    'same native Send button can be safely replaced before the one native click');
  await delay(500);
  const sameForm=box.closest('form');
  let detachedButton=null,decoyButton=null,detachedError=null;
  try{
    await CIP_DOM.send({payload:{config:noApps,text:'Never send through another form'}},async()=>{
      detachedButton=document.querySelector('#send');
      detachedButton.remove();
      decoyButton=document.createElement('button');
      decoyButton.setAttribute('data-testid','send-button');
      document.body.append(decoyButton);
      return true;
    },()=>{});
  }catch(e){detachedError=e.code;}
  decoyButton?.remove();
  if(detachedButton)sameForm.append(detachedButton);
  check(detachedError==='SEND_NOT_READY'&&fixtureSends===8,
    'a Send-looking control outside the owned composer can never be clicked');
  box.replaceChildren();
  await delay(500);
  // The browser can re-render the editor while the one-shot authorization
  // fails. That does not turn our unsent draft into a human-owned draft.
  let rejectedCode=null;
  try{
    await CIP_DOM.send({payload:{config:noApps,text:'Unsent authorization attempt'}},async()=>{
      const decor=document.createElement('span');
      decor.setAttribute('aria-hidden','true');box.append(decor);
      throw Object.assign(new Error('AUTH_TEST_REFUSED'),{code:'AUTH_TEST_REFUSED'});
    },()=>{});
  }catch(e){rejectedCode=e.code;}
  check(rejectedCode==='AUTH_TEST_REFUSED'&&CIP_DOM.authored(box)===''&&fixtureSends===8,
    'unsent owned draft is cleared despite harmless React markup update');
  const freshAfterReject=await CIP_DOM.send({payload:{config:noApps,text:'Next fresh message, once'}},async()=>true,()=>{});
  check(freshAfterReject.receipt===true&&fixtureSends===9,
    'unsent rejection and cleanup do not lock the next newly authorized Send');
  await delay(500);
  let humanChangedCode=null;
  try{
    await CIP_DOM.send({payload:{config:noApps,text:'Must preserve human replacement'}},async()=>{
      box.textContent='User-authored content after preparation';
      throw Object.assign(new Error('AUTH_TEST_REFUSED'),{code:'AUTH_TEST_REFUSED'});
    },()=>{});
  }catch(e){humanChangedCode=e.code;}
  check(humanChangedCode==='AUTH_TEST_REFUSED'&&CIP_DOM.authored(box)==='User-authored content after preparation'&&fixtureSends===9,
    'unsent authorization failure does not delete a changed user draft');
  box.replaceChildren();
  await delay(500);box.textContent='USER DRAFT';let error;
  try{await CIP_DOM.configure(config)}catch(e){error=e.code}
  check(error==='DRAFT_CONFLICT'&&box.textContent==='USER DRAFT','configuration never overwrites a user draft');
  box.replaceChildren();fixtureHints={system_hints:[]};await window.fetch(fixtureHintsUrl);await delay(50);
  try{await CIP_DOM.configure(config)}catch(e){error=e.code}
  check(error==='APP_UNAVAILABLE'&&fixtureSends===9,'removed app is refused before sending, never replaced by a same-named app');
  document.querySelector('#result').textContent=JSON.stringify({passed:checks.length,checks,scope:'offline real Chrome; not a signed-in live-site test'});
 }catch(e){document.querySelector('#result').textContent=JSON.stringify({failed:String(e),checks})}
})();
</script>'''
fixture=(R/'tests/fixtures/chatgpt.html').read_text()
fixture=fixture.replace('</body></html>',setup+''.join('<script src="/source/'+str(i)+'"></script>' for i in range(len(sources)))+runner+'</body></html>')
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/fixture':data=fixture.encode();kind='text/html; charset=utf-8'
  elif re.fullmatch(r'/source/\d+',self.path):
   i=int(self.path.rsplit('/',1)[1])
   if i>=len(sources):self.send_error(404);return
   data=('(()=>{const location=window.fixtureLocation;'+(R/'extension'/sources[i]).read_text()+'})();').encode();kind='application/javascript'
  else:self.send_error(404);return
  self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=HTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
chrome=os.environ.get('CIP_CHROME','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
(R/'.test-tools').mkdir(exist_ok=True)
try:
 with tempfile.TemporaryDirectory(prefix='chrome-test-',dir=R/'.test-tools') as profile:
  result=subprocess.run([chrome,'--headless','--disable-gpu','--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check','--user-data-dir='+profile,'--virtual-time-budget=16000','--dump-dom','http://127.0.0.1:'+str(server.server_port)+'/fixture'],capture_output=True,text=True,timeout=50)
  match=re.search(r'<pre id="result">(.*?)</pre>',result.stdout,re.S)
  if not match or html.unescape(match.group(1))=='PENDING':
   print(json.dumps({'failed':'BROWSER_TEST_DID_NOT_SETTLE','exitCode':result.returncode,'stderr':result.stderr[-1500:]},ensure_ascii=False));raise SystemExit(1)
  output=json.loads(html.unescape(match.group(1)));print(json.dumps(output,ensure_ascii=False,indent=2))
  if 'failed' in output:raise SystemExit(1)
finally:server.shutdown();server.server_close()
