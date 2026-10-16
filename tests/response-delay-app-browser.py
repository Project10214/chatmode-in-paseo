"""Regression: a verified @ app POST may wait for ChatGPT SSE headers.
All URLs are intercepted inside an isolated Chrome fixture. No real send.
"""
import os,json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path=os.environ.get(
        'CIP_CHROMIUM','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
    page=browser.new_page()
    page.route('https://chatgpt.com/**',lambda route:route.fulfill(
        status=200,content_type='text/html',body='<html><body>isolated test</body></html>'))
    page.goto('https://chatgpt.com/')
    page.evaluate("""()=>{ window.fetch=()=>new Promise(resolve=>{window.resolveNativeRequest=resolve;}); }""")
    page.add_script_tag(content=(ROOT/'extension/upstream/cos-send-evidence.js').read_text())
    page.add_script_tag(content=(ROOT/'extension/upstream/cos-request-receipt.js').read_text())
    outcome=page.evaluate("""async()=>{
       const originalNow=Date.now;let simulated=originalNow();
       Date.now=()=>simulated;
       const id='11111111-1111-4111-8111-111111111111';
       const cid='12345678-1234-4234-8234-123456789abc';
       const app='asdk_app_fixture';
       const message={messages:[{id,author:{role:'user'},content:{parts:['hello [$开发主机](app://'+app+')']}}]};
       const makeResponse=()=>{
         const response=new Response('data: [DONE]\\n\\n',{status:200,headers:{'content-type':'text/event-stream'}});
         Object.defineProperty(response,'url',{value:'https://chatgpt.com/backend-api/f/conversation'});
         return response;
       };
       try{
         const proof=await CIP_COS_SEND_RECEIPT.arm('hello',[app]);
         if(!proof)return {error:'not-armed'};
         const clickedAt=Date.now();
         history.replaceState({},'', '/c/'+cid);
         const outgoing=fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify(message)});
         await new Promise(resolve=>setTimeout(resolve,130));
         const pendingStage=proof.status().stage;
         simulated+=14000;window.resolveNativeRequest(makeResponse());
         await outgoing;await new Promise(resolve=>setTimeout(resolve,130));
         const lateReceipt=proof.since(clickedAt)?.id===id;
         const finalStage=proof.status().stage;
         proof.close();
         return {pendingStage,lateReceipt,finalStage};
       }finally{Date.now=originalNow;}
    }""")
    print(json.dumps(outcome))
    assert outcome['pendingStage']=='body','request body should be authenticated without waiting for delayed HTTP response'
    assert outcome['lateReceipt'] is True,'server-accepted SSE after 14 seconds must remain provable'
    assert outcome['finalStage']=='accepted'
    browser.close()
