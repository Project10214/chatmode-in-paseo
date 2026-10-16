"""Native file input smoke in real isolated Chrome (no logged-in ChatGPT)."""
import base64, json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YkCvYoAAAAASUVORK5CYII=')
PDF=b'%PDF-1.7\n1 0 obj << /Type /Catalog >>\n%%EOF\n'
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    page=browser.new_page()
    html='''<!doctype html><html><body><form data-chatgpt-composer>
      <div contenteditable id="prompt-textarea"></div>
      <input type="file" accept="image/png,application/pdf" multiple>
      <div data-composer-attachments></div><button data-testid="send-button">Send</button></form>
      <script>
      window.seen=[];
      document.querySelector('input[type=file]').addEventListener('change',async e=>{
        const root=document.querySelector('[data-composer-attachments]');
        for(const f of e.target.files){
          window.seen.push({name:f.name,type:f.type,bytes:[...new Uint8Array(await f.arrayBuffer())]});
          const chip=document.createElement('div');chip.textContent=f.name;root.append(chip);
        }
      });
      </script></body></html>'''
    # Loopback is a secure context for WebCrypto; all page requests stay
    # inside this isolated fixture and never reach ChatGPT.
    page.route('http://127.0.0.1:18781/**',lambda route:route.fulfill(status=200,content_type='text/html',body=html))
    page.goto('http://127.0.0.1:18781/fixture')
    page.add_script_tag(path=str(ROOT/'extension/file-upload.js'))
    js='''async ({data})=>{
      const enc=new TextEncoder();
      const sample=data.map(d=>new Uint8Array(d.bytes));
      const hash=async buffer=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))]
        .map(v=>v.toString(16).padStart(2,'0')).join('');
      const files=[];
      for(const d of data)files.push({fileName:d.name,mimeType:d.type,size:d.bytes.length,sha256:await hash(new Uint8Array(d.bytes))});
      const read=async ({index,offset})=>{
        const chunk=sample[index].subarray(offset,offset+131072);
        const str=String.fromCharCode(...chunk);
        return {data:btoa(str),offset,total:files[index].size,sha256:files[index].sha256};
      };
      const box=document.querySelector('#prompt-textarea');
      const proof=await CIP_UPLOAD.attach({id:'cmd',lease:'lease',documentKey:'doc',payload:{files}},box,read,()=>{},Date.now()+60000);
      await new Promise(resolve=>setTimeout(resolve,20));
      return {proof:proof(),uploads:window.seen,inputCount:document.querySelector('input[type=file]').files.length};
    }'''
    data=[{'name':'outbound.png','type':'image/png','bytes':list(PNG)},
          {'name':'document.pdf','type':'application/pdf','bytes':list(PDF)}]
    result=page.evaluate(js,{'data':data})
    assert result['proof'] is True,result
    assert result['inputCount']==2,result
    assert [v['name'] for v in result['uploads']]==[d['name'] for d in data],result
    assert [bytes(v['bytes']) for v in result['uploads']]==[PNG,PDF],result
    print(json.dumps({'passed':4,'checks':['native input accepted PNG and PDF','Paseo staged bytes matched','DOM attachment confirmation','two-file selection'],'scope':'isolated real Chrome, not ChatGPT account'},ensure_ascii=False))
    browser.close()
