import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChromeWake, launchStandardChrome } from '../server/chrome-wake.mjs';
import { HOST_NAME, wakeHostManifest, installNativeWake } from '../scripts/install-native-wake.mjs';

test('WAKE1 an online paired browser is used without touching Chrome',async()=>{
  let launched=0;
  const wake=createChromeWake({platform:'darwin',launch:async()=>{launched++;}});
  assert.deepEqual(await wake({status:()=>({connected:true,paired:true})}),{ready:true,launched:false});
  assert.equal(launched,0);
});
test('WAKE2 concurrent offline prompts launch Chrome once and resume when extension connects',async()=>{
  let opens=0,online=false,ticks=0;
  const wake=createChromeWake({platform:'darwin',launch:async()=>{opens++;},
    pause:async()=>{ticks++;if(ticks===2)online=true;},attempts:5});
  const status=()=>({paired:true,connected:online});
  const [a,b]=await Promise.all([wake({status}),wake({status})]);
  assert.deepEqual(a,{ready:true,launched:true});assert.deepEqual(b,a);
  assert.equal(opens,1);
});
test('WAKE3 an unavailable or unpaired browser never queues an unproven Send',async()=>{
  let opens=0;
  const wake=createChromeWake({platform:'darwin',launch:async()=>{opens++;},pause:async()=>{},attempts:2});
  await assert.rejects(wake({status:()=>({paired:false,connected:false})}),/BROWSER_NOT_PAIRED/);
  await assert.rejects(wake({status:()=>({paired:true,connected:false})}),/BROWSER_UNAVAILABLE/);
  assert.equal(opens,1);
});
test('WAKE4 platform errors, launch failures and canceled requests are explicit',async()=>{
  const down=()=>({paired:true,connected:false});
  await assert.rejects(createChromeWake({platform:'linux'})({status:down}),/BROWSER_WAKE_UNSUPPORTED/);
  await assert.rejects(createChromeWake({platform:'darwin',launch:async()=>{throw Error('not installed');}})({status:down}),/BROWSER_START_FAILED/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(createChromeWake({platform:'darwin'})({status:down,signal:abort.signal}),/SEND_CANCELLED/);
});
test('WAKE5 Chrome host manifest restricts the native launcher to one exact extension',()=>{
  const id='a'.repeat(32),expected=`chrome-extension://${id}/`;
  const m=wakeHostManifest(id,'/opt/cip/scripts/native-wake-host.py');
  assert.equal(m.name,HOST_NAME);assert.deepEqual(m.allowed_origins,[expected]);
  assert.equal(m.type,'stdio');
  for(const bad of ['../malicious','a'.repeat(31),'A'.repeat(32),id+'/',id+';other'])
    assert.throws(()=>wakeHostManifest(bad,'/opt/cip/scripts/native-wake-host.py'),/INVALID_EXTENSION_ID/);
  assert.throws(()=>wakeHostManifest(id,'./relative'),/INVALID_HOST_PATH/);
});
test('WAKE6 native host installer writes only a scoped, explicit allowed-origin manifest',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS native messaging');return;}
  const tmp=await mkdtemp(path.join(os.tmpdir(),'cip-host-test-'));
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  const stateDir=path.join(tmp,'state'),manifestDir=path.join(tmp,'ChromeNativeHost');
  const {mkdir}=await import('node:fs/promises');
  await mkdir(stateDir);const hostPath=path.join(tmp,'host.py');
  await writeFile(hostPath,'#!/usr/bin/python3\n');
  await writeFile(path.join(stateDir,'bridge-credential.json'),
    JSON.stringify({extensionId:'b'.repeat(32),token:'not-output'}));
  const result=await installNativeWake({stateDir,manifestDir,hostPath});
  const raw=await readFile(result.manifestPath,'utf8'),m=JSON.parse(raw);
  const {realpath,stat}=await import('node:fs/promises');
  assert.equal(m.path,path.join(stateDir,'bin','native-wake-host.py'));
  assert.equal(m.path,result.hostPath);
  assert.notEqual(m.path,await realpath(hostPath),'Chrome must run a local copy, not external source');
  assert.equal(await readFile(m.path,'utf8'),await readFile(hostPath,'utf8'));
  assert.equal((await stat(m.path)).mode&0o777,0o700);
  assert.deepEqual(m.allowed_origins,['chrome-extension://'+'b'.repeat(32)+'/']);
  assert.ok(!raw.includes('not-output'));
  await installNativeWake({stateDir,manifestDir,hostPath}); // idempotent
  await writeFile(result.manifestPath,JSON.stringify({...m,path:'/tmp/other-host'}));
  await assert.rejects(installNativeWake({stateDir,manifestDir,hostPath}),/WAKE_HOST_PATH_CONFLICT/);
});
test('WAKE7 host rejects arbitrary requests and only launches the fixed Paseo app',async t=>{
  const {spawnSync}=await import('node:child_process');
  const script="import importlib.util; p='scripts/native-wake-host.py'; spec=importlib.util.spec_from_file_location('wake',p); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); calls=[]; fake=lambda *a,**k:calls.append((a,k)); assert m.handle({'v':1,'action':'eval','command':'rm -rf /'},fake)['ok'] is False; assert m.handle({'v':1,'action':'wake'},fake)['ok'] is True; assert len(calls)==1; assert calls[0][0][0]==['/usr/bin/open','-g','-a','Paseo']; print('host-pass')";
  const p=spawnSync('/usr/bin/python3',['-c',script],{cwd:process.cwd(),encoding:'utf8'});
  if(p.error?.code==='ENOENT'){t.skip('system python unavailable');return;}
  assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/host-pass/);
});

test('WAKE8 stale Runtime status after Chrome quit triggers launch despite connected=true',async()=>{
  let launches=0,clock=Date.now(),fresh=false;
  const wake=createChromeWake({platform:'darwin',launch:async()=>{launches++;fresh=true;},
    pause:async()=>{},attempts:2});
  const status=()=>({paired:true,connected:true,lastSeenAt:fresh?Date.now():clock-45000});
  assert.deepEqual(await wake({status}),{ready:true,launched:true});
  assert.equal(launches,1);
});

test('WAKE9 existing external-disk native host registration migrates to the private local copy',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS native messaging');return;}
  const tmp=await mkdtemp(path.join(os.tmpdir(),'cip-host-migration-'));
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  const stateDir=path.join(tmp,'state'),manifestDir=path.join(tmp,'ChromeNativeHost');
  const {mkdir}=await import('node:fs/promises');
  await mkdir(stateDir);await mkdir(manifestDir);
  const source=path.join(tmp,'legacy-host.py');
  await writeFile(source,'#!/usr/bin/python3\n# known legacy host\n');
  const extensionId='c'.repeat(32);
  await writeFile(path.join(stateDir,'bridge-credential.json'),JSON.stringify({extensionId,token:'not-in-manifest'}));
  const realSource=await (await import('node:fs/promises')).realpath(source);
  await writeFile(path.join(manifestDir,HOST_NAME+'.json'),JSON.stringify(wakeHostManifest(extensionId,realSource)));
  const moved=await installNativeWake({stateDir,manifestDir,hostPath:source});
  const actual=JSON.parse(await readFile(moved.manifestPath,'utf8'));
  assert.equal(actual.path,path.join(stateDir,'bin','native-wake-host.py'));
  assert.deepEqual(actual.allowed_origins,['chrome-extension://'+extensionId+'/']);
  assert.equal(await readFile(actual.path,'utf8'),await readFile(source,'utf8'));
  assert.equal(await readFile(source,'utf8'),'#!/usr/bin/python3\n# known legacy host\n');
});

test('WAKE10 macOS launch creates default Chrome even while other isolated profiles exist',async()=>{
  const calls=[];
  await launchStandardChrome(async (binary,args,options)=>{
    calls.push({binary,args,options});
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].binary,'/usr/bin/open');
  assert.deepEqual(calls[0].args,['-g','-n','-a','Google Chrome']);
  assert.equal(calls[0].options.timeout,10000);
  assert(!calls[0].args.some(a=>/--user-data-dir|--remote-debugging|--app=|chatgpt/.test(a)),
    'never alter the users profile, launch a debugger, or navigate privately');
});
