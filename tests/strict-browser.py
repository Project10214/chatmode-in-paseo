"""Strict regressions run in isolated real Chromium using shipped adapters."""
import json,os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
R=Path(__file__).resolve().parents[1]
HTML=(R/'tests/fixtures/chatgpt.html').read_text().replace('</body>','<script>'+(R/'tests/fixtures/native-picker.js').read_text()+'</script></body>')
CID='12345678-1234-4234-8234-123456789abc'
checks=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path=os.getenv('CIP_CHROMIUM','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
 page=browser.new_page()
 page.set_content(HTML);load_adapter(page,True,True)
 page.evaluate('''cid=>{
  const section=document.createElement('section');section.setAttribute('data-turn-key','turn-main');
  section.innerHTML='<span data-content-search-turn-key="turn-main"></span>';
  document.querySelector('main').append(section);
  window.auditSection=section;window.auditEntry={id:'turn-main',conversationId:cid,turn:{status:'complete',items:[
   {type:'user-message',messageId:'native-user-a',serverMessageId:'native-user-a',message:'Reply with Network error.'},
   {type:'assistant-message',messageId:'native-answer-a',phase:'final_answer',completed:true,content:'Network error.'}
  ]}};
  section.__reactFiber$fixture={memoizedProps:{entry:auditEntry,conversationId:cid},return:null};
  fixtureLocation.pathname='/c/'+cid;fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;
 }''',CID)
 page.evaluate('CIP_DOM.refreshTranscript()')
 answer=page.evaluate("()=>{const s=CIP_DOM.state('native-user-a');return {text:s.answer?.text,error:s.error,final:s.answer?.final}}")
 assert answer['text']=='Network error.' and answer['final']
 assert answer['error'] is None,answer
 checks.append('normal final assistant text Network error. cannot become native transport failure')
 page.evaluate('''()=>{
  const prior=document.createElement('div');prior.setAttribute('data-message-id','native-user-older');
  prior.innerHTML='<span data-testid="conversation-error">stale network banner</span>';
  document.querySelector('main').append(prior);
 }''')
 assert page.evaluate("()=>CIP_DOM.state('native-user-a').error")==None
 checks.append('old/unowned visible error banner cannot fail the current native turn')
 page.evaluate('''()=>{
  const owner=document.createElement('div');owner.setAttribute('data-message-id','native-answer-a');
  owner.innerHTML='<span data-testid="conversation-error">active owned error</span>';
  auditSection.append(owner);
 }''')
 assert page.evaluate("()=>CIP_DOM.state('native-user-a').error")=='NATIVE_ERROR'
 checks.append('an explicitly native-owned current-turn error banner is still recognized')
 browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'isolated real Chromium DOM; no production account'},ensure_ascii=False,indent=2))
