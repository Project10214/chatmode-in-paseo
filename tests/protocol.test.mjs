import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, validateSelection, conversationId, sameSelection } from '../server/protocol.mjs';
import { selectionFrom, promptText, promptContent } from '../server/provider.mjs';
import { rawCatalog, selection } from './helpers.mjs';
const catalog = validateCatalog(rawCatalog);
test('catalog preserves actual model-specific thinking defaults', () => { assert.equal(catalog.models[0].defaultThinkingOptionId, 'standard'); assert.equal(validateSelection({}, catalog).thinkingOption, 'standard'); });
test('model disappearance fails closed', () => { assert.throws(() => validateSelection({ model: 'missing' }, catalog), /MODEL_UNAVAILABLE/); });
test('thinking options cannot cross models', () => { assert.throws(() => validateSelection({ model: 'm2', thinkingOption: 'extended' }, catalog), /THINKING_UNAVAILABLE/); });
test('unknown and duplicate app selections rejected', () => { assert.throws(() => validateSelection({ appIds: ['absent'] }, catalog), /APP_UNAVAILABLE/); assert.throws(() => validateSelection({ appIds: ['asdk_app_a', 'asdk_app_a'] }, catalog), /INVALID_APPS/); });
test('plain @names are never treated as native app IDs', () => { assert.throws(() => validateCatalog({ ...rawCatalog, apps: [{ id: '@Mac', label: 'Mac' }] }), /APP_ID_UNPROVEN/); });
test('ambiguous catalog labels with duplicate keys rejected', () => { assert.throws(() => validateCatalog({ ...rawCatalog, models: [rawCatalog.models[0], rawCatalog.models[0]] }), /DUPLICATE_OPTION/); });
test('conversation identity only accepts HTTPS chatgpt.com', () => { assert.equal(conversationId('https://chatgpt.com/c/abc'), 'abc'); assert.equal(conversationId('https://chatgpt.com/g/project/c/abc'), 'abc'); for (const u of ['https://evil.test/c/abc', 'http://chatgpt.com/c/abc', 'https://chatgpt.com.evil.test/c/abc']) assert.equal(conversationId(u), null); });
test('agent options override defaults; toggles may remove an app', () => { const s = selectionFrom({ model: 'm2', providerOptions: { appIds: ['asdk_app_b'] }, settings: { 'app:asdk_app_b': false } }, catalog, selection); assert.deepEqual(s, { model: 'm2', thinkingOption: null, appIds: [] }); });
test('one quick tool choice switches apps atomically without changing model or thinking',()=>{
  const base={model:'m1',thinkingOption:'extended',providerOptions:{appIds:['asdk_app_a']}},
    defaults={...selection,appIds:['asdk_app_a','asdk_app_b']};
  for(const [value,expected] of [
    ['none',[]],['app:asdk_app_b',['asdk_app_b']],['all',['asdk_app_a','asdk_app_b']],
    ['defaults',['asdk_app_a','asdk_app_b']]]) {
    const s=selectionFrom({...base,settings:{'app:quick':value}},catalog,defaults);
    assert.equal(s.model,'m1');assert.equal(s.thinkingOption,'extended');
    assert.deepEqual(s.appIds,expected);
  }
  for(const choice of ['app:unverified','not-an-app',123,'defaults']) {
    if(choice==='defaults')assert.throws(()=>selectionFrom({...base,settings:{'app:quick':choice}},catalog,{}));
    else assert.throws(()=>selectionFrom({...base,settings:{'app:quick':choice}},catalog,defaults));
  }
  const custom=selectionFrom({...base,providerOptions:{appIds:defaults.appIds},settings:{'app:quick':'keep'}},catalog,defaults);
  assert.deepEqual(custom.appIds,defaults.appIds);
  assert.deepEqual(selectionFrom({...base,settings:{'app:asdk_app_a':false}},catalog,defaults).appIds,[]);
});
test('former multi-add commands are refused by restored single-select configuration', () => {
  const base={model:'m1',thinkingOption:'extended',providerOptions:{appIds:['asdk_app_a']}};
  for(const value of ['add:asdk_app_b','remove:asdk_app_a','add:asdk_app_missing']){
    assert.throws(()=>selectionFrom({...base,settings:{'app:quick':value}},catalog,selection),/SETTING_UNSUPPORTED/);
  }
  assert.deepEqual(selectionFrom({...base,settings:{'app:quick':'app:asdk_app_b'}},catalog,selection).appIds,['asdk_app_b']);
});
test('unsupported provider options are not silently discarded', () => { assert.throws(() => selectionFrom({ providerOptions: { apiKey: 'ignored?' } }, catalog, selection), /UNKNOWN_PROVIDER_OPTION/); });
test('unsupported media, steering, and structured output fail clearly', () => { for (const p of [
  { delivery: 'steer', input: { type: 'message', content: [{ type: 'text', text: 'x' }] } },
  { delivery: 'auto', input: { type: 'message', content: [{ type: 'video', data: 'x' }] } },
  { delivery: 'auto', outputSchema: {}, input: { type: 'message', content: [{ type: 'text', text: 'x' }] } }
]) assert.throws(() => promptText(p)); });
test('Paseo image and uploaded_file parts preserve native attachments without embedding file bytes in text',()=>{
  const p={delivery:'auto',input:{type:'message',content:[
    {type:'text',text:'Describe these'}, {type:'image',mimeType:'image/png',data:'AAAA'},
    {type:'uploaded_file',id:'doc1',fileName:'example.pdf',mimeType:'application/pdf',size:5,path:'/tmp/example.pdf'}]}};
  assert.equal(promptContent(p).text,'Describe these');
  assert.deepEqual(promptContent(p).attachments,p.input.content.slice(1));
});
test('normal text and unordered app equality', () => { assert.equal(promptText({ delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }), 'a\nb'); assert(sameSelection({ ...selection, appIds: ['a', 'b'] }, { ...selection, appIds: ['b', 'a'] })); });
