"""Offline real Chromium + shipped CoS adapter: a soft receipt deadline keeps
only the same already-clicked browser turn observable. No ChatGPT login/network.
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter

ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'tests/fixtures/chatgpt.html').read_text()
CONFIG={'model':'m1','thinkingOption':'standard','appIds':[]}
checks=[]
with sync_playwright() as pw:
    options={'headless':True}
    if os.environ.get('CIP_CHROMIUM'): options['executable_path']=os.environ['CIP_CHROMIUM']
    browser=pw.chromium.launch(**options)
    def page():
        p=browser.new_page()
        p.set_content(HTML)
        load_adapter(p,True,False)
        p.evaluate('''()=>{
          window.recoveryClicks=0;window.oldIds=[];
          const old=document.createElement('section');old.setAttribute('data-testid','conversation-turn-old');
          const prior=document.createElement('div');prior.setAttribute('data-message-author-role','user');
          prior.setAttribute('data-message-id','preexisting-user');prior.textContent='old question';
          old.append(prior);messages.append(old);
          send.onclick=()=>{
            recoveryClicks++;box.replaceChildren();
            fixtureLocation.pathname='/c/00000000-0000-4000-8000-000000000999';
            fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;
            const stop=document.createElement('button');stop.textContent='Stop';
            stop.setAttribute('data-testid','stop-button');box.closest('form').append(stop);
            window.fixtureStop=stop;
          };
        }''')
        return p
    p=page()
    p.evaluate('''config=>{
      window.pendingResult=CIP_DOM.send({id:'one-shot',deadline:Date.now()+3500,
        payload:{turnId:'turn-one',text:'Exact pending user body',config}},async()=>true)
        .then(value=>({ok:true,value}),error=>({ok:false,code:error.code,bindingUrl:error.bindingUrl}));
    }''',CONFIG)
    result=p.evaluate('pendingResult')
    assert result['ok'] is False and result['code']=='RECEIPT_UNCONFIRMED',result
    assert result['bindingUrl'].endswith('000000000999')
    assert p.evaluate('recoveryClicks')==1
    pending=p.evaluate("CIP_DOM.probePendingReceipt('turn-one')")
    assert pending['available'] and pending['active'] and 'nativeMessageId' not in pending,pending
    checks.append('soft deadline returns no delivery receipt, preserves same tab and active native work')
    p.evaluate('''()=>{
      const sec=document.createElement('section');sec.setAttribute('data-testid','conversation-turn-new');
      const row=document.createElement('div');row.setAttribute('data-message-author-role','user');
      row.setAttribute('data-message-id','native-recovered-user');row.textContent='Exact pending user body';
      sec.append(row);messages.append(sec);fixtureStop.remove();
    }''')
    recovered=p.evaluate("CIP_DOM.probePendingReceipt('turn-one')")
    assert recovered['nativeMessageId']=='native-recovered-user',recovered
    assert p.evaluate('recoveryClicks')==1
    checks.append('late exact native user ID can be recovered without another click or using an old ID')
    assert p.evaluate("CIP_DOM.probePendingReceipt('foreign-turn')")['available'] is False
    checks.append('foreign turn cannot borrow pending receipt')
    p.close()

    p=page()
    p.evaluate('''config=>{
      window.pendingResult=CIP_DOM.send({id:'one-shot',deadline:Date.now()+3500,
        payload:{turnId:'turn-one',text:'Expected exact body',config}},async()=>true)
        .then(value=>({ok:true,value}),error=>({ok:false,code:error.code}));
    }''',CONFIG)
    result=p.evaluate('pendingResult')
    assert result['code']=='RECEIPT_UNCONFIRMED',result
    p.evaluate('''()=>{
      const sec=document.createElement('section');sec.setAttribute('data-testid','conversation-turn-wrong');
      const row=document.createElement('div');row.setAttribute('data-message-author-role','user');
      row.setAttribute('data-message-id','other-user');row.textContent='Unrelated manually sent text';
      sec.append(row);messages.append(sec);
    }''')
    seen=p.evaluate("CIP_DOM.probePendingReceipt('turn-one')")
    assert 'nativeMessageId' not in seen
    p.evaluate('''()=>{window.originalNow=Date.now;window.testAdvance=0;
      Date.now=()=>originalNow()+testAdvance;}''')
    p.evaluate('testAdvance=11001')
    seen=p.evaluate("CIP_DOM.probePendingReceipt('turn-one')")
    assert seen.get('conflict') is True,seen
    assert p.evaluate('recoveryClicks')==1
    checks.append('different authored text never becomes a recovered user ID, even after grace')
    p.close()
    browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,
                  'scope':'offline Chromium and shipped adapter, no logged-in sends'},ensure_ascii=False))
