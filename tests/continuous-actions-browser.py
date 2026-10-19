"""Production action adapter in isolated Chromium; all page/network behavior is local.
No logged-in Chrome, real approval, model request or deployment.
Run with CIP_PYTHON/CIP_CHROMIUM from ../logs/validation-env-012b2.sh.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'tests/fixtures/chatgpt.html').read_text()
CID = '00000000-0000-4000-8000-000000000001'
CONFIG = {'model':'m1', 'thinkingOption':'standard', 'appIds':[]}
checks = []


def check(condition, label):
    assert condition, label
    checks.append(label)


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ['CIP_CHROMIUM'], headless=True)
    context = browser.new_context(service_workers='block')
    external = []
    context.route('**/*', lambda route: (external.append(route.request.url), route.abort()))

    def fresh():
        page = context.new_page()
        page.set_content(HTML)
        load_adapter(page, True, False)
        page.evaluate('''cid => {
          fixtureLocation.pathname='/c/'+cid; fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;
          globalThis.__CIP_CONTENT__={documentKey:'document-one'};
          window.actionClicks={stop:0,allow:0,deny:0};window.guardCalls=0;window.revoked=false;
          window.nativeTurn={status:'complete',completed:true};
          const hidden=document.createElement('section');hidden.dataset.turnKey='native-conflict';
          Object.defineProperty(hidden,'__reactFiber$fixture',{get(){throw Error('NATIVE_STATE_READ_FORBIDDEN')}});
          messages.append(hidden);
          window.commandGuard=()=>{guardCalls++;if(revoked)throw Object.assign(Error('revoked'),{code:'OBSERVATION_LEASE_MISMATCH'});};
          window.stopOptions=()=>({conversationId:cid,documentKey:'document-one',observationLease:'lease-one',guard:commandGuard});
          window.tryAction=async work=>{try{return {ok:true,value:await work()}}catch(e){return {ok:false,code:e.code||e.message}}};
          window.addStop=()=>{const button=document.createElement('button');button.dataset.testid='stop-button';button.textContent='Stop';
            button.type='button';box.closest('form').append(button);button.onclick=()=>{actionClicks.stop++;button.remove();};return button;};
          window.addApproval=()=>{const card=document.createElement('div');card.dataset.codexApprovalSurface='true';
            card.innerHTML='<div role="alert">Allow ChatGPT to use fixture-tool?</div><button data-choice="deny">Deny</button><button data-choice="allow">Allow once</button>';
            messages.append(card);for(const button of card.querySelectorAll('button'))button.onclick=()=>{actionClicks[button.dataset.choice]++;card.remove();};
            return card;};
          window.approvalOptions=(choice='allow-once')=>({key:CIP_PAGE_CONTENT.read().approvals[0].key,choice,conversationId:cid,guard:commandGuard,authorizeClick:async()=>({allowed:true})});
          window.addAutoApproval=(labels=['Allow once','Allow','Deny'])=>{const card=document.createElement('div');card.dataset.codexApprovalSurface='true';
            card.innerHTML='<div role="alert">Allow ChatGPT to use fixture-tool?</div>'+labels.map((label,i)=>`<button data-choice="${i}">${label}</button>`).join('');
            messages.append(card);for(const button of card.querySelectorAll('button'))button.onclick=()=>{actionClicks['auto-'+button.dataset.choice]=(actionClicks['auto-'+button.dataset.choice]||0)+1;button.disabled=true;
              if(![...card.querySelectorAll('button')].some(other=>!other.disabled&&!['deny','cancel','not now','later'].includes(other.textContent.toLowerCase())))card.remove();};
            return card;};
          window.addReconnectApproval=()=>{const card=document.createElement('div');card.dataset.codexApprovalSurface='true';
            card.innerHTML='<div role="alert">presure</div><div>Reconnect presure</div><div>Your presure connection has expired.</div>'+
              '<button data-choice="deny">Not now</button><button data-choice="allow">Reconnect <kbd>↵</kbd></button>';
            messages.append(card);for(const button of card.querySelectorAll('button'))button.onclick=()=>{actionClicks[button.dataset.choice]++;button.disabled=true;card.remove();};
            return card;};
          const actualNow=Date.now;window.actionClock=0;Date.now=()=>actualNow()+actionClock;
        }''', CID)
        return page

    try:
        page = fresh()
        check(page.evaluate("['state','priorFinal','pageStatus','approval','approvalPending'].every(k=>!(k in CIP_DOM))"), 'old state, completion and duplicate approval APIs removed')
        page.evaluate('addStop()')
        result = page.evaluate('tryAction(()=>CIP_DOM.stop(stopOptions()))')
        check(result == {'ok':True,'value':{'stopped':True}} and page.evaluate('actionClicks.stop') == 1, 'enabled current Stop clicked exactly once and standby verified')
        check(page.evaluate('guardCalls') >= 4 and page.evaluate('nativeTurn.status') == 'complete', 'native complete contradicts Stop without overriding button evidence; guards rechecked')
        page.close()

        for mode in ['disabled','aria-disabled','ambiguous','no-stop-approval','no-composer','stale-guard','wrong-document','wrong-lease','wrong-conversation']:
            page = fresh()
            page.evaluate('addApproval()')
            if mode not in ['no-stop-approval','no-composer']:
                page.evaluate('window.testStop=addStop()')
            if mode == 'disabled': page.evaluate('testStop.disabled=true')
            if mode == 'aria-disabled': page.evaluate("testStop.setAttribute('aria-disabled','true')")
            if mode == 'ambiguous': page.evaluate('addStop()')
            if mode == 'no-composer': page.evaluate("box.closest('form').remove();messages.insertAdjacentHTML('beforeend','<h1>Page error</h1>')")
            if mode == 'stale-guard': page.evaluate('revoked=true')
            if mode == 'wrong-document': page.evaluate("__CIP_CONTENT__.documentKey='new-document'")
            if mode == 'wrong-lease': page.evaluate("window.stopOptions=()=>({conversationId:fixtureLocation.pathname.split('/c/')[1],documentKey:'document-one',observationLease:'',guard:commandGuard})")
            if mode == 'wrong-conversation': page.evaluate("window.stopOptions=()=>({conversationId:'00000000-0000-4000-8000-000000000099',documentKey:'document-one',observationLease:'lease-one',guard:commandGuard})")
            page.evaluate("nativeTurn.status='in_progress';nativeTurn.completed=false")
            result = page.evaluate('tryAction(()=>CIP_DOM.stop(stopOptions()))')
            check(not result['ok'] and page.evaluate('actionClicks') == {'stop':0,'allow':0,'deny':0}, mode + ': no Stop or approval click; native in_progress does not manufacture busy')
            page.close()

        for mode in ['abnormal-after-click','stop-remains','guard-during-wait','url-during-wait','document-during-wait']:
            page = fresh()
            page.evaluate('window.testStop=addStop()')
            page.evaluate('''mode=>{testStop.onclick=()=>{actionClicks.stop++;
              if(mode==='abnormal-after-click')box.closest('form').remove();
              if(mode==='guard-during-wait')setTimeout(()=>{revoked=true},20);
              if(mode==='url-during-wait')setTimeout(()=>{fixtureLocation.href+='?changed'},20);
              if(mode==='document-during-wait')setTimeout(()=>{__CIP_CONTENT__.documentKey='changed'},20);
              setTimeout(()=>{actionClock=10000},60);
            };}''', mode)
            result = page.evaluate('tryAction(()=>CIP_DOM.stop(stopOptions()))')
            check(not result['ok'] and page.evaluate('actionClicks.stop') == 1 and page.evaluate('actionClicks.deny') == 0,
                  mode + ': one click only, no fabricated success or Deny fallback')
            page.close()

        page = fresh()
        page.evaluate('''()=>{send.remove();const voice=document.createElement('button');voice.setAttribute('aria-label','Start Voice');box.closest('form').append(voice);addStop();}''')
        check(page.evaluate('tryAction(()=>CIP_DOM.stop(stopOptions()))')['ok'], 'Stop disappearance plus visible Voice is confirmed standby')
        page.close()

        page = fresh()
        page.evaluate("addAutoApproval(['Allow once','Allow','Deny'])")
        result = page.evaluate("tryAction(()=>CIP_DOM.answerApproval(approvalOptions('allow-auto')))")
        check(result['ok'] and result['value']['choice']=='allow-auto' and result['value']['clicked']==2
              and page.evaluate("actionClicks['auto-0']")==1 and page.evaluate("actionClicks['auto-1']")==1
              and (page.evaluate("actionClicks['auto-2']") or 0)==0,
              'auto approval clicks every one-time allow candidate, never Deny')
        page.close()

        page = fresh()
        page.evaluate("addAutoApproval(['Always allow','Allow once','Deny'])")
        result = page.evaluate("tryAction(()=>CIP_DOM.answerApproval(approvalOptions('allow-auto')))")
        check(result['ok'] and result['value']['tier']=='persistent' and result['value']['clicked']==1
              and page.evaluate("actionClicks['auto-0']")==1 and (page.evaluate("actionClicks['auto-1']") or 0)==0
              and (page.evaluate("actionClicks['auto-2']") or 0)==0,
              'auto approval prefers a persistent allow and does not also click the one-time button')
        page.close()

        page = fresh()
        page.evaluate("addAutoApproval(['Always allow','Trust this app','Deny'])")
        result = page.evaluate("tryAction(()=>CIP_DOM.answerApproval(approvalOptions('allow-auto')))")
        check(result['ok'] and result['value']['tier']=='persistent' and result['value']['clicked']==2
              and page.evaluate("actionClicks['auto-0']")==1 and page.evaluate("actionClicks['auto-1']")==1
              and (page.evaluate("actionClicks['auto-2']") or 0)==0,
              'auto approval clicks every persistent allow candidate, never Deny')
        page.close()

        page = fresh()
        page.evaluate("addAutoApproval(['Always allow','Trust this app','Deny'])")
        page.evaluate("""() => {
          const first=messages.querySelector('[data-choice="0"]'),second=messages.querySelector('[data-choice="1"]');
          first.onclick=()=>{
            actionClicks['auto-0']=(actionClicks['auto-0']||0)+1;
            first.disabled=true; second.textContent='Deny';
          };
        }""")
        result = page.evaluate("tryAction(()=>CIP_DOM.answerApproval(approvalOptions('allow-auto')))")
        check(not result['ok'] and page.evaluate("actionClicks['auto-0']")==1 and
              not page.evaluate("actionClicks['auto-1']||0") and
              page.evaluate("messages.querySelector('[data-choice=\\\"1\\\"]').textContent")=='Deny',
              'after the first auto click, a changed next button is never clicked as if it were Allow')
        page.close()

        page = fresh()
        page.evaluate("addAutoApproval(['Always allow','Trust this app','Deny'])")
        page.evaluate("""() => {
          let checks=0;
          window.stagedApproval=()=>{
            const value=approvalOptions('allow-auto');
            value.authorizeClick=async()=>{
              if(++checks>1)throw Object.assign(Error('vetoed'),{code:'APPROVAL_VETOED'});
              return {allowed:true};
            };
            return value;
          };
        }""")
        result=page.evaluate("tryAction(()=>CIP_DOM.answerApproval(stagedApproval()))")
        check(not result['ok'] and result['code']=='APPROVAL_PARTIAL_UNCONFIRMED' and
              page.evaluate("actionClicks['auto-0']||0")==1 and
              page.evaluate("actionClicks['auto-1']||0")==0,
              'auto toggle/veto between candidate buttons stops the second click and records partial uncertainty')
        page.close()

        page = fresh()
        page.evaluate("addAutoApproval(['Continue','OK','Deny'])")
        result = page.evaluate("tryAction(()=>CIP_DOM.answerApproval(approvalOptions('allow-auto')))")
        check(result['ok'] and result['value']['tier']=='confirm' and result['value']['clicked']==2
              and page.evaluate("actionClicks['auto-0']")==1 and page.evaluate("actionClicks['auto-1']")==1
              and (page.evaluate("actionClicks['auto-2']") or 0)==0,
              'auto approval clicks all generic confirmation candidates inside a recognized approval card')
        page.close()

        page = fresh()
        page.evaluate("addReconnectApproval()")
        result = page.evaluate("tryAction(()=>CIP_DOM.answerApproval(approvalOptions('allow-once')))")
        check(result['ok'] and result['value']['choice']=='allow-once'
              and page.evaluate('actionClicks.allow')==1 and page.evaluate('actionClicks.deny')==0,
              'reconnect cards expose the exact Reconnect button as a manual allow action')
        page.close()

        page = fresh()
        page.evaluate("addReconnectApproval()")
        result = page.evaluate("tryAction(()=>CIP_DOM.answerApproval(approvalOptions('deny')))")
        check(result['ok'] and result['value']['choice']=='deny'
              and page.evaluate('actionClicks.deny')==1 and page.evaluate('actionClicks.allow')==0,
              'reconnect cards expose the exact Not now deny action')
        page.close()

        page = fresh()
        page.evaluate("addReconnectApproval()")
        result = page.evaluate("tryAction(()=>CIP_DOM.answerApproval(approvalOptions('allow-auto')))")
        check(not result['ok'] and page.evaluate('actionClicks.allow')==0 and page.evaluate('actionClicks.deny')==0,
              'reconnect cards are never auto-approved by the allowlist switch')
        page.close()

        page = fresh()
        page.evaluate("addAutoApproval(['Sure','Deny'])")
        result = page.evaluate("tryAction(()=>CIP_DOM.answerApproval(approvalOptions('allow-auto')))")
        check(not result['ok'] and page.evaluate("actionClicks['auto-0']||0")==0 and page.evaluate("actionClicks['auto-1']||0")==0,
              'unknown labels are never guessed by auto approval')
        page.close()

        for mode in ['allow-after-ended','deny-after-ended','disabled-after-click','no-composer-approval']:
            page = fresh()
            page.evaluate('window.card=addApproval()')
            if mode == 'no-composer-approval': page.evaluate("box.closest('form').remove()")
            if mode == 'disabled-after-click':
                page.evaluate("() => {card.querySelector('[data-choice=allow]').onclick=e=>{actionClicks.allow++;e.currentTarget.disabled=true};}")
            choice = 'deny' if mode == 'deny-after-ended' else 'allow-once'
            result = page.evaluate('choice=>tryAction(()=>CIP_DOM.answerApproval(approvalOptions(choice)))', choice)
            check(result['ok'] and result['value']['answered'] and result['value']['choice'] == choice
                  and page.evaluate('actionClicks.allow+actionClicks.deny') == 1, mode + ': explicit approval remains actionable independently of running/composer/native completion')
            page.close()

        for mode in ['stale-key','disabled-button','changed-card','invalid-choice','guard-before','guard-during','url-during','doc-during','button-replaced','key-change-disabled','hidden-after-click','no-effect']:
            page = fresh()
            page.evaluate('window.card=addApproval();window.savedApproval=approvalOptions()')
            if mode == 'stale-key': page.evaluate("savedApproval.key='old-key'")
            if mode == 'disabled-button': page.evaluate("card.querySelector('[data-choice=allow]').disabled=true")
            if mode == 'changed-card': page.evaluate("card.querySelector('[role=alert]').textContent='Different request'")
            if mode == 'invalid-choice': page.evaluate("savedApproval.choice='always-allow'")
            if mode == 'guard-before': page.evaluate('revoked=true')
            delayed = mode in ['guard-during','url-during','doc-during','button-replaced','key-change-disabled','hidden-after-click','no-effect']
            if delayed:
                page.evaluate('''mode=>{card.querySelector('[data-choice=allow]').onclick=e=>{actionClicks.allow++;
                  if(mode==='guard-during')setTimeout(()=>{revoked=true},20);
                  if(mode==='url-during')setTimeout(()=>{fixtureLocation.href+='?changed'},20);
                  if(mode==='doc-during')setTimeout(()=>{__CIP_CONTENT__.documentKey='changed'},20);
                  if(mode==='button-replaced')e.currentTarget.replaceWith(e.currentTarget.cloneNode(true));
                  if(mode==='key-change-disabled'){card.querySelector('[role=alert]').textContent='Different request';e.currentTarget.disabled=true;}
                  if(mode==='hidden-after-click')card.hidden=true;
                  setTimeout(()=>{actionClock=10000},60);
                };}''', mode)
            result = page.evaluate('tryAction(()=>CIP_DOM.answerApproval(savedApproval))')
            check(not result['ok'] and page.evaluate('actionClicks.allow+actionClicks.deny') == (1 if delayed else 0),
                  mode + ': approval fails closed with no second click')
            page.close()

        page = fresh()
        page.evaluate('''()=>{addApproval();messages.insertAdjacentHTML('beforeend',
          '<div data-message-author-role="user" data-message-id="old-user">Old question</div>'+
          '<div data-message-author-role="assistant" data-message-id="answer">Assistant body must not enter receipt reader</div>'+
          '<div data-chatgpt-search-unit-key="shell:user" data-chatgpt-search-message-ids="shell-user shell-user">Shell question</div>'+
          '<div data-content-search-unit-key="layout:user">No native identity</div>');
          window.transcriptRequests=0;window.addEventListener('message',event=>{if(event.data?.source==='cip-cos-transcript-ask-v2')transcriptRequests++;});
        }''')
        rows = page.evaluate('async()=>{await CIP_DOM.refreshTranscript();return CIP_DOM.messages().map(({node,...row})=>row)}')
        check(rows == [{'id':'old-user','role':'user','text':'Old question'}, {'id':'shell-user','role':'user','text':'Shell question'}],
              'receipt compatibility APIs return native users only; shell duplicate IDs deduplicate and layout IDs are refused')
        check(page.evaluate('transcriptRequests') == 0 and page.evaluate('actionClicks.allow+actionClicks.deny') == 0, 'receipt refresh neither invokes old transcript pipeline nor answers approval')
        page.evaluate('''()=>{messages.insertAdjacentHTML('beforeend',
          '<div data-conversation-id="foreign"><div data-message-author-role="user" data-message-id="foreign-user">Foreign prompt</div></div>'+
          '<div hidden><div data-message-author-role="user" data-message-id="hidden-user">Hidden prompt</div></div>'+
          '<div data-message-author-role="user" data-message-id="empty-attachment"></div>'+
          '<div data-message-author-role="user" data-message-id="conflicting-user">Body one</div>'+
          '<div data-message-author-role="user" data-message-id="conflicting-user">Body two</div>');}''')
        extra = page.evaluate('CIP_DOM.messages().map(({node,...row})=>row)')
        check([row['id'] for row in extra] == ['old-user','shell-user','empty-attachment'] and extra[-1]['text'] == '',
              'receipt scan excludes foreign/hidden/conflicting identities but preserves attachment-only native user IDs')
        page.close()

        page = fresh()
        page.evaluate('window.authorizations=0;window.fixtureLong=true')
        result = page.evaluate('''async config=>CIP_DOM.send({payload:{turnId:'send-one',conversationId:fixtureLocation.pathname.split('/c/')[1],text:'Exact one-shot fixture body',config}},async()=>{authorizations++})''', CONFIG)
        check(result['receipt'] and result['nativeMessageId'] == 'user-1' and page.evaluate('fixtureSends') == 1
              and page.evaluate('authorizations') == 1, 'real CoS adapter Send retains one-shot authorization and exact new native user receipt')
        page.close()
        check(not external, 'no external network requests; only isolated synthetic pages and mocked hints')
    finally:
        context.close()
        browser.close()

source = (ROOT / 'extension/dom-adapter.js').read_text()
check(all(token not in source for token in ['C.generating', 'nativeAssistantIds', 'CIP_createPageObservation',
      'function state(', 'function priorFinal(', 'pageStatus', 'cip-cos-transcript-ask', 'function approval()', 'waitingCard']),
      'production adapter has no old status/body/tool/approval collector or native busy fallback')
print(json.dumps({'passed':len(checks), 'checks':checks, 'scope':'production adapter in isolated offline Chromium; no real browser/session or authorization'}, ensure_ascii=False, indent=2))
