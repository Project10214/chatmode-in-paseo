import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as zod from 'zod';
import { projectPageItem } from '../server/page-items.mjs';

function load(file, modules) {
  const source=ts.transpileModule(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  }).outputText;
  const exports={};
  vm.runInNewContext(source,{exports,require(name){
    assert.ok(Object.hasOwn(modules,name),'Unexpected dependency: '+name);
    return modules[name];
  }},{filename:file});
  return exports;
}

test('client entry registers the real page-source schema and renderer for projected progress/errors',()=>{
  const schema=load('shared/page-source.ts',{zod});
  const PageSourceCard=()=>null;
  const component=()=>null;
  const any=zod.z.any();
  const modules={
    './client/settings.js':{SettingsScreen:component},
    './client/generated-image.js':{GeneratedImage:component},
    './shared/images.js':{imageCardSchema:any},
    './client/generated-file.js':{GeneratedFile:component},
    './shared/artifacts.js':{artifactCardSchema:any},
    './client/page-state.js':{PageStateCard:component},
    './shared/page-state.js':{pageStateSchema:any},
    './client/page-source.js':{PageSourceCard},
    './shared/page-source.js':schema,
    './client/source-checkpoint.js':load('client/source-checkpoint.tsx',{}),
    './shared/source-checkpoint.js':load('shared/source-checkpoint.ts',{zod}),
    './client/native-activity.js':{NativeActivity:component,NativeActivityV2:component},
    './shared/activity.js':{activityCardSchema:any,activityCardSchemaV2:any}
  };
  const registrations=[],disposed=[];
  const dispose=load('index.client.tsx',modules).default({
    addSettingsScreen(value){return ()=>disposed.push(value.id);},
    addTimelineRenderer(value){registrations.push(value);return ()=>disposed.push(value.kind+':'+value.version);}
  });
  const renderer=registrations.find(row=>row.kind==='page-source'&&row.version===1);
  assert.ok(renderer,'production entry must register the source card, not only test its component');
  assert.equal(renderer.Component,PageSourceCard);
  for(const extra of [{role:'assistant',lane:'process',kind:'message'},{role:'page',lane:'output',kind:'notice'}]) {
    const item=projectPageItem({id:'source-'+extra.role,userMessageId:null,text:'错误请点击重试\n原文保留',
      format:'text',order:[0],...extra});
    assert.equal(item.kind,renderer.kind);
    assert.deepEqual(renderer.schema.parse(item.data),item.data);
  }
  const checkpoint=registrations.find(row=>row.kind==='source-checkpoint'&&row.version===1);
  assert.ok(checkpoint);
  assert.equal(checkpoint.Component(),null,'transport marker cannot become visible source prose');
  assert.equal(checkpoint.schema.safeParse({sessionId:'host',bindingGeneration:'binding',hostEpoch:'epoch',
    sourceId:'source',phase:'anchor',batch:0,through:0,attemptId:null,probeId:'probe'}).success,true);
  dispose();
  assert.equal(disposed.filter(value=>value==='page-source:1').length,1);
  assert.equal(disposed.length,registrations.length+1);
});
