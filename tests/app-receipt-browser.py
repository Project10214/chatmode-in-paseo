"""Offline Chrome regression for one authorized ChatGPT @ app send receipt.
No real ChatGPT account, browser profile, MCP call, or user prompt is used.
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / 'extension/upstream/cos-send-evidence.js').read_text()
ISOLATED = (ROOT / 'extension/upstream/cos-request-receipt.js').read_text()
CID = '12345678-1234-4234-8234-123456789abc'
UID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
GOOD = 'asdk_app_fixture'

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        headless=True,
        executable_path=os.environ.get('CIP_CHROMIUM', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
    page = browser.new_page()
    page.route('https://chatgpt.com/**', lambda route: route.fulfill(
        status=200, content_type='text/html', body='<html><body>Fixture only</body></html>'))
    page.goto('https://chatgpt.com/')
    page.evaluate("""()=> {
      window.fetch=async url=>{
        const r=new Response('data: [DONE]\\n\\n',{status:200,headers:{'Content-Type':'text/event-stream'}});
        Object.defineProperty(r,'url',{value:new URL(typeof url==='string'?url:url.url,location.origin).href});
        return r;
      };
    }""")
    page.add_script_tag(content=MAIN)
    page.add_script_tag(content=ISOLATED)
    cases = [
        ('canonical app markdown', 'hi [$mac](app://'+GOOD+')', 'hi', True),
        ('native underscore label', 'hi [$asdk_app_fixture](app://'+GOOD+')', 'hi', True),
        ('native nonlatin label', 'hi [$开发主机](app://'+GOOD+')', 'hi', True),
        ('native escaped markdown', 'hi \\[value\\] [$mac](app://'+GOOD+')', 'hi [value]', True),
        ('other unselected app', 'hi [$other](app://asdk_app_other)', 'hi', False),
        ('wrong prose', 'other [$mac](app://'+GOOD+')', 'hi', False),
        ('selected app omitted from real POST', 'hi', 'hi', False),
    ]
    checks=[]
    for label, body, expected_text, want in cases:
        result=page.evaluate("""async ({body,cid,uid,app,expectedText})=>{
          history.replaceState({},'', '/');
          const probe=await CIP_COS_SEND_RECEIPT.arm(expectedText, [app]);
          if(!probe)return {armed:false};
          const clicked=Date.now();
          history.replaceState({},'', '/c/'+cid);
          await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({
            messages:[{id:uid,author:{role:'user'},content:{parts:[body]}}]})});
          await new Promise(r=>setTimeout(r,110));
          const observed=probe.since(clicked)?.id||null;
          probe.close();
          return {armed:true,received:observed===uid,stage:probe.status().stage};
        }""", {'body':body,'cid':CID,'uid':UID,'app':GOOD,'expectedText':expected_text})
        checks.append((label,result))
        if result['received']!=want: print('FAIL',label,result)
    rich=page.evaluate("""async ({cid,uid,app})=>{
      history.replaceState({},'', '/');
      const probe=await CIP_COS_SEND_RECEIPT.arm('hi',[app]),clicked=Date.now();
      history.replaceState({},'', '/c/'+cid);
      await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({
        messages:[{id:uid,author:{role:'user'},content:{
          content_type:'text',parts:['hi',{type:'app_mention',app_id:app}]}}]})});
      await new Promise(r=>setTimeout(r,100));
      const observed=probe?.since(clicked)?.id||null;
      probe?.close();return observed===uid;
    }""",{'cid':CID,'uid':UID,'app':GOOD})
    checks.append(('structured app part', {'received':rich}))
    extra_cases = [
        ('unselected structured app', [{'type':'app_mention','app_id':'asdk_app_wrong'},'hi'], False),
        ('unknown rich object', [{'type':'file','app_id':GOOD},'hi'], False),
        ('split typed text and app', [{'type':'text','text':'h'},{'type':'text','text':'i'},
                                      {'type':'app_mention','app_id':GOOD}], True),
    ]
    for label, parts, want in extra_cases:
        value=page.evaluate("""async ({cid,uid,app,parts})=>{
          history.replaceState({},'', '/');
          const proof=await CIP_COS_SEND_RECEIPT.arm('hi',[app]),clicked=Date.now();
          history.replaceState({},'', '/c/'+cid);
          await fetch(new Request('/backend-api/f/conversation',{method:'POST',
            body:JSON.stringify({messages:[{id:uid,author:{role:'user'},content:{parts}}]})}));
          await new Promise(r=>setTimeout(r,110));
          const received=proof?.since(clicked)?.id===uid,stage=proof?.status().stage;
          proof?.close();return {received,stage};
        }""",{'cid':CID,'uid':UID,'app':GOOD,'parts':parts})
        checks.append((label,value))
        if value['received']!=want: print('FAIL',label,value)
    # Selecting no apps remains a normal text-only ChatGPT message.
    no_app=page.evaluate("""async ({cid,uid})=>{
      history.replaceState({},'', '/');
      const proof=await CIP_COS_SEND_RECEIPT.arm('hi',[]),clicked=Date.now();
      history.replaceState({},'', '/c/'+cid);
      await fetch('/backend-api/f/conversation',{method:'POST',
        body:JSON.stringify({messages:[{id:uid,author:{role:'user'},content:{parts:['hi']}}]})});
      await new Promise(r=>setTimeout(r,110));
      const received=proof?.since(clicked)?.id===uid;
      proof?.close();return received;
    }""",{'cid':CID,'uid':UID})
    checks.append(('no selected app plain text',{'received':no_app}))
    browser.close()
    expected={'canonical app markdown':True,'native underscore label':True,
              'native nonlatin label':True,'native escaped markdown':True,
              'other unselected app':False,'wrong prose':False,'selected app omitted from real POST':False,
               'no selected app plain text':True,'structured app part':True,
              'unselected structured app':False,'unknown rich object':False,'split typed text and app':True}
    fails=[name for name, result in checks if result['received']!=expected[name]]
    print(json.dumps({'passed':len(checks)-len(fails),'total':len(checks),'failures':fails,'scope':'offline Chrome fixture only'},ensure_ascii=False))
    assert not fails, f'app receipt regressions failed: {fails}'
