"""Real content script: one page read is split by the transport, and only its
last frame may carry the closing evidence.

The page holds more public content than one transport frame can carry, so the
content script has to split the read. The extension must mark exactly one
frame of that read with readFinal:true, and it must be the LAST one: a run
that ends on an earlier frame reports the host turn as completed before the
remaining content has been received.

Chrome, the content script, the DOM reader and the transport are real. The
background worker is a stub that only records what the content script sends.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ID = 'a' * 32
# One transport frame carries 384KB. Six messages of 90KB each are well past
# that, so the read must be split into more than one frame.
MESSAGES = 6
MESSAGE_BYTES = 90 * 1024
checks = []


def check(condition, name):
    assert condition, name
    checks.append(name)


def fixture_page():
    rows = []
    for index in range(MESSAGES):
        body = ('%02d-' % index) + 'x' * MESSAGE_BYTES
        rows.append(
            '<div data-message-id="answer-%02d" data-message-author-role="assistant">%s</div>' % (index, body))
    return ('<!doctype html><html><head><meta charset="utf-8"><title>frame</title></head><body>'
            '<main id="messages">' + ''.join(rows) + '</main>'
            '<form><div id="prompt-textarea" contenteditable="true" role="textbox"></div>'
            '<button data-testid="send-button" type="button">Send</button></form>'
            '</body></html>')


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ['CIP_CHROMIUM'], headless=True)
    context = browser.new_context(service_workers='block')

    def route(request):
        if request.request.url == 'https://chatgpt.com/c/frame-conversation':
            request.fulfill(status=200, content_type='text/html', body=fixture_page())
        else:
            request.abort()

    context.route('**/*', route)
    page = context.new_page()
    try:
        page.goto('https://chatgpt.com/c/frame-conversation')
        # The stub worker records every page view the content script sends.
        page.evaluate('''() => {
          window.__cip = { sent: [], listener: null };
          window.chrome = { runtime: {
            id: %r,
            onMessage: { addListener: fn => { window.__cip.listener = fn; } },
            sendMessage: message => {
              window.__cip.sent.push(message);
              return Promise.resolve({ ok: true, value: { accepted: true } });
            }
          } };
        }''' % RUNTIME_ID)
        for name in ['upstream/cos-controls.js', 'upstream/cos-native.js', 'upstream/cos-receipt-text.js',
                     'upstream/cos-request-receipt.js', 'upstream/cos-models.js', 'app-catalog.js',
                     'app-discovery.js', 'media-adapter.js', 'artifact-transfer.js', 'file-upload.js',
                     'page-controls.js', 'page-content.js', 'public-message-adapter.js', 'dom-adapter.js']:
            page.add_script_tag(content='(() => {' + (ROOT / 'extension' / name).read_text() + '})();')
        page.add_script_tag(content='(() => {' + (ROOT / 'extension' / 'content.js').read_text() + '})();')

        ready = page.evaluate('''() => new Promise((resolve, reject) => {
          const listener = window.__cip.listener;
          if (!listener) return reject(new Error('NO_LISTENER'));
          const call = (message) => new Promise((done) => {
            const responded = (value) => done(value);
            const keep = listener(message, { id: window.chrome.runtime.id }, responded);
            if (keep !== true) setTimeout(() => done(null), 50);
          });
          call({ type: 'identity' }).then((identity) => {
            if (!identity || !identity.ok) return reject(new Error('NO_IDENTITY'));
            call({ type: 'monitor', session: {
              documentKey: identity.value.documentKey,
              conversationId: 'frame-conversation',
              observationLease: 'lease-frame-fixture',
              sessionId: 'session-frame',
              tabId: 71
            } }).then((monitored) => {
              if (!monitored || !monitored.ok) return reject(new Error('NO_MONITOR'));
              resolve(identity.value.documentKey);
            });
          });
        })''')
        check(isinstance(ready, str) and ready, 'content script established its document identity')

        page.wait_for_function('() => window.__cip.sent.filter(m => m.type === "page-view").length > 0', timeout=20000)
        page.wait_for_timeout(400)
        frames = page.evaluate('''() => window.__cip.sent.filter(m => m.type === "page-view")
            .map(m => ({ sequence: m.event.sequence, readFinal: m.event.readFinal,
                         items: (m.event.view.items || []).length }))''')

        check(len(frames) >= 2, 'one page read was split into several transport frames')
        # The first read is the complete page: its frames are consecutive from
        # sequence 1 up to and including the frame that closes the read.
        first_read = []
        for frame in frames:
            first_read.append(frame)
            if frame['readFinal'] is True:
                break
        check(len(first_read) >= 2, 'the split read carries more than one frame')
        check([frame['sequence'] for frame in first_read] == list(range(1, len(first_read) + 1)),
              'frames of one read keep consecutive sequences')
        finals = [frame['readFinal'] for frame in first_read]
        check(finals[-1] is True, 'the LAST frame of the read is the one that closes it')
        check(all(value is False for value in finals[:-1]),
              'no earlier frame of the read may claim to be the closing evidence')
        check(first_read[-1]['items'] > 0, 'the closing frame still carries content')
    finally:
        browser.close()

print(json.dumps({'passed': len(checks), 'checks': checks,
                  'scope': 'real content script, split transport frames; not production ChatGPT'},
                 ensure_ascii=False))
