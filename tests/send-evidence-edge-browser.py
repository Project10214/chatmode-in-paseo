"""Probe gaps in alpha.3.11 native request receipt (isolated real Chrome; no account)."""
import os,json
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]
MAIN=(R/'extension/upstream/cos-send-evidence.js').read_text()
ISOLATED=(R/'extension/upstream/cos-request-receipt.js').read_text()
HTML='<html><body>fixture</body></html>'
CID='12345678-1234-4234-8234-123456789abc'
with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True,executable_path=os.environ.get('CIP_CHROMIUM','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
 p=b.new_page();p.route('https://chatgpt.com/**',lambda route:route.fulfill(status=200,content_type='text/html',body=HTML))
 p.goto('https://chatgpt.com/')
 p.evaluate("""()=>{window.fetch=async (url,opts)=>{const r=new Response('data: [DONE]\\n\\n',{status:200,headers:{'Content-Type':'text/event-stream'}});Object.defineProperty(r,'url',{value:typeof url==='string'?new URL(url,location.origin).href:url.url});return r;}}""")
 p.add_script_tag(content=MAIN);p.add_script_tag(content=ISOLATED)
 result=p.evaluate("""async cid=>{
  const obj={messages:[{id:'11111111-1111-4111-8111-111111111111',author:{role:'user'},content:{parts:['hi']}}],conversation_id:null};
  const a=await CIP_COS_SEND_RECEIPT.arm('hi');const t1=Date.now();
  history.replaceState({},'', '/c/'+cid);
  await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify(obj)});
  await new Promise(r=>setTimeout(r,150));const afterRoute=a?.since(t1)?.id??null;a?.close();
  const b=await CIP_COS_SEND_RECEIPT.arm('hi');const t2=Date.now();
  await fetch(new Request('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({...obj,conversation_id:cid})}));
  await new Promise(r=>setTimeout(r,150));const requestObject=b?.since(t2)?.id??null;b?.close();
  const wrong=await CIP_COS_SEND_RECEIPT.arm('hi'),t3=Date.now();
  await fetch(new Request('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({...obj,messages:[{...obj.messages[0],content:{parts:['other message']}}]})}));
  await new Promise(r=>setTimeout(r,120));
  const wrongBody=wrong?.since(t3)?.id??null;wrong?.close();
  history.replaceState({},'', '/c/'+cid);
  const changed=await CIP_COS_SEND_RECEIPT.arm('hi'),t4=Date.now();
  history.replaceState({},'', '/c/22222222-2222-4222-8222-222222222222');
  await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify(obj)});
  await new Promise(r=>setTimeout(r,120));
  const wrongConversation=changed?.since(t4)?.id??null;changed?.close();
  history.replaceState({},'', '/');
  const bouncing=await CIP_COS_SEND_RECEIPT.arm('hi'),t5=Date.now();
  history.replaceState({},'', '/c/'+cid);
  await new Promise(r=>setTimeout(r,0));
  history.replaceState({},'', '/c/33333333-3333-4333-8333-333333333333');
  await new Promise(r=>setTimeout(r,0));
  history.replaceState({},'', '/c/'+cid);
  await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify(obj)});
  await new Promise(r=>setTimeout(r,120));
  const bouncedRoute=bouncing?.since(t5)?.id??null;bouncing?.close();
  history.replaceState({},'', '/');
  const postBeforeRoute=await CIP_COS_SEND_RECEIPT.arm('hi'),t6=Date.now();
  const responsePending=fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify(obj)});
  history.replaceState({},'', '/c/'+cid);
  await responsePending;
  await new Promise(r=>setTimeout(r,120));
  const routeAfterPost=postBeforeRoute?.since(t6)?.id??null;postBeforeRoute?.close();
  return {afterRoute,requestObject,wrongBody,wrongConversation,bouncedRoute,routeAfterPost};
 }""",CID)
 print(json.dumps(result,ensure_ascii=False))
 assert result['afterRoute']=='11111111-1111-4111-8111-111111111111','new-chat route transition loses native POST proof'
 assert result['requestObject']=='11111111-1111-4111-8111-111111111111','Request object POST loses native proof'
 assert result['wrongBody'] is None,'another prompt cannot lend its request ID'
 assert result['wrongConversation'] is None,'an existing chat cannot switch its receipt to another chat'
 assert result['bouncedRoute'] is None,'a temporary route switch cannot be hidden by switching back before fetch'
 assert result['routeAfterPost']=='11111111-1111-4111-8111-111111111111','route transition after POST must still keep this one proof'
 b.close()
