"""Offline Chromium, shipped scripts; no pre-seeded system_hints success.
Models are native fixture controls. The page itself fetches plugin hints ONLY after
its composer receives @. No real accounts, no private network, no automatic Send.
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
R = Path(__file__).resolve().parents[1]
manifest = json.loads((R/'extension/manifest.json').read_text())
HTML = (R/'tests/fixtures/chatgpt.html').read_text()
checks = []
with sync_playwright() as pw:
    opts = {'headless': True}
    if os.environ.get('CIP_CHROMIUM'): opts['executable_path'] = os.environ['CIP_CHROMIUM']
    browser = pw.chromium.launch(**opts)
    def fresh(mode='on-input'):
        p = browser.new_page(); p.set_content(HTML)
        p.evaluate('''mode=>{
          fixtureLocation.origin='https://chatgpt.com';
          window.postMessage=(data,target)=>{
            if(target!==fixtureLocation.origin)throw new Error('FIXTURE_ORIGIN');
            const copy=structuredClone(data);setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:copy,origin:fixtureLocation.origin,source:window})),0);
          };
          if(!crypto.randomUUID)crypto.randomUUID=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
          window.hintRequests=0;window.probeInputs=0;
          window.hints={system_hints:apps.map(a=>({system_hint:'plugin:'+a.id,name:a.label}))};
          const url='https://chatgpt.com/backend-api/system_hints?mode=plugins';
          window.fetch=(target)=>{
            if(target!==url)throw new Error('UNEXPECTED_NETWORK');hintRequests++;
            const r=new Response(JSON.stringify(hints),{status:mode==='denied'?403:200,headers:{'content-type':'application/json'}});
            Object.defineProperty(r,'url',{value:url});return Promise.resolve(r);
          };
          box.addEventListener('input',()=>{
            if(plain()!=='@')return;probeInputs++;
            if(mode==='missing')return;
            if(mode==='user-edit'){setTimeout(()=>{box.textContent='Human draft preserved';box.dispatchEvent(new Event('input',{bubbles:true}))},20);return;}
            if(mode==='navigate'){fixtureLocation.pathname='/c/another-chat';fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;return;}
            void fetch(url);
          });
        }''', mode)
        for entry in manifest['content_scripts']:
            for name in entry['js']:
                if name == 'content.js': continue
                source = (R/'extension'/name).read_text()
                p.add_script_tag(content='(()=>{const location=window.fixtureLocation;'+source+'})();')
                if name == 'app-catalog.js':
                    p.evaluate('''()=>{const original=CIP_createAppCatalog;CIP_createAppCatalog=deps=>{
                      const a=original(deps);return {read:guard=>a.read(guard,850)};
                    };}''')
        return p
    def outcome(p, js):
        return p.evaluate('''async source=>{try{return {ok:true,value:await eval(source)}}catch(e){return {ok:false,code:e.code,diagnostic:e.diagnostic}}}''',js)
    p=fresh('on-input')
    result=outcome(p,'CIP_DOM.catalog()')
    assert result['ok'],result
    assert len(result['value']['apps'])==2 and len(result['value']['models'])==2
    assert p.evaluate('hintRequests')==1 and p.evaluate('fixtureSends')==0
    assert p.evaluate('CIP_DOM.authored(box)')==''
    checks.append('no boot-time hints: one native composer probe obtains complete list, removes only its @, never sends')
    p.close()
    p=fresh('missing')
    result=outcome(p,"CIP_DOM.configure({model:'m1',thinkingOption:'standard',appIds:[]})")
    assert result['ok'],result
    assert p.evaluate('hintRequests')==0 and p.evaluate('probeInputs')==0
    checks.append('no-app configuration needs no application list and performs no app probe')
    result=outcome(p,"CIP_DOM.send({payload:{config:{model:'m1',thinkingOption:'standard',appIds:[]},text:'No tools required'}},async()=>true)")
    assert result['ok'] and result['value']['receipt'] is True,result
    assert p.evaluate('fixtureSends')==1 and p.evaluate('hintRequests')==0
    checks.append('a no-app message obtains a native receipt without waiting for unrelated application discovery')
    p.close()
    p=fresh('on-input')
    result=outcome(p,"CIP_DOM.send({payload:{config:{model:'m1',thinkingOption:'standard',appIds:['asdk_app_a']},text:'First real body, not @'}},async()=>true)")
    assert result['ok'] and result['value']['receipt'] is True,result
    assert p.evaluate('fixtureSends')==1 and p.evaluate('hintRequests')==1 and p.evaluate('probeInputs')==1
    assert p.evaluate("CIP_DOM.messages().filter(m=>m.role==='user').at(-1).text")=='First real body, not @'
    checks.append('app-selected first Send discovers on demand, sends only the authored body once, and confirms receipt')
    p.close()
    p=fresh('missing')
    result=outcome(p,"CIP_DOM.configure({model:'m1',thinkingOption:'standard',appIds:['asdk_app_a']})")
    assert not result['ok'] and result['code']=='APP_CATALOG_UNAVAILABLE',result
    assert result['diagnostic']['nativeProbeAttempted'] is True
    assert result['diagnostic']['hintRequestSeen'] is False
    assert p.evaluate('probeInputs')==1 and p.evaluate('fixtureSends')==0
    assert p.evaluate('CIP_DOM.authored(box)')==''
    checks.append('requested app without complete native proof fails once, with no Send or repeated native probes')
    p.close()
    p=fresh('on-input')
    p.evaluate("hints={system_hints:[]}")
    result=outcome(p,"CIP_DOM.configure({model:'m1',thinkingOption:'standard',appIds:['asdk_app_a']})")
    assert result['code']=='APP_UNAVAILABLE' and p.evaluate('fixtureSends')==0,result
    checks.append('an explicitly empty list is not unknown: removed selected app is refused')
    p.close()
    p=fresh('denied')
    result=outcome(p,'CIP_DOM.catalog()')
    assert result['code']=='APP_LIST_LOGIN_REQUIRED' and p.evaluate('hintRequests')==1,result
    checks.append('permission/login refusal is preserved and never retried by the probe')
    p.close()
    p=fresh('user-edit')
    result=outcome(p,'CIP_DOM.catalog()')
    assert not result['ok'] and p.evaluate('box.textContent')=='Human draft preserved',result
    assert p.evaluate('fixtureSends')==0
    checks.append('new human draft during the read survives failure and cleanup')
    p.close()
    p=fresh('navigate')
    result=outcome(p,'CIP_DOM.catalog()')
    assert not result['ok'] and p.evaluate('fixtureSends')==0,result
    checks.append('navigation invalidates the read; no conversation is inferred from its URL')
    p.close()
    p=fresh('missing')
    p.evaluate('window.__CIP_COS_APPS_OBSERVER__.dispose()')
    result=outcome(p,'CIP_DOM.catalog()')
    assert not result['ok'] and result['diagnostic']['observerReplySeen'] is False,result
    assert result['diagnostic']['nativeProbeAttempted'] is False and p.evaluate('probeInputs')==0
    checks.append('missing MAIN observer never causes blind native input or a fabricated empty list')
    p.close()
    p=fresh('missing')
    p.evaluate("window.discoveryResult=CIP_DOM.catalog().then(value=>({ok:true,value}),e=>({ok:false,code:e.code}));")
    p.wait_for_function('probeInputs===1')
    p.locator('#prompt-textarea').click()
    p.locator('#prompt-textarea').fill('@')
    result=p.evaluate('discoveryResult')
    assert not result['ok'] and p.evaluate('CIP_DOM.authored(box)')=='@' and p.evaluate('fixtureSends')==0,result
    checks.append('a trusted human replacement @ is not erased by outer catalog cleanup')
    p.close()
    browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'offline Chromium + shipped code, page-owned network fixture; not signed-in acceptance'},ensure_ascii=False,indent=2))
