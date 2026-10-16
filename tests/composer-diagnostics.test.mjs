import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDiagnostic } from '../server/diagnostics.mjs';

test('composer diagnostics retain bounded structure and lifecycle facts, never draft content', () => {
  const facts = {stage:'composer',checkpoint:'configure-start',draftDiagnosticsVersion:1,
    extensionVersion:'0.2.17',editorTag:'DIV',readyState:'complete',
    draftChars:42,rawChars:60,visibleChars:42,editableChars:42,nonEditableChars:18,
    hiddenChars:0,placeholderChars:0,zeroWidthChars:0,valueChars:0,
    textNodes:3,appCount:1,msSinceInjection:120,msSinceReady:1,injectionDraftChars:0,readyDraftChars:0,
    initiallyEmpty:true,emptyAtInjection:true,editorReplaced:false,hasPaseoContextHeader:true,
    sameEditorSinceInjection:true,snapshotTruncated:false};
  const output=safeDiagnostic({...facts,text:'PRIVATE_DRAFT',html:'<div>PRIVATE_DRAFT</div>',
    url:'https://private.example',token:'SECRET',attributes:{placeholder:'PRIVATE_DRAFT'}});
  assert.deepEqual(output,facts);
  assert(!JSON.stringify(output).includes('PRIVATE'));
  assert(!JSON.stringify(output).includes('SECRET'));
});

test('composer diagnostics reject unknown strings, unbounded counts and non-boolean facts', () => {
  assert.deepEqual(safeDiagnostic({stage:'composer',checkpoint:'PRIVATE',draftDiagnosticsVersion:9,
    extensionVersion:'PRIVATE',editorTag:'PRIVATE',readyState:'PRIVATE',
    draftChars:64001,rawChars:-1,visibleChars:1.5,textNodes:129,appCount:999,
    msSinceInjection:60001,initiallyEmpty:'yes',emptyAtInjection:1,
    hasPaseoContextHeader:'PRIVATE',snapshotTruncated:'false'}),{stage:'composer'});
});

test('composer diagnostics cannot be smuggled through another stage', () => {
  assert.deepEqual(safeDiagnostic({stage:'receipt',checkpoint:'configure-start',
    draftChars:12,extensionVersion:'0.2.17',hasPaseoContextHeader:true}),{stage:'receipt'});
});
