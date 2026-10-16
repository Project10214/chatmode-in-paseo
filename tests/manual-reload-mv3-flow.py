"""Real Chrome MV3 developer-reload recovery, with isolated Runtime and fake ChatGPT.

No production Chrome Profile, token, login, model call or Paseo Agent touched.
First install 0.2.6 then load 0.2.7 from same extension ID. Chrome need not
emit onInstalled(update); the new worker must observe stored manifest version.
"""
import json, os, tempfile, shutil, time, threading
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
TOKEN='fixture-reload-token'
C_ID='bound-chat'
S_ID='manual-reload-agent'
calls=[]
lock=threading.Lock()

class Runtime(BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def _json(self,body,status=200):
    raw=json.dumps(body).encode()
    self.send_response(status)
    self.send_header('Content-Type','application/json')
    self.send_header('Content-Length',str(len(raw)))
    self.end_headers()
    self.wfile.write(raw)
  def do_GET(self):
    name=self.path.split('?')[0]
    with lock:calls.append((name,'GET'))
    if name=='/hello':return self._json({'product':'chatmode-in-paseo','protocol':5})
    if name=='/recovery-targets':
      return self._json({'sessions':[{'sessionId':S_ID,'conversationId':C_ID,'tabId':TARGET_ID[0]}]})
    if name=='/active' or name=='/bindings':return self._json({'sessions':[]})
    if name=='/commands':return self._json({'commands':[]})
    return self._json({'error':'ROUTE_NOT_FOUND'},404)
  def do_POST(self):
    name=self.path.split('?')[0]
    raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
    try:value=json.loads(raw)
    except Exception:value={}
    with lock:calls.append((name,value))
    if name=='/resume-agent':return self._json({'queued':True})
    return self._json({'accepted':True})

TARGET_ID=[None]
with tempfile.TemporaryDirectory(prefix='cip-real-chrome-reload-') as tmp:
  ext=Path(tmp)/'extension'
  shutil.copytree(ROOT/'extension',ext)
  manifest=ext/'manifest.json'
  obj=json.loads(manifest.read_text())
  obj['version']='0.2.6'
  obj['version_name']='0.2.6'
  manifest.write_text(json.dumps(obj))
  server=ThreadingHTTPServer(('127.0.0.1',0),Runtime)
  threading.Thread(target=server.serve_forever,daemon=True).start()
  try:
    with sync_playwright() as pw:
      launch={'headless':True,'args':['--enable-unsafe-extension-debugging','--disable-background-networking'],
        'ignore_default_args':['--disable-extensions']}
      if os.environ.get('CIP_CHROMIUM'):launch['executable_path']=os.environ['CIP_CHROMIUM']
      ctx=pw.chromium.launch_persistent_context(str(Path(tmp)/'profile'),**launch)
      try:
        def fake(route):
          r=route.request
          if '/backend-api/system_hints' in r.url:
            return route.fulfill(status=200,content_type='application/json',body='{"system_hints":[]}')
          return route.fulfill(status=200,content_type='text/html',body=(
            '<!doctype html><html><head><title>CIP RELOAD</title></head><body>'
            '<main>Safe offline recovery fixture</main><script>'
            'const n=Number(sessionStorage.getItem("loadCount")||0)+1;'
            'sessionStorage.setItem("loadCount",String(n));'
            '</script></body></html>'))
        ctx.route('https://chatgpt.com/**',fake)
        cdp=ctx.browser.new_browser_cdp_session()
        before=cdp.send('Extensions.loadUnpacked',{'path':str(ext)})
        eid=before['id']
        worker=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker',timeout=15000)
        tab=ctx.new_page()
        tab.goto('https://chatgpt.com/c/'+C_ID,wait_until='domcontentloaded')
        # chrome.tabs id is not Playwright page index.
        rows=worker.evaluate("""async()=>chrome.tabs.query({url:'https://chatgpt.com/*'})""")
        selected=[r for r in rows if r.get('url','').endswith('/c/'+C_ID)]
        assert len(selected)==1,selected
        TARGET_ID[0]=selected[0]['id']
        old_loads=tab.evaluate("Number(sessionStorage.getItem('loadCount'))")
        assert old_loads==1,old_loads
        worker.evaluate("""async a=>chrome.storage.local.set({
            loadedChromeVersion:'0.2.6',
            config:{endpoint:a.endpoint,token:a.token},
            tabs:{[a.tab]:{sessionId:a.sessionId,documentKey:'prior-doc'}}
        })""",{'endpoint':f'http://127.0.0.1:{server.server_port}','token':TOKEN,
              'tab':TARGET_ID[0],'sessionId':S_ID})
        # Preserve exactly the same unpacked extension identity and profile.
        obj['version']='0.2.7'
        obj['version_name']='0.2.7'
        manifest.write_text(json.dumps(obj))
        updated=cdp.send('Extensions.loadUnpacked',{'path':str(ext)})
        assert updated['id']==eid,(before,updated)
        outcome=None
        for retry in range(80):
          time.sleep(.25)
          with lock:
            seen=list(calls)
          try:
            count=tab.evaluate("Number(sessionStorage.getItem('loadCount')||0)")
          except Exception:count=0
          # Extension must explicitly reload only its saved managed tab and
          # ask the isolated Runtime to re-activate its original Agent.
          woke=any(x[0]=='/resume-agent' for x in seen)
          if count>=2 and woke:
            outcome=(count,seen)
            break
        post=cdp.send('Target.getTargets').get('targetInfos',[])
        print(json.dumps({
          'test':'REAL_MV3_MANUAL_VERSION_CHANGE','sameExtensionId':updated['id']==eid,
          'initialLoads':old_loads,'laterLoads':outcome[0] if outcome else count,
          'recoveryTargetQueried':any(x[0]=='/recovery-targets' for x in seen),
          'resumeAgentRequested':any(x[0]=='/resume-agent' for x in seen),
          'bodySendCalls':sum(1 for x in seen if x[0] in ['/claim','/authorize','/result']),
          'result':'PASS' if outcome else 'FAIL',
          'scope':'Isolated Chrome + fake Runtime / fake ChatGPT, never production'
        },ensure_ascii=False))
        assert outcome,seen
      finally:ctx.close()
  finally:
    server.shutdown()
    server.server_close()
