"""Full isolated MV3 + one native Paseo tool select, without logged-in ChatGPT."""
from pathlib import Path
BASE=Path(__file__).with_name('binding-mv3-flow.py')
source=BASE.read_text()
old="        prompt('second','SECOND_MV3_BODY')"
new="""        send_input({'type':'session.configure','sessionId':'a','requestId':'quick-tool-a',
          'changes':{'settings':{'app:quick':'app:asdk_app_a'}}})
        wait(lambda es:any(e['type']=='request.completed' and e['requestId']=='quick-tool-a' for e in es),25)
        current=call('read',id=sid)
        assert current['config']['appIds']==['asdk_app_a'],current['config']
        selected=page.evaluate("()=>[...document.querySelectorAll('#prompt-textarea [data-prompt-link-href]')].map(x=>x.getAttribute('data-prompt-link-href'))")
        assert selected==['app://asdk_app_a'],selected
        options=[e['config']['settings'] for e in call('events') if e['type']=='session.config' and e['sessionId']=='a']
        assert len(options[-1])==1 and options[-1][0]['type']=='select'
        assert options[-1][0]['id']=='app:quick' and options[-1][0]['value']=='app:asdk_app_a'
        assert not any(x['value'].startswith(('add:','remove:')) for x in options[-1][0]['options'])
        checks.append('one native Paseo select chooses the authorized ChatGPT app without duplicate controls')
        prompt('second','SECOND_MV3_BODY')"""
assert source.count(old)==1,source.count(old)
source=source.replace(old,new)
exec(compile(source,str(BASE)+'[quick-tools-select]','exec'),{'__file__':str(BASE),'__name__':'__main__'})
