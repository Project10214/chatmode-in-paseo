"""Actual TSX with React/RN-web; host RPC/Modal shell are fixtures, not installed UI.
Chrome popup uses shipped HTML/CSS/JS and a fake runtime. No real pairing or account.
"""
import json,os,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1];OUT=R/'docs'/os.environ.get('CIP_UI_EVIDENCE_DIR','evidence-alpha3-8');OUT.mkdir(exist_ok=True)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  path=self.path.split('?')[0]
  if path=='/ui':data=b'<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui}*{box-sizing:border-box}</style><div id="root"></div><script src="/preview.js"></script></html>';kind='text/html'
  elif path=='/preview.js':data=(R/'.test-tools/ui/preview.js').read_bytes();kind='application/javascript'
  elif path in ['/popup.html','/popup.css','/popup.js']:data=(R/'extension'/path[1:]).read_bytes();kind='text/html' if path.endswith('.html') else 'text/css' if path.endswith('.css') else 'application/javascript'
  else:self.send_error(404);return
  self.send_response(200);self.send_header('Content-Type',kind+'; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}'
checks=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('CIP_CHROMIUM','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
 try:
  for width,dark,name in [(920,False,'settings-desktop-light'),(390,True,'settings-mobile-dark')]:
   p=browser.new_page(viewport={'width':width,'height':940},color_scheme='dark' if dark else 'light');errs=[];p.on('pageerror',lambda e:errs.append(str(e)))
   p.goto(base+'/ui'+('?dark' if dark else ''));p.get_by_role('button',name='保存默认配置',exact=True).wait_for();p.wait_for_timeout(250)
   assert p.evaluate('document.documentElement.scrollWidth<=innerWidth'),name
   p.screenshot(path=str(OUT/(name+'.png')),full_page=True)
   assert p.get_by_role('radio',name='并发 2 路',exact=True).get_attribute('aria-checked')=='true'
   p.get_by_role('radio',name='并发 4 路',exact=True).click()
   p.get_by_role('button',name='应用并发上限',exact=True).click()
   p.get_by_text('已应用并保存。降低上限不会停止正在运行的任务。',exact=True).wait_for()
   p.wait_for_timeout(2200)
   assert p.evaluate('fixture.state.capacity.limit')==4
   assert p.get_by_role('radio',name='并发 4 路',exact=True).get_attribute('aria-checked')=='true'
   assert '正在执行 1 · 等待 2 · 当前上限 4' in p.locator('body').inner_text()
   checks.append(name+': concurrency 2->4 saves and survives polling without altering active/waiting')
   p.get_by_role('radio',name='并发 1 路',exact=True).click()
   p.evaluate('fixture.failConcurrency=true')
   p.get_by_role('button',name='应用并发上限',exact=True).click()
   p.get_by_text('保存失败，未修改并发上限。',exact=True).wait_for()
   assert p.evaluate('fixture.state.capacity.limit')==4
   assert p.get_by_role('radio',name='并发 1 路',exact=True).get_attribute('aria-checked')=='true'
   p.evaluate('fixture.failConcurrency=false')
   p.get_by_role('button',name='应用并发上限',exact=True).click()
   p.get_by_text('已应用并保存。降低上限不会停止正在运行的任务。',exact=True).wait_for()
   assert p.evaluate('fixture.state.capacity.limit')==1
   assert p.evaluate("fixture.calls.filter(c=>c.name==='bridge.concurrency').map(c=>c.input.maxConcurrent)")==[4,1,1]
   checks.append(name+': concurrency failed save retains draft; retry is the only committed change')
   p.get_by_role('radio',name='GPT · Pro',exact=True).click();p.wait_for_timeout(2200)
   assert p.get_by_role('radio',name='GPT · Pro',exact=True).get_attribute('aria-checked')=='true',p.get_by_role('radio',name='GPT · Pro',exact=True).evaluate('(e)=>e.outerHTML')
   assert '未保存' in p.locator('body').inner_text();checks.append(name+': responsive layout and polling preserves unsaved selection')
   p.get_by_label('搜索应用',exact=True).fill('github');assert p.get_by_role('switch',name='GitHub',exact=True).count()==1;assert p.get_by_role('switch',name='mymac',exact=True).count()==0
   p.get_by_label('搜索应用',exact=True).fill('');checks.append(name+': application search retains selections')
   p.evaluate('fixture.failSave=true');p.get_by_role('button',name='保存默认配置',exact=True).click();p.get_by_text('保存失败，未保存的选择仍在，请检查连接后重试。',exact=True).wait_for();assert '未保存' in p.locator('body').inner_text()
   p.evaluate('fixture.failSave=false');p.get_by_role('button',name='保存默认配置',exact=True).click();p.get_by_text('已保存。仅对新会话生效，现有会话保持不变。',exact=True).wait_for();p.wait_for_timeout(2200)
   assert p.get_by_role('radio',name='GPT · Pro',exact=True).get_attribute('aria-checked')=='true',p.get_by_role('radio',name='GPT · Pro',exact=True).evaluate('(e)=>e.outerHTML');assert '未保存' not in p.locator('body').inner_text()
   checks.append(name+': failed save preserved; successful save survives server clock offset and next poll')
   p.get_by_role('button',name='连接 Chrome 扩展',exact=True).click();p.get_by_role('button',name='生成一次性配对码',exact=True).click();p.get_by_role('button',name='复制配对码',exact=True).click();assert p.evaluate('fixture.copied')=='test-only-pairing-code-not-valid'
   checks.append(name+': pairing opens only by intent and copies test code')
   assert not errs,errs;p.close()
  p=browser.new_page(viewport={'width':390,'height':844});p.goto(base+'/ui?screen=image');p.get_by_role('button',name='放大预览',exact=True).wait_for();p.screenshot(path=str(OUT/'image-card-mobile.png'),full_page=True)
  p.get_by_role('button',name='放大预览',exact=True).click();p.get_by_role('dialog',name='图片预览').wait_for();p.get_by_role('button',name='关闭图片预览').click();assert p.get_by_role('dialog').count()==0
  p.get_by_role('button',name='网页查看原图',exact=True).click();assert p.evaluate('fixture.opened').startswith('https://chatgpt.com/c/');checks.append('actual image card loads chunks, zooms, closes, and opens only conversation URL');p.close()
  p=browser.new_page(viewport={'width':390,'height':844});p.goto(base+'/ui?screen=image&failimage');p.get_by_role('button',name='重试读取',exact=True).wait_for();p.evaluate('fixture.failImage=false');p.get_by_role('button',name='重试读取',exact=True).click();p.get_by_role('button',name='放大预览',exact=True).wait_for();assert p.evaluate("fixture.calls.every(c=>c.name==='bridge.image.read')");checks.append('preview read retry performs no send or generation');p.close()
  p=browser.new_page(viewport={'width':390,'height':844});p.goto(base+'/ui?screen=image&unavailable');p.get_by_text('图片已在网页生成，预览未能读取。',exact=True).wait_for();assert p.evaluate('fixture.calls.length')==0;checks.append('unavailable card is terminal and never loops reads');p.close()
  for query,title in [('screen=activity','正在搜索资料'),('screen=activity&approval','等待网页授权'),('screen=activity&finished','本轮已完成')]:
   p=browser.new_page(viewport={'width':390,'height':844},color_scheme='dark' if 'approval' in query else 'light')
   p.goto(base+'/ui?'+query);p.get_by_text(title,exact=True).wait_for()
   assert 'web.run' in p.locator('body').inner_text()
   assert 'mymac · run_shell_command' in p.locator('body').inner_text()
   assert 'PRIVATE_NOT_ALLOWED' not in p.locator('body').inner_text()
   if 'approval' in query:assert '本插件不会替你点击' in p.locator('body').inner_text()
   p.screenshot(path=str(OUT/('native-'+query.replace('screen=activity','activity').replace('&','-')+'.png')),full_page=True)
   checks.append(query+': public activity card renders stages without private data')
   p.close()
  for dark in [False,True]:
   p=browser.new_page(viewport={'width':400,'height':900},color_scheme='dark' if dark else 'light')
   p.add_init_script('''window.fx={paired:true,connected:true,calls:[]};window.chrome={runtime:{getManifest:()=>({version_name:'0.1.0-alpha.3.8'}),sendMessage:async m=>{fx.calls.push(m.type);if(m.type==='status')return{ok:true,value:{paired:fx.paired,connected:fx.connected,endpoint:'http://127.0.0.1:17843',activeSessions:1}};if(m.type==='pair'){fx.paired=true;fx.connected=true;return{ok:true,value:{paired:true}}};if(m.type==='disconnect'){fx.paired=false;fx.connected=false;return{ok:true,value:{paired:false}}};return{ok:false}}},tabs:{create:async()=>{fx.opened=true}}};''')
   p.goto(base+'/popup.html');p.get_by_text('已连接 Paseo',exact=True).wait_for();p.screenshot(path=str(OUT/('popup-dark.png' if dark else 'popup-light.png')),full_page=True)
   p.get_by_role('button',name='配对设置',exact=True).click();p.locator('#code').fill('fixture-code');p.get_by_role('button',name='显示配对码').click();assert p.locator('#code').get_attribute('type')=='text';p.locator('#connect').click();assert p.locator('#code').input_value()==''
   p.get_by_role('button',name='断开连接',exact=True).click();assert p.evaluate("!fx.calls.includes('disconnect')");p.get_by_role('button',name='继续保持连接',exact=True).click();assert p.evaluate('fx.paired');p.get_by_role('button',name='断开连接',exact=True).click();p.get_by_role('button',name='确认断开',exact=True).click();p.get_by_text('桥接已断开。已发出的网页任务没有被停止。',exact=True).wait_for();assert not p.evaluate('fx.paired')
   assert p.evaluate('document.documentElement.scrollWidth<=innerWidth');checks.append(('dark' if dark else 'light')+' popup: secret clears, disconnect requires confirmation, no horizontal overflow');p.close()
 finally:browser.close();server.shutdown();server.server_close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'Shipped TSX React/RN-web with fixture host RPC/modal; shipped Chrome popup with fixture runtime. Actual installed host contracts separately typechecked.'},ensure_ascii=False,indent=2))
