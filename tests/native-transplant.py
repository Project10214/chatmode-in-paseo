"""Actual transplanted CoS DOM+MAIN functions in Chromium; synthetic native picker/React tree.
In-memory document: test-only origin shim maps opaque-origin postMessage to *. No network.
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
R=Path(__file__).resolve().parents[1]
HTML=(R/'tests/fixtures/chatgpt.html').read_text().replace('</body>', '<script>'+(R/'tests/fixtures/native-picker.js').read_text()+'</script></body>')
checks=[]
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CIP_CHROMIUM','/usr/bin/chromium'),headless=True)
 def fresh():
  p=b.new_page();p.set_content(HTML)
  p.evaluate('''()=>{fixtureRealRoute=false;fixtureLocation.origin='null';const post=window.postMessage.bind(window);window.postMessage=(m,target)=>post(m,target==='null'?'*':target);if(!crypto.randomUUID)crypto.randomUUID=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');}''')
  load_adapter(p,True,True);return p
 p=fresh()
 c=p.evaluate('CIP_DOM.catalog()')
 assert [m['id'] for m in c['models']]==['model1','model2'],c
 assert [x['id'] for x in c['models'][0]['thinkingOptions']]==['medium','high']
 assert p.evaluate("document.querySelector('[data-tpp-toggle-value=chatgpt]').getAttribute('aria-checked')")=='true'
 checks.append('CoS MAIN reader + native DOM traversal discovers two model families/efforts and switches Work to Chat')
 assert p.evaluate('nativeState.selectedVersionEntry.id')=='model1' and p.evaluate('nativeState.currentBucket')==0
 assert not p.locator('[data-testid="composer-intelligence-picker-content"]').count()
 checks.append('catalog traversal restores exact original version/effort and closes native picker')
 cfg={'model':'model1','thinkingOption':'high','appIds':['asdk_app_a','asdk_app_b']}
 assert p.evaluate('c=>CIP_DOM.configure(c)',cfg)==cfg
 assert p.evaluate('nativeState.currentBucket')==1
 checks.append('model and thinking selection uses CoS native key actions with observed confirmation; two real fixture app chips')
 refused=p.evaluate('''async()=>{try{await CIP_DOM.configure({model:'model1',thinkingOption:'xhigh',appIds:[]});return false}catch(e){return e.code}}''')
 assert refused=='MODEL_OR_THINKING_UNAVAILABLE',refused
 assert p.evaluate('nativeState.currentBucket')==1 and p.evaluate('fixtureSends')==0
 checks.append('removed nearest-effort fallback: unavailable xhigh refuses and restores high without Send')
 p.evaluate("nativeProps.modelSwitcherDenialsBySlug={'model2-thinking':true}")
 refused=p.evaluate("async()=>{try{await CIP_DOM.configure({model:'model2',thinkingOption:'medium',appIds:[]});return false}catch(e){return e.code}}")
 assert refused=='MODEL_OR_THINKING_UNAVAILABLE'
 checks.append('account-evaluated model denial cannot be selected via otherwise visible UI')
 p.evaluate('delete nativeProps.modelSwitcherDenialsBySlug')
 text='第一行\n\n```js\n  console.log("<tag>");\n```'
 receipt=p.evaluate('async v=>CIP_DOM.send({payload:{config:v.cfg,text:v.text}},async()=>{})',{'cfg':cfg,'text':text})
 assert receipt['receipt'] and receipt['nativeMessageId']=='user-1' and p.evaluate('fixtureSends')==1
 assert p.evaluate("CIP_DOM.messages().find(m=>m.id==='user-1').text")==text
 p.wait_for_timeout(600)
 checks.append('transplanted insertPrompt/addAppMention/send preserves Chinese/code/newlines and confirms first native route birth')
 r=p.evaluate("async c=>CIP_DOM.send({payload:{config:c,text:'follow-up'}},async()=>{})",cfg)
 assert r['nativeMessageId']=='user-2' and r['url']==receipt['url'] and p.evaluate('fixtureSends')==2
 checks.append('second Send uses same native conversation with distinct receipt; old user DOM node never accepts it')
 p.close();p=fresh()
 # Actual committed alternate proof: stale props say a different id but committed reader sees the active owner.
 p.evaluate('''()=>{const stale={tag:0,memoizedProps:{},return:nativeRoot,alternate:nativeOwner};nativeOwner.alternate=stale;document.querySelector('#native-picker').__reactFiber$fixture=stale;}''')
 c=p.evaluate('CIP_DOM.catalog()');assert c['models'][0]['id']=='model1'
 checks.append('CoS committedPath follows root.current through stale Fiber alternates, not stale props')
 p.evaluate('''()=>{const stale={tag:0,memoizedProps:nativeProps};stale.return=stale;document.querySelector('#native-picker').__reactFiber$fixture=stale;}''')
 r=p.evaluate('''async()=>{const m=CIP_createCoSModels(CIP_COS_CONTROLS);return await m.readPickerState()}''')
 assert r is None
 checks.append('cyclic/uncommitted Fiber yields no model proof instead of guessing')
 p.close();p=fresh()
 # Test independent shell-reader input contract, no existing September props.
 p.evaluate('''()=>{const a={powerSettingIndex:0,model:'gpt-9',modelLabel:'9',reasoningEffort:'none',labels:{effort:'Instant'}},b={powerSettingIndex:1,model:'gpt-9-thinking',modelLabel:'9',reasoningEffort:'high',labels:{effort:'High'}};nativeProps={powerSelections:[a,b],selectedPowerSelection:b,modelListConfig:{options:[{id:'new',label:'Latest',selected:true}]}};nativeOwner.memoizedProps=nativeProps;}''')
 r=p.evaluate('CIP_createCoSModels(CIP_COS_CONTROLS).readPickerState()')
 assert r['currentBucket']==1 and r['choices'][1]['effort']=='high' and r['choices'][1]['familyId']=='gpt-9'
 checks.append('CoS shell powerSelections reader unifies observed instant/thinking family without a hardcoded catalog')
 p.close();p=fresh()
 p.evaluate('''()=>{const kept=document.createElement('div');kept.setAttribute('data-app-shell-page-surface','');kept.style.display='none';kept.innerHTML='<div id="prompt-textarea" contenteditable="true">old private draft</div>';document.body.prepend(kept)}''')
 assert p.evaluate("CIP_COS_CONTROLS.composer()===box")
 checks.append('hidden retained old editor cannot capture native input')
 p.evaluate('''()=>{const s=document.createElement('button');s.className='size-token-button-composer bg-composer-primary';s.innerHTML='<svg><path d="M4.5 5.75L7 8"/></svg>';s.setAttribute('aria-label','停止');s.onclick=()=>s.remove();box.closest('form').append(s);window.nativeStop=s}''')
 assert p.evaluate('CIP_COS_CONTROLS.stopButton()===nativeStop')
 assert p.evaluate('CIP_COS_CONTROLS.stopGeneration(()=>true)')
 checks.append('original locale-free Stop square is recognized and clicked only inside the owned composer')
 p.close();p=fresh();p.evaluate('CIP_DOM.catalog()')
 p.evaluate('''()=>{
   fixtureLocation.pathname='/c/12345678-1234-1234-1234-123456789abc';fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;
   const turn=document.createElement('section');turn.setAttribute('data-testid','conversation-turn-proven');document.querySelector('main').append(turn);
   window.publicMessages=[{id:'typed-u',author:{role:'user'},content:{content_type:'text',parts:['Question']}},{id:'typed-a',author:{role:'assistant'},recipient:'all',channel:'final',status:'finished_successfully',end_turn:true,content:{content_type:'text',parts:['**Raw markdown**\\nanswer']}},{id:'private',author:{role:'assistant'},channel:'analysis',status:'in_progress',content:{content_type:'text',parts:['PRIVATE_MUST_NOT_CROSS']}}];
   const owner={memoizedProps:{conversationId:'12345678-1234-1234-1234-123456789abc',turn:{messages:publicMessages}},return:null};turn.__reactFiber$fixture=owner;
 }''')
 p.evaluate('CIP_DOM.refreshTranscript()');items=p.evaluate('CIP_DOM.messages().map(({node,...x})=>x)')
 assert len(items)==2 and items[1]['final'] is True and 'PRIVATE' not in json.dumps(items)
 checks.append('copied public-text and terminal readers supply raw public Markdown; private analysis never crosses the projection')
 p.evaluate("publicMessages.push({id:'new-attempt',author:{role:'assistant'},channel:'final',status:'in_progress',end_turn:false,content:{content_type:'text',parts:['']}})")
 p.evaluate('CIP_DOM.refreshTranscript()');assert not p.evaluate("CIP_DOM.state('typed-u').answer.final")
 checks.append('original turnEndMessageId prevents an older completed answer from ending a newer textless generation')
 p.evaluate("publicMessages.pop();publicMessages[1].end_turn=false")
 p.evaluate('CIP_DOM.refreshTranscript()');assert not p.evaluate("CIP_DOM.state('typed-u').answer.final")
 checks.append('finished_successfully alone is not completion without native end_turn=true')
 p.evaluate("publicMessages[1].content.parts=['x'.repeat(256001)]")
 p.evaluate('CIP_DOM.refreshTranscript()');error=p.evaluate("()=>{try{CIP_DOM.state('typed-u');return null}catch(e){return e.code}}")
 assert error=='TRANSCRIPT_UNCONFIRMED'
 checks.append('oversized native text fails visibly rather than silently accepting an upstream-truncated answer')
 p.close();b.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'Chromium + actual transplanted CoS modules; synthetic native DOM and React states; no real ChatGPT/Paseo'},ensure_ascii=False,indent=2))
