#!/usr/bin/env node
/**
 * Register one fixed macOS native-messaging launcher, scoped to the paired
 * extension. The executable is copied into a private LOCAL directory: Chrome
 * may not be allowed to execute a script on a removable/external project disk.
 * This creates no background service and never restarts Paseo or Chrome.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.foolwork.chatmode_in_paseo_wake';

export function wakeHostManifest(extensionId, executable) {
  if(!/^[a-p]{32}$/.test(extensionId)) throw new Error('INVALID_EXTENSION_ID');
  if(!path.isAbsolute(executable)) throw new Error('INVALID_HOST_PATH');
  return {name:HOST_NAME,description:'Wake Paseo for a paired Chatmode in Paseo Chrome extension',
    path:executable,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]};
}

export async function installNativeWake({
  stateDir=process.env.CIP_STATE_DIR ?? path.join(os.homedir(),'.chatmode-in-paseo'),
  manifestDir=path.join(os.homedir(),'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
  hostPath=fileURLToPath(new URL('./native-wake-host.py',import.meta.url))
}={}) {
  if(process.platform!=='darwin') throw new Error('MACOS_ONLY');

  const credential=JSON.parse(await fs.readFile(path.join(stateDir,'bridge-credential.json'),'utf8'));
  const source=await fs.realpath(hostPath);
  const hostDirectory=path.join(stateDir,'bin');
  const executable=path.join(hostDirectory,'native-wake-host.py');
  const filename=path.join(manifestDir,HOST_NAME+'.json');
  const manifest=wakeHostManifest(credential.extensionId,executable);

  // Only upgrade a manifest already pointing at our legacy project script
  // or the new private copy. Never take over a different native host.
  try {
    const previous=JSON.parse(await fs.readFile(filename,'utf8'));
    if(previous.name!==HOST_NAME || previous.type!=='stdio' ||
       ![source,executable].includes(previous.path))
      throw new Error('WAKE_HOST_PATH_CONFLICT');
  }catch(e){if(e.code!=='ENOENT')throw e;}

  await fs.mkdir(hostDirectory,{recursive:true,mode:0o700});
  await fs.mkdir(manifestDir,{recursive:true,mode:0o700});
  try{
    const existing=await fs.lstat(executable);
    if(!existing.isFile() || existing.isSymbolicLink())
      throw new Error('WAKE_HOST_BINARY_CONFLICT');
  }catch(e){if(e.code!=='ENOENT')throw e;}

  // Replace atomically, never edit the source script on the external disk.
  const hostTemp=executable+'.'+randomUUID()+'.tmp';
  try{
    await fs.writeFile(hostTemp,await fs.readFile(source),{mode:0o700,flag:'wx'});
    await fs.chmod(hostTemp,0o700);
    await fs.rename(hostTemp,executable);
  }catch(e){await fs.rm(hostTemp,{force:true});throw e;}

  const manifestTemp=filename+'.'+randomUUID()+'.tmp';
  try{
    await fs.writeFile(manifestTemp,JSON.stringify(manifest,null,2)+'\n',
      {mode:0o600,flag:'wx'});
    await fs.rename(manifestTemp,filename);
  }catch(e){await fs.rm(manifestTemp,{force:true});throw e;}

  return {installed:true,manifestPath:filename,hostPath:executable};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  installNativeWake().then(result=>
    console.log('Installed Chatmode in Paseo wake host at '+result.manifestPath),
    e=>{console.error(e.code||e.message);process.exitCode=1;});
}
