"""Real unpacked MV3 extension + real Runtime on the current continuous contract.

Chrome tabs/worker/MAIN+ISOLATED worlds/extension messaging/HTTP are real; the
ChatGPT page and network are an isolated loopback fixture (no account/model).
Asserts user-authorized behaviour: one Paseo Send -> one user echo + one
assistant body, reload resumes observation without another Send, a second turn
reuses the conversation with one more Send, and a message typed in ChatGPT is
observed as page content without a Paseo Send.
"""
import json, os, queue, ssl, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

R = Path(__file__).resolve().parents[1]
fixture = (R/'tests/fixtures/chatgpt.html').read_text()
# Persist fixture turn state across reload so the page behaves like a real
# conversation with history instead of restarting at user-1.
fixture = fixture.replace('let seq=0', "let seq=Number(sessionStorage.getItem('fixture-seq')||0)")
fixture = fixture.replace('const n=++seq;', "const n=++seq;sessionStorage.setItem('fixture-seq',String(seq));")
fixture = fixture.replace('</body></html>',
    '<script>window.fixtureRealRoute=true;void fetch("/backend-api/system_hints?mode=plugins");'
    'if(sessionStorage.getItem("fixture-messages"))messages.innerHTML=sessionStorage.getItem("fixture-messages");'
    'new MutationObserver(()=>sessionStorage.setItem("fixture-messages",messages.innerHTML))'
    '.observe(messages,{childList:true,subtree:true,characterData:true});</script></body></html>')
checks = []
with tempfile.TemporaryDirectory(prefix='cip-mv3-state-') as directory, \
     tempfile.TemporaryDirectory(prefix='cip-mv3-profile-') as profile, sync_playwright() as pw:
    cert = Path(directory)/'fixture-cert.pem'; key = Path(directory)/'fixture-key.pem'
    subprocess.run(['/usr/bin/openssl','req','-x509','-newkey','rsa:2048','-nodes',
        '-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=chatgpt.com'],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*a): pass
        def do_GET(self):
            if self.path.startswith('/backend-api/system_hints'):
                body=json.dumps({'system_hints':[{'system_hint':'plugin:asdk_app_a','name':'Development Mac'}]}).encode(); kind='application/json'
            elif self.path.split('?')[0]=='/' or self.path.startswith('/c/'):
                body=fixture.encode(); kind='text/html; charset=utf-8'
            else:
                self.send_error(404); return
            self.send_response(200); self.send_header('Content-Type',kind)
            self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(cert,key)
    server.socket=tls.wrap_socket(server.socket,server_side=True)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    proc=subprocess.Popen([os.environ.get('CIP_NODE','/opt/homebrew/bin/node'),
        str(R/'tests/browser-harness.mjs'),directory,'0'],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=dict(os.environ))
    replies=queue.Queue(); stderr=[]
    def consume():
        for line in proc.stdout:
            try: replies.put(json.loads(line))
            except Exception: stderr.append('invalid harness output')
    threading.Thread(target=consume,daemon=True).start()
    threading.Thread(target=lambda:[stderr.append(l.rstrip()) for l in proc.stderr],daemon=True).start()
    first=replies.get(timeout=10); address=first['address']; rid=0
    def call(action,**kwargs):
        global rid
        rid+=1; mine=rid
        proc.stdin.write(json.dumps({'request':mine,'action':action,**kwargs})+'\n'); proc.stdin.flush()
        result=replies.get(timeout=20)
        if result.get('request')!=mine or result.get('error'): raise AssertionError(result)
        return result.get('result')
    browser=pw.chromium.launch_persistent_context(profile,headless=True,
        executable_path=os.environ.get('CIP_CHROMIUM'),
        args=['--enable-unsafe-extension-debugging','--no-proxy-server','--disable-background-networking',
              '--ignore-certificate-errors',f'--host-resolver-rules=MAP chatgpt.com 127.0.0.1:{server.server_port}'],
        ignore_default_args=['--disable-extensions'])
    created=[]; browser.on('page', lambda p: created.append(p))
    try:
        devtools=browser.browser.new_browser_cdp_session()
        devtools.send('Extensions.loadUnpacked',{'path':str(R/'extension')})
        worker=browser.service_workers[0] if browser.service_workers else browser.wait_for_event('serviceworker',timeout=15000)
        extension_id=worker.url.split('/')[2]
        popup=browser.new_page(); popup.goto('chrome-extension://'+extension_id+'/popup.html')
        pairing=json.loads((Path(directory)/'pairing.json').read_text())
        paired=popup.evaluate('async p=>chrome.runtime.sendMessage({type:"pair",endpoint:p.endpoint,code:p.code})',
            {'endpoint':address,'code':pairing['code']})
        assert paired.get('ok'),paired
        popup.wait_for_function('async()=>{const r=await chrome.runtime.sendMessage({type:"status"});return r.ok&&r.value.connected;}',timeout=15000)
        checks.append('real MV3 worker pairs with the isolated Runtime')
        def wait(fn,timeout=40):
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                events=call('events'); value=fn(events)
                if value: return value
                failures=[e for e in events if e.get('type')=='session.turn' and e.get('state')=='failed']
                if failures: raise AssertionError({'failures':failures[-2:],'harness':stderr[-4:]})
                time.sleep(0.1)
            raise AssertionError({'timeout':True,'events':call('events')[-8:],'harness':stderr[-6:]})
        def send_input(value): call('provider-input',input=value)
        send_input({'type':'catalog','requestId':'catalog'})
        catalog=wait(lambda es:next((e for e in es if e['type']=='catalog'),None),45)
        model=catalog['catalog']['defaultModel']
        config={'cwd':'/fixture-only','env':{},'settings':{},'mcpServers':{},'persist':True,
                'model':model,'thinkingOption':'standard','providerOptions':{'appIds':[]}}
        send_input({'type':'session.open','requestId':'open-a','sessionId':'a','config':config,'history':'skip'})
        opened=wait(lambda es:next((e for e in es if e['type']=='session.opened'),None))
        sid=opened['persistence']['data']['id']
        checks.append('catalog and open travel through the real MV3 runtime')
        def prompt(mid,text,host='a'):
            send_input({'type':'session.prompt','sessionId':host,
                'prompt':{'clientMessageId':mid,'delivery':'auto',
                          'input':{'type':'message','content':[{'type':'text','text':text}]}}})
        def state(): return call('read',id=sid)
        def wait_receipt(native_id,timeout=45):
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                s=state()
                if s['turn'].get('nativeMessageId')==native_id: return s
                time.sleep(0.1)
            raise AssertionError({'receipt':state()['turn'],'history':state()['history'],'harness':stderr[-4:]})
        def finish(sid_,timeout=45):
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                s=call('read',id=sid_)
                if s['turn'].get('outcome')=='completed' and s['status']=='idle': return s
                time.sleep(0.1)
            raise AssertionError({'not_finished':call('read',id=sid_),'harness':stderr[-4:]})
        def assistant_rows(s): return [r for r in s['history'] if r.get('type')=='assistant_message']
        def user_rows(s): return [r for r in s['history'] if r.get('type')=='user_message']
        def find_page(timeout=30):
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                page=next((p for p in created if 'chatgpt.com/c/' in p.url),None)
                if page is None:
                    page=next((p for p in browser.browser.contexts[0].pages if 'chatgpt.com/c/' in p.url),None)
                if page:
                    page.wait_for_selector('[data-testid="send-button"]',timeout=30000)
                    return page
                time.sleep(0.2)
            ts=devtools.send('Target.getTargets')['targetInfos']
            chat=[t for t in ts if t['type']=='page' and t['url'].startswith('https://chatgpt.com')]
            if chat:
                devtools.send('Target.activateTarget',{'targetId':chat[0]['targetId']})
                time.sleep(0.5)
                page=next((p for p in browser.browser.contexts[0].pages if 'chatgpt.com/c/' in p.url),None)
                if page:
                    page.wait_for_selector('[data-testid="send-button"]',timeout=30000)
                    return page
            raise AssertionError({'no_page':[p.url for p in browser.browser.contexts[0].pages],'targets':[t['url'] for t in ts if t['type']=='page'],'harness':stderr[-6:]})
        prompt('first','FIRST_MV3_BODY')
        page=find_page()
        received=wait_receipt('user-1')
        assert received['conversationId'] and received['turn']['receivedAt'], received['turn']
        first_done=finish(sid)
        assert first_done['turn']['nativeMessageId']=='user-1'
        users=user_rows(first_done)
        assert len(users)==1,users
        assert users[0]['text']=='FIRST_MV3_BODY',users
        answers=[r.get('text','') for r in assistant_rows(first_done)]
        assert any('Fixture' in text and 'FIRST' in text and 'MV3' in text for text in answers),answers
        saves=lambda: len([c for c in json.loads((Path(directory)/'state.json').read_text())['commands'].values() if c['kind']=='send' and c.get('sessionId')==sid])
        assert saves()==1
        checks.append('one Send -> one Paseo user echo, one observed assistant body, no duplicate user source')
        sends_before_reload=saves()
        page.reload(); page.wait_for_selector('[data-testid="send-button"]',timeout=30000)
        time.sleep(1.5)
        reloaded=state()
        assert saves()==sends_before_reload
        assert len(user_rows(reloaded))==1,reloaded['history']
        checks.append('page reload resumes observation without another Send or duplicate source')
        prompt('second','SECOND_MV3_BODY')
        wait_receipt('user-2')
        second=finish(sid)
        assert second['conversationId']==first_done['conversationId']
        # The source collector is independent of the page-button terminal.
        # Wait for eventual persisted content, not an arbitrary poll snapshot;
        # still fail if the second answer never arrives.
        end=time.monotonic()+15
        while not any('SECOND' in r.get('text','') and 'MV3' in r.get('text','') for r in assistant_rows(second)):
            if time.monotonic()>=end: raise AssertionError({'missing_second_answer':assistant_rows(second),'harness':stderr[-4:]})
            time.sleep(0.1); second=state()
        assert saves()==2
        checks.append('second Paseo turn reuses the conversation and sends exactly once')
        before_sends=saves()
        page.locator('#prompt-textarea').fill('MANUAL_CHATGPT_BODY')
        page.evaluate("document.querySelector('[data-testid=\"send-button\"]').click()")
        end=time.monotonic()+40; manual_state=None
        while time.monotonic()<end:
            s=state()
            if any(r.get('type')=='user_message' and r.get('messageId')=='user-3' for r in s['history']):
                manual_state=s; break
            time.sleep(0.1)
        assert manual_state,{'manual':state()['history'],'harness':stderr[-4:]}
        assert any(r.get('type')=='user_message' and r.get('messageId')=='user-3'
                   and r.get('text')=='MANUAL_CHATGPT_BODY' for r in manual_state['history']),manual_state['history']
        after_sends=saves()
        assert after_sends==before_sends, (before_sends, after_sends)
        checks.append('a message typed in ChatGPT is captured as page content with no Paseo Send')
        print(json.dumps({'passed':len(checks),'checks':checks,
            'scope':'REAL unpacked MV3 + Chrome tabs/worker/worlds + Node Runtime/Provider; page/network are offline fixtures'},
            ensure_ascii=False,indent=2))
    finally:
        try: call('close')
        finally:
            browser.close(); proc.stdin.close(); server.shutdown(); server.server_close()
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: proc.terminate(); proc.wait(timeout=5)
