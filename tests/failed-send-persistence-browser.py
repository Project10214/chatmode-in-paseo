"""Offline IndexedDB-backed draft restoration; NOT ChatGPT's production code.
A local fixture simulates website autosave. Real shipped adapter/native cleanup
must remove its own proven-unsent draft, but retain user edits/unknown delivery.
All routes are fulfilled locally or aborted; browser profiles are temporary.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'tests/fixtures/chatgpt.html').read_text()
URL = 'https://chatgpt.com/'
PERSISTENCE = r'''async () => {
  const box=document.querySelector('#prompt-textarea');
  const db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('cip-offline-home-draft',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('records');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const key='fixture.persistedAtomState',table='composer-prompt-drafts-v2',home='new-conversation';
  const read=()=>new Promise((resolve,reject)=>{
    const request=db.transaction('records','readonly').objectStore('records').get(key);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const update=change=>new Promise((resolve,reject)=>{
    const tx=db.transaction('records','readwrite'),store=tx.objectStore('records'),request=store.get(key);
    request.onsuccess=()=>store.put(change(request.result??{unrelated:'KEEP_UNRELATED_STATE',[table]:{'existing-conversation':{fixtureHtml:'KEEP_USER_DRAFT'}}}),key);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
  await update(state=>state);
  const initial=await read(),saved=initial[table]?.[home];
  if(saved)box.innerHTML=saved.fixtureHtml;
  let pending=Promise.resolve(),writes=0;
  function enqueue(){
    const html=box.innerHTML;
    const empty=box.textContent.trim()===''&&!box.querySelector('[app-mention-path],[data-prompt-link-href]');
    pending=pending.then(()=>update(state=>{
      const drafts={...state[table]};
      if(empty)delete drafts[home];else drafts[home]={fixtureHtml:html};
      writes++;return {...state,[table]:drafts};
    }));
  }
  const observer=new MutationObserver(enqueue);
  observer.observe(box,{subtree:true,childList:true,characterData:true,attributes:true});
  window.fixturePersistence={
    async flush(){if(observer.takeRecords().length)enqueue();await pending;return read();},
    async summary(){
      const state=await this.flush();return{
        homePresent:!!state[table]?.[home],homeHtml:state[table]?.[home]?.fixtureHtml??'',writes,
        unrelatedPreserved:state.unrelated==='KEEP_UNRELATED_STATE'&&state[table]['existing-conversation'].fixtureHtml==='KEEP_USER_DRAFT'
      };
    }
  };
}'''


def open_home(context):
    page = context.new_page()
    page.goto(URL)
    page.evaluate(PERSISTENCE)
    load_adapter(page)
    return page


results = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, **(
        {'executable_path': os.environ['CIP_CHROMIUM']} if os.environ.get('CIP_CHROMIUM') else {}
    ))
    for scenario in ['own-apps', 'human-text', 'human-app', 'unknown-receipt', 'historical-draft']:
        context = browser.new_context()
        context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=HTML)
                      if route.request.url == URL else route.abort())
        page = open_home(context)
        if scenario == 'historical-draft':
            page.evaluate('''async()=>{
              document.querySelector('#prompt-textarea').textContent='PREVIOUS_UNKNOWN_DRAFT';
              await fixturePersistence.flush();
            }''')
            page.close()
            page = open_home(context)
        outcome = page.evaluate('''async scenario=>{
          const box=CIP_DOM.composer(),config={model:'m1',thinkingOption:'standard',appIds:['asdk_app_a','asdk_app_b']};
          let failure=null,authorizations=0,persistedBeforeFailure=false;
          if(scenario==='unknown-receipt')document.querySelector('#send').onclick=()=>{fixtureSends++};
          try{
            await CIP_DOM.send({deadline:Date.now()+3500,payload:{config,text:'OWNED_UNSENT_PERSISTENCE_PROBE'}},async()=>{
              authorizations++;
              if(scenario==='human-text')box.textContent='NEW_USER_DRAFT';
              if(scenario==='human-app')box.querySelector('[app-mention-path]').setAttribute('app-mention-path','app://asdk_app_human');
              persistedBeforeFailure=(await fixturePersistence.summary()).homePresent;
              if(scenario!=='unknown-receipt')throw Object.assign(new Error('TEST_REJECTED'),{code:'TEST_REJECTED'});
            });
          }catch(e){failure={code:e.code,notSent:e.notSent===true};}
          const persisted=await fixturePersistence.summary();
          return {failure,authorizations,persistedBeforeFailure,clicks:fixtureSends,
            remaining:CIP_DOM.authored(box),homePresent:persisted.homePresent,unrelatedPreserved:persisted.unrelatedPreserved};
        }''', scenario)
        page.close()
        restored = open_home(context)
        after = restored.evaluate('''async()=>{
          const box=CIP_DOM.composer(),persisted=await fixturePersistence.summary();
          return {body:CIP_DOM.authored(box),marks:box.querySelectorAll('[app-mention-path],[data-prompt-link-href]').length,
            humanApp:!!box.querySelector('[app-mention-path="app://asdk_app_human"]'),unrelatedPreserved:persisted.unrelatedPreserved};
        }''')
        assert outcome['unrelatedPreserved'] and after['unrelatedPreserved'], (scenario, outcome, after)
        if scenario == 'own-apps':
            assert outcome['failure'] == {'code': 'TEST_REJECTED', 'notSent': True}, outcome
            assert outcome['persistedBeforeFailure'] and not outcome['homePresent'], outcome
            assert outcome['clicks'] == 0 and after['body'] == '' and after['marks'] == 0, (outcome, after)
            fresh = restored.evaluate('''async()=>{
              const receipt=await CIP_DOM.send({payload:{config:{model:'m1',thinkingOption:'standard',appIds:[]},text:'NEW_TEXT_AFTER_REOPEN'}},async()=>{});
              return {receipt:!!receipt.receipt,clicks:fixtureSends};
            }''')
            assert fresh == {'receipt': True, 'clicks': 1}, fresh
        elif scenario == 'historical-draft':
            assert outcome['failure']['code'] == 'DRAFT_CONFLICT' and outcome['authorizations'] == 0, outcome
            assert outcome['homePresent'] and outcome['clicks'] == 0 and after['body'] == 'PREVIOUS_UNKNOWN_DRAFT', (outcome, after)
        elif scenario == 'unknown-receipt':
            assert outcome['failure'] == {'code': 'RECEIPT_UNCONFIRMED', 'notSent': False}, outcome
            assert outcome['clicks'] == 1 and outcome['homePresent'], outcome
            assert after['body'] == 'OWNED_UNSENT_PERSISTENCE_PROBE' and after['marks'] == 2, after
        else:
            assert outcome['failure']['notSent'] and outcome['clicks'] == 0 and outcome['homePresent'], outcome
            if scenario == 'human-text':
                assert after['body'] == 'NEW_USER_DRAFT', after
            else:
                assert after['body'] == 'OWNED_UNSENT_PERSISTENCE_PROBE' and after['humanApp'], after
        results.append({'scenario': scenario, 'passed': True, 'clicks': outcome['clicks'], 'restoredChars': len(after['body'])})
        context.close()
    browser.close()
print(json.dumps({'scope': 'offline autosave simulation, not production ChatGPT', 'passed': len(results), 'results': results}))
