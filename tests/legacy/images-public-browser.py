"""CoS native image ownership, privacy and terminal proof; offline Chrome only."""
import os,json
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_utils import load_adapter
R=Path(__file__).resolve().parents[1]
HTML=(R/'tests/fixtures/chatgpt.html').read_text().replace('</body>','<script>'+(R/'tests/fixtures/native-picker.js').read_text()+'</script></body>')
checks=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('CIP_CHROMIUM','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
 def fresh():
  p=browser.new_page();p.set_content(HTML);load_adapter(p,True,True)
  p.evaluate('''()=>{
   fixtureLocation.pathname='/c/12345678-1234-4234-8234-123456789abc';fixtureLocation.href='https://chatgpt.com'+fixtureLocation.pathname;
   window.section=document.createElement('section');section.dataset.turnKey='native-turn';section.innerHTML='<span data-content-search-turn-key="native-turn"></span>';
   window.imageItem={type:'generated-image',id:'control-image',chatGptMessageId:'native-img',src:'sediment://file_fixture_image_1',width:16,height:12,status:'completed',isPreview:false};
   window.entry={id:'native-turn',conversationId:fixtureLocation.pathname.slice(3),turn:{status:'complete',messageIds:['native-user','native-img'],items:[{type:'user-message',messageId:'native-user',serverMessageId:'native-user',message:'Draw fixture'},imageItem]}};
   section.__reactFiber$fixture={memoizedProps:{entry,conversationId:entry.conversationId},return:null};
   document.querySelector('main').append(section);
  }''');return p
 def read(p):return p.evaluate("async()=>{await CIP_DOM.refreshTranscript();const v=CIP_DOM.state('native-user');return {images:v.images,imageFinalId:v.imageFinalId,answer:v.answer,error:v.error}}")
 p=fresh();v=read(p);assert len(v['images'])==1 and v['imageFinalId']=='native-img' and v['answer'] is None,v;checks.append('typed shell image-only final requires native owning message and containing turn')
 p.evaluate("imageItem.isPreview=true");assert read(p)['imageFinalId'] is None;p.evaluate("imageItem.isPreview=false;entry.turn.status='in_progress'");assert read(p)['imageFinalId'] is None;checks.append('preview or unfinished turn never supplies completed image proof')
 p.evaluate("entry.turn.status='complete';entry.turn.messageIds=['native-user']");v=read(p);assert not v['images'] and v['error']=='IMAGE_IDENTITY_UNPROVEN',v;checks.append('image id absent from native turn messageIds is refused')
 p.close();p=fresh();p.evaluate("section.style.display='none'");p.evaluate('CIP_DOM.refreshTranscript()');assert p.evaluate('CIP_DOM.messages()')==[];checks.append('kept hidden page supplies no user/image ownership');p.close()
 p=fresh();p.evaluate("entry.turn.items.push({...imageItem,id:'other',chatGptMessageId:'native-img-2',src:'sediment://file_fixture_image_2',status:'in_progress'});entry.turn.messageIds.push('native-img-2')");assert read(p)['imageFinalId'] is None;checks.append('one completed image does not finish an incomplete sibling');p.close()
 p=fresh();p.evaluate("imageItem.src='https://evil.invalid/image?token=private'");v=read(p);assert v['images']==[] and 'private' not in json.dumps(v);checks.append('unrecognized asset URL cannot become descriptor or leave page');p.close()
 # Loaded blob with mismatched control identity is never allowed to donate pixels.
 p=fresh();p.evaluate('''async()=>{
   const c=document.createElement('canvas');c.width=16;c.height=12;c.getContext('2d').fillRect(0,0,16,12);
   const b=await new Promise(r=>c.toBlob(r));const img=document.createElement('img');img.src=URL.createObjectURL(b);await img.decode();
   const w=document.createElement('div');w.className='group/imagegen-image';w.append(img);section.append(w);
   img.__reactFiber$fixture={memoizedProps:{imageId:'wrong-control',isComplete:true,isPreview:false,item:imageItem},return:section.__reactFiber$fixture};
  }''');v=read(p);r=p.evaluate('async image=>CIP_MEDIA.capture(image,()=>{})',v['images'][0]);assert r['previewStatus']=='unavailable';checks.append('blob pixels need exact item plus image control identity; proximity is insufficient');p.close()
 browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,'scope':'offline Chromium with shipped CoS extraction; no actual account'},ensure_ascii=False,indent=2))
