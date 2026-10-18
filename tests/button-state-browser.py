"""Real Chromium, production button observer. No account, network, click or native turn data."""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]
SCRIPT=(R/'extension/page-controls.js').read_text()
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ['CIP_CHROMIUM'],headless=True)
    try:
        page=browser.new_page()
        page.set_content('<main><form><div id="prompt-textarea" contenteditable="true" role="textbox"></div></form></main>')
        page.add_script_tag(content=SCRIPT)
        results=page.evaluate(r'''()=>{
          const checks=[];let clicks=0;document.addEventListener('click',()=>clicks++);
          const form=document.querySelector('form');
          function check(name,expect,buttons){
            form.querySelectorAll('button').forEach(b=>b.remove());
            for(const spec of buttons){const b=document.createElement('button');b.type='button';
              for(const [k,v]of Object.entries(spec)){if(k==='html')b.innerHTML=v;else if(k==='disabled')b.disabled=v;else b.setAttribute(k,v);}
              form.append(b);
            }
            const value=CIP_PAGE_CONTROLS.read();
            if(value.state!==expect)throw new Error(name+': '+JSON.stringify(value));
            checks.push({name,...value});return value;
          }
          check('stop means running','running',[{'aria-label':'Stop'}]);
          check('disabled stop still has stop appearance','running',[{'aria-label':'Stop',disabled:true}]);
          check('empty enabled Start Voice means standby','standby',[{'aria-label':'Start Voice'}]);
          check('empty disabled Send still means standby','standby',[{'aria-label':'Send',disabled:true}]);
          check('Send with real draft means standby','standby',[{'data-testid':'send-button'}]);
          check('microphone Dictate is not Start Voice','abnormal',[{'aria-label':'Dictate'}]);
          check('stop wins when an additional send control exists','running',[{'aria-label':'Stop'},{'aria-label':'Send'}]);
          check('hidden stop does not make page running','standby',[{'aria-label':'Stop',style:'display:none'},{'aria-label':'Start Voice'}]);
          check('Chinese labels','running',[{'aria-label':'停止生成'}]);
          check('Chinese voice','standby',[{'aria-label':'开始语音'}]);
          check('known square fallback is stop','running',[{class:'size-token-button-composer bg-composer-primary',html:'<svg><path d="M4.5 5.75H15.5V16.75H4.5Z"></path></svg>'}]);
          check('unidentified glyph is not guessed to be send','abnormal',[{class:'size-token-button-composer bg-composer-primary',html:'<svg><path d="M0 0L10 10"></path></svg>'}]);
          const quote=document.createElement('article');quote.innerHTML='<button aria-label="Stop">Stop in an old answer</button>';document.querySelector('main').prepend(quote);
          check('old answer controls are not composer controls','standby',[{'aria-label':'Start Voice'}]);
          const hidden=document.createElement('section');hidden.style.display='none';hidden.innerHTML='<form><div contenteditable="true" role="textbox"></div><button aria-label="Stop"></button></form>';document.body.append(hidden);
          check('kept hidden composer ignored','standby',[{'aria-label':'Start Voice'}]);
          document.querySelector('main').setAttribute('data-native-status','in_progress');
          check('native in_progress is not an input to state','standby',[{'aria-label':'Start Voice'}]);
          document.querySelector('main').setAttribute('data-native-status','complete');
          check('native complete is not an input to state','running',[{'aria-label':'Stop'}]);
          const approval=document.createElement('div');approval.dataset.codexApprovalSurface='true';approval.innerHTML='<form><button>Allow once</button><button>Deny</button></form>';document.querySelector('main').append(approval);
          check('approval is not an exception to button state','standby',[{'aria-label':'Start Voice'}]);
          document.querySelector('main').innerHTML='<p>错误请点击重试</p><button>重试</button>';
          const error=CIP_PAGE_CONTROLS.read();if(error.state!=='abnormal')throw new Error('composer-less error page');checks.push({name:'whole-page error without input',...error});
          return {checks,clicks,text:document.querySelector('main').innerText};
        }''')
    finally:
        browser.close()
assert results['clicks']==0
assert '错误请点击重试' in results['text']
print(json.dumps({'passed':len(results['checks']),'clicks':results['clicks'],'cases':[c['name'] for c in results['checks']]},ensure_ascii=False))
