"""Actual MV3 extension -> Runtime -> installed Paseo SDK: public native activities.
Uses the isolated TLS ChatGPT fixture from binding-mv3-flow. Not a logged-in test.
"""
from pathlib import Path
R=Path(__file__).resolve().parents[1]
base=R/'tests/binding-mv3-flow.py'
source=base.read_text()
old="fixtureState.turns.push(entry);storeFixture();renderFixture();resumeFixture(entry);"
new="""entry.turn.items.push({type:'chatgpt-reasoning-group',reasoningRecap:{type:'show'},items:[
  {type:'reasoning',presentation:'thought',content:'PRIVATE_NEVER_TRANSFER_ME'},
  {type:'mcp-tool-call',callId:'native-call-'+n,completed:false,invocation:{server:'mymac',tool:'run_shell_command',arguments:{token:'SECRET_NEVER_TRANSFER_ME'}}},
  {type:'dynamic-tool-call',callId:'native-exec-'+n,tool:'exec',completed:false,invocation:{arguments:'SECRET_NEVER_TRANSFER_ME'}}
 ]});
 fixtureState.turns.push(entry);storeFixture();renderFixture();resumeFixture(entry);"""
assert old in source; source=source.replace(old,new)
old="storeFixture();renderFixture();document.querySelector('[data-testid=\"stop-button\"]')?.remove();"
new="""for(const call of entry.turn.items.at(-1)?.items??[])if(call.type==='mcp-tool-call'||call.type==='dynamic-tool-call')call.completed=true;
 storeFixture();renderFixture();document.querySelector('[data-testid="stop-button"]')?.remove();"""
assert old in source;source=source.replace(old,new)
old="        state=call('read',id=sid)\n        assert state['turn']['nativeMessageId']=='native-user-1'"
new="""        state=call('read',id=sid)
        emitted=[e for e in call('events') if e['type']=='timeline.item' and e['sessionId']=='a' and e['item'].get('kind')=='native-activity']
        assert emitted, 'native tool activity must reach the Paseo timeline'
        assert all(e['item']['data']['turnId']==state['turn']['id'] for e in emitted)
        assert any(any(step['label']=='mymac · run_shell_command' for step in e['item']['data']['steps']) for e in emitted)
        assert any(e['item']['data']['phase']=='completed' for e in emitted)
        assert not any('PRIVATE_NEVER_TRANSFER_ME' in str(e) or 'SECRET_NEVER_TRANSFER_ME' in str(e) for e in emitted)
        cards=[x for x in state['history'] if x.get('kind')=='native-activity']
        assert len(cards)==1 and cards[0]['data']['phase']=='completed'
        checks.append('public native MCP/code steps reach the Paseo timeline, upsert once and complete without private reasoning/arguments')
        assert state['turn']['nativeMessageId']=='native-user-1'"""
assert old in source;source=source.replace(old,new)
exec(compile(source,str(base)+'[native-activity]','exec'),{'__name__':'__main__','__file__':str(base)})
