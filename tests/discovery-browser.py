"""Real Chrome/scripts with offline native hint responses. @ menu probing was removed.
Production observer parsing is separately covered by apps-observer.test.mjs and apps-headless.py.
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
R=Path(__file__).resolve().parents[1]
HTML=(R/'tests/fixtures/chatgpt.html').read_text()
checks=[]
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CIP_CHROMIUM','/usr/bin/chromium'),headless=True)
 def fresh():
  p=b.new_page();p.set_content(HTML)
  p.evaluate('''()=>{if(!crypto.randomUUID)crypto.randomUUID=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');}''')
  load_adapter(p);return p
 p=fresh();p.evaluate('''()=>{const form=box.closest('form');form.remove();setTimeout(()=>document.body.append(form),500)}''')
 result=p.evaluate('CIP_DOM.catalog()');assert len(result['models'])==2 and len(result['apps'])==2
 checks.append('late editor hydration is awaited');p.close()
 p=fresh();p.evaluate('''()=>{box.setAttribute('aria-disabled','true');setTimeout(()=>box.removeAttribute('aria-disabled'),350)}''')
 assert len(p.evaluate('CIP_DOM.catalog()')['apps'])==2
 checks.append('disabled editor becomes writable before any operation');p.close()
 p=fresh();p.evaluate('''()=>{const old=menu;menu=(options,kind,fn)=>{if(kind==='app')throw new Error('AT_MENU_MUST_NOT_OPEN');return old(options,kind,fn)}}''')
 result=p.evaluate('CIP_DOM.catalog()');assert len(result['apps'])==2 and p.evaluate('fixtureSends')==0
 checks.append('CoS passive list reads apps even when the @ menu is unavailable');p.close()
 p=fresh();p.evaluate('''async()=>{window.__cipFixtureHints={system_hints:[]};await fetch(__cipHintsUrl);await new Promise(r=>setTimeout(r,30))}''')
 assert p.evaluate('CIP_DOM.catalog()')['apps']==[]
 checks.append('a complete empty native list is distinct from an unavailable list');p.close()
 p=fresh();result=p.evaluate('''async()=>{box.closest('form').remove();let stop=false;setTimeout(()=>stop=true,200);try{await CIP_DOM.catalog(()=>{if(stop)throw Object.assign(new Error('COMMAND_CANCELLED'),{code:'COMMAND_CANCELLED'})})}catch(e){return {code:e.code,diagnostic:e.diagnostic}}}''')
 assert result['code']=='COMMAND_CANCELLED' and result['diagnostic']['stage']=='composer'
 checks.append('cancel during hydration stops before input or model changes');p.close()
 p=fresh();p.evaluate("box.textContent='USER DRAFT'")
 result=p.evaluate('''async()=>{try{await CIP_DOM.catalog()}catch(e){return {code:e.code,text:box.textContent}}}''')
 assert result['code']=='CATALOG_TAB_NOT_EMPTY' and result['text']=='USER DRAFT'
 checks.append('automatic discovery never overwrites a user draft');p.close()
 p=fresh();result=p.evaluate('''async()=>{await CIP_DOM.configure({model:'m1',thinkingOption:'extended',appIds:apps.map(a=>a.id)});return {ids:[...box.querySelectorAll('[app-mention-path]')].map(n=>n.getAttribute('app-mention-path')),draft:CIP_DOM.authored(box),sent:fixtureSends}}''')
 assert result['ids']==['app://asdk_app_a','app://asdk_app_b'] and result['draft']=='' and result['sent']==0
 checks.append('native CoS marks attach both exact app IDs without @ menu clicks');p.close()
 p=fresh();p.evaluate('''async()=>{window.__cipFixtureHints={system_hints:[{system_hint:'plugin:asdk_app_other',name:'Development Mac'}]};await fetch(__cipHintsUrl);await new Promise(r=>setTimeout(r,30))}''')
 result=p.evaluate('''async()=>{try{await CIP_DOM.configure({model:'m1',thinkingOption:'extended',appIds:['asdk_app_a']})}catch(e){return {code:e.code,sent:fixtureSends}}}''')
 assert result['code']=='APP_UNAVAILABLE' and result['sent']==0
 checks.append('a same-named different app never substitutes for the configured host');p.close()
 b.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'offline native browser tests, not signed-in account acceptance'},ensure_ascii=False,indent=2))
