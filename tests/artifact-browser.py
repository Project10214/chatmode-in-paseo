"""Isolated headless Chromium, intercepted fixtures only; no real profile/account.
Run with the project's Playwright Python environment. Never connects to an existing
browser, clicks native controls, changes authorization, or deploys the plugin.
"""
import base64
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CID = '12345678-1234-4234-8234-123456789abc'
ASSET = 'file_fixture_original_1'
URL = 'https://chatgpt.com/backend-api/estuary/content?id=' + ASSET
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1cAAAAASUVORK5CYII=')
SCRIPT = (ROOT / 'extension/media-adapter.js').read_text()
# Compile only the actual self-contained Web capability/download block. No
# replacement implementation, React host mock or hidden private host API.
WEB_HELPERS = subprocess.run(['node','--input-type=module','-e', '''
  import fs from 'node:fs';import ts from 'typescript';
  const source=fs.readFileSync('client/generated-file.tsx','utf8');
  const block=source.split('// BEGIN STANDARD WEB ARTIFACT DOWNLOAD')[1].split('// END STANDARD WEB ARTIFACT DOWNLOAD')[0];
  const code=ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  if(code.includes('require('))throw Error('Web helper gained an undeclared runtime dependency');
  console.log('(()=>{const exports={};'+code+';globalThis.CIP_ARTIFACT_WEB=exports;})()');
'''], cwd=ROOT, capture_output=True, text=True, check=True).stdout
STORE_SCRIPT = '''
  import {pathToFileURL} from 'node:url';
  const {ArtifactStore}=await import(pathToFileURL(process.argv[1]));
  let json='';for await(const chunk of process.stdin)json+=chunk;
  const input=JSON.parse(json),store=new ArtifactStore(process.argv[2]);
  const {uploadId}=store.begin(input);
  for(let offset=0;offset<input.base64.length;offset+=32768)store.append(uploadId,{offset,data:input.base64.slice(offset,offset+32768)});
  const meta=await store.commit(uploadId),restored=new ArtifactStore(process.argv[2]),parts=[];
  let offset=0;while(offset!==null){const chunk=await restored.read(meta,{offset});parts.push(chunk.data);offset=chunk.nextOffset;}
  console.log(JSON.stringify({meta,data:parts.join('')}));
'''

def persisted(metadata, encoded):
    with tempfile.TemporaryDirectory(prefix='cip-artifact-browser-') as directory:
        return json.loads(subprocess.run(['node','--input-type=module','-e',STORE_SCRIPT,str(ROOT / 'server/artifacts.mjs'),directory], input=json.dumps({**metadata,'base64':encoded}), capture_output=True, text=True, check=True).stdout)

DESC = dict(sourceId='native-image-source',conversationId=CID,messageId='native-image-1',assetId=ASSET,kind='image',provenance='native-original')
checks = []
with sync_playwright() as pw:
    # Use Playwright's disposable Chromium, not the user's installed/profile Chrome.
    args = {'headless': True}
    if os.environ.get('CIP_CHROMIUM'):
        args['executable_path'] = os.environ['CIP_CHROMIUM']
    browser = pw.chromium.launch(**args)

    def fresh(kind='image', body=PNG, mime='image/png', status=200, headers=None):
        p = browser.new_page(accept_downloads=True)
        fetches, blocked = [], []
        html = '<main><section data-message-id="native-image-1" data-message-author-role="assistant"><div class="group/imagegen-image"><img width="16" height="16" src="' + URL + '"></div></section></main>'
        if kind == 'file':
            html = '<main><section data-message-id="native-image-1"><a data-file-id="' + ASSET + '" download="report.txt" href="' + URL + '">Report</a></section></main>'

        def route(request):
            if request.request.resource_type == 'document' and request.request.url == 'https://chatgpt.com/c/' + CID:
                request.fulfill(status=200, content_type='text/html', body=html)
            elif request.request.url == URL:
                if request.request.resource_type == 'fetch':
                    fetches.append(request.request.url)
                request.fulfill(status=status, headers={'content-type': mime, **(headers or {})}, body=body)
            else:
                blocked.append(request.request.url)
                request.abort()  # Absolutely no route falls through to the network.
        p.route('**/*', route)
        p.goto('https://chatgpt.com/c/' + CID)
        p.add_script_tag(content=SCRIPT)
        p.evaluate("()=>{window.fetchOptions=[];window.nativeFetch=fetch;window.fetch=async(...args)=>{fetchOptions.push(args[1]);return nativeFetch(...args)}}")
        return p, fetches, blocked

    def capture(p, descriptor=DESC):
        return p.evaluate('d=>CIP_MEDIA.captureOriginal(d,()=>{})', descriptor)

    p, calls, _ = fresh()
    result = capture(p)
    assert result['status'] == 'available', result
    assert result['mimeType'] == 'image/png' and result['bytes'] == len(PNG)
    assert result['digest'] == hashlib.sha256(PNG).hexdigest()
    chunk = p.evaluate('id=>CIP_MEDIA.readOriginal(id,0,()=>{})', result['transferId'])
    assert base64.b64decode(chunk['data']) == PNG and chunk['nextOffset'] is None
    stored = persisted(result,chunk['data'])
    assert base64.b64decode(stored['data']) == PNG and stored['meta']['digest'] == result['digest']
    assert stored['meta']['mimeType'] == 'image/png' and stored['meta']['width'] == 1
    options = p.evaluate('fetchOptions[0]')
    assert options['credentials'] == 'same-origin' and options['redirect'] == 'error' and options['mode'] == 'same-origin'
    assert 'headers' not in options and 'cookie' not in json.dumps(result).lower()
    for offset in [-4, 1, len(chunk['data'])]:
        error = p.evaluate('v=>{try{CIP_MEDIA.readOriginal(v.id,v.offset,()=>{});return null}catch(e){return e.code}}', {'id':result['transferId'], 'offset':offset})
        assert error == 'ARTIFACT_OFFSET_INVALID'
    p.evaluate('id=>CIP_MEDIA.releaseOriginal(id)', result['transferId'])
    assert p.evaluate('id=>{try{CIP_MEDIA.readOriginal(id,0,()=>{})}catch(e){return e.code}}', result['transferId']) == 'ARTIFACT_TRANSFER_UNKNOWN'
    p.close(); checks.append('PNG exact DOM fetch -> original chunk -> ArtifactStore upload/commit -> reconstructed store read; auth, offsets, release')

    edits = [
        "document.querySelector('img').parentElement.className='markdown'",
        "document.querySelector('section').dataset.messageId='other-message'",
        "document.querySelector('section').dataset.messageAuthorRole='user'",
        "document.querySelector('section').dataset.conversationId='other-conversation'",
        "document.querySelector('section').hidden=true",
        "document.querySelector('section').setAttribute('aria-hidden','true')",
        "document.querySelector('section').dataset.private='true'",
        "document.querySelector('section').dataset.cipOwned='true'",
        "document.querySelector('section').className='sr-only'",
        "document.body.append(document.createElement('main'))",
        "document.querySelector('main').replaceWith(...document.querySelector('main').children)",
        "document.querySelector('section').append(document.querySelector('img').parentElement.cloneNode(true))",
        "document.querySelector('img').src='https://chatgpt.com/backend-api/estuary/content?id=file_wrong_identity'",
        "document.querySelector('img').src='https://chatgpt.com/backend-api/estuary/content?id=" + ASSET + "&width=100'",
        "document.querySelector('img').src='http://localhost:9876/private'",
        "document.querySelector('img').src='file:///etc/passwd'",
        "document.querySelector('img').src='https://evil.invalid/image'",
        "document.querySelector('img').src='blob:https://chatgpt.com/unknown'",
        "history.pushState({},'', '/c/another-conversation')",
    ]
    for edit in edits:
        p, calls, _ = fresh(); p.evaluate(edit)
        result = capture(p)
        assert result == {'status':'unsupported','reason':'native_source_unproven'}, (edit, result)
        assert calls == [], (edit, calls)
        p.close()
    checks.append('19 unproven/hidden/private/ambiguous/cross-owner/unsafe URL cases: no capture fetch')

    data = ('原始文件\r\n' * 10000).encode()
    p, calls, _ = fresh('file', data, 'text/plain; charset=utf-8')
    result = capture(p, {**DESC, 'kind':'file'})
    assert result['status'] == 'available' and result['name'] == 'report.txt', result
    encoded, offset = [], 0
    while offset is not None:
        chunk = p.evaluate('v=>CIP_MEDIA.readOriginal(v.id,v.offset,()=>{})', {'id':result['transferId'], 'offset':offset})
        assert len(chunk['data']) <= 32768
        encoded.append(chunk['data']); offset = chunk['nextOffset']
    assert base64.b64decode(''.join(encoded)) == data
    assert result['digest'] == hashlib.sha256(data).hexdigest()
    p.close(); checks.append('native file download-source raw UTF-8 bytes, CRLF and multi-chunk transfer retained')

    for edit in ["document.querySelector('a').href='sandbox:/mnt/data/report.txt'", "document.querySelector('section').className='markdown'", "document.querySelector('a').removeAttribute('data-file-id')"]:
        p, calls, _ = fresh('file', b'text', 'text/plain'); p.evaluate(edit)
        assert capture(p,{**DESC,'kind':'file'})['status'] == 'unsupported' and not calls
        p.close()
    checks.append('sandbox file, prose link and missing native file ID cannot masquerade as captured files')

    p, calls, blocked = fresh(status=302, headers={'location':'https://evil.invalid/private'})
    assert capture(p)['status'] == 'unsupported'
    assert not any('evil.invalid' in url for url in blocked)
    p.close(); checks.append('redirect rejected before redirected host is contacted')

    for mime in ['text/html','image/svg+xml','application/octet-stream']:
        p, calls, _ = fresh(mime=mime)
        assert capture(p) == {'status':'unsupported','reason':'mime_unsupported'}
        p.close()
    p, calls, _ = fresh(headers={'content-length':str(16*1024*1024+1)})
    assert capture(p) == {'status':'unsupported','reason':'oversized'}
    p.close(); checks.append('untrusted MIME, image/file confusion and declared oversized responses rejected')

    p, calls, _ = fresh()
    p.evaluate("()=>{window.fetch=async(...args)=>{const r=await nativeFetch(...args);history.pushState({},'', '/c/another-conversation');return r}}")
    result = p.evaluate('async d=>{try{return await CIP_MEDIA.captureOriginal(d,()=>{})}catch(e){return e.code}}', DESC)
    assert result == 'ARTIFACT_OWNER_CHANGED', result
    p.close(); checks.append('navigation during fetch cannot publish bytes')

    p, calls, _ = fresh()
    result = capture(p)
    p.evaluate("document.querySelector('img').remove()")
    retained = p.evaluate('id=>CIP_MEDIA.readOriginal(id,0,()=>{})',result['transferId'])
    assert base64.b64decode(retained['data']) == PNG
    p.close(); checks.append('already captured bytes survive DOM detachment under the same binding and asset')

    p, calls, _ = fresh()
    assert p.evaluate('async d=>{try{await CIP_MEDIA.captureOriginal(d)}catch(e){return e.code}}', DESC) == 'ARTIFACT_GUARD_REQUIRED'
    result = p.evaluate("async d=>{try{await CIP_MEDIA.captureOriginal(d,()=>{throw Object.assign(new Error('lease'),{code:'LEASE_LOST'})})}catch(e){return e.code}}", DESC)
    assert result == 'LEASE_LOST' and not calls
    # Deliberately no active-turn/completion metadata anywhere in the fixture.
    p.evaluate("window.turn={outcome:'completed'}")
    assert capture(p)['status'] == 'available'
    p.close(); checks.append('binding guard mandatory; lease rejection prevents fetch; ended turn does not gate capture')
    # New local-source path: the resolver proves a real current visible IMG;
    # no invented native IDs or arbitrary URL is accepted from the caller.
    local_desc=dict(sourceId='dom-visible',conversationId=CID,messageId=None,assetId=None,kind='image',provenance='visible-image-resource')
    def displayed(mode='blob',fmt='image/png'):
        p,calls,blocked=fresh()
        expected=p.evaluate('''async input=>{
          const img=document.querySelector('img');await img.decode();window.displayedNode=img;
          document.querySelector('section').removeAttribute('data-message-id');img.parentElement.className='';
          let data='data:image/png;base64,'+input.png;
          if(input.fmt==='image/gif')data='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
          else if(input.fmt!=='image/png'){const c=document.createElement('canvas');c.width=8;c.height=6;c.getContext('2d').fillRect(0,0,8,6);data=c.toDataURL(input.fmt);}
          if(input.mode==='blob'){const binary=atob(data.split(',')[1]);img.src=URL.createObjectURL(new Blob([Uint8Array.from(binary,c=>c.charCodeAt(0))],{type:input.fmt}));}
          else if(input.mode==='data')img.src=data;
          else if(input.mode==='data-percent')img.src='data:'+input.fmt+';charset=binary,'+[...atob(data.split(',')[1])].map(c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
          await img.decode();
          window.CIP_PAGE_CONTENT={resolveMedia:sourceId=>sourceId==='dom-visible'&&displayedNode.isConnected&&!displayedNode.closest('[hidden]')?{node:displayedNode,kind:'image',messageId:null,assetId:null}:null};
          return data.split(',')[1];
        }''',dict(mode=mode,fmt=fmt,png=base64.b64encode(PNG).decode()))
        return p,calls,blocked,base64.b64decode(expected)

    def download_displayed(p,meta,encoded):
        p.add_script_tag(content=WEB_HELPERS)
        p.evaluate('''async input=>{
          const prepared=await CIP_ARTIFACT_WEB.prepareArtifactBrowserDownload(input.meta,input.data,'unknown-host');
          const button=document.createElement('button');button.textContent='Download displayed image';
          button.onclick=()=>{window.displayedDownload=CIP_ARTIFACT_WEB.requestArtifactBrowserDownload(prepared)};document.body.append(button);
        }''',dict(meta=meta,data=encoded))
        with p.expect_download() as event:p.get_by_role('button',name='Download displayed image',exact=True).click()
        download=event.value;assert download.failure() is None and download.suggested_filename==meta['name']
        assert Path(download.path()).read_bytes()==base64.b64decode(encoded)
        assert p.evaluate('displayedDownload.status')=='requested'

    for mode,fmt in [('blob','image/png'),('data','image/png'),('data-percent','image/png'),('data','image/jpeg'),('data','image/webp'),('data','image/gif')]:
        p,calls,blocked,raw=displayed(mode,fmt)
        value=capture(p,{**local_desc,'url':'http://localhost:1234/do-not-fetch'})
        assert value['status']=='available' and value['provenance']=='visible-image-resource',value
        assert value['messageId'] is None and value['assetId'] is None and value['digest']==hashlib.sha256(raw).hexdigest()
        chunk=p.evaluate('id=>CIP_MEDIA.readOriginal(id,0,()=>{})',value['transferId'])
        assert base64.b64decode(chunk['data'])==raw and value['mimeType']==fmt
        restored=persisted(value,chunk['data']);assert base64.b64decode(restored['data'])==raw
        decoded=p.evaluate('''async input=>{const image=new Image();image.src='data:'+input.mimeType+';base64,'+input.data;await image.decode();return image.naturalWidth>0&&image.naturalHeight>0}''',dict(mimeType=fmt,data=restored['data']))
        assert decoded and not calls and not blocked
        if mode=='blob':download_displayed(p,restored['meta'],restored['data'])
        assert p.evaluate('fetchOptions[0].credentials')=='omit'
        p.evaluate('displayedNode.parentElement.hidden=true')
        assert base64.b64decode(p.evaluate('id=>CIP_MEDIA.readOriginal(id,0,()=>{}).data',value['transferId']))==raw
        p.close()
    checks.append('resolver-proven blob and PNG/JPEG/WebP/GIF data bytes survive Store/hash roundtrip and decode; null native IDs, no HTTP fetch, hidden after capture retained')

    p,calls,_,_=displayed('preview')
    preview=capture(p,{**local_desc,'provenance':'rendered-preview'})
    assert preview['status']=='available' and preview['provenance']=='rendered-preview' and preview['name'].startswith('preview.'),preview
    chunk=p.evaluate('id=>CIP_MEDIA.readOriginal(id,0,()=>{})',preview['transferId'])
    raw_preview=base64.b64decode(chunk['data']);assert raw_preview!=PNG and preview['digest']==hashlib.sha256(raw_preview).hexdigest()
    restored=persisted(preview,chunk['data']);assert restored['meta']['width']==1 and not calls and p.evaluate('fetchOptions.length')==0
    download_displayed(p,restored['meta'],restored['data']);p.close()
    p,calls,_,_=displayed('blob');p.evaluate('URL.revokeObjectURL(displayedNode.src)')
    fallback=capture(p,local_desc)
    assert fallback['status']=='available' and fallback['provenance']=='rendered-preview',fallback
    p.close();checks.append('already loaded pixels remain previewable when raw blob is unavailable; visible image and rendered preview actual downloads preserve their own bytes/name, not claimed as native-original')
    p,calls,_=fresh();p.evaluate('''async()=>{
      await document.querySelector('img').decode();
      window.CIP_PAGE_CONTENT={resolveMedia:id=>id==='native-image-source'?{node:document.querySelector('img'),kind:'image',messageId:'native-image-1',assetId:'file_fixture_original_1'}:null};
    }''')
    p.route(URL,lambda route:route.fulfill(status=503,content_type='text/plain',body='unavailable'))
    native_fallback=capture(p)
    assert native_fallback['status']=='available' and native_fallback['provenance']=='rendered-preview',native_fallback
    assert native_fallback['assetId']==ASSET and native_fallback['name'].startswith('preview.')
    p.close();checks.append('native original resource failure retains a truthful raster preview only when the real current IMG is resolver-proven')

    p,calls,_,_=displayed('blob')
    p.evaluate("()=>{const resolve=CIP_PAGE_CONTENT.resolveMedia;window.imageRevision='opaque-1';CIP_PAGE_CONTENT.resolveMedia=id=>{const row=resolve(id);return row?{...row,resourceRevision:imageRevision}:null}}")
    assert capture(p,{**local_desc,'resourceRevision':'stale-revision'})==dict(status='unsupported',reason='native_source_unproven')
    assert p.evaluate('fetchOptions.length')==0
    captured_revision=capture(p,{**local_desc,'resourceRevision':'opaque-1'})
    assert captured_revision['status']=='available';p.evaluate("window.imageRevision='opaque-2'")
    assert p.evaluate('id=>{try{CIP_MEDIA.readOriginal(id,0,()=>{})}catch(e){return e.code}}',captured_revision['transferId'])=='ARTIFACT_OWNER_CHANGED'
    p.close();checks.append('resolver resourceRevision must equal expected ledger revision before capture and actual revision changes revoke captured transfers')

    for edit in ["displayedNode.parentElement.hidden=true","document.querySelector('section').dataset.conversationId='other-conversation'","CIP_PAGE_CONTENT.resolveMedia=()=>null","CIP_PAGE_CONTENT.resolveMedia=()=>({node:document.createElement('img'),kind:'image',messageId:null,assetId:null})"]:
        p,calls,_,_=displayed('blob');p.evaluate(edit)
        assert capture(p,local_desc)==dict(status='unsupported',reason='native_source_unproven')
        assert not calls and p.evaluate('fetchOptions.length')==0;p.close()
    p,calls,_,_=displayed('blob');value=capture(p,local_desc)
    p.evaluate("async()=>{displayedNode.src='data:image/png;base64,"+base64.b64encode(PNG).decode()+"';await displayedNode.decode()}")
    assert p.evaluate('id=>{try{CIP_MEDIA.readOriginal(id,0,()=>{})}catch(e){return e.code}}',value['transferId'])=='ARTIFACT_OWNER_CHANGED';p.close()
    p,calls,_,_=displayed('blob');value=capture(p,local_desc)
    p.evaluate("CIP_PAGE_CONTENT.resolveMedia=()=>({node:displayedNode,kind:'image',messageId:'new-native-owner',assetId:null})")
    assert p.evaluate('id=>{try{CIP_MEDIA.readOriginal(id,0,()=>{})}catch(e){return e.code}}',value['transferId'])=='ARTIFACT_OWNER_CHANGED';p.close()
    checks.append('unresolved/hidden/cross-conversation/detached initial sources cannot capture; captured URL or real source identity replacement revokes old bytes')

    p,calls,_,_=displayed('preview')
    p.route('https://raster.fixture.invalid/tainted.png',lambda route:route.fulfill(status=200,content_type='image/png',body=PNG))
    p.evaluate("async()=>{displayedNode.src='https://raster.fixture.invalid/tainted.png';await displayedNode.decode()}")
    value=capture(p,{**local_desc,'provenance':'rendered-preview'})
    assert value==dict(status='unsupported',reason='tainted'),value
    assert not calls and p.evaluate('fetchOptions.length')==0;p.close()
    checks.append('cross-origin already-loaded but tainted IMG cannot export pixels; fallback never issues a network fetch')

    # Actual browser download events/files from the shipped standard Web helper,
    # triggered by a trusted fixture-button click AFTER all asynchronous reads.
    samples = [(PNG,'image/png',None), (data,'text/plain','report-原文.txt'), (bytes(range(256))*391+b'\x00','application/octet-stream','original.bin')]
    for raw,mime,filename in samples:
        kind = 'image' if mime.startswith('image/') else 'file'
        p,calls,blocked = fresh(kind,raw,mime)
        if filename:
            p.evaluate('name=>document.querySelector("a").download=name',filename)
        meta = capture(p,{**DESC,'kind':kind})
        assert meta['status'] == 'available', meta
        offset,parts = 0,[]
        while offset is not None:
            chunk = p.evaluate('v=>CIP_MEDIA.readOriginal(v.id,v.offset,()=>{})',{'id':meta['transferId'],'offset':offset})
            parts.append(chunk['data']);offset=chunk['nextOffset']
        restored = persisted(meta,''.join(parts))
        p.add_script_tag(content=WEB_HELPERS)
        assert p.evaluate("CIP_ARTIFACT_WEB.supportsArtifactBrowserDownload('web')")
        p.evaluate('''async input=>{
          const W=CIP_ARTIFACT_WEB;
          const encoded=await W.collectArtifactBase64(input.meta,async offset=>{
            const data=input.data.slice(offset,offset+32768),end=offset+data.length;
            return {data,total:input.data.length,nextOffset:end<input.data.length?end:null,mimeType:input.meta.mimeType,digest:input.meta.digest};
          },()=>true);
          window.prepared=await W.prepareArtifactBrowserDownload(input.meta,encoded,'web');
          const button=document.createElement('button');button.textContent='Download fixture';
          button.onclick=event=>{window.downloadClick={trusted:event.isTrusted,active:navigator.userActivation.isActive};window.requestResult=W.requestArtifactBrowserDownload(prepared)};
          document.body.append(button);
        }''',restored)
        with p.expect_download() as event:
            p.get_by_role('button',name='Download fixture',exact=True).click()
        download = event.value
        assert download.suggested_filename == meta['name'] and download.failure() is None
        with tempfile.TemporaryDirectory(prefix='cip-download-bytes-') as directory:
            saved = Path(directory) / 'downloaded-original'
            download.save_as(saved)
            assert saved.read_bytes() == raw
            assert hashlib.sha256(saved.read_bytes()).hexdigest() == meta['digest']
        assert p.evaluate('requestResult.status') == 'requested'  # never claims completion
        assert p.evaluate('downloadClick') == {'trusted':True,'active':True}
        assert p.evaluate('document.querySelectorAll("a[href^=\\"blob:\\"]").length') == 0
        assert len(calls) == 1  # only original capture; saving never fetches a URL
        p.close()
    checks.append('PNG, UTF-8/CRLF and multi-chunk binary: capture -> ArtifactStore -> Web SHA verification -> trusted click -> actual saved file bytes/hash/name')

    p,calls,_ = fresh();p.add_script_tag(content=WEB_HELPERS)
    capabilities = p.evaluate('''()=>{
      const W=CIP_ARTIFACT_WEB,env=()=>({document,Blob,URL,crypto,navigator,setTimeout});
      const allowed=[W.supportsArtifactBrowserDownload('ios'),W.supportsArtifactBrowserDownload('android')],missing=[];
      for(const field of ['document','Blob','URL','crypto','navigator','setTimeout']){const e=env();delete e[field];missing.push(W.supportsArtifactBrowserDownload('web',e));}
      for(const ua of ['Android; wv Mobile','iPhone Mobile','desktop Electron/42','native WebView']){const e=env();e.navigator={userAgent:ua,userActivation:{isActive:true}};allowed.push(W.supportsArtifactBrowserDownload('web',e));}
      const embedded=env();embedded.self={};embedded.top={};allowed.push(W.supportsArtifactBrowserDownload('web',embedded));
      const noUA=env();noUA.navigator={userActivation:{isActive:true},maxTouchPoints:5};allowed.push(W.supportsArtifactBrowserDownload('unknown-host',noUA));
      return {allowed,missing};
    }''')
    assert capabilities == {'allowed':[True]*8,'missing':[False]*6}, capabilities
    checks.append('only missing required APIs deny capability; platform, UA, touch and frame identity do not prohibit an explicit attempt')

    for policy,expected in [(None,True),('allow-scripts allow-same-origin',False),('allow-scripts allow-same-origin allow-downloads',True)]:
        with p.expect_event('frameattached') as attached:
            p.evaluate('''policy=>{
              const frame=document.createElement('iframe');frame.id='download-policy';frame.name='download-policy';
              if(policy!==null)frame.setAttribute('sandbox',policy);
              frame.srcdoc='<!doctype html><body>Download policy fixture</body>';document.body.append(frame);
            }''',policy)
        frame = attached.value;frame.wait_for_url('about:srcdoc');frame.wait_for_selector('body')
        frame.add_script_tag(content=WEB_HELPERS)
        assert frame.evaluate("CIP_ARTIFACT_WEB.supportsArtifactBrowserDownload('web')") is expected
        if policy and expected:
            frame.evaluate('''async input=>{
              const W=CIP_ARTIFACT_WEB,prepared=await W.prepareArtifactBrowserDownload(input.meta,input.data,'unknown-host');
              const button=document.createElement('button');button.textContent='Download in frame';
              button.onclick=()=>{window.frameDownloadResult=W.requestArtifactBrowserDownload(prepared)};document.body.append(button);
            }''',dict(meta=stored['meta'],data=stored['data']))
            with p.expect_download() as event:
                frame.get_by_role('button',name='Download in frame',exact=True).click()
            download=event.value
            assert download.failure() is None and Path(download.path()).read_bytes() == PNG
            assert frame.evaluate('frameDownloadResult.status') == 'requested'
        p.evaluate("document.getElementById('download-policy').remove()")
    checks.append('real iframe sandbox attribute blocks only absent allow-downloads; allowed sandbox frame actually downloads exact PNG bytes')

    input_value = dict(meta=stored['meta'],data=stored['data'])
    guards = p.evaluate('''async input=>{
      const W=CIP_ARTIFACT_WEB,created=[],revoked=[],timers=[];
      const env={document,Blob,crypto,self,top,navigator:{userAgent:navigator.userAgent,userActivation:{isActive:false}},URL:{createObjectURL:b=>{const u=URL.createObjectURL(b);created.push(u);return u},revokeObjectURL:u=>{revoked.push(u);URL.revokeObjectURL(u)}},setTimeout:f=>timers.push(f)};
      const errors=[];
      for(const [meta,data] of [[{...input.meta,digest:'0'.repeat(64)},input.data],[{...input.meta,name:'../private'},input.data],[{...input.meta,mimeType:'text/html'},input.data],[{...input.meta,bytes:input.meta.bytes+1},input.data],[input.meta,'!!!!']]){
        try{await W.prepareArtifactBrowserDownload(meta,data,'web',env);errors.push(null)}catch(e){errors.push(e.code)}
      }
      const before=created.length;
      const ready=await W.prepareArtifactBrowserDownload(input.meta,input.data,'web',env);
      const denied=W.requestArtifactBrowserDownload(ready).status;
      W.disposeArtifactBrowserDownload(ready);W.disposeArtifactBrowserDownload(ready);
      let cancelled=null;try{await W.collectArtifactBase64(input.meta,async()=>{throw Error('must not read')},()=>false)}catch(e){cancelled=e.code}
      let offsetError=null;try{await W.collectArtifactBase64(input.meta,async()=>({data:input.data,total:input.data.length,nextOffset:4,digest:input.meta.digest,mimeType:input.meta.mimeType}),()=>true)}catch(e){offsetError=e.code}
      return {errors,before,created:created.length,revoked:revoked.length,denied,timers:timers.length,cancelled,offsetError};
    }''',input_value)
    assert guards == dict(errors=['ARTIFACT_HASH_MISMATCH','ARTIFACT_METADATA_INVALID','ARTIFACT_METADATA_INVALID','ARTIFACT_DATA_INVALID','ARTIFACT_DATA_INVALID'],before=0,created=1,revoked=1,denied='unsupported',timers=0,cancelled='ARTIFACT_READ_CANCELLED',offsetError='ARTIFACT_OFFSET_INVALID'),guards
    p.close();checks.append('bad hash/name/MIME/length/base64 never create blob URLs; no user activation cannot download; cancel/offset guards and idempotent revoke')
    browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'offline intercepted DOM/resources plus standard Web helper in isolated Chromium; no real ChatGPT/Paseo account, authorization, mobile/WebView or Paseo client runtime validation'}, ensure_ascii=False, indent=2))
