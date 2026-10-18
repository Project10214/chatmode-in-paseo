"""Observed production key regression: search layout keys are not native message IDs.
Runs shipped MAIN + isolated reader functions in offline Chrome. Real app worlds and
service worker are covered separately by binding-mv3-flow.py, never claimed here.
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
R=Path(__file__).resolve().parents[1]
HTML=(R/'tests/fixtures/chatgpt.html').read_text().replace('</body>','<script>'+(R/'tests/fixtures/native-picker.js').read_text()+'</script></body>')
CID='12345678-1234-4234-8234-123456789abc'
checks=[]
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CIP_CHROMIUM','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless=True)
 def fresh():
  p=b.new_page();p.set_content(HTML);load_adapter(p,True,True)
  p.evaluate('''cid=>{
   fixtureLocation.pathname='/c/'+cid;fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;
   window.nativeItems=[{type:'user-message',messageId:'actual-native-user',serverMessageId:'actual-native-user',message:'hi'},
    {type:'assistant-message',messageId:'actual-native-answer',phase:'final_answer',completed:true,content:'Actual public reply'}];
   window.nativeTurn={status:'complete',items:nativeItems};
   window.slot=document.createElement('div');slot.setAttribute('data-chatgpt-search-unit-key','fallback-turn-0:0:user');slot.textContent='hi';
   slot.__reactFiber$fixture={memoizedProps:{conversationId:cid,turn:nativeTurn},return:null};document.querySelector('main').append(slot);
  }''',CID)
  return p
 def read(p):
  p.evaluate('CIP_DOM.refreshTranscript()');return p.evaluate('CIP_DOM.messages().map(({node,...x})=>x)')
 p=fresh();rows=read(p)
 assert [x['id'] for x in rows]==['actual-native-user','actual-native-answer'],rows
 checks.append('search-only mounted turn uses CoS typed message IDs, never fallback-turn-0:0:user')
 p.evaluate("slot.setAttribute('data-chatgpt-search-unit-key','real-layout-7:0:user')")
 assert [x['id'] for x in read(p)]==['actual-native-user','actual-native-answer']
 checks.append('UI key replacement does not change native binding or answer identity')
 p.evaluate('delete slot.__reactFiber$fixture')
 assert read(p)==[]
 checks.append('unproven search key refuses instead of inventing a receipt when native owner is absent')
 p.close();p=fresh()
 p.evaluate("nativeItems[0].messageId='fallback-turn-0:0:user';nativeItems[0].serverMessageId='fallback-turn-0:0:user'")
 assert not any(x['id']=='fallback-turn-0:0:user' for x in read(p))
 checks.append('known layout-shaped IDs cannot enter native projection even through malformed typed state')
 p.close();p=fresh()
 p.evaluate('''()=>{delete slot.__reactFiber$fixture;slot.setAttribute('data-message-id','dom-proven-user');slot.setAttribute('data-message-author-role','user');}''')
 assert read(p)[0]['id']=='dom-proven-user'
 checks.append('legacy explicit data-message-id remains valid; search caption itself is never ID evidence')
 p.close();p=fresh()
 p.evaluate('''cid=>{
  // The October search-result surface can carry both a shell entry and a
  // directly owned turn.items. CoS reads its search anchor through turnViewOf;
  // a shell-only turnId check must not discard that verified native user.
  const f=slot.__reactFiber$fixture;
  f.memoizedProps.entry={id:'shell-entry-not-layout-key',conversationId:cid,turn:nativeTurn};
  f.memoizedProps.turn=nativeTurn;
  slot.setAttribute('data-chatgpt-search-unit-key','search-mount-17:0:user');
 }''',CID)
 rows=read(p)
 assert [x['id'] for x in rows]==['actual-native-user','actual-native-answer'],rows
 checks.append('search user anchor carrying shell entry and direct turn.items uses the exact native turn view, not a nonexistent shell marker')
 p.evaluate("slot.__reactFiber$fixture.memoizedProps.turn.items[0].serverMessageId='different-native-user'")
 assert not any(x['id']=='actual-native-user' for x in read(p))
 checks.append('conflicting original user IDs still refuse a receipt when search-view fallback exists')
 p.close();p=fresh()
 p.evaluate("""()=>{
  // A mounted native view can be empty while an exact-ID legacy row is present.
  nativeTurn.items.length=0;
  const row=document.createElement('div');
  row.setAttribute('data-message-author-role','user');
  row.setAttribute('data-message-id','legacy-native-user');
  row.textContent='Question';
  document.querySelector('main').append(row);
 }""")
 rows=read(p)
 assert len(rows)==1 and rows[0]['id']=='legacy-native-user',rows
 checks.append('empty native projection does not suppress an explicitly-native DOM user ID')
 p.close();b.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'offline real Chrome + shipped CoS/native projection; not signed-in acceptance'},ensure_ascii=False,indent=2))
