"""Offline regression: a native menu may expose model metadata only while open.

Runs the shipped picker reader against synthetic React state. No user profile,
real account, private endpoint, or real message is used.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter

ROOT = Path(__file__).resolve().parents[1]
PAGE = (ROOT/'tests/fixtures/chatgpt.html').read_text()
NATIVE = (ROOT/'tests/fixtures/native-picker.js').read_text()
# Keep the native control recognizable, but put its model data only on the
# menu panel. The reader must open that control before it can verify a model.
assert NATIVE.count('pickerButton.__reactFiber$fixture=owner;') == 1
PANEL_ONLY = NATIVE.replace('pickerButton.__reactFiber$fixture=owner;', '')
checks = []

with sync_playwright() as pw:
    launch = {'headless': True}
    if os.environ.get('CIP_CHROMIUM'):
        launch['executable_path'] = os.environ['CIP_CHROMIUM']
    browser = pw.chromium.launch(**launch)

    def fixture(source=PANEL_ONLY):
        page = browser.new_page()
        page.set_content(PAGE.replace('</body>', '<script>'+source+'</script></body>'))
        page.evaluate("""() => {
          window.nativePickerOpens=0;
          pickerButton.addEventListener('keydown', e => {
            if(e.key==='Enter') nativePickerOpens++;
          }, true);
        }""")
        load_adapter(page, True, True)
        page.evaluate('window.pickerUnderTest=CIP_createCoSModels(CIP_COS_CONTROLS)')
        return page

    try:
        page = fixture()
        assert page.evaluate('pickerUnderTest.readPickerState()') is None
        result = page.evaluate("""async () => ({
          selected: await pickerUnderTest.selectModelSettings('model1', 'high'),
          opens: nativePickerOpens,
          bucket: nativeState.currentBucket,
          menuOpen: !!document.querySelector('[data-testid="composer-intelligence-picker-content"]'),
          sends: fixtureSends
        })""")
        assert result['selected'] is True, result
        assert result['opens'] == 1 and result['bucket'] == 1, result
        assert result['menuOpen'] is False and result['sends'] == 0, result
        checks.append('panel-only metadata: open the native control, verify exact model/effort, then close without Send')
        page.close()

        page = fixture()
        result = page.evaluate("""async () => ({
          selected: await pickerUnderTest.selectModelSettings('missing-model', 'high'),
          bucket: nativeState.currentBucket,
          sends: fixtureSends
        })""")
        assert result == {'selected': False, 'bucket': 0, 'sends': 0}, result
        checks.append('an unavailable model is rejected and the original selection is restored')
        page.close()

        page = fixture()
        page.evaluate("""() => {
          window.nativeProps={};
          publishProps();
        }""")
        result = page.evaluate("""async () => ({
          selected: await pickerUnderTest.selectModelSettings('model1', 'high'),
          opens: nativePickerOpens,
          sends: fixtureSends
        })""")
        assert result == {'selected': False, 'opens': 1, 'sends': 0}, result
        checks.append('opening a recognizable menu is not accepted as model evidence')
        page.close()
    finally:
        browser.close()

print(json.dumps({'passed':len(checks),'checks':checks,
    'scope':'offline Chromium; synthetic native picker; zero real Sends'}, ensure_ascii=False, indent=2))
