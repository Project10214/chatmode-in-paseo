"""Read-only acceptance of the registered Chrome Native Messaging host.

An invalid action is deliberately used: the host must refuse it without
opening Paseo or performing any native operation.
"""
from pathlib import Path
import json
import tempfile
import shutil
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
HOST='com.foolwork.cos_in_paseo_wake'
CREDS=Path.home()/'.cos-in-paseo/bridge-credential.json'
CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
cred=json.loads(CREDS.read_text())
with tempfile.TemporaryDirectory(prefix='cip-native-host-check-') as profile:
  # Chrome's isolated --user-data-dir does not inherit the user's default
  # NativeMessagingHosts folder. Mirror the tested manifest ONLY inside this
  # disposable test profile; this is not a production reinstallation.
  native_dir=Path(profile)/'NativeMessagingHosts'
  native_dir.mkdir(mode=0o700)
  source=Path.home()/'Library/Application Support/Google/Chrome/NativeMessagingHosts'/f'{HOST}.json'
  shutil.copy2(source,native_dir/f'{HOST}.json')
  with sync_playwright() as pw:
    ctx=pw.chromium.launch_persistent_context(profile,headless=True,executable_path=CHROME,
      args=['--enable-unsafe-extension-debugging','--disable-background-networking',
      '--no-first-run','--no-default-browser-check'],
      ignore_default_args=['--disable-extensions'])
    try:
      cdp=ctx.browser.new_browser_cdp_session()
      installed=cdp.send('Extensions.loadUnpacked',{'path':str(ROOT/'extension')})
      worker=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker',timeout=15000)
      extid=worker.url.split('/')[2]
      result=worker.evaluate("""async () => {
        try {
          return {connected:true,value:await chrome.runtime.sendNativeMessage(
            'com.foolwork.cos_in_paseo_wake',{v:1,action:'test_invalid'})};
        } catch (e) {return {connected:false,error:String(e.message||e)}}
      }""")
      ok=extid==cred['extensionId'] and result.get('connected') and result.get('value')=={'ok':False,'error':'INVALID_REQUEST'}
      print(json.dumps({'test':'NATIVE_HOST_CHROME_REAL','extensionIdentityMatchesPairing':extid==cred['extensionId'],
        'hostReached':result.get('connected'),
        'invalidActionRefused':result.get('value')=={'ok':False,'error':'INVALID_REQUEST'},
        'diagnostic':None if ok else result.get('error','unexpected response'),
        'result':'PASS' if ok else 'FAIL'}))
    finally:
      ctx.close()
