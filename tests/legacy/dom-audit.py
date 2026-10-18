"""In-memory Chromium DOM tests. No navigation, network, account, or real MCP.
Each test runs the revised dom-adapter.js. Results show expected safety vs actual behavior.
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'tests/fixtures/chatgpt.html').read_text()
ADAPTER=(ROOT/'extension/dom-adapter.js').read_text()
results=[]
def record(name, expected, actual, ok):
 results.append({'test':name,'pass':bool(ok),'expected':expected,'actual':actual})
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('CIP_CHROMIUM','/usr/bin/chromium'),headless=True)
 def fresh(html=HTML):
  page=b.new_page();page.set_content(html)
  page.evaluate('window.fixtureLocation ||= {href:"https://chatgpt.com/",pathname:"/",origin:window.location.origin,hostname:"chatgpt.com"}')
  load_adapter(page);return page
 page=fresh()
 c=page.evaluate('async()=>{try{return {catalog:await CIP_DOM.catalog()}}catch(e){return {error:e.code}}}')
 record('D00 original bundled fixture catalog must succeed','2 models and 2 apps',c,'catalog' in c)
 page.close()
 page=fresh()
 selection={'model':'m1','thinkingOption':'extended','appIds':['asdk_app_a','asdk_app_b']}
 actual=page.evaluate('(c)=>CIP_DOM.configure(c)',selection)
 record('D00b baseline selecting two app chips with supplied config',selection,actual,actual==selection)
 page.close()

 page=fresh()
 result=page.evaluate('''async()=>{
   const nativeSend = send.onclick; send.onclick=()=>{window.clickedText=CIP_DOM.authored(CIP_DOM.composer());nativeSend();};
   try{await CIP_DOM.send({payload:{config:{model:'m1',thinkingOption:'standard',appIds:[]},text:'First line\\nSecond line'}},async()=>{});return{ok:true,clicks:window.fixtureSends,clickedText:window.clickedText};}
   catch(e){return{error:e.code,html:CIP_DOM.composer().innerHTML,authored:CIP_DOM.authored(CIP_DOM.composer()),clicks:window.actualClicks||0,clickedText:window.clickedText};}
 }''')
 record('D01 multiline prompt must retain newlines and reach Send','No INPUT_NOT_CONFIRMED caused by line breaks',result,result.get('clicks')==1 and result.get('clickedText')=='First line\nSecond line')
 page.close()

 page=fresh()
 page.evaluate('''()=>{model.addEventListener('click',()=>document.querySelectorAll('[role="menuitem"]').forEach(n=>n.setAttribute('aria-disabled','false')))}''')
 c=page.evaluate('CIP_DOM.catalog()')
 record('D02 aria-disabled=false options are enabled','2 selectable models',{'models':c['models']},len(c['models'])==2)
 page.close()

 page=fresh('''<div id="prompt-textarea" contenteditable="true"></div><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u1">question</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a1"><p>Still working:</p><pre><code>print(1)</code><button aria-label="Copy">Copy code</button></pre></div></section>''')
 state=page.evaluate('CIP_DOM.state("u1")')
 record('D03 code-block Copy button must not prove final answer',False,state['answer']['final'],not state['answer']['final'])
 page.close()

 page=fresh()
 page.evaluate('''()=>{
  window.sent=[];
  send.onclick=()=>window.sent.push({text:CIP_DOM.authored(CIP_DOM.composer()),model:model.getAttribute('data-model-id')});
  window.pending=CIP_DOM.send({payload:{config:{model:'m1',thinkingOption:'standard',appIds:[]},text:'Approved text'}},async()=>{
   // Represents a real DOM change while the asynchronous server authorization is pending.
   model.setAttribute('data-model-id','m2');model.textContent='Model Two';
   CIP_DOM.composer().textContent='Changed after authorization began';
  }).catch(e=>window.lastError=e.code).finally(()=>window.finished=true);
 }''')
 page.wait_for_function('window.finished===true',timeout=2000)
 actual=page.evaluate('window.sent')
 record('D04 Send must revalidate actual text/model after async authorization','0 clicks after configuration/draft changes',actual,len(actual)==0)
 page.close()

 page=fresh()
 r=page.evaluate('''async()=>{
  send.disabled=true;let first,second;
  const command={payload:{config:{model:'m1',thinkingOption:'standard',appIds:[]},text:'Owned draft'}};
  try{await CIP_DOM.send(command,async()=>{});}catch(e){first=e.code;}
  send.disabled=false;
  try{await CIP_DOM.configure(command.payload.config);}catch(e){second=e.code;}
  return{firstError:first,nextAttemptError:second,remainingDraft:CIP_DOM.authored(CIP_DOM.composer())};
 }''')
 record('D05 pre-Send error must leave a safe retry path','Retry is not blocked by its own unchanged draft',r,r.get('nextAttemptError')!='DRAFT_CONFLICT')
 page.close()

 page=fresh()
 r=page.evaluate('''async()=>{
  models.splice(0,1);chooseModel(models[0]);apps.length=0;
  window.__cipFixtureHints={system_hints:[]};await fetch(window.__cipHintsUrl);await new Promise(r=>setTimeout(r,30));
  const realNow=Date.now;let clock=realNow();Date.now=()=>{clock+=5000;return clock};
  try{return{catalog:await CIP_DOM.catalog()};}catch(e){return{error:e.code,remaining:CIP_DOM.authored(CIP_DOM.composer())};}finally{Date.now=realNow;}
 }''')
 record('D06 no installed apps must not make the model catalog unavailable','Model list remains usable with apps=[]',r,'catalog' in r and len(r['catalog']['models'])>0 and r['catalog']['apps']==[])
 page.close()

 page=fresh('''<div id="prompt-textarea" contenteditable="true"></div><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u1">question</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a1"><p>First paragraph</p><p>Second paragraph</p><pre><code>line1\nline2</code></pre></div></section>''')
 r=page.evaluate('CIP_DOM.state("u1").answer.text')
 record('D07 rendered paragraphs must keep structural line breaks','First paragraph\\nSecond paragraph',r,'First paragraph\nSecond paragraph' in r)
 page.close()
 b.close()
output={'scope':'In-memory Chromium fixture only; no ChatGPT/Paseo live installation','passed':sum(r['pass'] for r in results),'failed':sum(not r['pass'] for r in results),'results':results}
print(json.dumps(output,indent=2,ensure_ascii=False))
raise SystemExit(1 if output['failed'] else 0)
