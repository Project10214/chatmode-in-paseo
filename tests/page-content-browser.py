"""Offline production IIFE in real, isolated Playwright Chromium.

Synthetic fixture, plus existing captured approval-card markup. No logged-in
profile, external network, real sessions, approval clicks, or deployment.
Run: source ../logs/validation-env-012b2.sh; "$CIP_PYTHON" tests/page-content-browser.py
"""
import json
import os
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'extension/page-content.js').read_text()
FIXTURE = (ROOT / 'tests/fixtures/chatgpt-work-classification.html').read_text()
checks = []


def check(condition, name):
    assert condition, name
    checks.append(name)


def native(snapshot, message_id):
    matches = [item for item in snapshot['items'] if item.get('nativeMessageId') == message_id]
    assert len(matches) == 1, (message_id, matches)
    return matches[0]


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ['CIP_CHROMIUM'], headless=True)
    context = browser.new_context(service_workers='block')
    network = []

    def route(request):
        network.append(request.request.url)
        if request.request.url == 'https://fixture.invalid/c/fixture-conversation':
            request.fulfill(status=200, content_type='text/html', body=FIXTURE)
        else:
            request.abort()

    context.route('**/*', route)
    page = context.new_page()
    try:
        page.goto('https://fixture.invalid/c/fixture-conversation')
        page.add_script_tag(content=SOURCE)
        page.evaluate('''() => {
          window.actions = {click:0,input:0,submit:0,network:0};
          for(const name of ['click','input','submit']) document.addEventListener(name, e => {
            actions[name]++; e.preventDefault();
          }, true);
          window.fetch = () => {actions.network++; throw Error('NO_NETWORK');};
          XMLHttpRequest.prototype.open = () => {actions.network++; throw Error('NO_NETWORK');};
          Object.defineProperty(document.querySelector('#public-work'), '__reactFiber$private', {
            get() {throw Error('PRIVATE_REACT_ACCESS');}
          });
        }''')
        before_html = page.content()
        opened = page.evaluate('CIP_PAGE_CONTENT.read()')
        check(set(opened) == {'conversationId', 'observedAt', 'items', 'approvals', 'closedApprovals', 'issues'}, 'snapshot API shape')
        check(opened['conversationId'] == 'fixture-conversation' and isinstance(opened['observedAt'], int), 'URL conversation and observation time')
        required = {'id', 'userMessageId', 'role', 'lane', 'kind', 'text', 'format', 'order'}
        check(all(required <= row.keys() and row['format'] == 'text' and isinstance(row['order'], list)
                  and all(isinstance(x, int) and x >= 0 for x in row['order']) for row in opened['items']), 'source item protocol and honest DOM text format')
        check(page.content() == before_html, 'read does not mutate DOM, expand, refresh, or type')
        check(len({row['id'] for row in opened['items']}) == len(opened['items']), 'all source identities unique')
        user = native(opened, 'user-one')
        check(user['role'] == 'user' and user['text'] == '请核对代码，保留原文。', 'nested shell search aliases and repeated IDs deduplicated')
        final = native(opened, 'answer-one')
        check(final['text'] == '核对完成。正式回答保持独立。\n原文含有 tool、completed，不代表工具结果或网页状态。'
              and final['lane'] == 'output' and final['kind'] == 'message' and final['role'] == 'assistant', 'final is independent native assistant output, not a Work aggregate')
        check(final['userMessageId'] == 'user-one' and native(opened, 'answer-two')['userMessageId'] == 'user-two'
              and native(opened, 'answer-three')['userMessageId'] == 'user-three', 'full multi-turn history associated per source user, never last-anchor only')
        progress = next(row for row in opened['items'] if row['text'] == '我先核对代码，再检查测试。')
        recap = next(row for row in opened['items'] if row['text'] == 'Focused on checking the implementation')
        check(progress['lane'] == 'process' and progress['kind'] == 'message' and progress['role'] == 'assistant', 'Chinese primary Work commentary stays process message')
        check(recap['lane'] == 'process' and recap['kind'] == 'reasoning', 'public tertiary Work summary is not a tool call')
        tool = next(row for row in opened['items'] if row.get('callId') == 'call-one')
        check(tool['kind'] == 'tool_call' and tool['name'] == 'read_file' and tool['status'] == 'completed'
              and tool['details'] == {'input':'{"path":"fixture.txt"}', 'output':'fixture line 1\n  fixture line 2'}, 'tool requires exact DOM call metadata; public input/output retained verbatim')
        check(sum(row['kind'] == 'tool_call' for row in opened['items']) == 1, 'tool-looking prose never fabricates a call')
        check('state' not in opened and 'status' not in final, 'no completion, delivery or page-state inference')
        unknown = next(row for row in opened['items'] if row['text'].startswith('Unknown public activity'))
        check(unknown['lane'] == 'output' and unknown['kind'] == 'notice', 'unknown Work blocks retained as output/notice')
        check(any(row['text'] == '无法分类的正文提示：Error 9Z' for row in opened['items']), 'unknown top-level prose retained')
        check(any(issue['code'] == 'AMBIGUOUS_MESSAGE_ID' for issue in opened['issues'])
              and any(row['text'] == '身份无法拆分，但原文必须保留。' and not row.get('nativeMessageId') for row in opened['items']), 'ambiguous multi-ID source retained without invented native identity')
        serialized = json.dumps(opened, ensure_ascii=False)
        check(all(token not in serialized for token in ['PRIVATE_', 'HIDDEN_', 'SIDEBAR_', 'OTHER_VISIBLE_', 'EDITOR_DRAFT']), 'private/hidden thinking, kept pages, sidebar, foreign conversation, drafts and scripts excluded')
        check(any(row['kind'] == 'image' and row['media']['uriScheme'] == 'data:'
                  and row['media']['provenance'] == 'visible-image-resource'
                  and row['media']['resourceRevision'] and 'src' not in row['media'] for row in opened['items'])
              and any(row['kind'] == 'file' and row['media']['name'] == 'fixture.txt' for row in opened['items']), 'media descriptors retained without pretending bytes were downloaded')
        page.evaluate("document.querySelector('#public-work').open = false")
        folded = page.evaluate('CIP_PAGE_CONTENT.read()')
        check(native(folded, 'answer-one') == final, 'folding Work cannot change final identity, text or ordering')
        check(next(row for row in folded['items'] if row['id'] == progress['id']) == progress, 'mounted public details content remains readable when collapsed')
        check(not folded['closedApprovals'], 'folding content is not evidence of approval closure')
        check(native(folded, 'progress-three')['lane'] == 'process', 'hidden aria-controls Work panel is publicly readable; private descendants are not')
        page.evaluate('''() => {const panel = document.querySelector('#work-panel'); panel.hidden = false;
          panel.removeAttribute('aria-hidden'); panel.previousElementSibling.setAttribute('aria-expanded', 'true');}''')
        expanded = page.evaluate('CIP_PAGE_CONTENT.read()')
        check(native(expanded, 'answer-three') == native(folded, 'answer-three'), 'aria-controls expansion also leaves final stable')
        # Simulate lazy mounting, without any application click.
        page.evaluate('''() => {const n=document.querySelector('#public-work [data-selected-text-overlay-target="progress-one"]');
          window.savedProgress=n; n.remove();}''')
        unmounted = page.evaluate('CIP_PAGE_CONTENT.read()')
        check(not any(row['id'] == progress['id'] for row in unmounted['items']) and native(unmounted, 'answer-one') == final,
              'unmounted process is not invented or cached into final')
        page.evaluate("document.querySelector('#public-work').append(savedProgress)")
        remounted = page.evaluate('CIP_PAGE_CONTENT.read()')
        check(next(row for row in remounted['items'] if row['id'] == progress['id'])['text'] == progress['text'], 'public overlay identity survives fragment remount')
        approval = opened['approvals'][0]
        check(len(opened['approvals']) == 1 and approval['clickable'] and approval['allowLabel'] == 'Allow once'
              and approval['denyLabel'] == 'Deny' and 'requestId' not in approval, 'approval separate, exact native buttons, no invented request ID')
        check(not any('Allow ChatGPT' in row['text'] or 'Allow once' in row['text'] for row in opened['items']), 'approval request never mixed into assistant prose')
        check(page.evaluate('''key => CIP_PAGE_CONTENT.resolveApproval(key,'allow-once') === document.querySelector('#allow') &&
          CIP_PAGE_CONTENT.resolveApproval(key,'deny') === document.querySelector('#deny') &&
          CIP_PAGE_CONTENT.resolveApproval(key,'always-allow') === null''', approval['key']), 'resolver returns verified native nodes only; never Always allow')
        page.evaluate("document.querySelector('#allow').disabled=true")
        check(page.evaluate("key => CIP_PAGE_CONTENT.resolveApproval(key,'allow-once') === null", approval['key']), 'disabled approval cannot be resolved by stale key')
        page.evaluate("document.querySelector('#allow').disabled=false")
        new_key = page.evaluate('CIP_PAGE_CONTENT.read().approvals[0].key')
        page.evaluate("document.querySelector('#approval [role=alert]').textContent='Changed native request'")
        check(page.evaluate("key => CIP_PAGE_CONTENT.resolveApproval(key,'allow-once') === null", new_key), 'changed card contents revoke old key even when DOM reused')
        new_key = page.evaluate('CIP_PAGE_CONTENT.read().approvals[0].key')
        page.evaluate("document.querySelector('#approval').hidden=true")
        check(page.evaluate('CIP_PAGE_CONTENT.read().approvals.length') == 0
              and page.evaluate("key => CIP_PAGE_CONTENT.resolveApproval(key,'deny') === null", new_key), 'only currently visible approvals, no hidden pending-card guesses')
        page.evaluate("document.querySelector('#approval').hidden=false")
        # Independently unreadable source must not veto other public messages.
        page.evaluate('''() => {document.querySelector('#partial').getAttribute = () => {throw Error('fixture failure');};}''')
        partial = page.evaluate('CIP_PAGE_CONTENT.read()')
        check(native(partial, 'answer-one')['text'] == final['text'] and any(issue['code'] == 'SOURCE_READ_FAILED' for issue in partial['issues']), 'one failing source does not discard independent messages or approval')
        check(page.evaluate('actions') == {'click':0, 'input':0, 'submit':0, 'network':0}, 'zero clicks, inputs, submits or network during read/resolve')
        check(len(network) == 1, 'only mocked fixture navigation, no external network')

        def load(body):
            page.set_content(body)
            page.add_script_tag(content=SOURCE)
            return page.evaluate('CIP_PAGE_CONTENT.read()')

        error = load('<main><h1>页面暂时无法打开</h1><div>Unknown response 93X<br>请稍后重试。</div></main>')
        check([row['text'] for row in error['items']] == ['页面暂时无法打开', 'Unknown response 93X\n请稍后重试。'], 'full-page errors without composer or message metadata retained')
        error = load('<aside>OTHER_SIDEBAR</aside><h1>Whole-page error without main</h1><div role="alert">No composer</div>')
        check([row['text'] for row in error['items']] == ['Whole-page error without main', 'No composer'], 'body fallback reads whole-page errors but never sidebar')
        server_approvals = []
        for filename in ['chatgpt-approval-card.html', 'chatgpt-approval-card-chrome.html']:
            markup = (ROOT / 'tests/fixtures' / filename).read_text()
            snapshot = load('<main>' + markup + '</main>')
            check(not snapshot['items'] and len(snapshot['approvals']) == 1 and snapshot['approvals'][0]['clickable'],
                  'captured native approval markup with no prose: ' + filename)
            server_approvals.append(snapshot['approvals'][0])
        check([request['app'] for request in server_approvals] == ['mymac', 'Chrome'], 'app comes from actual native card header, not an invented fallback')
        contract = subprocess.run(['node', '--input-type=module', '-e', '''
          import {approvalEvent} from './server/approval.mjs';
          let input=''; for await(const chunk of process.stdin) input+=chunk;
          const results=JSON.parse(input).map(({text,...request}) => approvalEvent({state:'open',...request}));
          console.log(JSON.stringify(results));
        '''], input=json.dumps(server_approvals), text=True, capture_output=True, cwd=ROOT, check=True)
        check(len(json.loads(contract.stdout)) == 2, 'actual server approvalEvent accepts confirmed cards after raw text projection and state:open wrapping')
        snapshot = load('''<main><div data-codex-approval-surface="true"><p>Native request</p>
          <button aria-controls="approval-details" aria-haspopup="dialog" aria-expanded="true">See details</button>
          <button>Allow once</button><button>Deny</button></div>
          <div role="dialog" id="approval-details"><pre>{"command":"fixture-only"}</pre><div hidden>PRIVATE_APPROVAL_DETAIL</div></div></main>''')
        check(not snapshot['items'] and snapshot['approvals'][0]['input'] == '{"command":"fixture-only"}'
              and 'PRIVATE_APPROVAL_DETAIL' not in json.dumps(snapshot), 'visible linked approval details read without clicking and excluded from ordinary output')
        page.evaluate("document.querySelector('#approval-details').hidden = true")
        snapshot = page.evaluate('CIP_PAGE_CONTENT.read()')
        check(snapshot['approvals'][0]['input'] is None, 'hidden approval details never opened or read')
        snapshot = load('<main><div class="markdown"><details><summary>Work</summary><p>PRIVATE_QUOTED_DETAILS</p></details></div><p>Public</p></main>')
        check('PRIVATE_QUOTED_DETAILS' not in json.dumps(snapshot), 'quoted details summary cannot authorize hidden reading')
        snapshot = load('''<main><div data-message-author-role="assistant" data-message-id="outer-final">
          <details><summary>Work</summary><div data-markdown-text-style="assistant-message">公开嵌套进度</div></details>
          <p>Independent final</p></div></main>''')
        check(native(snapshot, 'outer-final')['text'] == 'Independent final'
              and any(row['text'] == '公开嵌套进度' and row['lane'] == 'process' and 'nativeMessageId' not in row for row in snapshot['items']),
              'Work within a legacy assistant wrapper cannot inherit or rewrite final message identity')
        snapshot = load('''<main><details><summary>Work</summary><button aria-controls="nested-public" aria-expanded="false">Work</button>
          <div id="nested-public" hidden><div data-message-author-role="assistant" data-message-id="nested-progress">Nested public work</div><p hidden>PRIVATE_NESTED</p></div>
          </details></main>''')
        check(native(snapshot, 'nested-progress')['lane'] == 'process' and 'PRIVATE_NESTED' not in json.dumps(snapshot),
              'nested public Work disclosures readable without expanding; nested private child excluded')
        snapshot = load('<main><button aria-expanded="false">Work</button><p>Unlinked visible content</p><div hidden>PRIVATE_UNLINKED</div></main>')
        check(any(issue['code'] == 'WORK_PANEL_UNIDENTIFIED' for issue in snapshot['issues'])
              and 'PRIVATE_UNLINKED' not in json.dumps(snapshot), 'unlinked Work layout reported, never guessed or force-expanded')
        snapshot = load('<main><div data-codex-approval-surface="true"><p>Native request</p><button>Sure</button><button>Nope</button></div></main>')
        check(snapshot['approvals'][0]['clickable'] is False and snapshot['approvals'][0]['labels'] == ['Sure','Nope'], 'unknown approval labels retained but never guessed from position or style')
        check(snapshot['approvals'][0]['app'] is None and any(issue['code'] == 'APPROVAL_APP_UNCONFIRMED' for issue in snapshot['issues']),
              'missing app identity reported as server incompatibility, never replaced with an invented app')
        snapshot = load('<main><div data-codex-approval-surface="true"><p>请求</p><button>拒绝</button><button>允许一次</button></div></main>')
        check(snapshot['approvals'][0]['clickable'], 'explicit Chinese approval captions supported')
        snapshot = load('<main><div data-codex-approval-surface="true"><button>Always allow</button><button>Deny</button></div></main>')
        check(not snapshot['approvals'][0]['clickable'], 'Always allow cannot substitute for Allow once')
        snapshot = load('<main><div data-codex-approval-surface="true"><button>Allow</button><button>Allow once</button><button>Deny</button></div></main>')
        check(not snapshot['approvals'][0]['clickable'], 'multiple allow targets fail closed')
        snapshot = load('<main><p>Conversation A</p></main><main><p>Conversation B</p></main>')
        check(not snapshot['items'] and snapshot['issues'] == [{'code':'AMBIGUOUS_MAIN_SURFACE'}], 'ambiguous visible main surfaces cannot mix conversations')
        snapshot = load('<main><div data-message-id="same" data-message-author-role="assistant">Same answer</div><div data-message-id="same" data-message-author-role="assistant">Same answer</div><div data-message-id="same" data-message-author-role="assistant">Conflicting answer</div></main>')
        check(len(snapshot['items']) == 2 and len([row for row in snapshot['items'] if row.get('nativeMessageId') == 'same']) == 1
              and any(issue['code'] == 'SOURCE_ID_CONFLICT' for issue in snapshot['issues']), 'same native copy deduplicated; conflicting source retained without fabricating identity')
        snapshot = load('<main><article data-turn-key="turn"><div data-content-search-unit-key="slot:assistant">Layout keyed answer</div><p>Unkeyed notice</p></article></main>')
        first = snapshot['items'][0]
        page.evaluate("document.querySelector('[data-content-search-unit-key]').outerHTML=document.querySelector('[data-content-search-unit-key]').outerHTML")
        check(page.evaluate('CIP_PAGE_CONTENT.read().items[0]') == first and 'nativeMessageId' not in first, 'search-layout identity survives remount but is not advertised as a native message')
        check(any(issue['code'] == 'DOM_LOCAL_IDENTITY' for issue in snapshot['issues']), 'unkeyed DOM identity limitation explicitly reported')
        snapshot = load('''<main><details><summary>Work</summary><div data-chatgpt-search-unit-key="work:assistant" data-chatgpt-search-message-ids="recap-id recap-id">
          <div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">Public keyed recap</div></div></details></main>''')
        check(native(snapshot, 'recap-id')['kind'] == 'reasoning', 'keyed shell wrapper preserves public tertiary recap classification')
        snapshot = load('<main><div style="height:0;overflow:hidden">PRIVATE_CLIPPED</div><div style="opacity:0">PRIVATE_TRANSPARENT</div><div style="content-visibility:hidden">PRIVATE_SKIPPED_RENDER</div><p>Public retained</p></main>')
        check([row['text'] for row in snapshot['items']] == ['Public retained'], 'clipped, transparent and content-visibility hidden text excluded')
        snapshot = load('<main><form><div role="alert">Form error without editor</div><button>Retry</button></form></main>')
        check([row['text'] for row in snapshot['items']] == ['Form error without editor'], 'non-composer form error is not lost to a form whitelist')
        snapshot = load('<main><div data-item-type="future-artifact-v9">Unknown source payload</div></main>')
        check(snapshot['items'][0]['kind'] == 'notice' and snapshot['items'][0]['sourceType'] == 'future-artifact-v9'
              and snapshot['items'][0]['text'] == 'Unknown source payload', 'unknown public source type retained verbatim alongside notice classification')
        approval_page = '''<main><p>Current conversation</p><div id="cards"><div id="request" data-codex-approval-surface="true">
          <div role="alert">Allow ChatGPT to use fixture-tool?</div><button>Allow once</button><button>Deny</button>
          </div><p>Stable parent</p></div></main>'''
        snapshot = load(approval_page)
        page.evaluate('''() => {const root=document.querySelector('main'), query=root.querySelectorAll.bind(root);
          root.querySelectorAll=selector=>{if(selector==='summary,button')throw Error('CONTENT_FAILURE'); return query(selector);};}''')
        snapshot = page.evaluate('CIP_PAGE_CONTENT.read()')
        check(len(snapshot['approvals']) == 1 and any(issue['code'] == 'CONTENT_LANE_READ_FAILED' for issue in snapshot['issues']),
              'content-lane failure does not prevent independent approval snapshot')
        snapshot = load(approval_page)
        page.evaluate("() => {document.querySelector('#request').getClientRects=()=>{throw Error('APPROVAL_FAILURE')};}")
        snapshot = page.evaluate('CIP_PAGE_CONTENT.read()')
        check(any(row['text'] == 'Current conversation' for row in snapshot['items']) and any(issue['code'] == 'APPROVAL_READ_FAILED' for issue in snapshot['issues']),
              'approval-lane failure does not prevent independent public content snapshot')
        snapshot = load(approval_page)
        key = snapshot['approvals'][0]['key']
        page.evaluate("document.querySelector('#request').remove()")
        snapshot = page.evaluate('CIP_PAGE_CONTENT.read()')
        check(snapshot['closedApprovals'] == [key] and not snapshot['approvals'], 'exact card removal from unchanged live parent reports closure, not a choice')
        check(page.evaluate('CIP_PAGE_CONTENT.read().closedApprovals') == [key], 'confirmed closure is replayable for transport retry')
        snapshot = load(approval_page)
        page.evaluate("document.querySelector('#request').hidden=true")
        check(not page.evaluate('CIP_PAGE_CONTENT.read().closedApprovals'), 'hidden card does not close approval')
        page.evaluate("document.querySelector('#request').hidden=false; document.querySelectorAll('#request button').forEach(b=>b.disabled=true)")
        check(not page.evaluate('CIP_PAGE_CONTENT.read().closedApprovals'), 'disabled buttons alone do not prove processing or Deny')
        snapshot = load(approval_page)
        page.evaluate("document.querySelector('main').innerHTML='<h1>Whole-page error</h1>'")
        check(not page.evaluate('CIP_PAGE_CONTENT.read().closedApprovals'), 'whole-page error and missing card are not closure evidence')
        snapshot = load(approval_page)
        page.evaluate("document.querySelector('#cards').innerHTML='<p>Temporary renderer error</p>'")
        check(not page.evaluate('CIP_PAGE_CONTENT.read().closedApprovals'), 'replacement render cannot close missing card')
        snapshot = load(approval_page)
        page.evaluate("document.querySelector('#cards').remove()")
        check(not page.evaluate('CIP_PAGE_CONTENT.read().closedApprovals'), 'removed ancestor is not an explicit card-removal event')
        snapshot = load('<main><details open><summary>Work</summary>' + approval_page.split('<main>')[1].split('</main>')[0] + '</details></main>')
        page.evaluate("document.querySelector('details').open=false; document.querySelector('#request').remove()")
        check(not page.evaluate('CIP_PAGE_CONTENT.read().closedApprovals'), 'lazy unmount on Work collapse does not close the request')
        snapshot = load(approval_page)
        page.evaluate("history.replaceState({},'', '/c/another-conversation'); document.querySelector('#request').remove()")
        check(not page.evaluate('CIP_PAGE_CONTENT.read().closedApprovals'), 'navigation does not close previous-conversation approval')
        page.evaluate("history.replaceState({},'', '/c/fixture-conversation')")
        snapshot = load('<main><div data-message-author-role="assistant" data-message-id="whitespace"><p><span>Hello</span> <b>world</b></p><pre>line 1\n  line 2</pre></div></main>')
        check(native(snapshot, 'whitespace')['text'] == 'Hello world\nline 1\n  line 2', 'inline separating spaces and code indentation retained')
    finally:
        context.close()
        browser.close()

print(json.dumps({'passed':len(checks), 'checks':checks,
                  'scope':'isolated offline Chromium; DOM-only synthetic Work plus captured approvals; not live layout acceptance'}, ensure_ascii=False, indent=2))
