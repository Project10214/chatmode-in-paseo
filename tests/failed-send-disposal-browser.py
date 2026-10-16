"""Discard a known-unsent plugin draft, including its own @ marks; no live account."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'tests/fixtures/chatgpt.html').read_text()
results = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, **(
        {'executable_path': os.environ['CIP_CHROMIUM']} if os.environ.get('CIP_CHROMIUM') else {}
    ))
    for scenario in ['own-apps', 'human-text', 'human-app', 'human-attachment', 'navigation', 'unknown-receipt']:
        page = browser.new_page()
        page.route('**/*', lambda route: route.abort())
        page.set_content(HTML)
        load_adapter(page)
        result = page.evaluate('''async scenario => {
          const config={model:'m1',thinkingOption:'standard',appIds:['asdk_app_a','asdk_app_b']};
          const box=CIP_DOM.composer();
          let authorizations=0, failure=null;
          if (scenario==='unknown-receipt') {
            // Native click occurs but there is no trustworthy receipt. Keep its
            // evidence and draft, regardless of what the eventual error says.
            document.querySelector('#send').onclick=()=>{window.fixtureSends++};
          }
          try {
            await CIP_DOM.send({deadline:Date.now()+3500,payload:{config,text:'DISCARD_ONLY_THIS_UNSENT_BODY'}},async()=>{
              authorizations++;
              if(scenario==='human-text')box.textContent='NEW USER DRAFT';
              if(scenario==='human-app')box.querySelector('[app-mention-path]').setAttribute('app-mention-path','app://asdk_app_human');
              if(scenario==='human-attachment'){
                const file=document.createElement('div');file.setAttribute('data-composer-attachments','');
                file.textContent='user file';box.closest('form').append(file);
              }
              if(scenario==='navigation')fixtureLocation.pathname='/different-page';
              if(scenario!=='unknown-receipt')throw Object.assign(new Error('TEST_REJECTED'),{code:'TEST_REJECTED'});
            });
          }catch(e){failure={code:e.code,notSent:e.notSent===true};}
          const remaining=CIP_DOM.authored(box);
          const marks=box.querySelectorAll('[app-mention-path],[data-prompt-link-href]').length;
          const firstClicks=window.fixtureSends;
          let nextReceipt=null;
          if(scenario==='own-apps')nextReceipt=(await CIP_DOM.send({payload:{config,text:'FRESH_TEXT_ONLY'}},async()=>{authorizations++})).receipt;
          return{failure,remaining,marks,firstClicks,clicks:window.fixtureSends,authorizations,nextReceipt};
        }''', scenario)
        result['scenario'] = scenario
        if scenario == 'own-apps':
            assert result['failure'] == {'code': 'TEST_REJECTED', 'notSent': True}, result
            assert result['remaining'] == '' and result['marks'] == 0, result
            assert result['firstClicks'] == 0 and result['clicks'] == 1 and result['nextReceipt'], result
        elif scenario == 'unknown-receipt':
            assert result['failure']['code'] == 'RECEIPT_UNCONFIRMED' and not result['failure']['notSent'], result
            assert result['firstClicks'] == 1 and result['remaining'] == 'DISCARD_ONLY_THIS_UNSENT_BODY', result
            assert result['marks'] == 2, result
        else:
            assert result['firstClicks'] == 0 and result['failure']['notSent'], result
            assert result['remaining'] == ('NEW USER DRAFT' if scenario == 'human-text' else 'DISCARD_ONLY_THIS_UNSENT_BODY'), result
        results.append({'scenario': scenario, **result})
        page.close()
    browser.close()
print(json.dumps({'scope': 'offline DOM, not production ChatGPT', 'passed': len(results), 'results': results}, ensure_ascii=False))
