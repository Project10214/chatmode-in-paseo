"""Shipped extension in offline Chromium; native typed shell, not a logged-in test.
Regression: a real native Send changes route and produces replies but has no legacy
message DOM attributes. Require exact native user ID plus body, never URL-only ACK.
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT/'tests/fixtures/chatgpt.html').read_text().replace('</body>', '<script>'+(ROOT/'tests/fixtures/native-picker.js').read_text()+'</script></body>')
CID = '12345678-1234-4234-8234-123456789abc'
checks=[]
with sync_playwright() as pw:
    opts={'headless':True}
    if os.environ.get('CIP_CHROMIUM'): opts['executable_path']=os.environ['CIP_CHROMIUM']
    browser=pw.chromium.launch(**opts)
    def fresh():
        p=browser.new_page();p.set_content(HTML);load_adapter(p,True,True)
        p.evaluate('''cid=>{
          window.cid=cid;
          window.shellSection=document.createElement('section');shellSection.setAttribute('data-turn-key','shell-key');
          shellSection.innerHTML='<span data-content-search-turn-key="turn-one"></span><div class="markdown">Visible reply</div>';
          document.querySelector('main').append(shellSection);
          window.shellEntry={id:'turn-one',conversationId:cid,turn:{status:'complete',items:[
            {type:'user-message',messageId:'native-user-1',serverMessageId:'native-user-1',message:'Question [$mac](app://asdk_app_a)'},
            {type:'chatgpt-reasoning-group',items:[{type:'reasoning',presentation:'thought',content:'PRIVATE_NOT_ALLOWED'},
              {type:'mcp-tool-call',invocation:{arguments:{token:'SECRET_NOT_ALLOWED'}}}]},
            {type:'assistant-message',messageId:'native-answer-1',phase:'final_answer',completed:true,content:'Hi，我在。'}]}};
          shellSection.__reactFiber$fixture={memoizedProps:{entry:shellEntry,conversationId:cid},return:null};
          fixtureLocation.pathname='/c/'+cid;fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;
        }''',CID)
        return p
    def read(p):
        p.evaluate('CIP_DOM.refreshTranscript()')
        return p.evaluate('CIP_DOM.messages().map(({node,...row})=>row)')
    p=fresh();rows=read(p)
    assert len(rows)==2 and rows[0]['id']=='native-user-1' and rows[0]['text']=='Question',rows
    assert rows[1]['final'] and rows[1]['text']=='Hi，我在。'
    assert 'PRIVATE' not in json.dumps(rows) and 'SECRET' not in json.dumps(rows)
    checks.append('cold/reloaded document reads native shell user receipt and final; no analysis/tool values')
    p.evaluate("shellEntry.turn.status='in_progress'");rows=read(p);assert not rows[-1]['final']
    checks.append('complete item alone cannot finish an in-progress native turn')
    p.evaluate("shellEntry.turn.status='complete';shellEntry.turn.items[2].completed=false");assert not read(p)[-1]['final']
    checks.append('complete turn alone cannot finish an incomplete final item')
    p.evaluate("shellEntry.turn.items[2].completed=true;shellEntry.turn.items.push({type:'assistant-message',messageId:'new-empty-final',phase:'final_answer',completed:false,content:''})")
    rows=read(p);assert not any(x['final'] for x in rows)
    checks.append('new textless attempt supersedes older final proof')
    p.close();p=fresh()
    p.evaluate("shellEntry.turn.items[0].serverMessageId='different-user'")
    rows=read(p);assert not any(x['id']=='native-user-1' for x in rows)
    checks.append('conflicting messageId/serverMessageId never produces a receipt')
    p.close();p=fresh()
    p.evaluate("shellEntry.conversationId='local-chatgpt:local-one';shellSection.__reactFiber$fixture.memoizedProps.conversationId='local-chatgpt:local-one';shellSection.__reactFiber$fixture.return={memoizedProps:{client:{getQueryCache:()=>({getAll:()=>[{queryKey:['chatgpt-conversation-details',{clientConversationId:'local-chatgpt:local-one',serverConversationId:cid}]}]})}},return:null}")
    assert read(p)[0]['id']=='native-user-1'
    checks.append('local shell ID resolves only through its exact native local/server query pair')
    p.evaluate("shellSection.__reactFiber$fixture.return.memoizedProps.client.getQueryCache=()=>({getAll:()=>[{queryKey:['chatgpt-conversation-details',{clientConversationId:'local-chatgpt:another',serverConversationId:cid}]}]})")
    assert not read(p)
    checks.append('unrelated cached conversation cannot lend the URL a receipt')
    p.close();p=fresh()
    p.evaluate("shellSection.__reactFiber$fixture.memoizedProps={conversationId:cid,turn:shellEntry.turn}")
    assert read(p)[-1]['final']
    checks.append('September turn.items view also supplies native user and completed final')
    p.close();p=fresh()
    p.evaluate("shellSection.style.display='none'");assert not read(p)
    checks.append('retained hidden conversation is not current receipt evidence')
    p.close();p=fresh()
    p.evaluate("shellEntry.turn.items[2].content='x'.repeat(256001)");p.evaluate('CIP_DOM.refreshTranscript()')
    error=p.evaluate("()=>{try{CIP_DOM.state('native-user-1')}catch(e){return e.code}}")
    assert error=='TRANSCRIPT_UNCONFIRMED',error
    checks.append('oversized public source fails instead of accepting truncated text')
    p.close();p=fresh()
    # Fresh route: no old question present before native Send. Public shell only.
    p.evaluate('''()=>{
      shellSection.remove();fixtureLocation.pathname='/';fixtureLocation.href='https://chatgpt.com/';
      window.receiptSends=0;
      send.onclick=()=>{
        receiptSends++;const body=plain();box.replaceChildren();
        fixtureLocation.pathname='/c/'+cid;fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;
        const n=receiptSends,section=document.createElement('section');section.setAttribute('data-turn-key','k'+n);
        section.innerHTML='<span data-content-search-turn-key="t'+n+'"></span><div class="markdown">rendered only</div>';
        const entry={id:'t'+n,conversationId:cid,turn:{status:'in_progress',items:[
          {type:'user-message',messageId:'sent-u-'+n,serverMessageId:'sent-u-'+n,message:body+' [$mac](app://asdk_app_a)'},
          {type:'assistant-message',messageId:'sent-a-'+n,phase:'final_answer',completed:false,content:''}]}};
        section.__reactFiber$fixture={memoizedProps:{entry,conversationId:cid},return:null};document.querySelector('main').append(section);
        const stop=document.createElement('button');stop.setAttribute('data-testid','stop-button');stop.textContent='Stop';box.closest('form').append(stop);
        setTimeout(()=>{entry.turn.items[1].content='Reply '+n;entry.turn.items[1].completed=true;entry.turn.status='complete';stop.remove()},500);
      };
    }''')
    cfg={'model':'model1','thinkingOption':'medium','appIds':['asdk_app_a','asdk_app_b']}
    body='[Paseo context — user-level instructions]\nWorking-directory hint (not a permission grant):\n/fixture/Plane\n[/Paseo context]\n\nhi'
    first=p.evaluate('async v=>CIP_DOM.send({payload:{config:v.cfg,text:v.body}},async()=>{})',{'cfg':cfg,'body':body})
    assert first['nativeMessageId']=='sent-u-1' and p.evaluate('receiptSends')==1,first
    p.wait_for_timeout(650);read(p);assert p.evaluate("CIP_DOM.state('sent-u-1').answer.final")
    checks.append('first Send acknowledges exact typed user once, before waiting for the answer')
    second=p.evaluate('async cfg=>CIP_DOM.send({payload:{config:cfg,text:"second unique question"}},async()=>{})',cfg)
    assert second['url']==first['url'] and second['nativeMessageId']=='sent-u-2' and p.evaluate('receiptSends')==2
    p.wait_for_timeout(650);read(p);assert p.evaluate("CIP_DOM.state('sent-u-2').answer.text")=='Reply 2'
    checks.append('second turn uses same conversation and delivers its own final, not the old reply')
    p.close()
    for mode in ['wrong-body','old-id']:
        p=fresh();read(p)
        result=p.evaluate('''async mode=>{
          const D=CIP_DOM,C=CIP_COS_CONTROLS;
          const N=CIP_createCoSNative({composer:D.composer,messages:D.messages,conversationId:C.conversationId,
            generating:C.generating,stopButton:C.stopButton,sendButton:C.sendButton,sendButtonEnabled:C.sendButtonEnabled});
          const wanted=mode==='old-id'?'Question':'Expected new request';
          let clicks=0,receipts=0;
          N.insertPrompt(wanted,true);
          send.onclick=()=>{clicks++;box.replaceChildren();if(mode==='wrong-body'){
            shellEntry.turn.items[0].messageId='different-new-id';shellEntry.turn.items[0].serverMessageId='different-new-id';
            shellEntry.turn.items[0].message='Other request';}};
          const accepted=await N.send({acceptanceTimeoutMs:500,receiptTimeoutMs:250,clearAcceptedDraft:false,
            matchesUser:r=>r.text===wanted,acceptUserReceipt:()=>{receipts++;return true},
            observeEvidence:check=>{const t=setInterval(async()=>{await D.refreshTranscript();check()},25);return()=>clearInterval(t)}});
          return {accepted,clicks,receipts};
        }''',mode)
        assert result=={'accepted':False,'clicks':1,'receipts':0},result
        checks.append(mode+': native route/answer/editor-clear is insufficient; one click and no false receipt')
        p.close()
    browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'offline Chromium + shipped code; no logged-in sends'},ensure_ascii=False,indent=2))
