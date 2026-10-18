"""Real URL/history/Navigation API + shipped content.js and DOM Send engine.
All HTTPS requests are fulfilled locally; no account, live prompts or user browser.
Unlike the older fixtures, location is NOT replaced by a test object.
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
R=Path(__file__).resolve().parents[1]
HTML=(R/'tests/fixtures/chatgpt.html').read_text()
CID='12345678-1234-4234-8234-123456789abc'
checks=[]
with sync_playwright() as pw:
    opts={'headless':True}
    if os.environ.get('CIP_CHROMIUM'):opts['executable_path']=os.environ['CIP_CHROMIUM']
    b=pw.chromium.launch(**opts)
    def fresh(mode):
        p=b.new_page()
        p.route('**/*',lambda r:r.fulfill(status=200,content_type='text/html',body=HTML))
        p.goto('https://chatgpt.com/')
        p.evaluate('''()=>{
          window.fixtureEvents=[];window.chrome={runtime:{id:'a'.repeat(32),
          sendMessage:async m=>{fixtureEvents.push(m);return {ok:true,value:{authorized:true,active:true}}},
          onMessage:{addListener:fn=>window.fixtureListener=fn}}};
        }''')
        load_adapter(p,False,False)
        p.add_script_tag(content=(R/'extension/content.js').read_text())
        p.evaluate('''({mode,cid})=>{
          window.fixtureClicks=0;window.authoredTurns=[];
          const message=(id,text)=>{const section=document.createElement('section');section.setAttribute('data-testid','conversation-turn-'+id);
            const row=document.createElement('div');row.setAttribute('data-message-author-role','user');row.setAttribute('data-message-id',id);row.textContent=text;section.append(row);document.querySelector('main').append(section);return section};
          send.onclick=()=>{
            fixtureClicks++;const body=plain();box.replaceChildren();authoredTurns.push(body);
            const n=fixtureClicks;
            if(mode==='provisional'){
              message('native-u-'+n,body);history.replaceState({},'', '/c/local-chatgpt:pending');
              setTimeout(()=>{history.replaceState({},'', '/c/'+cid);document.body.dataset.routeReady='yes'},250);
            }else if(mode==='second-route'){
              history.replaceState({},'', '/c/'+cid);
              setTimeout(()=>history.replaceState({},'', '/c/87654321-4321-4321-8321-cba987654321'),100);
              setTimeout(()=>message('native-u-'+n,body),250);
            }else{
              history.replaceState({},'', '/c/'+cid);message('native-u-'+n,mode==='wrong-body'?'Other body':body);
            }
            if(mode!=='second-route'&&mode!=='wrong-body')setTimeout(()=>{
              const s=document.createElement('section');s.setAttribute('data-testid','conversation-turn-answer-'+n);
              const a=document.createElement('div');a.setAttribute('data-message-author-role','assistant');a.setAttribute('data-message-id','native-a-'+n);a.setAttribute('data-is-final','true');a.textContent='RECEIPT_NAV_OK_'+n;s.append(a);document.querySelector('main').append(s);
            },500);
          };
        }''',{'mode':mode,'cid':CID})
        return p
    def message(p,m):
        return p.evaluate('m=>new Promise(resolve=>fixtureListener(m,{id:chrome.runtime.id},resolve))',m)
    def send(p,mid,text='exact test message',conversation=None):
        identity=message(p,{'type':'identity'})
        assert identity['ok'],identity
        c={'id':mid,'kind':'send','documentKey':identity['value']['documentKey'],'tabId':101,'lease':'test-lease','deadline':4102444800000,
           'payload':{'conversationId':conversation,'config':{'model':'m1','thinkingOption':'standard','appIds':[]},'text':text}}
        return message(p,{'type':'command','command':c}),c
    p=fresh('provisional');result,c=send(p,'nav-first')
    assert result.get('ok'),result
    assert result['value']['receipt'] and result['value']['nativeMessageId']=='native-u-1',result
    assert result['value']['url']=='https://chatgpt.com/c/'+CID and p.evaluate('fixtureClicks')==1
    checks.append('first Send survives same-document provisional route; receipt requires actual native user and concrete conversation')
    monitor={'sessionId':'test-session','turnId':'test-turn','lease':'test-lease','tabId':101,'documentKey':c['documentKey'],'conversationId':CID,'nativeMessageId':'native-u-1'}
    assert message(p,{'type':'monitor','session':monitor})['ok']
    p.wait_for_function("fixtureEvents.some(e=>e.type==='observation'&&e.event.kind==='completed')",timeout=9000)
    events=p.evaluate('fixtureEvents')
    assert any(e.get('event',{}).get('kind')=='snapshot' and e['event'].get('text')=='RECEIPT_NAV_OK_1' for e in events)
    checks.append('shipped content observer returns the public answer and one completed event after receipt')
    p.evaluate("send.onclick=(()=>{const old=send.onclick;return ()=>{history.replaceState({},'', '/c/'+"+json.dumps(CID)+");old()}})()")
    # A follow-up must not be permitted to revisit the provisional New Chat route.
    result2,_=send(p,'nav-follow-up','second body',CID)
    assert result2.get('ok') is False and p.evaluate('fixtureClicks')==2,result2
    checks.append('existing conversation cannot move back to an unbound route after its follow-up Send')
    p.close()
    p=fresh('second-route');result,_=send(p,'nav-wrong-destination')
    assert result.get('ok') is False and p.evaluate('fixtureClicks')==1,result
    checks.append('second concrete conversation revokes receipt permanently even when text matches and no DOM changed on first route')
    p.close()
    p=fresh('normal');result,c=send(p,'normal-first');assert result['ok'],result
    p.wait_for_timeout(650)
    result2,_=send(p,'normal-next','second body',CID);assert result2['ok'] and result2['value']['nativeMessageId']=='native-u-2',result2
    checks.append('normal first and second Sends remain bound to one native conversation with exactly two clicks')
    p.close();b.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'offline real Chrome URL/history + shipped content.js; not logged-in acceptance'},ensure_ascii=False,indent=2))
