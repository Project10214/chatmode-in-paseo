"""Popup UI/UX checks against the shipped HTML/CSS/JS in Chromium.

The Chrome runtime is a deterministic local fixture. No user credentials,
production extension, ChatGPT tab, real pairing, or session is touched.
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUTPUT=ROOT/'.test-tools/popup-ux-evidence'
OUTPUT.mkdir(parents=True,exist_ok=True)
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        file=self.path.split('?')[0].lstrip('/')
        if file not in ('popup.html','popup.css','popup.js'):
            self.send_error(404);return
        content=(ROOT/'extension'/file).read_bytes()
        mime='text/html' if file.endswith('.html') else 'text/css' if file.endswith('.css') else 'application/javascript'
        self.send_response(200)
        self.send_header('Content-Type',mime+'; charset=utf-8')
        self.send_header('Content-Length',str(len(content)))
        self.end_headers()
        self.wfile.write(content)

server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}/popup.html'
js="""window.fx={paired:true,connected:true,activeSessions:2,calls:[],failStatus:false,failPair:false,opened:0};
window.chrome={
  runtime:{
    getManifest:()=>({version:'0.2.6',version_name:'0.2.6'}),
    sendMessage:async request=>{
      fx.calls.push(request);
      if(request.type==='status'){
        if(fx.failStatus)throw new Error('mock offline');
        return {ok:true,value:{paired:fx.paired,connected:fx.connected,
          endpoint:'http://127.0.0.1:17843',activeSessions:fx.activeSessions}};
      }
      if(request.type==='pair'){
        if(fx.failPair)return {ok:false,error:'PAIRING_REJECTED'};
        fx.paired=true;fx.connected=true;
        return {ok:true,value:{paired:true}};
      }
      if(request.type==='disconnect'){
        fx.paired=false;fx.connected=false;
        return {ok:true,value:{paired:false}};
      }
      return {ok:false,error:'UNKNOWN'};
    }
  },
  tabs:{create:async()=>{fx.opened++;return {id:1}}}
};"""
checks=[]
try:
    with sync_playwright() as pw:
        args={'headless':True}
        if os.environ.get('CIP_CHROMIUM'):args['executable_path']=os.environ['CIP_CHROMIUM']
        browser=pw.chromium.launch(**args)
        try:
            for scheme in ('light','dark'):
                page=browser.new_page(viewport={'width':480,'height':720},color_scheme=scheme)
                errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                page.add_init_script(js)
                page.goto(base,wait_until='load')
                page.get_by_text('已连接 Paseo',exact=True).wait_for()
                assert page.get_by_text('v0.2.6',exact=True).is_visible()
                assert page.locator('#version').get_attribute('title')=='Chrome 扩展 0.2.6'
                assert page.locator('#dashboard').is_visible()
                assert not page.locator('#pair-section').is_visible()
                assert page.get_by_text('2 个活跃会话',exact=True).is_visible()
                size=page.evaluate("()=>({w:document.body.getBoundingClientRect().width,h:document.body.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth})")
                assert size['w']==400 and size['h']<400 and not size['overflow'],size
                page.locator('body').screenshot(path=str(OUTPUT/f'connected-{scheme}.png'))
                checks.append(scheme+' dashboard: connected state, 400px wide, compact height, no overflow')
                # Reproduce the narrow initial viewport of a Chrome action
                # popup. html and body must stay at 400px, not shrink to 150px.
                page.set_viewport_size({'width':150,'height':720})
                narrow=page.evaluate("""()=>({
                  html:getComputedStyle(document.documentElement).width,
                  body:document.body.getBoundingClientRect().width,
                  rootScroll:document.documentElement.scrollWidth
                })""")
                assert narrow['html']=='400px' and narrow['body']==400 and narrow['rootScroll']>=400,narrow
                page.set_viewport_size({'width':480,'height':720})
                checks.append(scheme+' popup root: stays 400px even when Chrome starts at 150px')
                page.get_by_role('button',name='配对设置').click()
                assert page.locator('#pair-section').is_visible() and not page.locator('#dashboard').is_visible()
                size=page.evaluate("()=>({w:document.body.getBoundingClientRect().width,h:document.body.getBoundingClientRect().height})")
                assert size['w']==400 and size['h']<580,size
                page.locator('body').screenshot(path=str(OUTPUT/f'setup-{scheme}.png'))
                page.locator('#endpoint').fill('http://127.0.0.1:19000')
                page.locator('#code').fill('fixture-code')
                page.get_by_role('button',name='显示配对码').click()
                assert page.locator('#code').get_attribute('type')=='text'
                page.wait_for_timeout(2150)
                assert page.locator('#endpoint').input_value()=='http://127.0.0.1:19000'
                assert page.locator('#code').input_value()=='fixture-code'
                page.get_by_role('button',name='← 返回概况').click()
                assert page.locator('#dashboard').is_visible() and page.locator('#code').input_value()==''
                checks.append(scheme+' setup: separate page, back cleans secret, polling preserves draft')
                page.get_by_role('button',name='打开 ChatGPT').click()
                assert page.evaluate('fx.opened')==1
                page.get_by_role('button',name='断开连接').click()
                assert page.locator('#disconnect-confirm').is_visible()
                assert page.locator('#disconnect').is_hidden(), 'confirm must not expose another disconnect action'
                assert page.evaluate("fx.calls.filter(c=>c.type==='disconnect').length")==0
                page.locator('body').screenshot(path=str(OUTPUT/f'confirm-{scheme}.png'))
                page.get_by_role('button',name='继续保持连接').click()
                assert page.locator('#dashboard').is_visible()
                page.get_by_role('button',name='断开连接').click()
                page.get_by_role('button',name='确认断开').click()
                page.get_by_text('桥接已断开。已发出的网页任务没有被停止。',exact=True).wait_for()
                assert page.evaluate("fx.calls.filter(c=>c.type==='disconnect').length")==1
                assert page.locator('#pair-section').is_hidden()
                assert page.get_by_role('button',name='开始配对').is_visible()
                page.locator('body').screenshot(path=str(OUTPUT/f'unpaired-{scheme}.png'))
                checks.append(scheme+' disconnect: explicit confirmation, no auto-open pairing, no extra logout')
                page.get_by_role('button',name='开始配对').click()
                page.evaluate('fx.failPair=true')
                page.locator('#code').fill('fixture-rejected')
                page.get_by_role('button',name='连接 Paseo').click()
                page.get_by_text('配对码无效或已过期。现有连接未被替换。',exact=True).wait_for()
                assert page.locator('#code').input_value()=='fixture-rejected'
                assert page.locator('#pair-section').is_visible()
                page.evaluate('fx.failPair=false')
                page.get_by_role('button',name='连接 Paseo').click()
                page.get_by_text('配对成功。现在可在 Paseo 新建 Chatmode 会话。',exact=True).wait_for()
                assert page.locator('#code').input_value()=='' and page.locator('#dashboard').is_visible()
                checks.append(scheme+' pairing: invalid code retains draft; success clears secret and returns home')
                assert not errors,errors
                page.close()
        finally:browser.close()
finally:server.shutdown();server.server_close()
print(json.dumps({'passed':len(checks),'checks':checks,
  'scope':'actual shipped popup HTML/CSS/JS in Chromium, mocked runtime only',
  'images':str(OUTPUT)},ensure_ascii=False,indent=2))
