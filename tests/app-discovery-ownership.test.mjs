import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../extension/app-discovery.js',import.meta.url),'utf8');
function harness(){
  const handlers=new Map();
  let draft='';
  const form={querySelector:()=>null};
  const box={isConnected:true,closest:selector=>selector==='form'?form:null,
    contains:target=>target===box||target?.inside===true,
    focus(){},dispatchEvent(){}};
  const document={
    querySelectorAll:()=>[],
    addEventListener(type,handler){
      const list=handlers.get(type)??[];list.push(handler);handlers.set(type,list);
    },
    removeEventListener(type,handler){
      handlers.set(type,(handlers.get(type)??[]).filter(fn=>fn!==handler));
    }
  };
  const context=vm.createContext({
    document,location:{pathname:'/'},KeyboardEvent:class{constructor(type,data){this.type=type;this.data=data;}},
    getComputedStyle:()=>({visibility:'visible'}),NodeFilter:{SHOW_TEXT:4}
  });
  vm.runInContext(source,context);
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  const probe=context.CIP_activateAppDiscovery({composer:()=>box,authored:()=>draft,
    chips:()=>[],insert:value=>{draft=value;},guard:()=>{},fail});
  const outside={closest:()=>null,inside:false};
  const inside={closest:()=>null,inside:true};
  const emit=(type,target=outside,key='x')=>{
    for(const fn of handlers.get(type)??[])fn({type,target,key,isTrusted:true});
  };
  return {probe,box,outside,inside,emit,get draft(){return draft;}};
}
test('APP-PROBE1 unrelated ChatGPT menu click or keyboard shortcut does not revoke app discovery',()=>{
  const f=harness();
  f.emit('pointerdown',f.outside);f.emit('keydown',f.outside);
  assert.doesNotThrow(()=>f.probe.check());
  assert.equal(f.draft,'@');
});
test('APP-PROBE2 clicking in editor or using arrow keys does not change application identity',()=>{
  const f=harness();
  f.emit('pointerdown',f.box);f.emit('keydown',f.box,'ArrowLeft');
  assert.doesNotThrow(()=>f.probe.check());
});
test('APP-PROBE3 trusted typing into the active editor invalidates temporary @ ownership',()=>{
  const f=harness();
  f.emit('keydown',f.box,'a');
  assert.throws(()=>f.probe.check(),/APP_PROBE_INTERRUPTED/);
});
test('APP-PROBE4 trusted paste in the editor invalidates temporary @ ownership',()=>{
  const f=harness();f.emit('paste',f.inside);
  assert.throws(()=>f.probe.check(),/APP_PROBE_INTERRUPTED/);
});
test('APP-PROBE5 modifying native app marks is never a permitted menu click',()=>{
  const f=harness();
  const chipButton={inside:true,closest:selector=>
    selector.includes('app-mention')?{id:'chip'}:selector.includes('button')?{id:'remove'}:null};
  f.emit('pointerdown',chipButton);
  assert.throws(()=>f.probe.check(),/APP_PROBE_INTERRUPTED/);
});
