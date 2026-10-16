"""Offline DOM integration checks. No ChatGPT account, extension installation, or model call.
Requires Python playwright and an installed Chromium. Uses ONLY in-memory HTML and a fixture URL binding (no navigation).
Run: CIP_CHROMIUM=/path/to/chromium python tests/browser-fixture.py
"""
import json, os, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'tests/fixtures/chatgpt.html').read_bytes()
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.end_headers(); self.wfile.write(HTML)
    def log_message(self, *_): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
checks = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CIP_CHROMIUM', '/usr/bin/chromium'), headless=True)
        page = browser.new_page()
        page.set_content(HTML.decode())
        load_adapter(page)
        catalog = page.evaluate('CIP_DOM.catalog()')
        assert [x['id'] for x in catalog['models']] == ['m1', 'm2']
        assert [x['id'] for x in catalog['apps']] == ['asdk_app_a', 'asdk_app_b']
        checks.append('dynamic model/thinking/app catalog from DOM')
        selected = {'model': 'm1', 'thinkingOption': 'extended', 'appIds': ['asdk_app_a', 'asdk_app_b']}
        actual = page.evaluate('(c) => CIP_DOM.configure(c)', selected)
        assert actual == selected
        checks.append('model + thinking + TWO native app chips confirmed')
        command = {'payload': {'config': selected, 'text': 'First offline message'}}
        reply = page.evaluate('(c) => CIP_DOM.send(c, async () => { window.authorized = true; })', command)
        assert reply['receipt'] is True and reply['nativeMessageId'] == 'user-1'
        assert page.evaluate('window.fixtureSends') == 1
        checks.append('native text insertion and verified send receipt')
        page.wait_for_timeout(700)
        state = page.evaluate("CIP_DOM.state('user-1')")
        assert not state['busy'] and state['answer']['final'] and 'First offline message' in state['answer']['text']
        checks.append('completed answer anchored to the NEW native user message')
        denied = page.evaluate('''async (c) => {
          try { await CIP_DOM.send(c, async () => { throw Object.assign(new Error('denied'), {code:'DENIED'}); }); return false; }
          catch(e) { return e.code === 'DENIED'; }
        }''', {'payload': {'config': selected, 'text': 'Do not send'}})
        assert denied and page.evaluate('window.fixtureSends') == 1
        checks.append('authorization refusal causes NO native Send click')
        # New isolated document; set_content alone keeps JavaScript globals.
        page.close(); page = browser.new_page()
        page.set_content(HTML.decode())
        load_adapter(page)
        page.evaluate('window.fixtureLong = true')
        result = page.evaluate('(c) => CIP_DOM.send(c, async () => {})', {'payload': {'config': selected, 'text': 'Long offline message'}})
        stopped = page.evaluate('(id) => CIP_DOM.stop(id)', result['nativeMessageId'])
        assert stopped['stopped'] and not page.evaluate("CIP_DOM.state('user-1').busy")
        checks.append('stop targets the exact native turn, not another tab')
        page.evaluate("document.querySelector('#prompt-textarea').textContent = 'Personal draft'")
        draft = page.evaluate("async c => { try { await CIP_DOM.configure(c); return false; } catch(e) { return e.code === 'DRAFT_CONFLICT'; } }", selected)
        assert draft
        assert page.evaluate("document.querySelector('#prompt-textarea').textContent") == 'Personal draft'
        checks.append('pre-existing draft is preserved and sending refused')
        browser.close()
    print(json.dumps({'passed': len(checks), 'checks': checks, 'scope': 'Chromium in-memory DOM fixture ONLY; not real ChatGPT or full MV3/Paseo integration'}, indent=2, ensure_ascii=False))
finally:
    server.shutdown(); server.server_close()
