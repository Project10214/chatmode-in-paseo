"""Read-only draft-conflict evidence in an offline browser; no user profile/network."""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'tests/fixtures/chatgpt.html').read_text()
results=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True, **({'executable_path':os.environ['CIP_CHROMIUM']} if os.environ.get('CIP_CHROMIUM') else {}))
    for scenario in ['user-text','paseo-context','hidden-text','noneditable-placeholder','zero-width','late-draft','during-model-change','catalog','bounded','empty']:
        page=browser.new_page();page.route('**/*',lambda route:route.abort());page.set_content(HTML)
        page.evaluate('''scenario=>{
          globalThis.chrome={runtime:{getManifest:()=>({version:'0.2.17'})}};
          const box=document.querySelector('#prompt-textarea');
          if(scenario==='user-text')box.textContent='PRIVATE_DRAFT';
          if(scenario==='paseo-context')box.textContent='[Paseo context — user-level instructions]\\nPRIVATE_DRAFT\\n[/Paseo context]';
          if(scenario==='hidden-text')box.innerHTML='<span style="display:none">PRIVATE_DRAFT</span>';
          if(scenario==='noneditable-placeholder')box.innerHTML='<span contenteditable="false" data-placeholder="PRIVATE_ATTRIBUTE">PRIVATE_DRAFT</span>';
          if(scenario==='zero-width')box.textContent='\\u200b';
          if(scenario==='catalog')box.textContent='PRIVATE_DRAFT';
          if(scenario==='bounded')for(let i=0;i<150;i++){const s=document.createElement('span');s.textContent='x'.repeat(500);box.append(s);}
        }''',scenario)
        load_adapter(page)
        result=page.evaluate('''async scenario=>{
          const box=CIP_DOM.composer();
          if(scenario==='late-draft')box.textContent='PRIVATE_DRAFT';
          if(scenario==='during-model-change')model.addEventListener('click',()=>{box.textContent='PRIVATE_DRAFT'});
          const before=document.body.innerHTML;
          let error=null;
          try{
            if(scenario==='catalog')await CIP_DOM.catalog();
            else await CIP_DOM.configure(scenario==='during-model-change'
              ? {model:'m2',thinkingOption:null,appIds:[]}
              : {model:'m1',thinkingOption:'standard',appIds:[]});
          }
          catch(e){error={code:e.code,notApplied:e.notApplied,diagnostic:e.diagnostic}}
          return{error,unchanged:before===document.body.innerHTML,clicks:fixtureSends};
        }''',scenario)
        if scenario=='empty':
            assert result['error'] is None,result
        else:
            assert result['error']['code']==('CATALOG_TAB_NOT_EMPTY' if scenario=='catalog' else 'DRAFT_CONFLICT'),result
            if scenario not in ['catalog','during-model-change']:assert result['error']['notApplied'] is True,result
            d=result['error'].get('diagnostic')
            expected_checkpoint='catalog-start' if scenario=='catalog' else 'apps-before-discovery' if scenario=='during-model-change' else 'configure-start'
            assert d and d['stage']=='composer' and d['checkpoint']==expected_checkpoint,result
            assert d['draftDiagnosticsVersion']==1 and d['extensionVersion']=='0.2.17',result
            assert 'PRIVATE' not in json.dumps(d),result
            if scenario!='during-model-change':assert result['unchanged'],result
            assert result['clicks']==0,result
            if scenario=='during-model-change':assert d['initiallyEmpty'] is True and d['readyDraftChars']==0 and d['draftChars']>0,result
            if scenario=='bounded':assert d['draftChars']==64000 and d['snapshotTruncated'] is True and d['textNodes']==128,result
            if scenario=='hidden-text':assert d['hiddenChars']>0 and d['editableChars']==0,result
            if scenario=='noneditable-placeholder':assert d['nonEditableChars']>0 and d['placeholderChars']>0,result
            if scenario=='zero-width':assert d['zeroWidthChars']==1 and d['draftChars']==1,result
            if scenario=='paseo-context':assert d['hasPaseoContextHeader'] is True,result
            if scenario=='late-draft':assert d['emptyAtInjection'] is True and d['injectionDraftChars']==0 and d['readyDraftChars']>0,result
        results.append({'scenario':scenario,**result});page.close()
    browser.close()
print(json.dumps({'passed':len(results),'scope':'offline read-only diagnostics, not live ChatGPT','results':results},ensure_ascii=False))
