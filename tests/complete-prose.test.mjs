import test from 'node:test';
import assert from 'node:assert/strict';
import {decodePublicProse} from '../shared/public-prose.mjs';
test('complete prose: ordinary text is byte-preserved, no trimming or newline rewrite',()=>{
 const text='  文本 😀\r\n末尾 \t';assert.equal(decodePublicProse({text,format:'text'}),text);
});
test('complete prose: one-shot DIL decode handles complete formula, code and escapes without frame state',()=>{
 for(const [text,want]of [[String.raw`公式 \(x\)`,String.raw`公式 \(x\)`],[String.raw`说明 \!`,'说明 !'],['```js\n\\(x\\)\n```','```js\n\\(x\\)\n```']])
  assert.equal(decodePublicProse({text,format:'dil'}),want);
 assert.equal(decodePublicProse({text:'B',format:'text'}),'B');
 assert.equal(decodePublicProse({text:'A',format:'text'}),'A','there is no sticky cross-message cache');
});
test('complete prose: unknown formats and oversized input are refused, not guessed',()=>{
 for(const value of [{format:'html',text:'x'},{format:'dil',text:42},{format:'text',text:'x'.repeat(256001)}])assert.throws(()=>decodePublicProse(value));
});
