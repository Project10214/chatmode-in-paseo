/**
 * Optional parity harness: execute ONLY the relevant functions from an
 * explicitly supplied, read-only pinned Paseo distribution (0.11.4, 0.12.0-beta.1 or beta.2).
 *
 * Usage:
 *   CIP_PASEO_PROVIDER_SOURCE=/path/to/extracted/plugin-provider.js
 *   CIP_PASEO_RENDERER_BUNDLE=/path/to/index-...js
 *   node --test tests/provider-timeline-host-regression.test.mjs
 *
 * No installation path defaults, no writes, no fixture modifications, and
 * no silent skip. Portable tests use the authored narrow model instead.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {PASEO_0114} from './paseo-0.11.4-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
// 0.12 beta mapper is byte-identical to 0.11.4. Its audited reducer adds only
// optional tool-call agentMessage metadata forwarding; no text/upsert/ordering fix.
const PASEO_012_BETA1 = Object.freeze({
  appVersion:'0.12.0-beta.1',
  daemonFileSha256:'dc9948ca942d2aeef10a48c4ef1fc625819005ef28296bb386cfb9737502d475',
  webBundleSha256:'b2c903a005b0da2afde8eb7f810278d374bd7425f8098597de901dea0e5a1929',
  webMetroReducerId:3664
});
// beta.2 (2026-10-18): same daemon mapper bytes; the reducer Metro module is
// identical to beta.1 after module-id normalization (installed app bundle).
const PASEO_012_BETA2 = Object.freeze({
  appVersion:'0.12.0-beta.2',
  daemonFileSha256:'dc9948ca942d2aeef10a48c4ef1fc625819005ef28296bb386cfb9737502d475',
  webBundleSha256:'e42f2a3fbb0ad0a8203df7f336da7cca6f699639d20e17d76d6efe1b44b9ce1c',
  webMetroReducerId:3664
});

// 0.12.0 final (2026-10-21): the published @getpaseo/server@0.12.0 is
// byte-identical to the installed desktop app, so this audit is reproducible
// from the registry. Against the audited 0.12.0-beta.2 the daemon mapper
// differs by three lines, all in the prompt.steer capability negotiation, and
// the agent manager by two lines, both in the agent REGISTRATION path - not
// in the pending/staged-events turn lifecycle. mapTimelineItem is byte
// identical, and the reducer keeps Metro module id 3664 with the same three
// dependencies.
const PASEO_012_FINAL = Object.freeze({
  appVersion:'0.12.0',
  daemonFileSha256:'d33af5c95b5fa06c232ad6a7a8e4f7f41926757ae77d0574fa8380ff0a774ed1',
  webBundleSha256:'5a975098ad9ec6669f1a0178c5f83a8ab7b5975c65c346531237791534f84a22',
  webMetroReducerId:3664
});
// Every host build this repository has audited, by its app version.
export const PINNED_HOST_VERSIONS=Object.freeze(
  [PASEO_0114,PASEO_012_BETA1,PASEO_012_BETA2,PASEO_012_FINAL].map(entry=>entry.appVersion));

export async function loadInstalledPaseoContract() {
  const serverPath=process.env.CIP_PASEO_PROVIDER_SOURCE;
  const rendererPath=process.env.CIP_PASEO_RENDERER_BUNDLE;
  assert.equal(Boolean(serverPath),Boolean(rendererPath),
    'Specify BOTH CIP_PASEO_PROVIDER_SOURCE and CIP_PASEO_RENDERER_BUNDLE');
  if(!serverPath)return null;

  const source=await readFile(serverPath,'utf8');
  const bundle=await readFile(rendererPath,'utf8');
  const pinned=[PASEO_0114,PASEO_012_BETA1,PASEO_012_BETA2,PASEO_012_FINAL].find(p=>p.webBundleSha256===hash(bundle));
  assert(pinned,'Paseo renderer bundle hash/version changed; update only after a new audit');
  assert.equal(hash(source),pinned.daemonFileSha256,
    'Paseo daemon file hash/version changed; update only after a new audit');

  const begin=source.indexOf('function mapTimelineItem(item, snapshots, revertTokens) {');
  const end=source.indexOf('\nfunction persistenceHandle(',begin);
  assert(begin>=0 && end>begin,'Installed mapTimelineItem definition not found');
  // Entire unmodified daemon implementation, evaluated as a detached pure
  // function. It only receives synthetic data and a test-owned Map.
  const map=vm.runInNewContext('('+source.slice(begin,end)+')');
  assert.equal(typeof map,'function');

  const entry=bundle.indexOf('.applyStreamEvent=function');
  assert(entry>=0,'Installed reducer was not found');
  function moduleAt(position) {
    const begin=bundle.lastIndexOf('__d(function(',position);
    assert(begin>=0,'Metro module start not found');
    const remain=bundle.slice(position);
    const match=/\},(\d+),\[([^\]]*)\]\);/.exec(remain);
    assert(match,'Metro module end not found');
    let registration;
    vm.runInNewContext(bundle.slice(begin,position+match.index+match[0].length),{
      __d:(factory,id,deps)=>registration={factory,id,deps}
    });
    assert(registration,'Metro module did not register');
    return registration;
  }
  const reducer=moduleAt(entry);
  assert.equal(reducer.id,pinned.webMetroReducerId);
  assert.equal(reducer.deps.length,3);
  const identityIndex=bundle.indexOf('},'+reducer.deps[1]+',[');
  assert(identityIndex>=0,'Installed identity dependency was not found');
  const identityModule=moduleAt(identityIndex);
  const identity={};
  identityModule.factory(null,()=>{throw Error('Unexpected identity module dependency');},
    null,null,{},identity,identityModule.deps);
  const exports={};
  reducer.factory(null,dependency=>{
    if(dependency===reducer.deps[0])return {__esModule:true,default:()=>{}};
    if(dependency===reducer.deps[1])return identity;
    if(dependency===reducer.deps[2])return {extractTaskEntriesFromToolCall:()=>null};
    throw Error('Unexpected Metro dependency: '+dependency);
  },null,null,{},exports,reducer.deps);
  assert.equal(typeof exports.applyStreamEvent,'function');
  return {appVersion:pinned.appVersion,source:serverPath,bundle:rendererPath,map,apply:exports.applyStreamEvent};
}

export function realTranslate(events,real,initialReplay=false) {
  const snapshots=new Map();
  let turnId=null, replaying=initialReplay;
  const translated=[];
  for(const event of events){
    if(event.type==='session.ready'){replaying=false;continue;}
    if(event.type==='session.turn'){
      if(event.state==='started')turnId=event.turnId;
      else if(turnId===event.turnId)turnId=null;
      translated.push({type:'turn_'+event.state,provider:'chatmode',
        turnId:event.turnId,_source:replaying?'replay':'live'});
      continue;
    }
    if(event.type!=='timeline.item')continue;
    const item=real.map(event.item,snapshots);
    if(item)translated.push({type:'timeline',provider:'chatmode',
      item:JSON.parse(JSON.stringify(item)),turnId:turnId??undefined,
      _source:replaying?'replay':'live'});
  }
  return translated;
}

export function realRender(events,real) {
  let tail=[],head=[],step=0;
  for(const {_source,...event} of events){
    const state=real.apply({tail,head,event,source:_source??'live',
      timestamp:new Date(Date.UTC(2026,9,16,12,0,0)+step++*1000)});
    tail=state.tail;head=state.head;
  }
  return JSON.parse(JSON.stringify([...tail,...head]));
}
