"""Attachments go in BEFORE message text; an unsent attempt removes its own files.
Offline DOM fixture with a stub upload module; no live account.
"""
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
    for scenario in ['upload-refused', 'authorize-rejected', 'sent']:
        page = browser.new_page()
        page.route('**/*', lambda route: route.abort())
        page.set_content(HTML)
        load_adapter(page)
        result = page.evaluate('''async scenario => {
          const config={model:'m1',thinkingOption:'standard',appIds:[]};
          const box=CIP_DOM.composer(), form=box.closest('form');
          let textAtAttach=null, removed=0, authorizations=0, failure=null, receipt=null;
          globalThis.CIP_UPLOAD={attach:async()=>{
            textAtAttach=CIP_DOM.authored(box);
            if(scenario==='upload-refused')
              throw Object.assign(new Error('ATTACHMENT_PASTE_UNHANDLED'),{code:'ATTACHMENT_PASTE_UNHANDLED',notSent:true});
            const host=document.createElement('div');host.setAttribute('data-composer-attachments','');
            host.textContent='report.pdf';form.append(host);
            return {proof:()=>host.isConnected,remove:async()=>{removed++;host.remove();return true;}};
          }};
          try {
            receipt=await CIP_DOM.send({deadline:Date.now()+3500,payload:{config,text:'BODY_AFTER_FILES',
              files:[{fileName:'report.pdf'}]}},async()=>{
              authorizations++;
              if(scenario==='authorize-rejected')throw Object.assign(new Error('TEST_REJECTED'),{code:'TEST_REJECTED'});
            },()=>{},async()=>{throw new Error('stub upload reads nothing');});
          }catch(e){failure={code:e.code,notSent:e.notSent===true};}
          return {failure,receipt:receipt?.receipt??null,textAtAttach,removed,authorizations,
            remaining:CIP_DOM.authored(box),files:form.querySelectorAll('[data-composer-attachments]').length,
            clicks:window.fixtureSends};
        }''', scenario)
        assert result['textAtAttach'] == '', result
        if scenario == 'upload-refused':
            assert result['failure'] == {'code': 'ATTACHMENT_PASTE_UNHANDLED', 'notSent': True}, result
            assert result['remaining'] == '' and result['authorizations'] == 0 and result['clicks'] == 0, result
        elif scenario == 'authorize-rejected':
            assert result['failure'] == {'code': 'TEST_REJECTED', 'notSent': True}, result
            assert result['removed'] == 1 and result['files'] == 0, result
            assert result['remaining'] == '' and result['clicks'] == 0, result
        else:
            assert result['failure'] is None and result['receipt'] is True, result
            assert result['removed'] == 0 and result['authorizations'] == 1 and result['clicks'] == 1, result
        results.append({'scenario': scenario, **result})
        page.close()
    browser.close()
print(json.dumps({'scope': 'offline DOM, not production ChatGPT', 'passed': len(results), 'results': results}, ensure_ascii=False))
