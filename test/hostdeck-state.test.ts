import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StateServices } from '../src/hostdeck/state/index.js';

const options=(root:string)=>({root,deviceId:'device_test',workspace:root,shellExecutable:process.env.SystemRoot?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'pwsh',environment:{PATH:process.env.PATH},launchJobs:false});
const ctx={ownerId:'owner_one',deviceId:'device_test',executorId:'executor_one'};
const waitFor=async<T>(fn:()=>Promise<T>,done:(v:T)=>boolean)=>{for(let i=0;i<100;i++){const v=await fn();if(done(v))return v;await new Promise(r=>setTimeout(r,100))}throw new Error('JOB_DID_NOT_FINISH')};
test('state tools scope objects by owner/device/executor and survive service recreation',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-state-'));let first:StateServices|undefined,restarted:StateServices|undefined,peer:StateServices|undefined;
 try{
  first=StateServices.create(options(root));
  const submitted=await first.handle('submit_job',{command:'Write-Output "state test"',working_directory:'.',idempotency_key:'once',timeout_seconds:30},ctx) as {job_id:string};
  assert.ok(submitted.job_id);
  const same=await first.handle('submit_job',{command:'Write-Output "state test"',working_directory:'.',idempotency_key:'once',timeout_seconds:30},ctx);
  assert.equal((same as {job_id:string}).job_id,submitted.job_id);
  await assert.rejects(first.handle('submit_job',{command:'different',working_directory:'.',idempotency_key:'once',timeout_seconds:30},ctx),/IDEMPOTENCY_CONFLICT/);
  assert.equal(await first.handle('read_job',{job_id:submitted.job_id},{...ctx,ownerId:'owner_two'}),null);
  restarted=StateServices.create(options(root));
  assert.equal((await restarted.handle('read_job',{job_id:submitted.job_id},ctx) as {job_id:string}).job_id,submitted.job_id);
  const replay=await restarted.handle('submit_job',{command:'Write-Output "state test"',working_directory:'.',idempotency_key:'once',timeout_seconds:30},ctx) as {job_id:string};assert.equal(replay.job_id,submitted.job_id);
  peer=StateServices.create(options(root));const parallel=await Promise.all([first.handle('submit_job',{command:'parallel',working_directory:root,idempotency_key:'parallel-key',timeout_seconds:30},ctx),peer.handle('submit_job',{command:'parallel',working_directory:root,idempotency_key:'parallel-key',timeout_seconds:30},ctx)]) as {job_id:string}[];assert.equal(parallel[0]!.job_id,parallel[1]!.job_id);
 }finally{await peer?.close();await restarted?.close();await first?.close();await rm(root,{recursive:true,force:true})}
});

test('Windows PowerShell job survives caller disconnect and reconciles output/exit receipt after reopen',async()=>{
 if(!process.env.SystemRoot)return;
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-state-runner-'));
 const live={...options(root),launchJobs:true};let state:StateServices|undefined;
 try{
  state=StateServices.create(live);
  const submitted=await state.handle('submit_job',{command:'[Console]::Out.Write("runner-output"); exit 7',working_directory:root,idempotency_key:'real-runner',timeout_seconds:30},ctx) as {job_id:string};
  // The client makes no further calls while the separate runner process finishes.
  const completed=await waitFor(()=>state!.handle('read_job',{job_id:submitted.job_id},ctx) as Promise<{status:string;exit_code?:number;stdout_artifact_id?:string}>,j=>['succeeded','failed','timed_out','interrupted'].includes(j.status));
  assert.equal(completed.status,'failed');assert.equal(completed.exit_code,7);assert.ok(completed.stdout_artifact_id);
  await state.close();state=undefined;
  state=StateServices.create(live);
  const job=await state.handle('read_job',{job_id:submitted.job_id},ctx) as {status:string;exit_code?:number;stdout_artifact_id?:string};
  assert.equal(job.status,'failed');assert.equal(job.exit_code,7);assert.ok(job.stdout_artifact_id);
  const output=await state.handle('read_artifact',{artifact_id:job.stdout_artifact_id,offset:0,length:65536},ctx) as {data_base64:string};
  assert.match(Buffer.from(output.data_base64,'base64').toString(),/runner-output/);
  const replay=await state.handle('submit_job',{command:'[Console]::Out.Write("runner-output"); exit 7',working_directory:root,idempotency_key:'real-runner',timeout_seconds:30},ctx) as {job_id:string};assert.equal(replay.job_id,submitted.job_id);
  assert.equal(await state.handle('read_job',{job_id:submitted.job_id},{...ctx,ownerId:'other'}),null);
 }finally{await state?.close();await new Promise(r=>setTimeout(r,250));await rm(root,{recursive:true,force:true})}
});

test('unknown names are rejected and tenant event reads are filtered',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-state-'));
 const state=StateServices.create(options(root));try{await assert.rejects(state.handle('unknown',{},ctx),/UNKNOWN_OPERATION/);assert.deepEqual(await state.handle('hostdeck_read_events',{after:0,limit:100},{...ctx,ownerId:'other'}),[]);const diag=await state.handle('diagnostics',{include_jobs:false},ctx) as {artifact_id:string;sha256:string};const data=await state.handle('read_artifact',{artifact_id:diag.artifact_id,offset:0,length:65536},ctx) as {data_base64:string;sha256:string};assert.equal(data.sha256,diag.sha256);assert.match(Buffer.from(data.data_base64,'base64').toString(),/generated_at/);assert.equal(await state.handle('read_artifact',{artifact_id:diag.artifact_id}, {...ctx,ownerId:'other'}),null);const dest=path.join(root,'applied.json');const staged=await state.handle('apply_artifact',{artifact_id:diag.artifact_id,path:'applied.json'},ctx) as {destination:string;bytes:Buffer};assert.equal(staged.destination,dest);assert.match(staged.bytes.toString(),/generated_at/);assert.ok(state.implementedTools.has('hostdeck_read_job'))}finally{await state.close();await rm(root,{recursive:true,force:true})}
});

test('native Windows runner records timeout and cancel receipts with tree containment',async()=>{
 if(!process.env.SystemRoot)return;const exe=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');if(!existsSync(exe))return;
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-state-native-'));const nativeOptions={...options(root),launchJobs:true,desktopWorkerExecutable:exe};let state=StateServices.create(nativeOptions);
 try{
  const disconnected=await state.handle('submit_job',{command:'Start-Sleep -Seconds 1; Write-Output native-receipt',working_directory:root,idempotency_key:'reopen-native',timeout_seconds:30},ctx) as {job_id:string};await state.close();await new Promise(r=>setTimeout(r,1600));state=StateServices.create(nativeOptions);const reopenedResults=await Promise.all([state.handle('read_job',{job_id:disconnected.job_id},ctx),state.handle('read_job',{job_id:disconnected.job_id},ctx)]) as {status:string;stdout_artifact_id?:string}[];assert.equal(reopenedResults[0]!.status,'succeeded');assert.ok(reopenedResults[0]!.stdout_artifact_id);assert.equal(reopenedResults[1]!.stdout_artifact_id,reopenedResults[0]!.stdout_artifact_id);
  const timed=await state.handle('submit_job',{command:'Start-Sleep -Seconds 15',working_directory:root,idempotency_key:'timeout-native',timeout_seconds:1},ctx) as {job_id:string};
  const timeout=await waitFor(()=>state.handle('read_job',{job_id:timed.job_id},ctx) as Promise<{status:string;descendants_contained?:boolean}>,j=>['timed_out','failed','interrupted'].includes(j.status));assert.equal(timeout.status,'timed_out');assert.equal(timeout.descendants_contained,true);
  const cancelled=await state.handle('submit_job',{command:'Start-Sleep -Seconds 15',working_directory:root,idempotency_key:'cancel-native',timeout_seconds:30},ctx) as {job_id:string};
  const result=await state.handle('cancel_job',{job_id:cancelled.job_id},ctx) as {cancelled:boolean;status:string};assert.equal(result.cancelled,true);
  const final=await waitFor(()=>state.handle('read_job',{job_id:cancelled.job_id},ctx) as Promise<{status:string;descendants_contained?:boolean}>,j=>j.status==='cancelled');assert.equal(final.descendants_contained,true);
 }finally{await state.close();await rm(root,{recursive:true,force:true})}
});

test('native durable runner gives commands only the explicitly supplied environment',async t=>{
 if(!process.env.SystemRoot)return;const exe=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');if(!existsSync(exe)){t.skip('Windows native desktop worker build is unavailable');return}
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-state-env-'));const id='fedcba9876543210fedcba9876543210';const paths={stdoutPath:path.join(root,`${id}.out`),stderrPath:path.join(root,`${id}.err`),receiptPath:path.join(root,`${id}.json`),cancelPath:path.join(root,`${id}.cancel`),statusMarkerPath:path.join(root,`${id}.live.json`)};
 try{const requestPath=path.join(root,`${id}.request.json`);await writeFile(requestPath,JSON.stringify({command:'Write-Output $env:HOSTDECK_PARENT_ONLY',cwd:root,shellExecutable:path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),timeoutSeconds:10,...paths,environment:{SystemRoot:process.env.SystemRoot,windir:process.env.windir,TEMP:process.env.TEMP,TMP:process.env.TMP,PATH:process.env.PATH}}));await new Promise<void>((resolve,reject)=>execFile(exe,['--run-job',requestPath],{windowsHide:true,timeout:15000,maxBuffer:16_000,env:{...process.env,HOSTDECK_PARENT_ONLY:'must-not-reach-command'}},error=>error?reject(error):resolve()));const receipt=JSON.parse(await readFile(paths.receiptPath,'utf8')) as {status:string;descendantsContained:boolean};assert.equal(receipt.status,'completed');assert.equal(receipt.descendantsContained,true);assert.equal((await readFile(paths.stdoutPath,'utf8')).trim(),'')}finally{await rm(root,{recursive:true,force:true})}
});

test('native runner writes a failed receipt when pre-effect request validation rejects a job',async t=>{
 if(!process.env.SystemRoot)return;const exe=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');if(!existsSync(exe)){t.skip('Windows native desktop worker build is unavailable');return}
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-state-startup-receipt-'));const id='0123456789abcdef0123456789abcdef';const paths={stdoutPath:path.join(root,`${id}.out`),stderrPath:path.join(root,`${id}.err`),receiptPath:path.join(root,`${id}.json`),cancelPath:path.join(root,`${id}.cancel`),statusMarkerPath:path.join(root,`${id}.live.json`)};
 try{const requestPath=path.join(root,`${id}.request.json`);await writeFile(requestPath,JSON.stringify({command:'Write-Output should-not-run',cwd:root,shellExecutable:path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),timeoutSeconds:0,...paths,environment:{SystemRoot:process.env.SystemRoot}}));await new Promise<void>((resolve,reject)=>execFile(exe,['--run-job',requestPath],{windowsHide:true,timeout:10000,maxBuffer:16_000},error=>error?reject(error):resolve()));const receipt=JSON.parse(await readFile(paths.receiptPath,'utf8')) as {status:string;descendantsContained:boolean};assert.equal(receipt.status,'failed');assert.equal(receipt.descendantsContained,false);assert.equal((await readFile(paths.stdoutPath,'utf8')).length,0);assert.equal(existsSync(paths.statusMarkerPath),false)}finally{await rm(root,{recursive:true,force:true})}
});

test('native runner survives its detached Node launcher exiting',async t=>{
 if(!process.env.SystemRoot)return;const exe=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');if(!existsSync(exe)){t.skip('Windows native desktop worker build is unavailable');return}
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-state-parent-exit-'));const id='abcdef0123456789abcdef0123456789';const paths={stdoutPath:path.join(root,`${id}.out`),stderrPath:path.join(root,`${id}.err`),receiptPath:path.join(root,`${id}.json`),cancelPath:path.join(root,`${id}.cancel`),statusMarkerPath:path.join(root,`${id}.live.json`)};
 try{const requestPath=path.join(root,`${id}.request.json`);await writeFile(requestPath,JSON.stringify({command:"Write-Output 'parent-exit-survived'; Start-Sleep -Seconds 1",cwd:root,shellExecutable:path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),timeoutSeconds:10,...paths,environment:{SystemRoot:process.env.SystemRoot,windir:process.env.windir,TEMP:process.env.TEMP,TMP:process.env.TMP,PATH:process.env.PATH}}));const launcher=`const {spawn}=require('node:child_process');const child=spawn(process.argv[1],['--run-job',process.argv[2]],{cwd:process.argv[3],env:process.env,stdio:'ignore',windowsHide:true,detached:true});child.unref();`;await new Promise<void>((resolve,reject)=>execFile(process.execPath,['-e',launcher,exe,requestPath,root],{windowsHide:true,timeout:5000,maxBuffer:16_000},error=>error?reject(error):resolve()));await waitFor(async()=>existsSync(paths.receiptPath),Boolean);const receipt=JSON.parse(await readFile(paths.receiptPath,'utf8')) as {status:string;exitCode:number;descendantsContained:boolean};assert.equal(receipt.status,'completed');assert.equal(receipt.exitCode,0);assert.equal(receipt.descendantsContained,true);assert.match(await readFile(paths.stdoutPath,'utf8'),/parent-exit-survived/)}finally{await rm(root,{recursive:true,force:true})}
});

test('native runner dead without receipt is recovered as uncertain after service reopen',async()=>{
 if(!process.env.SystemRoot)return;const exe=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');if(!existsSync(exe))return;
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-state-liveness-'));const nativeOptions={...options(root),launchJobs:true,desktopWorkerExecutable:exe};let state=StateServices.create(nativeOptions);
 try{const started=await state.handle('submit_job',{command:'Start-Sleep -Seconds 1; Write-Output should-not-be-receipted',working_directory:root,idempotency_key:'missing-dead-receipt',timeout_seconds:30},ctx) as {job_id:string};await state.close();const marker=path.join(root,'receipts',`${started.job_id}.live.json`),receipt=path.join(root,'receipts',`${started.job_id}.json`);await waitFor(async()=>existsSync(marker),Boolean);const status=async()=>await new Promise<string>(resolve=>execFile(exe,['--job-status',marker],{windowsHide:true,timeout:3000,maxBuffer:16_000},(error,stdout)=>{if(error){resolve('unknown');return}try{resolve(JSON.parse(stdout.trim()).status)}catch{resolve('unknown')}}));await waitFor(status,s=>s==='absent');await waitFor(async()=>existsSync(receipt),Boolean);await rm(receipt,{force:true});state=StateServices.create(nativeOptions);const recovered=await state.handle('read_job',{job_id:started.job_id},ctx) as {status:string;message?:string};assert.equal(recovered.status,'interrupted');assert.match(recovered.message??'',/outcome is uncertain/);}finally{await state.close();await rm(root,{recursive:true,force:true})}
});

test('uncertain live native runner remains cancellable through its private cancel file',async()=>{
 if(!process.env.SystemRoot)return;const exe=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');if(!existsSync(exe))return;
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-state-uncertain-'));const nativeOptions={...options(root),launchJobs:true,desktopWorkerExecutable:exe};let state=StateServices.create(nativeOptions);
 try{const started=await state.handle('submit_job',{command:'Start-Sleep -Seconds 30',working_directory:root,idempotency_key:'uncertain-cancel',timeout_seconds:60},ctx) as {job_id:string};await state.close();const marker=path.join(root,'receipts',`${started.job_id}.live.json`);await waitFor(async()=>existsSync(marker),Boolean);await rm(marker,{force:true});const db=new DatabaseSync(path.join(root,'state.sqlite'));try{const row=db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get('job',started.job_id) as {payload:string};const record=JSON.parse(row.payload);record.updated=new Date(Date.now()-20_000).toISOString();db.prepare('UPDATE records SET payload=? WHERE kind=? AND id=?').run(JSON.stringify(record),'job',started.job_id)}finally{db.close()}state=StateServices.create(nativeOptions);const uncertain=await state.handle('read_job',{job_id:started.job_id},ctx) as {status:string;message?:string};assert.equal(uncertain.status,'uncertain');assert.match(uncertain.message??'',/liveness is unknown/);const requested=await state.handle('cancel_job',{job_id:started.job_id},ctx) as {cancelled:boolean;status:string;outcome:string};assert.equal(requested.cancelled,true);assert.equal(requested.status,'cancelling');assert.equal(requested.outcome,'uncertain');const final=await waitFor(()=>state.handle('read_job',{job_id:started.job_id},ctx) as Promise<{status:string}>,x=>x.status==='cancelled');assert.equal(final.status,'cancelled')}finally{await state.close();await rm(root,{recursive:true,force:true})}
});

test('artifact event insertion failure rolls back metadata, quota and file',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-state-event-'));const state=StateServices.create(options(root));let injector:DatabaseSync|undefined;
 try{await state.handle('read_events',{after:0,limit:100},ctx);injector=new DatabaseSync(path.join(root,'state.sqlite'));injector.exec("CREATE TRIGGER deny_artifact_event BEFORE INSERT ON records WHEN NEW.kind='event' AND instr(NEW.payload,'artifact_created')>0 BEGIN SELECT RAISE(FAIL,'injected event failure'); END;");await assert.rejects(state.storeArtifact(ctx,Buffer.from('payload'),'failure.txt'),/injected event failure/);injector.exec('DROP TRIGGER deny_artifact_event');const artifacts=injector.prepare('SELECT COUNT(*) AS count FROM records WHERE kind=?').get('artifact') as {count:number};const usage=injector.prepare('SELECT COALESCE(SUM(used_bytes),0) AS bytes FROM artifact_usage WHERE owner_id=?').get(ctx.ownerId) as {bytes:number};assert.equal(artifacts.count,0);assert.equal(usage.bytes,0);assert.deepEqual(await readdir(path.join(root,'artifacts')),[]);assert.deepEqual(await state.handle('read_events',{after:0,limit:100},ctx),[])}finally{injector?.close();await state.close();await rm(root,{recursive:true,force:true})}
});
