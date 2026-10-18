import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../extension/upstream/cos-activity-main.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(script, ctx);
const project = turn => JSON.parse(JSON.stringify(ctx.CIP_COS_ACTIVITY.publicTimeline(turn)));
const trace = turn => JSON.parse(JSON.stringify(ctx.CIP_COS_ACTIVITY.shellTurnTrace(turn)));
const call = (id,extra={}) => ({
  type:'mcp-tool-call',callId:id,recipient:'mymac',completed:true,
  invocation:{server:'mymac',tool:'read',arguments:{token:'NEVER_EXPORT'},response:{private:'SECRET'}},
  ...extra
});
test('real collapsed public group carries two provider-directed calls and its completed public recap',()=>{
 const turn={status:'complete',items:[
   {type:'user-message',messageId:'native-user-1',message:'probe'},
   {type:'chatgpt-reasoning-group',reasoningRecap:{type:'collapse'},items:[
     call('mcp-1'),{type:'reasoning',presentation:'thought',content:'已核对公开过程',completed:true,id:'public-recap-1'},
     call('mcp-2',{invocation:{server:'tasks',tool:'list_items'}}),
     {type:'reasoning',presentation:'analysis',content:'PRIVATE_COT',id:'hidden-thought',completed:true},
     call('secret-hidden',{metadata:{is_visually_hidden_from_conversation:true}})
   ]}
 ]};
 const value=project(turn);
 assert.deepEqual(value.calls.map(x=>x.callId),['mcp-1','mcp-2']);
 assert.equal(value.calls[0].status,'completed');
 assert.deepEqual(value.reasoning,[{id:'public-recap-1',text:'已核对公开过程',position:[1,1]}]);
 assert.deepEqual(trace(turn).steps.map(x=>x.label),['mymac · read','tasks · list_items']);
 assert.equal(JSON.stringify(value).includes('PRIVATE_COT'),false);
 assert.equal(JSON.stringify(value).includes('NEVER_EXPORT'),false);
 assert.equal(JSON.stringify(value).includes('SECRET'),false);
});
test('hide_all, hidden parent and private subitems do not yield events',()=>{
 const turn={status:'in_progress',items:[
   {type:'chatgpt-reasoning-group',reasoningRecap:{type:'hide_all'},items:[call('call-hide')]},
   {type:'chatgpt-reasoning-group',reasoningRecap:{type:'collapse'},isVisuallyHidden:true,items:[call('call-hidden-parent')]},
   {type:'chatgpt-reasoning-group',reasoningRecap:{type:'collapse'},items:[
     call('hidden-channel',{channel:'analysis'}),
     call('hidden-mark',{isVisuallyHidden:true}),
     call('visible-call'),
     call('tool-private-meta',{metadata:{is_visually_hidden:true}})
   ]}
 ]};
 assert.deepEqual(project(turn).calls.map(x=>x.callId),['visible-call']);
});
test('folded tool calls update by stable callId and malformed ids are dropped',()=>{
 const turn={status:'in_progress',items:[{
   type:'chatgpt-reasoning-group',reasoningRecap:{type:'collapse'},items:[
     call('mcp-2',{completed:false}),call('mcp-2',{completed:false}),call('invalid id with spaces')
   ]
 }]};
 assert.deepEqual(project(turn).calls.map(x=>[x.callId,x.status]),[['mcp-2','running']]);
 turn.items[0].items[0].completed=true;
 assert.deepEqual(project(turn).calls.map(x=>[x.callId,x.status]),[['mcp-2','completed']]);
});
