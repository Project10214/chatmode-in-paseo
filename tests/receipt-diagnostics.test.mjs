import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDiagnostic } from '../server/diagnostics.mjs';

test('receipt diagnostics keep counts/reason, never authored bodies, URLs or credentials', () => {
  const value=safeDiagnostic({stage:'receipt',nativeClicked:true,transcriptAvailable:false,rowCount:0,matchingUserCount:0,
    refusal:'not-accepted',text:'PRIVATE',url:'SECRET',token:'SECRET',appIds:['PRIVATE']});
  assert.deepEqual(value,{stage:'receipt',rowCount:0,matchingUserCount:0,nativeClicked:true,transcriptAvailable:false,refusal:'not-accepted'});
  assert.ok(!JSON.stringify(value).includes('SECRET'));
});
test('receipt diagnostics reject invented reason, non-boolean proof and oversized counts', () => {
  assert.deepEqual(safeDiagnostic({stage:'receipt',nativeClicked:'true',transcriptAvailable:1,matchingUserCount:999,rowCount:-1,refusal:'PRIVATE'}),{stage:'receipt'});
});
test('receipt coverage and network proof stage are bounded, never echo bodies or IDs',()=>{
  const safe=safeDiagnostic({stage:'receipt',sourceSections:8,sourceMatches:2,sourceUsers:0,
    networkStage:'request',networkRouteMoved:true,expected:'PRIVATE_BODY',url:'https://secret.test',nativeId:'PRIVATE_ID'});
  assert.deepEqual(safe,{stage:'receipt',sourceSections:8,sourceMatches:2,sourceUsers:0,
    networkStage:'request',networkRouteMoved:true});
  assert.deepEqual(safeDiagnostic({stage:'receipt',networkStage:'PRIVATE',sourceSections:900,
    sourceUsers:-2,networkRouteMoved:'yes'}),{stage:'receipt'});
});

test('app request failures expose only the allowlisted stage, not prompt or app identities', () => {
  for (const stage of ['shape','parsed','mismatch','body','response']) {
    assert.deepEqual(safeDiagnostic({stage:'receipt',networkStage:stage,
      text:'PRIVATE_PROMPT',appIds:['PRIVATE_APP'],requestBody:'PRIVATE_NETWORK_BODY'}),
    {stage:'receipt',networkStage:stage});
  }
});
