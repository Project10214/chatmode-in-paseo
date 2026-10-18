"""Shipped MAIN/ISOLATED transcript reader on a synthetic page: one cited answer is
reachable through two anchors of the same turn, only one of which holds the
source pills (regression found live on 2026-10-17). No account or real Send.
"""
import json,os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
R=Path(__file__).resolve().parents[1]
cid='6ad37d96-6e94-83ee-8dea-64d77ec8817d'
def run(browser,pills_first):
  page=browser.new_page()
  page.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body=(R/'tests/fixtures/chatgpt.html').read_text()))
  page.goto('https://chatgpt.com/c/'+cid)
  page.evaluate('''([cid,pillsFirst])=>{fixtureLocation.origin='https://chatgpt.com';fixtureLocation.pathname='/c/'+cid;fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;
   window.nativeTurn={status:'complete',items:[{type:'user-message',messageId:'fixture-user',message:'synthetic'},
    {type:'assistant-message',messageId:'cited-answer',phase:'final_answer',completed:true,
     content:'OT 能离线。:chatgpt-content-reference{index="0"} 结论。:chatgpt-content-reference{index="1"}'}]};
   const fiber={memoizedProps:{conversationId:cid,turn:nativeTurn},return:null};
   // Another anchor of the same turn holds no pills; both document orders are read.
   const anchor=document.createElement('div');anchor.dataset.turnKey='turn-1';anchor.__reactFiber$fixture=fiber;
   const section=document.createElement('section');section.dataset.testid='conversation-turn-1';section.__reactFiber$fixture=fiber;
   for(const [label,href] of [['ShareDB','https://share.github.io/sharedb/?utm_source=chatgpt.com'],['docs.yjs.dev','https://docs.yjs.dev/api/document-updates?utm_source=chatgpt.com']]){
    const a=document.createElement('a');a.dataset.testid='chatgpt-citation';a.href=href;a.textContent=label;section.append(a);}
   if(pillsFirst)document.querySelector('main').append(section,anchor);else document.querySelector('main').append(anchor,section);
  }''',[cid,pills_first])
  load_adapter(page,True,True)
  result=page.evaluate('''async()=>{await CIP_DOM.refreshTranscript();await new Promise(r=>setTimeout(r,100));await CIP_DOM.refreshTranscript();
   return {messages:CIP_DOM.messages().map(m=>({id:m.id,role:m.role,text:m.text})),status:CIP_DOM.pageStatus('fixture-user')};}''')
  print(json.dumps(result,ensure_ascii=False,indent=1))
  answer=[m for m in result['messages'] if m['id']=='cited-answer']
  assert answer,'the cited answer must be readable: '+json.dumps(result,ensure_ascii=False)
  assert answer[0]['text']=='OT 能离线。 [ShareDB](<https://share.github.io/sharedb/>) 结论。 [docs.yjs.dev](<https://docs.yjs.dev/api/document-updates>)',answer[0]['text']
  assert not [i for i in result['status'].get('issues',[]) if i['code'].startswith('TRANSCRIPT')],result['status']
  page.close()
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=os.environ['CIP_CHROMIUM'],headless=True)
 try:
  for order in (False,True):run(browser,order)
  print('PASS citation transcript: duplicate anchors read once in both orders, links rendered')
 finally:browser.close()
