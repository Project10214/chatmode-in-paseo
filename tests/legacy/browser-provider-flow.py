"""Real Node Provider/Broker/HTTP + real Chromium DOM/content script, synthetic Chrome driver.
No live website navigation, real Paseo installation, account, model or MCP is used.
Python substitutes the extension's Chrome tab API only; production background scheduling is
covered separately in adversarial.test.mjs. This is NOT a real MV3 installation test.
"""
import json, os, queue, subprocess, tempfile, threading, time, urllib.request, urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
R = Path(__file__).resolve().parents[1]
HTML = (R/'tests/fixtures/chatgpt.html').read_text()
ADAPTER = (R/'extension/dom-adapter.js').read_text()
CONTENT = (R/'extension/content.js').read_text()
checks=[]
with tempfile.TemporaryDirectory(prefix='cip-flow-') as tmp, sync_playwright() as pw:
 process=subprocess.Popen(['node',str(R/'tests/browser-harness.mjs'),tmp,'0'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 first=json.loads(process.stdout.readline()); address=first['address']; replies=queue.Queue(); stash={}; counter=0
 def reader():
  for line in process.stdout:
   replies.put(json.loads(line))
 thread=threading.Thread(target=reader,daemon=True);thread.start()
 def call(action,**kwargs):
  global counter
  counter+=1; rid=counter
  process.stdin.write(json.dumps({'action':action,'request':rid,**kwargs})+'\n');process.stdin.flush()
  while rid not in stash:
   item=replies.get(timeout=8);stash[item.get('request')]=item
  item=stash.pop(rid)
  if item.get('error'):raise AssertionError(item)
  return item.get('result')
 extension_id='a'*32
 token=None
 def http(route,value=None,auth=True):
  headers={'X-CIP-Extension':extension_id}
  if auth:headers['Authorization']='Bearer '+token
  if value is not None:headers['Content-Type']='application/json'
  req=urllib.request.Request(address+route,data=json.dumps(value).encode() if value is not None else None,headers=headers)
  try:
   with urllib.request.urlopen(req,timeout=8) as response:return json.load(response)
  except urllib.error.HTTPError as e:raise RuntimeError(json.load(e).get('error','HTTP_ERROR')) from e
 pairing=json.loads((Path(tmp)/'pairing.json').read_text());token=http('/pair',{'code':pairing['code'],'extensionId':extension_id},False)['token']
 http('/commands') # A paired driver must make an authenticated heartbeat before provider discovery.
 checks.append('one-time pairing and authenticated heartbeat with the real loopback Runtime')
 browser=pw.chromium.launch(executable_path=os.environ.get('CIP_CHROMIUM','/usr/bin/chromium'),headless=True)
 pages={}; session_tabs={};next_tab=100
 def new_page(command):
  global next_tab
  next_tab+=1;tab=next_tab;p=browser.new_page()
  # Secure, intercepted origin supplies production WebCrypto; no real network.
  p.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body=HTML))
  p.goto('https://chatgpt.com/')
  p.evaluate('window.fixtureNativeMessages=true')
  p.evaluate('(id)=>{window.fixtureId=String(id);Object.defineProperty(crypto,"randomUUID",{value:()=>"document-fixture-"+id,configurable:true});}',tab)
  if command['payload'].get('conversationId'):
   conv=command['payload']['conversationId'];p.evaluate('(id)=>{fixtureLocation.pathname="/c/"+id;fixtureLocation.href="https://chatgpt.com"+fixtureLocation.pathname;}',conv)
  def page_rpc(message):
   try:
    if message['type']=='authorize':value=http('/authorize',{'id':message['id'],'lease':message['lease']})
    elif message['type']=='observation':value=http('/event',message['event'])
    else:raise RuntimeError('UNKNOWN_TEST_MESSAGE')
    return {'ok':True,'value':value}
   except Exception as e:return {'ok':False,'error':str(e)}
  p.expose_function('_fixtureBridge',page_rpc)
  p.add_script_tag(content='window.chrome={runtime:{id:"'+extension_id+'",sendMessage: m=>window._fixtureBridge(m),onMessage:{addListener:fn=>window._fixtureListener=fn}}};')
  load_adapter(p,main=True)
  p.add_script_tag(content='(() => { const location=window.fixtureLocation;'+CONTENT+'})();')
  pages[tab]=p
  if command.get('sessionId'):session_tabs[command['sessionId']]=tab
  return tab,p
 def message(p,value):
  return p.evaluate('(m)=>new Promise(resolve=>window._fixtureListener(m,{id:chrome.runtime.id},resolve))',value)
 def drive():
  for command in http('/commands')['commands']:
   if command['kind'] in ('open','catalog'):tab,p=new_page(command)
   else:tab=command['payload']['tabId'];p=pages[tab]
   ident=message(p,{'type':'identity'})['value']
   claim=http('/claim',{'id':command['id'],'tabId':tab,'documentKey':ident['documentKey'],'url':ident['url'],'nativeMessageId':ident.get('nativeMessageId'),'reopened':False})
   if command['kind']=='send' and command.get('sessionId')==local_ids.get('a'): p.evaluate('window.fixtureLong=true')
   reply=message(p,{'type':'command','command':claim})
   if not reply.get('ok'):raise AssertionError({'kind':command['kind'],'reply':reply})
   http('/result',{'id':command['id'],'lease':claim['lease'],'result':reply['value']})
   if command['kind']=='catalog':p.close();del pages[tab]
  for session in http('/active')['sessions']:
   reply=message(pages[session['tabId']],{'type':'monitor','session':session});assert reply['ok'],reply
 def wait(predicate,timeout=12):
  deadline=time.monotonic()+timeout
  while time.monotonic()<deadline:
   drive()
   events=call('events')
   found=predicate(events)
   if found:return found
   if pages:next(iter(pages.values())).wait_for_timeout(70)
   else:time.sleep(.02)
  raise AssertionError({'timeout':True,'events':call('events')})
 def send(value):call('provider-input',input=value)
 def prompt(host,mid,text):send({'type':'session.prompt','sessionId':host,'prompt':{'clientMessageId':mid,'delivery':'auto','input':{'type':'message','content':[{'type':'text','text':text}]}}})
 try:
  send({'type':'catalog','requestId':'catalog'})
  catalog=wait(lambda es:next((e for e in es if e['type']=='catalog'),None))['catalog']
  assert len(catalog['models'])==2 and 'defaultThinkingOptionId' not in catalog['models'][1]
  checks.append('web model/thinking/app discovery travels through the Provider wire projection')
  selected={'model':'m1','thinkingOption':'extended','appIds':['asdk_app_a']};call('defaults',selection=selected)
  configs={'a':selected,'b':{'model':'m2','thinkingOption':None,'appIds':['asdk_app_b']}}
  local_ids={}
  for host,chosen in configs.items():
   config={'cwd':'/fixture/'+host,'env':{},'settings':{},'mcpServers':{'paseo':{'type':'http','url':'http://127.0.0.1:1234/mcp/agents'}},'persist':True,'model':chosen['model'],'providerOptions':{'appIds':chosen['appIds']},'systemPrompt':'Fixture user instructions'}
   if chosen['thinkingOption'] is not None:config['thinkingOption']=chosen['thinkingOption']
   send({'type':'session.open','requestId':'open-'+host,'sessionId':host,'config':config,'history':'skip'})
   wait(lambda es:any(e['type']=='session.ready' and e['sessionId']==host for e in es))
   opened=next(e for e in call('events') if e['type']=='session.opened' and e['sessionId']==host)
   local_ids[host]=opened['persistence']['data']['id']
   assert local_ids[host] not in session_tabs
  checks.append('two configured Paseo sessions create ZERO browser tabs before first Send')
  assert len([e for e in call('events') if e['type']=='session.notice' and e['notice']['id']=='host-mcp-not-imported'])==2
  checks.append('host-injected MCP produces an explicit limitation notice, not a false tool connection')
  prompt('a','a1','A long task');prompt('b','b1','第一行\n第二行\n\n```text\ncode line\n```')
  wait(lambda es:any(e['type']=='session.turn' and e['sessionId']=='b' and e['state']=='completed' for e in es))
  a=pages[session_tabs[local_ids['a']]];b=pages[session_tabs[local_ids['b']]]
  for host,chosen in configs.items():
   assert call('read',id=local_ids[host])['config']==chosen
  checks.append('first Send opens separate tabs and confirms each exact model/thinking/app choice')
  assert call('read',id=local_ids['a'])['status']=='running'
  assert b.evaluate('window.fixtureSends')==1
  checks.append('multiline message WITH the injected working-directory context receives a real fixture receipt')
  answers=[e['item']['text'] for e in call('events') if e['type']=='timeline.item' and e['sessionId']=='b' and e['item']['type']=='assistant_message']
  assert any('第一行\n第二行' in value for value in answers)
  checks.append('B completes and preserves line breaks while A is still generating')
  send({'type':'session.interrupt','requestId':'stop-a','sessionId':'a'})
  wait(lambda es:any(e['type']=='session.turn' and e['sessionId']=='a' and e['state']=='canceled' for e in es))
  assert call('read',id=local_ids['b'])['status']=='idle'
  partials=[e['item']['text'] for e in call('events') if e['type']=='timeline.item' and e['sessionId']=='a' and e['item']['type']=='assistant_message']
  assert len(partials)==1 and partials[0].startswith('Fixture partial: ')
  assert not any(e['type']=='session.turn' and e['sessionId']=='a' and e['state']=='completed' for e in call('events'))
  checks.append('confirmed Stop preserves A interrupted text exactly once without completing A or canceling B')
  old_conversation=call('read',id=local_ids['b'])['conversationId']
  prompt('b','b2','Follow-up')
  wait(lambda es:len([e for e in es if e['type']=='session.turn' and e['sessionId']=='b' and e['state']=='completed'])==2)
  assert call('read',id=local_ids['b'])['conversationId']==old_conversation
  assert b.evaluate('window.fixtureSends')==2 and a.evaluate('window.fixtureSends')==1
  checks.append('follow-up reuses B native conversation and performs exactly one new fixture Send')
 finally:
  call('close');process.stdin.close();process.wait(timeout=5);browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'Node Provider + real local Runtime + Chromium in-memory DOM/content script; synthetic Chrome tab API; NOT live ChatGPT/Paseo/MV3 installation'},ensure_ascii=False,indent=2))
