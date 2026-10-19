import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectDesktopIdentity } from '../src/hostdeck/desktop.js';
import { ProcessAdapter, type ProcessContext } from '../src/hostdeck/processes.js';

const executable=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
const env=Object.fromEntries(Object.entries(process.env).filter((x):x is [string,string]=>typeof x[1]==='string'&&!/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/i.test(x[0])));

test('native interactive PowerShell input/output and Job Object descendant termination',async t=>{
 if(!process.env.SystemRoot||!existsSync(executable)){t.skip('Windows native desktop worker build is unavailable');return}
 const identity=await inspectDesktopIdentity(executable);assert.ok(identity.sid);assert.ok(identity.session_id>0);
 if(!identity.eligible||identity.integrity.toLowerCase()!=='medium'){t.skip(`Current Windows desktop is not eligible (elevated=${identity.elevated}, integrity=${identity.integrity}, session=${identity.session_id}, desktop=${identity.input_desktop}, station=${identity.window_station})`);return}
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-process-'));const context:ProcessContext={ownerId:'process_owner_a',deviceId:'device_test',executorId:'executor_test',sessionId:identity.session_id,sessionIds:[identity.session_id]};
 const adapter=await ProcessAdapter.create({executable,expectedSid:identity.sid!,identity,workspace:root,shells:{powershell:path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),cmd:path.join(process.env.SystemRoot!,'System32','cmd.exe')},environment:env,reauthorize:async()=>{}});
 try{
  const first=await adapter.handle('hostdeck_start_process',{command:"[Console]::Out.WriteLine('READY'); $line=[Console]::In.ReadLine(); [Console]::Out.WriteLine('GOT:'+ $line)",shell:'powershell',timeout_ms:3000},context) as {process_id:string;output:string;state:string};
  assert.equal(first.state,'running');assert.match(first.output,/READY/);
  const after=await adapter.handle('hostdeck_interact_process',{process_id:first.process_id,input:'pipe-input\n',timeout_ms:3000},context) as {output:string;input_delivery:string};assert.equal(after.input_delivery,'written_to_pipe');assert.match(after.output,/GOT:pipe-input/);
  await assert.rejects(adapter.handle('hostdeck_read_process',{process_id:first.process_id,timeout_ms:1},{...context,ownerId:'process_owner_b'}),/UNKNOWN_PROCESS/);
  const marker=path.join(root,'descendant.txt').replace(/'/g,"''");
  const tree=await adapter.handle('hostdeck_start_process',{command:`$child="Start-Sleep -Seconds 3; [IO.File]::WriteAllText('${marker}','alive')"; Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command',$child) | Out-Null; [Console]::Out.WriteLine('TREE_READY'); Start-Sleep -Seconds 30`,shell:'powershell',timeout_ms:2000},context) as {process_id:string;output:string};
  assert.match(tree.output,/TREE_READY/);const stopped=await adapter.handle('hostdeck_terminate_process',{process_id:tree.process_id,action:'terminate'},context) as {terminated:boolean;descendants_contained:boolean};assert.equal(stopped.terminated,true);assert.equal(stopped.descendants_contained,true);
  await new Promise(r=>setTimeout(r,3500));assert.equal(existsSync(path.join(root,'descendant.txt')),false);
 }finally{await adapter.dispose();await rm(root,{recursive:true,force:true})}
});

test('process adapter refuses to start a process without reauthorization or the configured session',async()=>{
 const identity={sid:'S-1-5-21-1',account:'user',logon_id:'1',session_id:1,elevated:false,integrity:'medium',input_desktop:'Default',window_station:'WinSta0',eligible:true};
 const adapter=await ProcessAdapter.create({executable,expectedSid:identity.sid,identity,workspace:process.cwd(),shells:{},environment:{}});
 try{await assert.rejects(adapter.handle('start_process',{command:'whoami',shell:'powershell'},{ownerId:'o',deviceId:'d',executorId:'e',sessionId:2}),/WRONG_SESSION/)}finally{await adapter.dispose()}
});
