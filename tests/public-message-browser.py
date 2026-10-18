"""Offline Chromium/CDP two-world test of the production raw supplement.

Every React graph here is an explicitly SYNTHETIC committed-model fixture, not
captured ChatGPT evidence. Fresh non-persistent Chromium, intercepted navigation,
no real account/session, external network, clicks, clipboard or authorization.
Run with CIP_PYTHON / CIP_CHROMIUM from the project's validation environment.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / 'extension/public-message-main.js').read_text()
ADAPTER = (ROOT / 'extension/public-message-adapter.js').read_text()
COLLECTOR = (ROOT / 'extension/page-content.js').read_text()
CONTROLS = (ROOT / 'extension/page-controls.js').read_text()
CID = 'public-fixture'
LINK = 'https://chatgpt.com/c/' + CID
checks = []


def check(condition, name):
    assert condition, name
    checks.append(name)


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ['CIP_CHROMIUM'], headless=True)
    context = browser.new_context(service_workers='block')
    requests = []

    def route(request):
        requests.append(request.request.url)
        if request.request.url == LINK:
            request.fulfill(status=200, content_type='text/html', body='<!doctype html><main></main>')
        else:
            request.abort()

    context.route('**/*', route)
    page = context.new_page()
    try:
        page.goto(LINK)
        page.evaluate(r'''() => {
          window.fixture = {cid:'public-fixture', refs:new Map(), actions:{click:0,input:0,submit:0,network:0,private:0},
            holds:false, held:[], asks:[], replies:[]};
          for(const type of ['click','input','submit']) document.addEventListener(type,event=>{
            fixture.actions[type]++;event.preventDefault();},true);
          window.fetch=()=>{fixture.actions.network++;throw Error('NO_NETWORK');};
          XMLHttpRequest.prototype.open=function(){fixture.actions.network++;throw Error('NO_NETWORK');};
          navigator.sendBeacon=()=>{fixture.actions.network++;throw Error('NO_NETWORK');};
          window.WebSocket=function(){fixture.actions.network++;throw Error('NO_NETWORK');};
          window.EventSource=function(){fixture.actions.network++;throw Error('NO_NETWORK');};
          const nativePost=window.postMessage.bind(window);
          window.postMessage=(data,origin)=>{
            if(data?.source==='cip-public-message-reply'&&fixture.holds){fixture.held.push({data,origin});return;}
            return nativePost(data,origin);
          };
          fixture.release=()=>{for(const {data,origin}of fixture.held.splice(0))nativePost(data,origin);};
          window.addEventListener('message',event=>{
            if(event.data?.source==='cip-public-message-read')fixture.asks.push(event.data);
            if(event.data?.source==='cip-public-message-reply')fixture.replies.push(event.data);
          });
          fixture.poison=(object,keys)=>{for(const key of keys)Object.defineProperty(object,key,{configurable:true,
            get(){fixture.actions.private++;throw Error('PRIVATE_FIELD_'+key);}});return object;};
          fixture.model=(id,text,extra={})=>fixture.poison({type:'assistant-message',messageId:id,phase:'final_answer',
            recipient:'all',content:text,...extra},['completed','status','isTransient','activeReasoning','analysis','raw_cot','invocation','arguments','response']);
          fixture.attach=(node,props,{stale=false,uncommitted=false}={})=>{
            const state={},root={tag:3,stateNode:state,memoizedProps:null,return:null};state.current=root;
            const owner={tag:0,memoizedProps:props,return:root,sibling:null};
            const host={tag:5,memoizedProps:{},return:owner,sibling:null};root.child=owner;owner.child=host;
            for(const f of [root,owner,host])fixture.poison(f,['memoizedState','updateQueue']);
            if(stale){
              const oldRoot={tag:3,stateNode:state,alternate:root,return:null};root.alternate=oldRoot;
              const oldOwner={tag:0,memoizedProps:fixture.poison({},['item','message']),return:oldRoot,alternate:owner};owner.alternate=oldOwner;
              const oldHost={tag:5,memoizedProps:{},return:oldOwner,alternate:host};host.alternate=oldHost;
              oldRoot.child=oldOwner;oldOwner.child=oldHost;node.__reactFiber$fixture=oldHost;
            }else node.__reactFiber$fixture=uncommitted?{memoizedProps:props,return:null}:host;
            return {root,owner,host,state};
          };
          fixture.mount=(id,text,options={})=>{
            const node=document.createElement('div');node.dataset.messageId=id;node.dataset.messageAuthorRole='assistant';
            node.textContent=options.domText??text;document.querySelector('main').append(node);
            const model=options.model??fixture.model(id,text);
            const props=options.props??{conversationId:fixture.cid,item:model};
            const proof=fixture.attach(node,props,options);
            const result={node,model,props,...proof};fixture.refs.set(options.key??id,result);return result;
          };
          // Poison unapproved global/cache paths. The supplement must never
          // enumerate global state, hook state, query caches or turn.messages.
          fixture.poison(window,['__PRIVATE_CACHE__']);
        }''')
        page.add_script_tag(content=MAIN)
        cdp = context.new_cdp_session(page)
        frame_id = cdp.send('Page.getFrameTree')['frameTree']['frame']['id']
        isolated = cdp.send('Page.createIsolatedWorld', {'frameId': frame_id, 'worldName': 'cip-public-raw-test'})['executionContextId']

        def iso(expression, await_promise=True):
            value = cdp.send('Runtime.evaluate', {'expression': expression, 'contextId': isolated,
                                                 'awaitPromise': await_promise, 'returnByValue': True})
            assert 'exceptionDetails' not in value, value.get('exceptionDetails')
            return value['result'].get('value')

        iso(ADAPTER)
        iso(COLLECTOR)
        iso(CONTROLS)
        check(page.evaluate('typeof CIP_PUBLIC_MESSAGES') == 'undefined' and iso('typeof CIP_PUBLIC_MESSAGES.read') == 'function',
              'real separate MAIN and ISOLATED execution worlds; no shared React expandos')

        def source(message_id, **extra):
            return dict(id='source:' + message_id, nativeMessageId=message_id, role='assistant', lane='output', kind='message', text='DOM original', **extra)

        def read_ids(*ids):
            return iso('CIP_PUBLIC_MESSAGES.read(' + json.dumps([source(i) for i in ids]) + ')')

        def one(result, message_id):
            matches = [record for record in result['messages'] if record['nativeMessageId'] == message_id]
            assert len(matches) == 1, (message_id, result)
            return matches[0]

        page.evaluate("fixture.mount('closing', '**bold', {domText:'**bold'})")
        before = iso('(async()=>{const source=CIP_PAGE_CONTENT.read();return {source,raw:await CIP_PUBLIC_MESSAGES.read(source.items)};})()')
        page.evaluate("""() => {const f=fixture.refs.get('closing');f.model.content='**bold**';f.node.innerHTML='<strong>bold</strong>';}""")
        after = iso('(async()=>{const source=CIP_PAGE_CONTENT.read();return {source,raw:await CIP_PUBLIC_MESSAGES.read(source.items)};})()')
        dom_before = next(i['text'] for i in before['source']['items'] if i.get('nativeMessageId') == 'closing')
        dom_after = next(i['text'] for i in after['source']['items'] if i.get('nativeMessageId') == 'closing')
        raw_before = one(before['raw'], 'closing')['rawText']
        raw_after = one(after['raw'], 'closing')['rawText']
        check(not dom_after.startswith(dom_before) and raw_after.startswith(raw_before),
              'closing Markdown produces a DOM non-prefix revision while exact committed raw remains a prefix')
        check(raw_before == '**bold' and raw_after == '**bold**' and dom_after == 'bold', 'raw is neither DOM text mislabeled Markdown nor reconstructed markup')
        check(set(one(after['raw'], 'closing')) == {'nativeMessageId', 'rawText', 'representation', 'observedAt'}, 'only narrow public representation fields cross worlds')

        page.evaluate("""() => {const work=document.createElement('details');work.open=true;
          work.innerHTML='<summary>Work</summary><div data-message-id="progress" data-message-author-role="assistant">公开过程</div>';
          document.querySelector('main').append(work);fixture.attach(work.lastElementChild,{conversationId:fixture.cid,
            turn:{items:[fixture.model('progress','PUBLIC_PROGRESS',{phase:'commentary'})]}});} """)
        work = iso('(async()=>{const source=CIP_PAGE_CONTENT.read();return {source,raw:await CIP_PUBLIC_MESSAGES.read(source.items)};})()')
        check(one(work['raw'], 'closing')['rawText'] == raw_after and not any(m['nativeMessageId'] == 'progress' for m in work['raw']['messages']), 'Work expansion adds process but never changes external final raw')
        check(page.evaluate("fixture.asks.at(-1).nativeMessageIds.includes('progress')") is False, 'adapter requests only collector-confirmed assistant/output/message IDs')
        page.evaluate("document.querySelector('details').open=false")
        check(one(read_ids('closing'), 'closing')['rawText'] == raw_after, 'folding Work leaves raw source unchanged without any disclosure click')
        page.evaluate("""() => {
          const button=document.createElement('button');button.textContent='Work';button.setAttribute('aria-controls','aria-work');
          const panel=document.createElement('section');panel.id='aria-work';document.querySelector('main').append(button,panel);
          const copy=fixture.mount('closing','derived Work copy',{key:'aria-copy',model:fixture.poison(
            {type:'assistant-message',messageId:'closing',phase:'final_answer'},['content'])});panel.append(copy.node);
        }""")
        check(one(read_ids('closing'), 'closing')['rawText'] == raw_after, 'visible aria-controlled Work copies cannot poison or replace an external final raw candidate')
        page.evaluate("document.querySelector('#aria-work').hidden=true")
        check(one(read_ids('closing'), 'closing')['rawText'] == raw_after, 'closing an aria-controlled Work panel also leaves final raw unchanged')

        page.evaluate("""() => {
          const model=fixture.model('dil','::chatgpt-content-reference{reference_id="r"}');
          model.contentReferences=[fixture.poison({type:'file',source_message_id:'dil'},['model_dil_v2']),
            fixture.poison({type:'dil',source_message_id:'somebody-else'},['model_dil_v2']),
            {type:'dil',source_message_id:'dil',model_dil_v2:{fallbackMarkdown:'  <dil>原始 fallback **Markdown**</dil>\\n  '}}];
          fixture.mount('dil','rendered DIL',{model});
        }""")
        dil = one(read_ids('dil'), 'dil')
        check(dil['representation'] == 'dil' and dil['rawText'] == '  <dil>原始 fallback **Markdown**</dil>\n  ', 'only the exact unique DIL fallback is returned unchanged, without decoding')
        page.evaluate("fixture.refs.get('dil').model.contentReferences.push({type:'dil',source_message_id:'dil',model_dil_v2:{fallbackMarkdown:'duplicate'}})")
        result = read_ids('dil', 'closing')
        check(not any(m['nativeMessageId'] == 'dil' for m in result['messages']) and any(i['code'] == 'PUBLIC_MESSAGE_DIL_CONFLICT' for i in result['issues'])
              and one(result, 'closing')['rawText'] == raw_after, 'duplicate DIL is a per-item refusal, not a whole-batch failure')

        page.evaluate("""() => {
          fixture.mount('legacy','legacy',{model:{id:'legacy',author:{role:'assistant'},recipient:'all',channel:'final',
            content:{content_type:'text',parts:['  # Original\\n**markdown**  ']}}});
          fixture.mount('multipart','multipart',{model:{id:'multipart',author:{role:'assistant'},content:{content_type:'text',parts:['a','b']}}});
          fixture.mount('entry','entry',{props:{entry:{conversationId:fixture.cid,turn:{items:[fixture.model('entry','entry raw')]}}}});
          fixture.mount('turn','turn',{props:{conversationId:fixture.cid,turn:fixture.poison({items:[
            fixture.poison({type:'chatgpt-reasoning-group'},['items','activeReasoning','content']),
            fixture.poison({type:'mcp-tool-call',callId:'private-tool'},['invocation','arguments','response']),
            fixture.model('turn','top-level raw')]},['messages','status'])}});
          fixture.mount('message','message',{props:{conversationId:fixture.cid,message:fixture.model('message','own message raw')}});
        }""")
        result = read_ids('legacy', 'multipart', 'entry', 'turn', 'message')
        check(one(result, 'legacy')['rawText'] == '  # Original\n**markdown**  ', 'traditional public assistant single string part is preserved byte-for-byte')
        check(not any(m['nativeMessageId'] == 'multipart' for m in result['messages']) and any(i['code'] == 'PUBLIC_MESSAGE_MULTIPART_UNSUPPORTED' for i in result['issues']), 'multipart boundaries are not guessed or joined into invented raw')
        check([one(result, i)['rawText'] for i in ['entry', 'turn', 'message']] == ['entry raw', 'top-level raw', 'own message raw'], 'only own message/item and top-level turn.items/entry.turn.items are read')

        page.evaluate("""() => {
          fixture.mount('dedup','raw dedup');const node=fixture.refs.get('dedup').node;
          node.removeAttribute('data-message-id');node.dataset.chatgptSearchMessageIds='["dedup","dedup"]';
          fixture.mount('ambiguous','must not read');fixture.refs.get('ambiguous').node.dataset.chatgptSearchMessageIds='["ambiguous","other"]';
          fixture.mount('exact','exact raw');fixture.mount('exact-long','wrong prefix raw');
          fixture.mount('no-scope','UNPROVEN',{props:{item:fixture.model('no-scope','UNPROVEN')}});
          fixture.mount('wrong-scope','FOREIGN',{props:{conversationId:'other-conversation',item:fixture.poison(
            {type:'assistant-message',messageId:'wrong-scope',phase:'final_answer'},['content'])}});
          fixture.mount('uncommitted','NO COMMIT',{uncommitted:true});
          fixture.mount('alternate','COMMITTED RAW',{stale:true});
        }""")
        result = read_ids('dedup', 'ambiguous', 'exact', 'no-scope', 'wrong-scope', 'uncommitted', 'alternate')
        check(one(result, 'dedup')['rawText'] == 'raw dedup', 'repeated search-message-ids deduplicate before native identity matching')
        check(not any(m['nativeMessageId'] == 'ambiguous' for m in result['messages']), 'multiple different DOM native IDs are not guessed')
        check(one(result, 'exact')['rawText'] == 'exact raw', 'native ID matching is exact, not prefix/content similarity')
        check(not any(m['nativeMessageId'] in ['no-scope', 'wrong-scope', 'uncommitted'] for m in result['messages']), 'missing/conflicting model conversation or absent HostRoot.current is explicitly refused')
        check(one(result, 'alternate')['rawText'] == 'COMMITTED RAW', 'a stale host Fiber alternate resolves via actual root.current without reading stale props')

        page.evaluate("""() => {
          fixture.mount('conflict','left');fixture.mount('conflict','right',{key:'conflict-copy'});
          fixture.mount('identical','same');fixture.mount('identical','same',{key:'identical-copy'});
          fixture.mount('model-conflict','ignored',{props:{conversationId:fixture.cid,item:fixture.model('model-conflict','own'),
            turn:{items:[fixture.model('model-conflict','different top-level')]}}});
          fixture.mount('one-bad','visible DOM',{model:fixture.poison({type:'assistant-message',messageId:'one-bad',phase:'final_answer'},['content'])});
          fixture.mount('cycle','cycle');const c=fixture.refs.get('cycle').node.__reactFiber$fixture;c.return=c;
        }""")
        result = read_ids('conflict', 'identical', 'model-conflict', 'one-bad', 'cycle', 'closing')
        check(not any(m['nativeMessageId'] in ['conflict', 'model-conflict'] for m in result['messages'])
              and any(i['code'] == 'PUBLIC_MESSAGE_CANDIDATE_CONFLICT' for i in result['issues']), 'different public candidates conflict; longest/latest/first is never guessed')
        check(one(result, 'identical')['rawText'] == 'same', 'identical visible aliases yield one raw source')
        check(not any(m['nativeMessageId'] in ['one-bad', 'cycle'] for m in result['messages']) and one(result, 'closing')['rawText'] == raw_after, 'an inaccessible field or Fiber cycle is isolated from other requested sources')

        page.evaluate("""() => {
          for(const [id,extra]of [['analysis-case',{channel:'analysis'}],['private-case',{visibility:'private'}],
            ['hidden-model',{metadata:{is_visually_hidden_from_conversation:true}}],['raw-cot',{metadata:{summary_type:'raw_cot'}}],
            ['tool-recipient',{recipient:'some_tool'}],['not-assistant',{type:'message',role:'user'}]]){
            const model={type:'assistant-message',messageId:id,id,phase:'final_answer',...extra};
            fixture.poison(model,['content','activeReasoning','raw_cot','invocation']);fixture.mount(id,'visible but not public model',{model});
          }
          fixture.mount('hidden-dom','HIDDEN RAW');const h=fixture.refs.get('hidden-dom').node;h.hidden=true;
          delete h.__reactFiber$fixture;Object.defineProperty(h,'__reactFiber$private',{get(){fixture.actions.private++;throw Error('HIDDEN FIBER');}});
          fixture.mount('foreign-dom','OTHER PAGE');fixture.refs.get('foreign-dom').node.dataset.conversationId='other-conversation';
          fixture.mount('all-messages','not scanned',{props:fixture.poison({conversationId:fixture.cid},['allMessages','client'])});
        }""")
        result = read_ids('analysis-case', 'private-case', 'hidden-model', 'raw-cot', 'tool-recipient', 'not-assistant', 'hidden-dom', 'foreign-dom', 'all-messages')
        check(not result['messages'] and len(result['issues']) == 9, 'private/analysis/raw_cot/recipient/role/hidden-page/foreign-page or cache-only sources yield issues, not raw')
        check(page.evaluate('fixture.actions.private') == 0, 'poison getters prove no private body, reasoning, tool payload, hidden Fiber, hook state or cache path is read')

        missing = iso("CIP_PUBLIC_MESSAGES.read([{id:'no-native',role:'assistant',lane:'output',kind:'message',text:'DOM retained'},"
                      "{id:'process',nativeMessageId:'turn',role:'assistant',lane:'process',kind:'message'},"
                      "{id:'user',nativeMessageId:'turn',role:'user',lane:'output',kind:'message'}])")
        check(not missing['messages'] and missing['issues'][0]['code'] == 'PUBLIC_MESSAGE_NATIVE_ID_MISSING', 'missing native ID is explicitly not read; process/user entries are inapplicable')
        unchanged = iso("(async()=>{const items=[{id:'source',nativeMessageId:'closing',role:'assistant',lane:'output',kind:'message',text:'DOM unchanged',format:'text'}];"
                        "const before=JSON.stringify(items);await CIP_PUBLIC_MESSAGES.read(items);return before===JSON.stringify(items);})()")
        check(unchanged, 'adapter never mutates source text/format, classifies content, decodes DIL or publishes a representation')

        for state, buttons in [('running', '<button aria-label="Stop">Stop</button>'), ('standby', '<button aria-label="Start Voice">Voice</button>'), ('abnormal', '')]:
            form = '<form><div id="prompt-textarea" contenteditable="true" role="textbox"></div>' + buttons + '</form>' if buttons else '<p>No composer: public page error</p>'
            page.evaluate("""html=>{document.querySelector('#state')?.remove();const n=document.createElement('section');n.id='state';n.innerHTML=html;document.querySelector('main').append(n);} """, form)
            check(iso('CIP_PAGE_CONTROLS.read().state') == state and one(read_ids('closing'), 'closing')['rawText'] == raw_after,
                  'raw reading has no ' + state + '/composer/authorization/native completion gate')

        page.evaluate("""() => {for(let i=0;i<45;i++)fixture.mount('many-'+i,'uncapped raw '+i);} """)
        many = read_ids(*['many-' + str(i) for i in range(45)])
        check(len(many['messages']) == 45 and not many['issues'], 'more than former 12/32/40 caps are all considered without silent truncation')
        page.evaluate("fixture.mount('long-raw','x'.repeat(300000)+' END')")
        check(one(read_ids('long-raw'), 'long-raw')['rawText'].endswith(' END') and len(one(read_ids('long-raw'), 'long-raw')['rawText']) == 300004,
              'long raw strings are not truncated by a former transcript text cap')

        before_replies = page.evaluate('fixture.replies.length')
        page.evaluate("""() => {const base={source:'cip-public-message-read',v:1,nonce:'nonce-invalid-scope-0001',path:location.pathname,
          conversationId:fixture.cid,nativeMessageIds:['closing']};for(const patch of [{path:'/c/other'},{conversationId:'other'},{nonce:'short'},{v:99}])
          window.postMessage({...base,...patch},location.origin);} """)
        page.wait_for_timeout(50)
        check(page.evaluate('fixture.replies.length') == before_replies, 'MAIN rejects wrong nonce shape, path, exact conversation or protocol version')

        page.evaluate('fixture.holds=true')
        iso('window.pendingRaw=CIP_PUBLIC_MESSAGES.read(' + json.dumps([source('closing')]) + ');"started"', False)
        page.wait_for_function('fixture.held.length>0')
        page.evaluate("""() => {history.pushState(null,'','/c/other');dispatchEvent(new PopStateEvent('popstate'));
          history.pushState(null,'','/c/'+fixture.cid);dispatchEvent(new PopStateEvent('popstate'));fixture.holds=false;fixture.release();} """)
        moved = iso('pendingRaw')
        check(not moved['messages'] and any(i['code'] == 'PUBLIC_MESSAGE_GUARD_REJECTED' for i in moved['issues']), 'A -> B -> A during reply delivery cannot revive a stale raw supplement')
        guarded = iso('CIP_PUBLIC_MESSAGES.read(' + json.dumps([source('closing')]) + ',()=>{throw Error("revoked");})')
        check(not guarded['messages'] and guarded['issues'][0]['code'] == 'PUBLIC_MESSAGE_GUARD_REJECTED', 'caller observation guard can revoke a read without breaking DOM collection')

        page.evaluate("""() => {
          const bad=fixture.poison({type:'assistant-message',messageId:'shared-bad',phase:'final_answer'},['content']);
          const turn={items:[bad,fixture.model('shared-good','shared success')]};
          for(const id of ['shared-bad','shared-good'])fixture.mount(id,'DOM stays available',{props:{conversationId:fixture.cid,turn}});
          const model=fixture.model('unresolved-dil','::chatgpt-content-reference{reference_id="missing"}');
          model.contentReferences=[fixture.poison({type:'dil',source_message_id:'different-id'},['model_dil_v2'])];
          fixture.mount('unresolved-dil','DOM fallback still visible',{model});
        }""")
        shared = read_ids('shared-bad', 'shared-good', 'unresolved-dil')
        check(one(shared, 'shared-good')['rawText'] == 'shared success' and len(shared['messages']) == 1,
              'one bad source in a shared turn does not block other IDs; a foreign DIL fallback is never borrowed')
        page.evaluate('fixture.holds=true')
        timeout = iso('(async()=>{const raw=await CIP_PUBLIC_MESSAGES.read(' + json.dumps([source('closing')]) + ');'
                      'return {raw,source:CIP_PAGE_CONTENT.read(),page:CIP_PAGE_CONTROLS.read()};})()')
        check(not timeout['raw']['messages'] and timeout['raw']['issues'][0]['code'] == 'PUBLIC_MESSAGE_SUPPLEMENT_UNAVAILABLE'
              and any(row.get('nativeMessageId') == 'closing' for row in timeout['source']['items'])
              and timeout['page']['state'] == 'abnormal', 'supplement timeout is an issue, not a failure of DOM text or button observation')
        page.evaluate('fixture.holds=false;fixture.release()')
        check(not iso('CIP_PUBLIC_MESSAGES.read(null)')['messages'], 'invalid caller batch is a safe issue result rather than an exception')
        counters = page.evaluate('fixture.actions')
        check(all(value == 0 for value in counters.values()), 'zero clicks, inputs, submits, networking, private getter execution or authorization during supplementation')
        check(all(url == LINK for url in requests), 'fresh isolated browser never contacts external sites, real sessions or hidden cached pages')
        print(json.dumps({'passed': len(checks), 'worlds': ['MAIN', 'ISOLATED'], 'synthetic_models': True,
                          'actions': counters, 'cases': checks}, ensure_ascii=False))
    finally:
        context.close()
        browser.close()
