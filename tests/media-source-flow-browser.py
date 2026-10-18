"""Offline DOM -> collector -> capture -> transfer -> real Broker/ArtifactStore.
Disposable Chromium, intercepted resources, temporary Node fixture process.
No real host/browser/account, no production Send/Stop/permissions.
"""
import base64
import hashlib
import json
import os
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1cAAAAASUVORK5CYII=')
class Broker:
    def __init__(self):
        self.p = subprocess.Popen(['node', str(ROOT/'tests/fixtures/artifact-flow-server.mjs')],
                                  cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.binding = json.loads(self.p.stdout.readline())['binding']
    def call(self, op, **data):
        self.p.stdin.write(json.dumps(dict(op=op, **data))+'\n'); self.p.stdin.flush()
        line = self.p.stdout.readline()
        assert line, 'fixture process ended'
        reply = json.loads(line)
        assert 'error' not in reply, reply
        return reply.get('value')
    def close(self):
        self.call('close');self.p.stdin.close()
        self.p.wait(timeout=10)
        assert self.p.returncode == 0, self.p.stderr.read()

checks=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ['CIP_CHROMIUM'],headless=True)
    try:
        for mode in ['native','data','blob','preview','file']:
            broker=Broker()
            try:
                page=browser.new_page()
                resource='https://chatgpt.com/backend-api/estuary/content?id=file_fixture_original_1'
                raw=b'public file bytes\n' if mode=='file' else PNG
                mime='text/plain' if mode=='file' else 'image/png'
                markup=('<a data-file-id="file_fixture_original_1" download="report.txt" href="'+resource+'">Report</a>') if mode=='file' else '<div class="group/imagegen-image"><img width="16" height="16" alt="original caption" src="'+resource+'"></div>'
                html='<main><section data-message-author-role="assistant" data-message-id="native-image-1">'+markup+'</section></main>'
                blocked=[]
                def route(request):
                    if request.request.url == broker.binding['url']:
                        request.fulfill(status=200, content_type='text/html', body=html)
                    elif request.request.url == resource:
                        request.fulfill(status=200, content_type=mime, body=raw)
                    else:
                        blocked.append(request.request.url); request.abort()
                page.route('**/*',route)
                page.goto(broker.binding['url'])
                if mode!='file': page.evaluate('document.querySelector("img").decode()')
                if mode in ['data','blob','preview']:
                    page.evaluate("""async input=>{
                      const img=document.querySelector('img');
                      img.closest('section').removeAttribute('data-message-id');
                      if(input.mode!=='preview'){
                        const data='data:image/png;base64,'+input.png;
                        img.src=input.mode==='data'?data:URL.createObjectURL(await (await fetch(data)).blob());
                        await img.decode();
                      }
                    }""",dict(mode=mode,png=base64.b64encode(PNG).decode()))
                for script in ['page-content.js','media-adapter.js','artifact-transfer.js']:
                    page.add_script_tag(content=(ROOT/'extension'/script).read_text())
                snapshot=page.evaluate('CIP_PAGE_CONTENT.read()')
                source=next(item for item in snapshot['items'] if item['kind'] in ['image','file'])
                expected={'native':'native-original','file':'native-original','data':'visible-image-resource',
                          'blob':'visible-image-resource','preview':'rendered-preview'}[mode]
                assert source['media'].get('provenance')==expected, (mode,source)
                if mode=='data':
                    assert 'data:image/' not in json.dumps(snapshot), 'image bytes must not ride the observation frame'
                broker.call('view',view=snapshot)
                page.expose_function('artifactRPC',lambda event:broker.call('rpc',event=event))
                page.evaluate("""input=>{
                  window.bound=input.binding;window.rpcEvents=[];
                  window.transfer=CIP_ARTIFACT_TRANSFER.create({binding:()=>bound,guard:()=>{},
                    rpc:async event=>{const row=await artifactRPC(event);rpcEvents.push(event.type);return row;}});
                  transfer.observe(input.items);
                }""",dict(binding=broker.binding,items=snapshot['items']))
                page.wait_for_function("rpcEvents.includes('artifact-commit')",timeout=5000)
                stored=broker.call('snapshot')
                card=next(item for item in stored['history'] if item.get('kind')=='generated-file')
                assert card['data']['status']=='available' and card['data']['provenance']==expected, (mode,card)
                result=broker.call('read',input=dict(sessionId=stored['id'],sourceId=source['id'],
                    digest=card['data']['resource']['digest'],offset=0))
                captured=base64.b64decode(result['data'])
                assert hashlib.sha256(captured).hexdigest()==card['data']['resource']['digest']
                if mode!='preview': assert captured==raw
                else: assert captured!=raw and card['data']['resource']['mimeType']=='image/webp'
                # Description updates must not replace a downloaded artifact with its placeholder.
                if mode!='file':
                    page.evaluate("document.querySelector('img').alt='updated caption'")
                    changed=page.evaluate('CIP_PAGE_CONTENT.read()')
                    updated=next(item for item in changed['items'] if item['kind']=='image')
                    assert updated['media']['resourceRevision']==source['media']['resourceRevision']
                    broker.call('view',view=changed)
                    current=next(item for item in broker.call('snapshot')['history'] if item['id']==card['id'])
                    assert current.get('kind')=='generated-file', current
                    assert current['data']['sourceText']=='updated caption'
                    assert current['data']['resource']['digest']==card['data']['resource']['digest']
                    # A resource change, unlike a caption change, fences the old descriptor immediately.
                    stale=dict(sourceId=source['id'],conversationId=broker.binding['conversationId'],
                        **source['media'])
                    page.evaluate("""async png=>{
                      const data='data:image/png;base64,'+png;
                      document.querySelector('img').src=URL.createObjectURL(await (await fetch(data)).blob());
                      await document.querySelector('img').decode();
                    }""",base64.b64encode(PNG).decode())
                    rejected=page.evaluate('d=>CIP_MEDIA.captureOriginal(d,()=>{})',stale)
                    assert rejected==dict(status='unsupported',reason='native_source_unproven'), rejected
                    replacement=page.evaluate('CIP_PAGE_CONTENT.read()')
                    replaced=next(item for item in replacement['items'] if item['kind']=='image')
                    assert replaced['id']==source['id']
                    assert replaced['media']['resourceRevision']!=source['media']['resourceRevision']
                    broker.call('view',view=replacement)
                    placeholder=next(item for item in broker.call('snapshot')['history'] if item['id']==card['id'])
                    assert placeholder['kind']=='page-source', placeholder
                    try:
                        broker.call('read',input=dict(sessionId=stored['id'],sourceId=source['id'],
                            digest=card['data']['resource']['digest'],offset=0))
                        raise RuntimeError('stale resource was readable')
                    except AssertionError as error: assert 'ARTIFACT_UNKNOWN' in str(error), error
                    page.evaluate('items=>transfer.observe(items)',replacement['items'])
                    page.wait_for_function("rpcEvents.filter(x=>x==='artifact-commit').length===2",timeout=5000)
                    refreshed=next(item for item in broker.call('snapshot')['history'] if item['id']==card['id'])
                    assert refreshed['kind']=='generated-file' and refreshed['data']['provenance']=='visible-image-resource'
                assert not blocked, blocked
                page.evaluate('transfer.dispose()')
                page.close()
                checks.append(mode+': production source/capture/transfer/storage + description preservation')
            finally: broker.close()
    finally: browser.close()
print(json.dumps(dict(checks=len(checks),passed=checks),ensure_ascii=False,indent=2))
