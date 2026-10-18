"""Offline Chromium -> REAL content/collector/raw bridge -> Store/converter ->
REAL Provider -> pinned ORIGINAL SDK/Session/AgentManager native projection.

React public models and page layout are synthetic. Python/stdin substitutes the
extension HTTP transport. No live daemon, IPC, account, UI acceptance or clicks.
"""
import json
import os
import subprocess
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT/'extension/manifest.json').read_text())
assert any(s.get('world') == 'MAIN' and s['run_at'] == 'document_start' and
           'public-message-main.js' in s['js'] for s in manifest['content_scripts'])
assert any('public-message-adapter.js' in s['js'] and
           s['js'].index('public-message-adapter.js') < s['js'].index('content.js')
           for s in manifest['content_scripts'] if 'content.js' in s['js'])

class World:
    def __init__(self):
        self.p = subprocess.Popen(['node', str(ROOT/'tests/fixtures/prose-flow-server.mjs')], cwd=ROOT,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.p.stdout.readline()
        assert line, self.p.stderr.read()
        self.binding = json.loads(line)['binding']
    def call(self, op, **data):
        self.p.stdin.write(json.dumps(dict(op=op, **data))+'\n'); self.p.stdin.flush()
        line = self.p.stdout.readline()
        assert line, 'original-host fixture exited'
        result = json.loads(line)
        assert 'error' not in result, result
        return result.get('value')
    def close(self):
        self.call('close'); self.p.stdin.close(); self.p.wait(timeout=10)
        assert self.p.returncode == 0, self.p.stderr.read()

checks = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ['CIP_CHROMIUM'], headless=True)
    try:
        for mode in ['markdown', 'dil', 'unavailable', 'rewrite', 'late-collapse', 'route-revoked']:
            world = World()
            context = browser.new_context(service_workers='block')
            try:
                link = 'https://chatgpt.com/c/'+world.binding['conversationId']
                html = '''<!doctype html><main><div data-message-id="native-final" data-message-author-role="assistant">DOM initial</div></main>
                  <form><textarea id="prompt-textarea"></textarea><button aria-label="Stop" disabled>Stop</button></form>'''
                requests = []
                def route(request):
                    requests.append(request.request.url)
                    if request.request.url == link:
                        request.fulfill(status=200, content_type='text/html', body=html)
                    else:
                        request.abort()
                context.route('**/*', route)
                page = context.new_page(); page.goto(link)
                page.expose_function('brokerRPC', lambda message: world.call('rpc', message=message))
                page.evaluate(r'''input=>{
                  window.actions={click:0,input:0,submit:0,private:0};
                  for(const type of ['click','input','submit'])document.addEventListener(type,()=>actions[type]++,true);
                  const node=document.querySelector('[data-message-id]');
                  const model={type:'assistant-message',messageId:'native-final',phase:'final_answer',recipient:'all',content:'**bold'};
                  const state={},root={tag:3,stateNode:state,memoizedProps:null,return:null};state.current=root;
                  const owner={tag:0,memoizedProps:{conversationId:input.cid,item:model},return:root,sibling:null};
                  const host={tag:5,memoizedProps:{},return:owner,sibling:null};root.child=owner;owner.child=host;
                  node.__reactFiber$fixture=host;
                  for(const key of ['analysis','raw_cot','invocation','arguments','response'])
                    Object.defineProperty(model,key,{get(){actions.private++;throw Error('PRIVATE_FIELD');}});
                  window.fixture={node,model,held:[],hold:input.hold};
                  const post=window.postMessage.bind(window);
                  window.postMessage=(data,origin)=>{
                    if(data?.source==='cip-public-message-reply'&&fixture.hold){fixture.held.push({data,origin});return;}
                    post(data,origin);
                  };
                  fixture.release=()=>{fixture.hold=false;for(const {data,origin} of fixture.held.splice(0))post(data,origin);};
                }''', dict(cid=world.binding['conversationId'], hold=mode in ['late-collapse','route-revoked']))
                if mode == 'dil':
                    page.evaluate(r'''()=>{
                      fixture.model.content='::chatgpt-content-reference{index="0"}';
                      fixture.model.contentReferences=[{type:'dil',source_message_id:'native-final',
                        model_dil_v2:{fallbackMarkdown:'before a\\_b and \\('}}];
                    }''')
                elif mode == 'unavailable':
                    page.evaluate("delete fixture.node.__reactFiber$fixture;fixture.node.textContent='*literal*'")
                elif mode == 'rewrite':
                    page.evaluate("fixture.model.content='old'")
                page.add_script_tag(content=(ROOT/'extension/public-message-main.js').read_text())
                cdp = context.new_cdp_session(page)
                frame = cdp.send('Page.getFrameTree')['frameTree']['frame']['id']
                isolated = cdp.send('Page.createIsolatedWorld', {'frameId':frame,'worldName':'cip-prose-flow'})['executionContextId']
                def iso(expression):
                    result = cdp.send('Runtime.evaluate', dict(expression=expression,contextId=isolated,awaitPromise=True,returnByValue=True))
                    assert 'exceptionDetails' not in result, result
                    return result['result'].get('value')
                # One transport seam; actual production content monitor owns all
                # sequencing/batching/raw reads. No helper constructs page-views.
                page.evaluate('''()=>{window.addEventListener('message',async event=>{
                  if(event.data?.source!=='fixture-rpc')return;
                  const value=await brokerRPC(event.data.message);
                  window.postMessage({source:'fixture-rpc-reply',id:event.data.id,value},location.origin);
                });}''')
                iso('''window.fixtureRPC=message=>new Promise(resolve=>{
                  const id=crypto.randomUUID();const receive=event=>{if(event.data?.source==='fixture-rpc-reply'&&event.data.id===id){
                    removeEventListener('message',receive);resolve(event.data.value);}};
                  addEventListener('message',receive);window.postMessage({source:'fixture-rpc',id,message},location.origin);
                }); window.chrome={runtime:{id:'test-extension',sendMessage:fixtureRPC,onMessage:{addListener:fn=>window.listener=fn}}};
                window.CIP_DOM={};''')
                for script in ['page-controls.js','page-content.js','public-message-adapter.js','content.js']:
                    iso((ROOT/'extension'/script).read_text())
                document_key = iso('__CIP_CONTENT__.documentKey')
                binding = world.call('bind', documentKey=document_key)
                response = iso('new Promise(resolve=>listener('+json.dumps(dict(type='monitor',session=binding))+
                               ',{id:"test-extension"},resolve))')
                assert response['ok'], response
                def wait(condition):
                    deadline = time.monotonic()+6
                    latest = None
                    while time.monotonic() < deadline:
                        page.wait_for_timeout(40)
                        latest = world.call('inspect')
                        if condition(latest):
                            return latest
                    raise AssertionError((mode, latest))
                def native_text(value):
                    return ''.join(row['item']['text'] for row in value['rows']
                                   if row['item']['type']=='assistant_message' and row['item'].get('messageId')=='native-final')
                if mode in ['late-collapse','route-revoked']:
                    page.wait_for_function('fixture.held.length>0')
                    initial = wait(lambda v: any(s.get('prose',{}).get('status')=='pending' for s in v['session'].get('sources',[])))
                    assert native_text(initial) == '' and initial['session']['observation']['page']['state']=='running'
                    if mode == 'late-collapse':
                        page.evaluate("fixture.node.remove();document.querySelector('button').setAttribute('aria-label','Send');fixture.release()")
                        current = wait(lambda v: native_text(v)=='**bold')
                        assert current['session']['observation']['page']['state']=='standby'
                    else:
                        page.evaluate("history.pushState({},'', '/c/other');dispatchEvent(new PopStateEvent('popstate'));fixture.release()")
                        page.wait_for_timeout(350)
                        current = world.call('inspect')
                        assert native_text(current) == ''
                        assert not any(s.get('prose',{}).get('status')=='available' for s in current['session']['sources'])
                else:
                    expected = dict(markdown='**bold', dil='before a_b and ', unavailable=r'\*literal\*', rewrite='old')[mode]
                    current = wait(lambda v: native_text(v)==expected)
                    assert current['session']['observation']['page']['state']=='running', 'disabled visible Stop still wins'
                    source = next(s for s in current['session']['sources'] if s.get('nativeMessageId')=='native-final')
                    if mode == 'markdown':
                        assert source['text']=='DOM initial' and source['prose']['rawText']=='**bold'
                        page.evaluate("fixture.model.content='**bold** 😀';fixture.node.innerHTML='<b>bold</b> 😀';document.querySelector('button').setAttribute('aria-label','Send')")
                        current = wait(lambda v: native_text(v)=='**bold** 😀')
                        assert current['session']['observation']['page']['state']=='standby'
                    elif mode == 'dil':
                        assert source['prose']['representation']=='dil'
                        page.evaluate(r'''()=>{fixture.model.contentReferences[0].model_dil_v2.fallbackMarkdown='before a\\_b and \\(x\\) `a\\_b`';fixture.model.completed=true;}''')
                        current = wait(lambda v: native_text(v)==r'before a_b and \(x\) `a\_b`')
                        assert current['session']['observation']['page']['state']=='running', 'message EOF never ends a run'
                    elif mode == 'rewrite':
                        page.evaluate("fixture.model.content='NEW';fixture.node.textContent='NEW'")
                        current = wait(lambda v: any(s.get('prose',{}).get('rawText')=='NEW' for s in v['session']['sources']))
                        page.wait_for_timeout(350); current=world.call('inspect')
                        assert native_text(current)=='old', 'published non-prefix rewrite must never concatenate'
                        assert any(s.get('proseRewrites') for s in current['session']['sources'])
                    before = native_text(current)
                    page.wait_for_timeout(950)
                    assert native_text(world.call('inspect')) == before, 'repeated observation cannot duplicate native body'
                assert ''.join(row['text'] for row in current['clientAssistants']) == native_text(current)
                assert len(current['clientAssistants']) <= 1, 'original streaming reducer joins the same native identity'
                assert current['sendCount'] == 1, 'only fixture setup Send, never task replay'
                assert page.evaluate('actions') == dict(click=0,input=0,submit=0,private=0)
                assert requests == [link], requests
                checks.append(dict(mode=mode, clientAssistants=current['clientAssistants'], nativeFragments=[row['item']['text'] for row in current['rows']
                    if row['item']['type']=='assistant_message' and row['item'].get('messageId')=='native-final']))
            finally:
                context.close(); world.close()
    finally:
        browser.close()
print(json.dumps(dict(passed=checks, seam='synthetic public React/DOM; stdin transport; ORIGINAL in-process host, NOT UI/IPC'), ensure_ascii=False))
