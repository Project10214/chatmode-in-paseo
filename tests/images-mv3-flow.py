"""Real unpacked extension / Runtime / installed SDK, offline native image fixture.
Reuses the established MV3 harness. No user profile, model request or production state.
"""
from pathlib import Path
import os, json, base64, struct, zlib
BASE=Path(__file__).with_name('binding-mv3-flow.py')
source=BASE.read_text()
mode=os.environ.get('CIP_IMAGE_FIXTURE','url')
assert mode in ('url','blob','missing')
def once(old,new):
 global source
 assert source.count(old)==1,old[:90]
 source=source.replace(old,new,1)
def chunk(k,b):return struct.pack('!I',len(b))+k+b+struct.pack('!I',zlib.crc32(k+b)&0xffffffff)
pixels=b''.join(b'\0'+bytes([50,125,180,255])*16 for _ in range(12))
PNG=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',16,12,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')
once('window.fixtureRealRoute=true;','window.fixtureRealRoute=true;\nconst MEDIA_MODE='+json.dumps(mode)+';const MEDIA_PNG='+json.dumps(base64.b64encode(PNG).decode())+';')
once("  const answer=document.createElement('div');answer.className='markdown';\n  answer.setAttribute('data-chatgpt-search-unit-key',entry.layout+':1:assistant');\n  answer.textContent=entry.turn.items[1].content;\n  section.append(user,answer);document.querySelector('main').append(section);",r"""  section.append(user);
  const item=entry.turn.items[1];
  if(item.type==='generated-image'){
    const wrap=document.createElement('div');wrap.className='group/imagegen-image';
    if(MEDIA_MODE!=='missing'){
      const img=document.createElement('img');img.style.width='160px';img.style.height='120px';
      img.src=MEDIA_MODE==='blob'?URL.createObjectURL(new Blob([Uint8Array.from(atob(MEDIA_PNG),x=>x.charCodeAt(0))],{type:'image/png'})):'/backend-api/estuary/content?id='+item.src.slice('sediment://'.length);
      img.__reactFiber$fixture={memoizedProps:{imageId:item.id,isComplete:item.status==='completed',isPreview:item.isPreview,item},return:{memoizedProps:{turn:entry.turn,conversationId:entry.conversationId},return:null}};
      wrap.append(img);
    }
    section.append(wrap);
  }else{
    const answer=document.createElement('div');answer.className='markdown';answer.textContent=item.content;section.append(answer);
  }
  document.querySelector('main').append(section);""")
once(" entry.layout=entry.id;entry.turn.status='complete';entry.turn.items[1].completed=true;\n entry.turn.items[1].content='MV3_REPLY_'+entry.number;", " entry.layout=entry.id;entry.turn.status='complete';const item=entry.turn.items[1];\n if(item.type==='generated-image'){item.status='completed';item.isPreview=false;}else{item.completed=true;item.content='MV3_REPLY_'+entry.number;}")
start=source.index(" const n=fixtureState.clicks,entry=")
end=source.index(' fixtureState.turns.push(entry);',start)
source=source[:start]+r""" const n=fixtureState.clicks,generated=n!==2;
 const answer=generated?{type:'generated-image',id:'image-control-'+n,chatGptMessageId:'native-image-'+n,src:'sediment://file_fixture_image_'+n,status:'in_progress',isPreview:true,width:16,height:12}:{type:'assistant-message',messageId:'native-answer-'+n,phase:'final_answer',completed:false,content:''};
 const entry={id:'native-turn-'+n,number:n,layout:'fallback-turn-'+(n-1),conversationId:cid,turn:{status:'in_progress',messageIds:['native-user-'+n,generated?'native-image-'+n:'native-answer-'+n],items:[{type:'user-message',messageId:'native-user-'+n,serverMessageId:'native-user-'+n,message:nativeText},answer]}};
"""+source[end:]
once("            elif self.path.split('?')[0]=='/' or self.path.startswith('/c/'):","            elif self.path.startswith('/backend-api/estuary/content'):\n                body=PNG; kind='image/png'\n            elif self.path.split('?')[0]=='/' or self.path.startswith('/c/'):")
once("        elif request.request.resource_type=='document':request.fulfill", "        elif '/backend-api/estuary/content' in url:request.fulfill(status=200,content_type='image/png',body=PNG)\n        elif request.request.resource_type=='document':request.fulfill")
start=source.index("        prompt('first','FIRST_MV3_BODY')")
end=source.index("    finally:\n        try:call('close')",start)
source=source[:start]+'''        prompt('first','Generate fixture image only')
        wait(lambda es:any(e['type']=='session.turn' and e['state']=='completed' for e in es),45)
        state=call('read',id=sid);cards=[x for x in state['history'] if x.get('kind')=='generated-image']
        assert len(cards)==1 and cards[0]['kind']=='generated-image',state['history']
        image=cards[0]['data'];assert image['assetId']=='file_fixture_image_1' and image['messageId']=='native-image-1'
        assert len(json.dumps(image))<2048 and 'data:image' not in json.dumps(image)
        assert state['turn']['outcome']=='completed'
        assert not [x for x in state['history'] if x['type']=='assistant_message']
        checks.append('native image-only completion returns a provider image card, never a fabricated text final')
        if mode=='missing':
            assert image['status']=='unavailable' and image['error']=='not_rendered',image
            checks.append('unreadable preview emits an unavailable card and ends; never runs forever')
        else:
            assert image['status']=='available' and image['mimeType']=='image/webp',image
            preview=(Path(directory)/'media'/(image['digest']+'.webp')).read_bytes()
            assert preview[:4]==b'RIFF' and preview[8:12]==b'WEBP'
            checkpage=browser.new_page();decoded=checkpage.evaluate("async uri=>{const i=new Image();i.src=uri;await i.decode();return [i.naturalWidth,i.naturalHeight]}",'data:image/webp;base64,'+base64.b64encode(preview).decode());checkpage.close()
            assert decoded==[16,12],decoded
            checks.append('owned '+mode+' pixels become a decodable durable WebP preview without forwarding source URLs')
        cid=state['conversationId'];page=next(p for p in browser.pages if p.url.endswith('/c/'+cid))
        assert page.evaluate('fixtureState.clicks')==1
        prompt('second','Text after image')
        wait(lambda es:len([e for e in es if e['type']=='session.turn' and e['state']=='completed'])==2,30)
        state=call('read',id=sid);assert any(x.get('text')=='MV3_REPLY_2' for x in state['history'])
        assert len([x for x in state['history'] if x.get('kind')=='generated-image'])==1
        checks.append('next text reply keeps the same conversation; old image does not end or duplicate the new turn')
        prompt('third','One more image')
        wait(lambda es:(call('read',id=sid).get('turn') or {}).get('nativeMessageId')=='native-user-3')
        page.reload()
        wait(lambda es:len([e for e in es if e['type']=='session.turn' and e['state']=='completed'])==3,45)
        state=call('read',id=sid);assert state['conversationId']==cid and page.evaluate('fixtureState.clicks')==3
        assert len([x for x in state['history'] if x.get('kind')=='generated-image'])==2
        checks.append('page reload during image generation restores observation without resending or duplicating cards')
''' +source[end:]
once("'escapedRequests':escape_requests,", "'escapedRequests':escape_requests,'imageFixture':mode,")
exec(compile(source,str(BASE)+'[native-image-fixture]','exec'),{'__file__':str(BASE),'__name__':'__main__','PNG':PNG,'mode':mode,'base64':base64})
