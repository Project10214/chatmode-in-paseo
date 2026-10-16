"""Actual unpacked extension on 8 isolated Chrome tabs: resource and isolation smoke.
No model sends, no real ChatGPT account, no writes outside temporary profile.
The 8 concurrent SEND contract is exercised by Broker stress independently.
"""
import json,os,subprocess,tempfile,time
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]
fixture=(R/'tests/fixtures/chatgpt.html').read_text()
with tempfile.TemporaryDirectory(prefix='cip-8tabs-profile-') as profile,sync_playwright() as pw:
 launch={'headless':True,'args':['--enable-unsafe-extension-debugging','--disable-background-networking','--no-proxy-server'],
   'ignore_default_args':['--disable-extensions']}
 if os.environ.get('CIP_CHROMIUM'):launch['executable_path']=os.environ['CIP_CHROMIUM']
 browser=pw.chromium.launch_persistent_context(profile,**launch)
 browser.route('https://chatgpt.com/**',lambda request:request.fulfill(status=200,content_type='text/html',body=fixture))
 try:
  devtools=browser.browser.new_browser_cdp_session()
  installed=devtools.send('Extensions.loadUnpacked',{'path':str(R/'extension')})
  worker=browser.service_workers[0] if browser.service_workers else browser.wait_for_event('serviceworker',timeout=10000)
  assert worker.url.startswith('chrome-extension://')
  pages=[]
  for i in range(8):
   page=browser.new_page()
   page.goto('https://chatgpt.com/c/12345678-1234-4234-8234-'+format(i+1,'012x'),wait_until='domcontentloaded',timeout=10000)
   pages.append(page)
  for page in pages: page.locator('#prompt-textarea').wait_for(timeout=6000)
  assert len({p.url for p in pages})==8
  metrics=[]
  def snapshot():
   data=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,rss=,%cpu=,args='],text=True)
   rows=[]
   for ln in data.splitlines():
    cols=ln.strip().split(None,4)
    if len(cols)!=5:continue
    try:rows.append((int(cols[0]),int(cols[1]),int(cols[2]),float(cols[3]),cols[4]))
    except ValueError:pass
   family={r[0] for r in rows if '--user-data-dir='+profile in r[4]}
   for _ in range(12):
    more={r[0] for r in rows if r[1] in family}
    if more.issubset(family):break
    family|=more
   match=[r for r in rows if r[0] in family]
   return {'processes':len(match),'rssMiB':round(sum(r[2] for r in match)/1024,1),
     'cpuSingleCorePct':round(sum(r[3] for r in match),1)}
  for _ in range(5):
   metrics.append(snapshot());time.sleep(.25)
  for page in pages:
   assert page.locator('#prompt-textarea').count()==1
   assert '/c/' in page.url
  print(json.dumps({'passed':3,'checks':['unpacked Chrome MV3 extension loads into a disposable browser','eight unique ChatGPT fixture tabs remain isolated','resource CPU/RSS measured for the disposable browser profile'], 'tabCount':8,'samples':metrics,'rssMiBMax':max(s['rssMiB'] for s in metrics),'cpuSingleCorePctMax':max(s['cpuSingleCorePct'] for s in metrics),'scope':'eight real Chrome tabs, isolated mock pages; NO eight simultaneous live Sends or signed-in UI'},ensure_ascii=False,indent=2))
 finally:browser.close()
