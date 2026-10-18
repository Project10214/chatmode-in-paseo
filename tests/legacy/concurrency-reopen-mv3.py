"""Actual MV3 + Runtime/SDK, isolated native fixture. No user account or live Send.
Reuse the maintained TLS fixture, with per-conversation persistence across tab closure.
"""
from pathlib import Path
R=Path(__file__).resolve().parents[1]
base=R/'tests/binding-mv3-flow.py'
source=base.read_text()
source=source.replace("sessionStorage.getItem('fixture-state')","localStorage.getItem('fixture-state:'+location.pathname)")
source=source.replace("sessionStorage.setItem('fixture-state',JSON.stringify(fixtureState))","localStorage.setItem('fixture-state:'+location.pathname,JSON.stringify(fixtureState))")
source=source.replace("setTimeout(()=>finishFixture(entry),2500)","setTimeout(()=>finishFixture(entry),6000)")
a=source.index("        config_b={**config,")
b=source.index("    finally:\n        try:call('close')",a)
flow=r'''
        original_tab=state['tabId']
        page.close()
        prompt('reopen-third','NEW_MESSAGE_AFTER_TAB_CLOSED')
        wait(lambda es:len([e for e in es if e['type']=='session.turn' and e['state']=='completed'])==3,35)
        restored=call('read',id=sid)
        page=next(p for p in browser.pages if p.url.endswith('/c/'+cid))
        assert restored['tabId']!=original_tab and restored['conversationId']==cid
        assert restored['turn']['nativeMessageId']=='native-user-3'
        assert page.evaluate('fixtureState.clicks')==3
        assert len([x for x in restored['history'] if x['type']=='user_message'])==3
        checks.append('close completed tab -> NEW prompt opens same native URL, restores history and sends exactly once')
        call('concurrency',limit=2)
        hosts={}
        for host in ['b','c','d','e']:
            send_input({'type':'session.open','requestId':'open-'+host,'sessionId':host,'config':config,'history':'skip'})
            opened=wait(lambda es:next((e for e in es if e['type']=='session.opened' and e['sessionId']==host),None))
            hosts[host]=opened['persistence']['data']['id']
        for host in hosts:prompt('queued-'+host,'CONCURRENT_'+host,host)
        wait(lambda es:call('capacity')['waiting']==2,10)
        assert call('read',id=hosts['d'])['tabId'] is None
        assert call('read',id=hosts['e'])['tabId'] is None
        checks.append('two occupied slots leave third and fourth requests queued, without phantom Chrome tabs')
        send_input({'type':'session.interrupt','requestId':'cancel-queued-e','sessionId':'e'})
        wait(lambda es:any(e['type']=='request.completed' and e.get('requestId')=='cancel-queued-e' for e in es),10)
        wait(lambda es:call('capacity')['waiting']==1,10)
        assert call('read',id=hosts['e'])['tabId'] is None
        assert call('read',id=hosts['e'])['history']==[]
        call('concurrency',limit=4)
        prompt('a-fourth','FOURTH_ACTIVE_SESSION')
        wait(lambda es:call('capacity')['active']==4,15)
        call('concurrency',limit=1)
        assert call('capacity')['active']==4
        wait(lambda es:len([e for e in es if e['type']=='session.turn' and e['state']=='completed'])==7,40)
        assert call('capacity')=={'limit':1,'active':0,'waiting':0}
        assert page.evaluate('fixtureState.clicks')==4
        assert call('read',id=hosts['e'])['history']==[]
        conversations={call('read',id=val)['conversationId'] for key,val in hosts.items() if key!='e'}
        assert len(conversations)==3 and cid not in conversations
        checks.append('live 2 -> 4 -> 1 settings allow four active sessions, preserve isolation and never interrupt existing turns')
        checks.append('canceling waiting request sends nothing and cannot reappear when the limit is raised')
        # Existing tab navigated elsewhere is not taken over or silently replaced.
        page.goto('https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
        prompt('wrong-route','MUST_NOT_SEND')
        failed=wait(lambda es:next((e for e in es if e['type']=='session.prompt_result' and e['clientMessageId']=='wrong-route'),None),12)
        # Prompt acceptance can precede browser preflight; it is not a Send receipt.
        if failed['result']['type']=='turn':
            terminal=wait(lambda es:next((e for e in es if e['type']=='session.turn' and e['turnId']==failed['result']['turnId'] and e['state'] in ('failed','completed','canceled')),None),12)
            assert terminal['state']=='failed',{'unexpectedTerminal':terminal,'boundTabId':call('read',id=sid)['tabId'],'originalTabId':restored['tabId'],'conversationId':call('read',id=sid)['conversationId']}
            error=terminal['error']
        else:
            assert failed['result']['type']=='failed',failed
            error=failed['result']['error']
        assert error['code']=='WRONG_CONVERSATION',error
        assert page.evaluate('fixtureState.clicks')==0
        assert call('read',id=sid)['conversationId']==cid
        checks.append('manually navigated tab fails promptly with explicit ownership error; no replacement or Send')
'''
source=source[:a]+flow+source[b:]
exec(compile(source,str(base)+'[concurrency-reopen]','exec'),{'__file__':str(base),'__name__':'__main__'})
