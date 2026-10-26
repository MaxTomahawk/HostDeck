import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StateServices} from '../src/hostdeck/state/index.js';

test('native job expands the Windows system drive without leaking filtered environment', {timeout:20_000}, async t=>{
  const worker=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
  if(process.platform!=='win32'||!process.env.SystemRoot||!existsSync(worker)){t.skip('Built Windows worker required');return;}
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-job-systemdrive-')));
  const caller={ownerId:'systemdrive-fixture',deviceId:'fixture-device',executorId:'fixture-executor'};
  const state=StateServices.create({root,workspace:root,deviceId:caller.deviceId,
    desktopWorkerExecutable:worker,shellExecutable:path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    environment:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,HOSTDECK_SECRET:'test-only-sentinel'}});
  let contained=false;
  try{
    const command="$d=[Environment]::ExpandEnvironmentVariables('%SystemDrive%'); Write-Output ('DRIVE|'+$d); Write-Output ('SECRET_PRESENT|'+[bool]$env:HOSTDECK_SECRET); if($d -notmatch '^[A-Za-z]:$'){exit 23}; exit 0";
    const job=await state.handle('submit_job',{command,working_directory:'.',idempotency_key:'own-systemdrive-fixture',timeout_seconds:10,resume:'never'},caller) as {job_id:string};
    let final:{status:string;descendants_contained?:boolean;stdout_artifact_id?:string}|undefined;
    const deadline=Date.now()+12_000;
    while(Date.now()<deadline){final=await state.handle('read_job',{job_id:job.job_id},caller) as typeof final;if(final&&['succeeded','failed','timed_out','cancelled','interrupted'].includes(final.status))break;await new Promise(r=>setTimeout(r,80));}
    contained=final?.descendants_contained===true;
    assert.equal(contained,true,'own job must reach confirmed containment');
    const output=await state.handle('read_artifact',{artifact_id:final!.stdout_artifact_id,offset:0,length:65536},caller) as {data_base64:string};
    const text=Buffer.from(output.data_base64,'base64').toString('utf8');
    assert.match(text,/DRIVE\|[A-Za-z]:/,'Windows must not create relative literal %SystemDrive% cache paths');
    assert.match(text,/SECRET_PRESENT\|False/,'adding a required OS variable must not leak filtered values');
    assert.equal(final!.status,'succeeded');
    assert.equal(existsSync(path.join(root,'%SystemDrive%')),false);
  }finally{
    await state.close();
    if(contained){assert.equal(path.dirname(root),await realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('hd-job-systemdrive-'));await rm(root,{recursive:true,force:true});}
    else t.diagnostic('Owned native fixture preserved because containment was not confirmed.');
  }
});
