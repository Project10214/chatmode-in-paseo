"""Full unpacked MV3 extension + actual Provider/Runtime on an isolated browser profile.
ChatGPT's network and native page are fixtures. Chrome tabs, service worker,
MAIN/ISOLATED scripts, extension messaging and HTTP are NOT mocked. No user profile,
real account, model calls or production Runtime credentials are touched.
"""
import json, os, queue, ssl, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright
R = Path(__file__).resolve().parents[1]
escape_requests = os.environ.get('CIP_FIXTURE_ESCAPE_REQUESTS') == '1'
collapse_fixture = os.environ.get('CIP_FIXTURE_COLLAPSE') == '1'
fixture = (R/'tests/fixtures/chatgpt.html').read_text()
fixture = fixture.replace('</body></html>', '<script>' + (R/'tests/fixtures/native-picker.js').read_text() + '</script></body></html>')
script = r'''
window.fixtureRealRoute=true;
const fixtureEscapeRequests=__CIP_FIXTURE_ESCAPE_REQUESTS__;
const fixtureCollapse=__CIP_FIXTURE_COLLAPSE__;
window.fixtureState=JSON.parse(sessionStorage.getItem('fixture-state')||'{"clicks":0,"turns":[]}');
function storeFixture(){sessionStorage.setItem('fixture-state',JSON.stringify(fixtureState));}
function renderFixture(){
 document.querySelector('main').replaceChildren();
 for(const entry of fixtureState.turns){
  const section=document.createElement('article');
  const user=document.createElement('div');
  user.setAttribute('data-chatgpt-search-unit-key',entry.layout+':0:user');
  user.textContent=entry.turn.items[0].message;
  user.__reactFiber$fixture={memoizedProps:{conversationId:entry.conversationId,turn:entry.turn},return:null};
  const answer=document.createElement('div');answer.className='markdown';
  answer.setAttribute('data-chatgpt-search-unit-key',entry.layout+':1:assistant');
  answer.textContent=entry.turn.items[1].content;
  const recap=entry.turn.items.find(x=>x.type==='chatgpt-reasoning-group');
   if(recap){
     const summary=document.createElement('div');summary.textContent=recap.reasoningRecap.summary;
     summary.setAttribute('data-testid','visible-thinking-summary');
     const tool=document.createElement('div');tool.textContent='mymac · read';
     tool.setAttribute('data-testid','visible-tool-call');
     tool.setAttribute('data-tool-call-id','mcp-visible-'+entry.number);
     const input=document.createElement('pre');input.dataset.testid='tool-call-input';
     input.textContent='api_key=VISIBLE_DEMO_CREDENTIAL';
     const output=document.createElement('pre');output.dataset.testid='tool-call-output';
     output.textContent=entry.turn.status==='complete'?'Visible tool result '+entry.number:'Working';
     const hidden=document.createElement('pre');hidden.dataset.testid='tool-call-output';
     hidden.setAttribute('aria-hidden','true');hidden.textContent='HIDDEN_TOOL_PAYLOAD';
     tool.append(input,output,hidden);
     section.append(summary,tool);
   }
   section.append(user,answer);document.querySelector('main').append(section);
 }
}
function finishFixture(entry){
 entry.layout=entry.id;entry.turn.status='complete';entry.turn.items[1].completed=true;
  const recap=entry.turn.items.find(x=>x.type==='chatgpt-reasoning-group');
  if(recap)recap.items[0].completed=true;
 entry.turn.items[1].content='MV3_REPLY_'+entry.number;
 storeFixture();renderFixture();document.querySelector('[data-testid="stop-button"]')?.remove();
}
function resumeFixture(entry){
 const stop=document.createElement('button');stop.type='button';stop.dataset.testid='stop-button';stop.textContent='Stop';box.closest('form').append(stop);
 setTimeout(()=>{entry.layout=entry.id;storeFixture();renderFixture()},1200);
 setTimeout(()=>finishFixture(entry),2500);
}
renderFixture();
if(fixtureState.turns.at(-1)?.turn.status==='in_progress')resumeFixture(fixtureState.turns.at(-1));
send.onclick=()=>{
 const text=plain();box.replaceChildren();fixtureState.clicks++;
 // Independent fixture serializer; never call the production decoder to build test data.
 const nativeText=fixtureEscapeRequests?Array.from(text,c=>{
  const n=c.charCodeAt(0);
  return c==='\n'?'\\\n':((n>=33&&n<=47)||(n>=58&&n<=64)||(n>=91&&n<=96)||(n>=123&&n<=126))?'\\'+c:c;
 }).join(''):text;
 let cid=/^\/c\/([^/]+)/.exec(location.pathname)?.[1];
 if(!cid){cid=crypto.randomUUID();history.replaceState({},'', '/c/'+cid);}
 const n=fixtureState.clicks,entry={id:'native-turn-'+n,number:n,layout:'fallback-turn-'+(n-1),conversationId:cid,turn:{status:'in_progress',items:[
  {type:'user-message',messageId:'native-user-'+n,serverMessageId:'native-user-'+n,message:nativeText},
  {type:'assistant-message',messageId:'native-answer-'+n,phase:'final_answer',completed:false,content:''}
 ]}};
 entry.turn.items.push({type:'chatgpt-reasoning-group',id:'recap-'+n,
    reasoningRecap:{type:fixtureCollapse?'collapse':'show',summary:'Public summary for turn '+n},
    activeReasoning:{text:'NEVER_EXPORT_PRIVATE_COT',presentation:'thought'},
    items:[{type:'mcp-tool-call',callId:'mcp-visible-'+n,recipient:fixtureCollapse?'mymac':'all',
      invocation:{server:'mymac',tool:'link_'+'a'.repeat(32)+'/read',
        arguments:{secret:'NEVER_EXPORT_TOOL_ARGUMENTS'}},
      completed:false}]});
  fixtureState.turns.push(entry);storeFixture();renderFixture();resumeFixture(entry);
};
void fetch('/backend-api/system_hints?mode=plugins');
'''
script=script.replace('__CIP_FIXTURE_ESCAPE_REQUESTS__', 'true' if escape_requests else 'false')
script=script.replace('__CIP_FIXTURE_COLLAPSE__', 'true' if collapse_fixture else 'false')
fixture=fixture.replace('</body></html>','<script>'+script+'</script></body></html>')
checks=[]
with tempfile.TemporaryDirectory(prefix='cip-mv3-state-') as directory, tempfile.TemporaryDirectory(prefix='cip-mv3-profile-') as profile, sync_playwright() as pw:
    # Extension-created tabs may begin navigation before Playwright attaches its
    # route hooks. Resolve ChatGPT to a LOOPBACK TLS fixture at the network layer;
    # no request can reach the real service, including the very first document.
    cert=Path(directory)/'fixture-cert.pem'; key=Path(directory)/'fixture-key.pem'
    subprocess.run(['/usr/bin/openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=chatgpt.com'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
    class FixtureHandler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_GET(self):
            if self.path.startswith('/backend-api/system_hints'):
                body=json.dumps({'system_hints':[{'system_hint':'plugin:asdk_app_a','name':'Development Mac'},{'system_hint':'plugin:asdk_app_b','name':'Tasks'}]}).encode(); kind='application/json'
            elif self.path.split('?')[0]=='/' or self.path.startswith('/c/'):
                body=fixture.encode(); kind='text/html; charset=utf-8'
            else:
                self.send_error(404); return
            self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    fixture_server=ThreadingHTTPServer(('127.0.0.1',0),FixtureHandler)
    tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(cert,key)
    fixture_server.socket=tls.wrap_socket(fixture_server.socket,server_side=True)
    threading.Thread(target=fixture_server.serve_forever,daemon=True).start()
    env=dict(os.environ)
    node=os.environ.get('CIP_NODE','/opt/homebrew/bin/node')
    proc=subprocess.Popen([node,str(R/'tests/browser-harness.mjs'),directory,'0'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    replies=queue.Queue(); errors=[]; count=0
    def consume():
        for line in proc.stdout:
            try:replies.put(json.loads(line))
            except Exception:errors.append('invalid harness output')
    threading.Thread(target=consume,daemon=True).start()
    threading.Thread(target=lambda:errors.extend(line.rstrip() for line in proc.stderr),daemon=True).start()
    first=replies.get(timeout=10);address=first['address']
    sdk_validated=first.get('sdkValidated',False)
    if os.environ.get('CIP_SDK_MODULE'): assert sdk_validated, 'Installed SDK validation must actually be enabled'
    def call(action,**kwargs):
        global count
        count+=1;rid=count;proc.stdin.write(json.dumps({'request':rid,'action':action,**kwargs})+'\n');proc.stdin.flush()
        result=replies.get(timeout=10)
        if result.get('request')!=rid or result.get('error'):raise AssertionError(result)
        return result.get('result')
    def send_input(value):return call('provider-input',input=value)
    # Chrome's supported CDP installer requires pipe transport (Playwright default)
    # and explicit extension-debugging in THIS disposable, never logged-in profile.
    launch={'headless':True,'args':['--enable-unsafe-extension-debugging','--no-proxy-server','--disable-background-networking','--ignore-certificate-errors',f'--host-resolver-rules=MAP chatgpt.com 127.0.0.1:{fixture_server.server_port}'], 'ignore_default_args':['--disable-extensions']}
    if os.environ.get('CIP_CHROMIUM'):launch['executable_path']=os.environ['CIP_CHROMIUM']
    browser=pw.chromium.launch_persistent_context(profile,**launch)
    def route(request):
        url=request.request.url
        if '/backend-api/system_hints' in url:
            request.fulfill(status=200,content_type='application/json',body=json.dumps({'system_hints':[{'system_hint':'plugin:asdk_app_a','name':'Development Mac'},{'system_hint':'plugin:asdk_app_b','name':'Tasks'}]}))
        elif request.request.resource_type=='document':request.fulfill(status=200,content_type='text/html; charset=utf-8',body=fixture)
        else:request.abort()
    browser.route('https://chatgpt.com/**',route)
    try:
        devtools=browser.browser.new_browser_cdp_session()
        installed=devtools.send('Extensions.loadUnpacked',{'path':str(R/'extension')})
        worker=browser.service_workers[0] if browser.service_workers else browser.wait_for_event('serviceworker',timeout=15000)
        extension_id=worker.url.split('/')[2]
        popup=browser.new_page();popup.goto('chrome-extension://'+extension_id+'/popup.html')
        pairing=json.loads((Path(directory)/'pairing.json').read_text())
        result=popup.evaluate('async p=>chrome.runtime.sendMessage({type:"pair",endpoint:p.endpoint,code:p.code})',{'endpoint':address,'code':pairing['code']})
        assert result.get('ok'),result
        popup.wait_for_function('async()=>{const r=await chrome.runtime.sendMessage({type:"status"});return r.ok&&r.value.connected;}',timeout=10000)
        checks.append('actual MV3 service worker pairs with isolated Runtime using real Chrome extension messages')
        def wait(fn,timeout=25):
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                events=call('events');value=fn(events)
                if value:return value
                failures=[e for e in events if e.get('type')=='session.turn' and e.get('state')=='failed']
                if failures:raise AssertionError({'failures':failures[-2:],'harness':errors[-3:]})
                popup.wait_for_timeout(100)
            pages=[]
            for p in browser.pages:
                if p.url.startswith('https://chatgpt.com/'):
                    pages.append({'url':p.url,'shape':p.evaluate('({title:document.title,ready:document.readyState,editors:document.querySelectorAll("#prompt-textarea").length,forms:document.forms.length,body:document.body?.innerText.slice(0,200)})')})
            background=worker.evaluate('async()=>{const s=await chrome.storage.local.get(["tabs","bindingWaits","ledger"]);const all=await chrome.tabs.query({url:"https://chatgpt.com/*"});return {waits:s.bindingWaits,tabs:s.tabs,ledger:Object.values(s.ledger||{}).map(x=>({phase:x.phase,kind:x.command?.kind,result:x.result?.error})),identities:await Promise.all(all.map(async t=>({tabId:t.id,identity:await chrome.tabs.sendMessage(t.id,{type:"identity"}).catch(e=>({error:String(e)}))})))}}')
            raise AssertionError({'timeout':True,'events':call('events')[-10:],'harness':errors[-6:],'fixturePages':pages,'background':background})
        send_input({'type':'catalog','requestId':'catalog'})
        wait(lambda es:next((e for e in es if e['type']=='catalog'),None),45)
        config={'cwd':'/fixture-only','env':{},'settings':{},'mcpServers':{},'persist':True,'model':'model1','thinkingOption':'medium','providerOptions':{'appIds':[]}}
        send_input({'type':'session.open','requestId':'open-a','sessionId':'a','config':config,'history':'skip'})
        opened=wait(lambda es:next((e for e in es if e['type']=='session.opened'),None))
        sid=opened['persistence']['data']['id']
        checks.append('real background catalog and native model configuration reach the Provider')
        def prompt(mid,text,host='a'):
            send_input({'type':'session.prompt','sessionId':host,'prompt':{'clientMessageId':mid,'delivery':'auto','input':{'type':'message','content':[{'type':'text','text':text}]}}})
        prompt('first','FIRST_MV3_BODY')
        wait(lambda es:any(e['type']=='session.turn' and e['state']=='completed' for e in es),40)
        state=call('read',id=sid)
        assert state['turn']['nativeMessageId']=='native-user-1',state['turn'].get('nativeMessageId')
        assert any(x.get('text')=='MV3_REPLY_1' for x in state['history']),state['history']
        page=next(p for p in browser.pages if p.url.startswith('https://chatgpt.com/c/'))
        assert page.evaluate('fixtureState.clicks')==1
        if escape_requests:
            stored=page.evaluate('fixtureState.turns[0].turn.items[0].message')
            assert '\\[' in stored and '\\\n' in stored and 'FIRST\\_MV3\\_BODY' in stored
            checks.append('escaped native user body obtains receipt without rewriting transcript or another Send')
        persisted=json.loads((Path(directory)/'state.json').read_text())
        sent=[c for c in persisted['commands'].values() if c['kind']=='send' and c.get('sessionId')==sid]
        assert len(sent)==1 and sent[0]['diagnostic']['bodyMatch']==('markdown' if escape_requests else 'raw')
        cid=state['conversationId']
        checks.append('temporary layout key changes but actual worker/Runtime binding remains on native-user-1')
        calls=[x for x in state['history'] if x.get('type')=='tool_call']
        summaries=[x for x in state['history'] if x.get('type')=='reasoning']
        assert len(calls)==1 and calls[0]['callId']=='mcp-visible-1',calls
        assert calls[0]['status']=='completed',calls
        assert '网页可见调用输入' in calls[0]['detail']['text'],calls[0]['detail']
        assert '[REDACTED]' in calls[0]['detail']['text'],calls[0]['detail']
        assert 'VISIBLE_DEMO_CREDENTIAL' not in json.dumps(state['history'])
        assert 'HIDDEN_TOOL_PAYLOAD' not in json.dumps(state['history'])
        assert 'Visible tool result 1' in calls[0]['detail']['text'],calls[0]['detail']
        assert len(summaries)==1 and summaries[0]['text']=='Public summary for turn 1',summaries
        assert 'NEVER_EXPORT_PRIVATE_COT' not in json.dumps(state['history'])
        assert 'NEVER_EXPORT_TOOL_ARGUMENTS' not in json.dumps(state['history'])
        checks.append('Paseo native tool_call and public reasoning summary survive Chrome MV3 streaming with no hidden args/COT')
        checks.append('public answer travels content -> worker -> HTTP /event -> Runtime history -> Provider timeline')
        prompt('second','SECOND_MV3_BODY')
        wait(lambda es:call('read',id=sid)['turn'].get('nativeMessageId')=='native-user-2')
        page.reload()
        wait(lambda es:len([e for e in es if e['type']=='session.turn' and e['state']=='completed'])==2,30)
        state=call('read',id=sid)
        assert state['conversationId']==cid and state['turn']['nativeMessageId']=='native-user-2'
        assert page.evaluate('fixtureState.clicks')==2
        assert any(x.get('text')=='MV3_REPLY_2' for x in state['history'])
        checks.append('real page reload resumes exact native message observation without a second Send')
        assert len([e for e in call('events') if e['type']=='session.turn' and e['state']=='completed'])==2
        checks.append('same conversation completes two turns, exactly one terminal event and one native Send per turn')
        config_b={**config,'model':'model2','providerOptions':{'appIds':['asdk_app_b']}}
        send_input({'type':'session.open','requestId':'open-b','sessionId':'b','config':config_b,'history':'skip'})
        opened_b=wait(lambda es:next((e for e in es if e['type']=='session.opened' and e['sessionId']=='b'),None))
        sid_b=opened_b['persistence']['data']['id']
        prompt('third','THIRD_MV3_BODY');prompt('b-first','OTHER_SESSION_BODY','b')
        wait(lambda es:len([e for e in es if e['type']=='session.turn' and e['state']=='completed'])==4,40)
        state_a=call('read',id=sid);state_b=call('read',id=sid_b)
        assert state_a['conversationId']==cid and state_b['conversationId']!=cid
        assert state_a['turn']['nativeMessageId']=='native-user-3' and state_b['turn']['nativeMessageId']=='native-user-1'
        assert any(x.get('text')=='MV3_REPLY_3' for x in state_a['history'])
        assert any(x.get('text')=='MV3_REPLY_1' for x in state_b['history'])
        assert state_b['config']['model']=='model2' and state_b['config']['appIds']==['asdk_app_b']
        page_b=next(p for p in browser.pages if p.url.endswith('/c/'+state_b['conversationId']))
        assert page.evaluate('fixtureState.clicks')==3 and page_b.evaluate('fixtureState.clicks')==1
        checks.append('two simultaneous native tabs retain separate model/app choices, IDs, answers and terminal events')
        # ChatGPT's OWN editor, not Paseo, starts a new native user turn.
        # This must be imported as one autonomous Paseo turn without a second Send.
        before=json.loads((Path(directory)/'state.json').read_text())
        native_sends_before=len([v for v in before['commands'].values()
                                 if v['kind']=='send' and v.get('sessionId')==sid])
        page.evaluate("""() => {
          const editor=document.querySelector('#prompt-textarea');
          editor.textContent='MANUAL_CHATGPT_BODY';
          document.querySelector('[data-testid="send-button"]').click();
        }""")
        imported=wait(lambda es:next((c for c in [call('read',id=sid)]
                         if c['turn'].get('nativeMessageId')=='native-user-4'
                         and c['turn'].get('origin')=='browser'),None),35)
        external_turn_id=imported['turn']['id']
        wait(lambda es:any(e.get('type')=='session.turn' and e.get('sessionId')=='a'
                           and e.get('turnId')==external_turn_id and e.get('state')=='completed'
                           for e in es),35)
        after=call('read',id=sid)
        assert after['status']=='idle' and after['turn']['outcome']=='completed',after['turn']
        expected_manual='MANUAL\\_CHATGPT\\_BODY' if escape_requests else 'MANUAL_CHATGPT_BODY'
        assert any(r.get('type')=='user_message' and r.get('text')==expected_manual
                   for r in after['history'])
        assert any(r.get('text')=='MV3_REPLY_4' for r in after['history'])
        sent_after=len([v for v in json.loads((Path(directory)/'state.json').read_text())['commands'].values()
                        if v['kind']=='send' and v.get('sessionId')==sid])
        assert sent_after==native_sends_before,(native_sends_before,sent_after)
        assert page.evaluate('fixtureState.clicks')==4
        assert len([e for e in call('events') if e.get('type')=='timeline.item'
                    and e.get('item',{}).get('type')=='user_message'
                    and e.get('item',{}).get('messageId')=='native-user-4'])==1
        checks.append('ChatGPT direct user input creates autonomous Paseo native turn and reply without duplicate browser Send')
        # Return to Paseo in the same native conversation after a browser-origin turn.
        prompt('post-browser','RETURN_TO_PASEO')
        wait(lambda es:call('read',id=sid)['turn'].get('nativeMessageId')=='native-user-5',35)
        wait(lambda es:len([e for e in es if e.get('type')=='session.turn' and
                           e.get('state')=='completed'])==6,35)
        returned=call('read',id=sid)
        assert returned['status']=='idle' and returned['conversationId']==cid
        assert any(x.get('text')=='MV3_REPLY_5' for x in returned['history'])
        assert page.evaluate('fixtureState.clicks')==5
        sent_final=len([v for v in json.loads((Path(directory)/'state.json').read_text())['commands'].values()
                        if v['kind']=='send' and v.get('sessionId')==sid])
        assert sent_final==native_sends_before+1,(sent_final,native_sends_before)
        checks.append('same conversation resumes Paseo-origin prompt after a browser-origin turn with one new Send')
    finally:
        try:call('close')
        finally:
            browser.close();proc.stdin.close();fixture_server.shutdown();fixture_server.server_close()
            try:proc.wait(timeout=5)
            except subprocess.TimeoutExpired:proc.terminate();proc.wait(timeout=5)
print(json.dumps({'passed':len(checks),'checks':checks,'installedSdkValidated':sdk_validated,'escapedRequests':escape_requests,'foldedPublicGroup':collapse_fixture,'scope':'REAL unpacked MV3 + Chrome tabs/worker/worlds + Node Runtime/Provider; ChatGPT page and network are OFFLINE FIXTURES, not a signed-in acceptance'},ensure_ascii=False,indent=2))
