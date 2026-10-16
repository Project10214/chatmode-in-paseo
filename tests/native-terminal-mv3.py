"""Stale Stop control must not delay a proven native final. Isolated TLS fixture."""
from pathlib import Path
BASE=Path(__file__).with_name('binding-mv3-flow.py')
source=BASE.read_text()
old="storeFixture();renderFixture();document.querySelector('[data-testid=\"stop-button\"]')?.remove();"
new="""storeFixture();renderFixture();
 if(entry.number===1)setTimeout(()=>document.querySelector('[data-testid="stop-button"]')?.remove(),7500);
 else document.querySelector('[data-testid="stop-button"]')?.remove();"""
assert source.count(old)==1
source=source.replace(old,new)
old="        state=call('read',id=sid)\n        assert state['turn']['nativeMessageId']=='native-user-1'"
new="""        page=next(p for p in browser.pages if p.url.startswith('https://chatgpt.com/c/'))
        assert page.evaluate("Boolean(document.querySelector('[data-testid=stop-button]'))"), 'native final should finish even with stale Stop visible'
        page.evaluate("document.querySelector('[data-testid=stop-button]')?.remove()")
        checks.append('native completed end_turn settles while stale Stop remains mounted; no false pending')
        state=call('read',id=sid)
        assert state['turn']['nativeMessageId']=='native-user-1'"""
assert source.count(old)==1
source=source.replace(old,new)
exec(compile(source,str(BASE)+'[native-terminal-stale-stop]','exec'),{'__file__':str(BASE),'__name__':'__main__'})
