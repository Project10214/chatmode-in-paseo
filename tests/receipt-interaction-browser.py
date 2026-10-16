"""Offline browser regression: a post-dispatch click is not an unsent-draft edit.
Uses trusted Playwright input, real transplanted Send, delayed native user receipt.
No account, real ChatGPT request or production runtime is used.
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT/'tests/fixtures/chatgpt.html').read_text()
CFG = {'model':'m1','thinkingOption':'standard','appIds':[]}
checks=[]
with sync_playwright() as pw:
    options={'headless':True}
    if os.environ.get('CIP_CHROMIUM'): options['executable_path']=os.environ['CIP_CHROMIUM']
    browser=pw.chromium.launch(**options)
    def fresh():
        p=browser.new_page();p.set_content(HTML);load_adapter(p,True,False)
        p.evaluate('''()=>{
          window.delayedClicks=0;
          send.onclick=()=>{
            delayedClicks++;const body=plain();box.replaceChildren();
            setTimeout(()=>{
              fixtureLocation.pathname='/c/00000000-0000-4000-8000-000000000901';
              fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;
              const section=document.createElement('section');section.setAttribute('data-testid','conversation-turn-late');
              const row=document.createElement('div');row.setAttribute('data-message-author-role','user');row.setAttribute('data-message-id','late-user');
              row.textContent=body;section.append(row);document.querySelector('main').append(section);
            },900);
          };
        }''')
        return p
    p=fresh()
    p.evaluate('''cfg=>{window.pendingSend=CIP_DOM.send({payload:{config:cfg,text:'Post-dispatch receipt'}},async()=>true)
      .then(value=>({ok:true,value}),error=>({ok:false,code:error.code,diagnostic:error.diagnostic}));}''',CFG)
    p.wait_for_function('delayedClicks===1');p.locator('h1').click()
    result=p.evaluate('pendingSend')
    assert result['ok'] and result['value']['nativeMessageId']=='late-user',result
    assert p.evaluate('delayedClicks')==1
    checks.append('trusted click on non-navigating page after Send does not discard a later exact receipt')
    p.close()
    p=fresh()
    p.evaluate('''cfg=>{window.authorizing=false;window.pendingSend=CIP_DOM.send({payload:{config:cfg,text:'Do not send edited draft'}},async()=>{
      window.authorizing=true;await new Promise(r=>window.releaseAuthorization=r);return true;
    }).then(value=>({ok:true,value}),error=>({ok:false,code:error.code}));}''',CFG)
    p.wait_for_function('authorizing===true')
    p.locator('#prompt-textarea').fill('Human replacement before authorization completes')
    p.evaluate('releaseAuthorization()');result=p.evaluate('pendingSend')
    assert not result['ok'] and p.evaluate('delayedClicks')==0,result
    assert p.evaluate('box.textContent')=='Human replacement before authorization completes'
    checks.append('trusted edit before Send still refuses and preserves the human draft')
    p.close()
    p=fresh()
    p.evaluate('''cfg=>{window.pendingSend=CIP_DOM.send({payload:{config:cfg,text:'Receipt with next draft'}},async()=>true)
      .then(value=>({ok:true,value}),error=>({ok:false,code:error.code}));}''',CFG)
    p.wait_for_function('delayedClicks===1')
    p.locator('#prompt-textarea').fill('Next unsent draft')
    result=p.evaluate('pendingSend')
    assert result['ok'] and p.evaluate('delayedClicks')==1,result
    assert p.evaluate('box.textContent')=='Next unsent draft'
    checks.append('a new unsent draft after dispatch neither changes the sent body nor gets deleted')
    p.close();browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'offline Chromium with trusted user events; not logged-in acceptance'},ensure_ascii=False,indent=2))
