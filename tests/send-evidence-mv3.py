"""Actual unpacked MV3 Chrome -> accepted native POST proof -> Runtime/Provider.
All chatgpt.com HTTPS served by the local TLS fixture. Never send a real message.
"""
from pathlib import Path
import os
R=Path(__file__).resolve().parents[1]
with_app=os.environ.get('CIP_FIXTURE_WITH_APP')=='1'
delay_sse=os.environ.get('CIP_FIXTURE_DELAY_SSE')=='1'
base=R/'tests/binding-mv3-flow.py'
source=base.read_text()
UID='11111111-1111-4111-8111-111111111111'
old="  section.append(user,answer);document.querySelector('main').append(section);"
new="""  if(entry.number===1&&entry.layout.startsWith('fallback-turn-'))section.append(answer);
  else section.append(user,answer);
  document.querySelector('main').append(section);"""
assert source.count(old)==1;source=source.replace(old,new)
old=" const text=plain();box.replaceChildren();fixtureState.clicks++;"
new="""  const text=plain(),app=box.querySelector('[app-mention-path]')?.getAttribute('app-mention-path')||'';
  box.replaceChildren();fixtureState.clicks++;
  if(fixtureState.clicks===1)void fetch('/backend-api/f/conversation',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({messages:[{id:'11111111-1111-4111-8111-111111111111',author:{role:'user'},
     content:{parts:[text+(app ? ' [$'+app.slice(6)+']('+app+')' : '')]}}]})});
"""
assert source.count(old)==1;source=source.replace(old,new)
source=source.replace("messageId:'native-user-'+n,serverMessageId:'native-user-'+n,",
 "messageId:n===1?'11111111-1111-4111-8111-111111111111':'native-user-'+n,serverMessageId:n===1?'11111111-1111-4111-8111-111111111111':'native-user-'+n,")
source=source.replace("'native-user-1'",repr(UID))
old="        elif request.request.resource_type=='document':request.fulfill"
new="""        elif '/backend-api/f/conversation' in url and request.request.method=='POST':
            request.fulfill(status=200,content_type='text/event-stream',body='data: [DONE]\\n\\n')
        elif request.request.resource_type=='document':request.fulfill"""
assert source.count(old)==1;source=source.replace(old,new)
old="        prompt('first','FIRST_MV3_BODY')"
new="""        prompt('first','FIRST_MV3_BODY')
        wait(lambda es:(call('read',id=sid).get('turn') or {}).get('nativeMessageId')=='11111111-1111-4111-8111-111111111111',15)
        accepted=call('read',id=sid)
        assert accepted['turn']['receivedAt'] and accepted['turn']['outcome'] is None
        checks.append('a server-accepted, body-matched native request ID proves the first Send without any rendered user bubble')
"""
assert source.count(old)==1;source=source.replace(old,new)
source=source.replace("sent[0]['diagnostic']['bodyMatch']==('markdown' if escape_requests else 'raw')",
                      "sent[0]['diagnostic']['bodyMatch']=='request'")
old="'escapedRequests':escape_requests,"
assert old in source;source=source.replace(old,"'escapedRequests':escape_requests,'requestProofFixture':True,")
if with_app:
    old="'providerOptions':{'appIds':[]}}"
    assert source.count(old)==1
    source=source.replace(old,"'providerOptions':{'appIds':['asdk_app_a']}}")
if delay_sse:
    # The delayed HTTP result allows the native DOM receipt to win later;
    # both strict receipt sources are valid, but URL must bind BEFORE either.
    source=source.replace("sent[0]['diagnostic']['bodyMatch']=='request'",
                          "sent[0]['diagnostic']['bodyMatch'] in ('raw','markdown','request')")
    old="""            request.fulfill(status=200,content_type='text/event-stream',body='data: [DONE]\\n\\n')"""
    assert source.count(old)==1
    source=source.replace(old,"            request.continue_()")
    old="    fixture_server=ThreadingHTTPServer(('127.0.0.1',0),FixtureHandler)"
    assert source.count(old)==1
    source=source.replace(old,"""        def do_POST(self):
            if self.path!='/backend-api/f/conversation':
                self.send_error(404);return
            time.sleep(4)
            body=b'data: [DONE]\\n\\n'
            self.send_response(200);self.send_header('Content-Type','text/event-stream')
            self.send_header('Content-Length',str(len(body)));self.end_headers()
            try:self.wfile.write(body)
            except BrokenPipeError:pass
    fixture_server=ThreadingHTTPServer(('127.0.0.1',0),FixtureHandler)""")
    old="        prompt('first','FIRST_MV3_BODY')"
    assert source.count(old)==1
    source=source.replace(old,"""        prompt('first','FIRST_MV3_BODY')
        bound=wait(lambda es:call('read',id=sid).get('conversationId'),12)
        before_receipt=call('read',id=sid)
        assert bound and not before_receipt['turn'].get('receivedAt'),before_receipt['turn']
        checks.append('ChatGPT conversation URL bound BEFORE delayed SSE delivery receipt')
""")
exec(compile(source,str(base)+'[request-receipt]','exec'),{'__file__':str(base),'__name__':'__main__'})
