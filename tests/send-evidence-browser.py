"""CoS native POST request-ID proof: scoped, body-bound, response-accepted only.
Real Chromium; all requests are mocked locally; no logged-in account Send.
"""
import json,os
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]
s_main=(R/'extension/upstream/cos-send-evidence.js').read_text()
s_isolated=(R/'extension/upstream/cos-request-receipt.js').read_text()
HTML="<html><body><main id='test'></main></body></html>"
checks=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('CIP_CHROMIUM','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
 page=browser.new_page()
 page.route('https://chatgpt.com/**',lambda route:route.fulfill(status=200,content_type='text/html',body=HTML))
 page.goto('https://chatgpt.com/')
 page.evaluate("""()=>{
  window.fetch=async (url,opts={})=>{
    const response=new Response('data: [DONE]\\n\\n',{status:window.auditHttpStatus||200,headers:{'Content-Type':window.auditContentType||'text/event-stream'}});
    Object.defineProperty(response,'url',{value:window.auditResponseURL||new URL(url,location.origin).href});
    return response;
  };
 }""")
 page.add_script_tag(content=s_main)
 page.add_script_tag(content=s_isolated)
 async_ok=page.evaluate("""async()=>{
  const real='12345678-1234-4234-8234-123456789abc',expected='Please answer with a photograph.';
  const receipt=await CIP_COS_SEND_RECEIPT.arm(expected);
  if(!receipt)return {armed:false};
  const at=Date.now();
  await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:real,author:{role:'user'},content:{parts:[expected]}}]})});
  await new Promise(r=>setTimeout(r,150));
  const proof=receipt.since(at);receipt.close();
  return {armed:true,id:proof?.id||null,previous:receipt.since(at)};
 }""")
 assert async_ok['armed'] and async_ok['id']=='12345678-1234-4234-8234-123456789abc' and async_ok['previous'] is None,async_ok
 checks.append('one armed, HTTP 2xx SSE, matching original authored body confirms one native UUID')
 def attempt(body,status=200,content_type='text/event-stream',url=None):
  return page.evaluate("""async a=>{
    window.auditHttpStatus=a.status;window.auditContentType=a.contentType;window.auditResponseURL=a.responseURL||null;
    const receipt=await CIP_COS_SEND_RECEIPT.arm('Exact future question');
    if(!receipt)return {armed:false};
    const at=Date.now();
    await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',author:{role:'user'},content:{parts:[a.body]}}]})});
    await new Promise(r=>setTimeout(r,125));
    const proof=receipt.since(at);receipt.close();
    return {armed:true,proof:proof?.id||null};
  }""",{'body':body,'status':status,'contentType':content_type,'responseURL':url})
 assert attempt('Wrong question')['proof'] is None
 checks.append('unrelated page-initiated POST cannot lend identity to the attempted click')
 extra=page.evaluate("""async()=>{
  const receipt=await CIP_COS_SEND_RECEIPT.arm('Exact future question');
  const at=Date.now();
  await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[
    {id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',author:{role:'user'},content:{parts:['Exact future question']}},
    {id:'bad-message',author:{role:'user'},content:{parts:['other user']}}
  ]})});
  await new Promise(r=>setTimeout(r,130));
  const id=receipt?.since(at)?.id||null;receipt?.close();return id;
 }""")
 assert extra is None
 checks.append('a mixed valid and invalid two-user Send cannot borrow one matching UUID')
 assert attempt('Exact future question',403)['proof'] is None
 checks.append('HTTP 403 rejects native request receipt even with exact text')
 assert attempt('Exact future question',200,'application/json')['proof'] is None
 checks.append('unrecognized JSON response cannot masquerade as successful SSE Send')
 assert attempt('Exact future question',200,'text/event-stream','https://evil.example/backend-api/f/conversation')['proof'] is None
 checks.append('wrong response origin never produces a receipt')
 page.evaluate("window.auditHttpStatus=200;window.auditContentType='text/event-stream';window.auditResponseURL=null")
 async_unarmed=page.evaluate("""async()=>{
  await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',author:{role:'user'},content:{parts:['unarmed']}}]})});
  return window.__CIP_COS_SEND_EVIDENCE_V1__?.version===1;
 }""")
 assert async_unarmed
 checks.append('unarmed Send is observed only as normal fetch, never as a foreign proof')
 page.evaluate("""()=>{history.replaceState({},'', '/c/11111111-1111-4111-8111-111111111111');}""")
 assert attempt('Exact future question')['proof']=='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
 checks.append('reused exact conversation route supports a verified new ID')
 browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'real Chrome execution; local response fixtures, no user Send'},ensure_ascii=False,indent=2))
