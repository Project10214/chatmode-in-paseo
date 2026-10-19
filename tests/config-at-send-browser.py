"""Offline Chromium regression: keep the same native model selection across turns.

Uses actual shipped CoS model picker and DOM adapter, synthetic React state,
and never opens a user's Chrome or calls a real model endpoint.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT/'tests/fixtures/chatgpt.html').read_text().replace(
    '</body>', '<script>'+(ROOT/'tests/fixtures/native-picker.js').read_text()+'</script></body>')
CONVERSATION = '/c/00000000-0000-4000-8000-000000000001'
CONFIG = {'model':'model1','thinkingOption':'high','appIds':[]}
CHANGED = {'model':'model2','thinkingOption':'medium','appIds':[]}
checks = []

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ['CIP_CHROMIUM'], headless=True)
    page = browser.new_page()
    try:
        page.set_content(HTML)
        page.evaluate("""route => {
          fixtureLocation.pathname=route;fixtureLocation.href='https://chatgpt.com'+route;
          window.nativePickerOpens=0;window.nativeBucketMoves=0;
          document.getElementById('native-picker').addEventListener('keydown',
            event=>{if(event.key==='Enter')nativePickerOpens++},true);
          window.origBucket=nativeState.currentBucket;
        }""", CONVERSATION)
        load_adapter(page, True, True)
        result=page.evaluate("c=>CIP_DOM.configure(c)", CONFIG)
        assert result == CONFIG, result
        first_open=page.evaluate('nativePickerOpens')
        assert first_open >= 1, first_open
        assert page.evaluate('nativeState.currentBucket') == 1
        checks.append('initial native model selection opens and verifies the real fixture picker')

        def turn(text):
            return page.evaluate("""async args => {
              try { return await CIP_DOM.send({payload:{turnId:args.text,text:args.text,config:args.cfg,
                conversationId:fixtureLocation.pathname.slice(3)}}, async()=>true); }
              catch(e){return {error:e.code||e.message,notSent:e.notSent===true}}
            }""", {'text':text,'cfg':CONFIG})

        a=turn('first identical model')
        assert a.get('receipt') is True, a
        assert page.evaluate('nativePickerOpens') == first_open
        page.wait_for_timeout(450)
        b=turn('second identical model')
        assert b.get('receipt') is True, b
        assert page.evaluate('nativePickerOpens') == first_open
        assert page.evaluate('fixtureSends') == 2
        checks.append('two Sends with unchanged Paseo model/effort perform zero additional native picker opens')

        model_after=page.evaluate("c=>CIP_DOM.configure(c)", CHANGED)
        assert model_after == CHANGED, model_after
        assert page.evaluate('nativePickerOpens') > first_open
        checks.append('a real selection change opens the native picker and verifies the changed model')

        no_more=page.evaluate('nativePickerOpens')
        assert page.evaluate("c=>CIP_DOM.configure(c)", CHANGED)==CHANGED
        assert page.evaluate('nativePickerOpens')==no_more
        checks.append('same selection repeated after a change is cached inside the same page document')

        tool_config = {**CHANGED, 'appIds':['asdk_app_a']}
        changed_tool = page.evaluate('c=>CIP_DOM.configure(c)', tool_config)
        assert changed_tool == tool_config, changed_tool
        assert page.evaluate('nativePickerOpens') == no_more
        assert page.evaluate("box.querySelector('[data-prompt-link-href]')?.getAttribute('data-prompt-link-href')") == 'app://asdk_app_a'
        checks.append('changing only Paseo tools updates current per-message @ mark without opening the native model picker')

        page.evaluate('CIP_DOM.invalidateModelMatch()')
        restored = page.evaluate('c=>CIP_DOM.configure(c)', tool_config)
        assert restored == tool_config, restored
        assert page.evaluate('nativePickerOpens') > no_more
        checks.append('a page-identity invalidation requires a fresh native model confirmation')
    finally:
        page.close()
        browser.close()

print(json.dumps({'passed':len(checks),'checks':checks,'scope':'offline Chromium native fixture; no account/real Send'},ensure_ascii=False,indent=2))
