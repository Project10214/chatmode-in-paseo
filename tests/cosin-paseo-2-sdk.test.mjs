import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,selection,until} from './helpers.mjs';
import {createProvider,CAPABILITIES} from '../server/provider.mjs';

let ProviderEventSchema=null;
try{
  ({ProviderEventSchema}=await import('../.test-tools/ui/node_modules/@getpaseo/plugin/dist/server/provider.js'));
}catch{}

test('COS2-SDK: the installed Paseo Provider validates actual native reasoning/tool calls and endings',
  {skip:!ProviderEventSchema&&'Pinned Paseo SDK not available in isolated test-tools'},async t=>{
    const f=await fixture(t),s=await f.ready(),{event}=await f.sending(s);
    const conn=await createProvider({...f,status:()=>({connected:true})},
      value=>ProviderEventSchema.parse(value)).connect({versions:[1],capabilities:CAPABILITIES});
    t.after(()=>conn.close());
    const out=[];conn.onEvent(x=>out.push(x));
    const config={cwd:'/fixture',env:{},settings:{},mcpServers:{},persist:true,
      model:selection.model,thinkingOption:selection.thinkingOption,
      providerOptions:{appIds:selection.appIds}};
    await conn.send({type:'session.open',requestId:'open',sessionId:'one',
      config,persistence:{version:1,data:{id:s.id}},history:'skip'});
    await until(()=>out.some(x=>x.type==='session.ready'));
    const call={type:'tool_call',callId:'call-1',name:'mymac · read',kind:'tool',
      details:{input:'api_key=HIDDEN',output:'Visible progress'},status:'running'};
    await f.broker.observe({...event,kind:'native_timeline',item:call});
    await f.broker.observe({...event,kind:'native_timeline',item:{...call,status:'completed',
      details:{input:'api_key=HIDDEN',output:'Visible completed'}}});
    await f.broker.observe({...event,kind:'native_timeline',item:{
      type:'reasoning',id:'reason-1',text:'公开的思考摘要'}});
    const native=out.filter(x=>x.type==='timeline.item'&&
      ['tool_call','reasoning'].includes(x.item?.type));
    assert.deepEqual(native.map(x=>x.item.type),['tool_call','tool_call','reasoning']);
    assert.equal(native[0].item.status,'running');
    assert.equal(native[1].item.status,'completed');
    assert.equal(native[0].item.id,native[1].item.id);
    assert.ok(native[0].item.detail.text.includes('[REDACTED]'));
    assert.equal(native[0].item.detail.text.includes('HIDDEN'),false);
    assert.equal(out.some(x=>x.type==='session.runtime_failed'),false);
    for(const e of out)assert.equal(ProviderEventSchema.safeParse(e).success,true,e.type);
    await f.broker.observe({...event,kind:'snapshot',messageId:'final',text:'done'});
    await f.broker.observe({...event,kind:'completed',messageId:'final',finalConfirmed:true});
    assert.equal(out.at(-1).type,'session.turn');
    assert.equal(out.at(-1).state,'completed');
  });
