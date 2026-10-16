"""Load shipped scripts with an explicit offline page-response/transport fixture.
The real system_hints observer is exercised; no account or private network is used.
Opaque about:blank test origins use a synthetic same-origin postMessage transport.
"""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT/'extension/manifest.json').read_text())

def load_adapter(page, fixture_location=True, main=False):
    if fixture_location:
        page.evaluate('''()=>{
          fixtureLocation.origin='https://chatgpt.com';
          window.postMessage=(data,target)=>{
            if(target!==fixtureLocation.origin&&target!=='*')throw new Error('TEST_ORIGIN_MISMATCH');
            const copy=structuredClone(data);setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:copy,origin:fixtureLocation.origin,source:window})),0);
          };
        }''')
    page.evaluate('''()=>{
      if (!crypto.randomUUID) crypto.randomUUID=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
      window.__cipFixtureHints={system_hints:(typeof apps!=='undefined'?apps:[]).map(a=>({system_hint:'plugin:'+a.id,name:a.label}))};
      window.__cipHintsUrl='https://chatgpt.com/backend-api/system_hints?mode=plugins';
      window.fetch=(url)=>{
        if(url!==window.__cipHintsUrl)throw new Error('UNEXPECTED_FIXTURE_FETCH');
        const response=new Response(JSON.stringify(window.__cipFixtureHints),{headers:{'Content-Type':'application/json'}});
        Object.defineProperty(response,'url',{value:url});return Promise.resolve(response);
      };
    }''')
    for entry in MANIFEST['content_scripts']:
        for name in entry['js']:
            if name == 'content.js':
                continue
            if entry.get('world') == 'MAIN' and not main and name != 'upstream/cos-apps-observer.js':
                continue
            source = (ROOT/'extension'/name).read_text()
            prefix = 'const location=window.fixtureLocation;' if fixture_location else ''
            page.add_script_tag(content='(() => {'+prefix+source+'})();')
    page.evaluate('async()=>{await fetch(window.__cipHintsUrl);await new Promise(r=>setTimeout(r,20));}')
