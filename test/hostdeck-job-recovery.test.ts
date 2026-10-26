import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { StateServices } from '../src/hostdeck/state/index.js';

const context = {ownerId:'owner_fixture',deviceId:'device_fixture',executorId:'executor_fixture'};
const options=(root:string)=>({root,workspace:root,deviceId:context.deviceId,
  shellExecutable:'unused-in-fixture',environment:{},launchJobs:false});
const submission={command:'Write-Output fixture-only',working_directory:'.',
  idempotency_key:'resume-never-fixture',timeout_seconds:20};

async function reserved(root:string, status:'running'|'cancelling'='cancelling') {
  const first=StateServices.create(options(root));
  const accepted=await first.handle('submit_job',submission,context) as {job_id:string;status:string};
  assert.equal(accepted.status,'queued','launchJobs:false never spawns a command');
  await first.close();
  const db=new DatabaseSync(path.join(root,'state.sqlite'));
  try{
    const saved=db.prepare("SELECT payload FROM records WHERE kind='job' AND id=?").get(accepted.job_id) as {payload:string};
    const job=JSON.parse(saved.payload);
    job.status=status;
    job.error='Cancellation requested; runner completion remains uncertain until its receipt is reconciled.';
    db.prepare("UPDATE records SET payload=? WHERE kind='job' AND id=?")
      .run(JSON.stringify(job),accepted.job_id);
  }finally{db.close()}
  const receiptRoot=path.join(root,'receipts');
  return {id:accepted.job_id,root:receiptRoot,
    receipt:path.join(receiptRoot,accepted.job_id+'.json'),
    stdout:path.join(receiptRoot,accepted.job_id+'.out'),
    stderr:path.join(receiptRoot,accepted.job_id+'.err'),
    cancel:path.join(receiptRoot,accepted.job_id+'.cancel')};
}
async function emitReceipt(files:Awaited<ReturnType<typeof reserved>>,value:unknown){
  await writeFile(files.receipt,JSON.stringify(value),{flag:'wx'});
  await writeFile(files.stdout,Buffer.from('known stdout bytes','utf8'),{flag:'wx'});
  await writeFile(files.stderr,Buffer.from('known stderr bytes','utf8'),{flag:'wx'});
}

test('R04-B003-F015 confirmed cancellation clears obsolete uncertainty and retains owned artifacts',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-job-f015-'));
  let state:StateServices|undefined;
  try{
    const files=await reserved(root);
    await emitReceipt(files,{status:'cancelled',exitCode:null,descendantsContained:true});
    state=StateServices.create(options(root));
    const first=await state.handle('read_job',{job_id:files.id},context) as
      {job_id:string;status:string;message?:string;descendants_contained?:boolean;stdout_artifact_id?:string;stderr_artifact_id?:string};
    assert.equal(first.status,'cancelled');
    assert.equal(first.descendants_contained,true);
    assert.equal(first.message,undefined,'obsolete cancellation-warning must be removed');
    assert.ok(first.stdout_artifact_id);
    assert.ok(first.stderr_artifact_id);
    const stdout=await state.handle('read_artifact',{artifact_id:first.stdout_artifact_id},context) as {data_base64:string};
    assert.equal(Buffer.from(stdout.data_base64,'base64').toString(),'known stdout bytes');
    assert.equal(await state.handle('read_artifact',{artifact_id:first.stdout_artifact_id},
      {...context,ownerId:'someone_else'}),null);
    const again=await state.handle('read_job',{job_id:files.id},context);
    assert.deepEqual(again,first,'reconciliation must be idempotent');
    assert.equal(existsSync(files.receipt),false,'successful reconciliation cleans owned receipt');
    const reused=await state.handle('submit_job',submission,context) as {job_id:string;status:string};
    assert.equal(reused.job_id,files.id,'same key cannot replay accepted command');
    assert.equal(reused.status,'cancelled');
  }finally{await state?.close();await rm(root,{recursive:true,force:true})}
});

test('missing descendant containment keeps cancelled receipt uncertain and never deletes raw evidence',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-job-uncontained-'));
  let state:StateServices|undefined;
  try{
    const files=await reserved(root);
    await emitReceipt(files,{status:'cancelled',exitCode:null,descendantsContained:false});
    state=StateServices.create(options(root));
    const result=await state.handle('read_job',{job_id:files.id},context) as
      {status:string;message?:string;descendants_contained?:boolean};
    assert.equal(result.status,'uncertain');
    assert.equal(result.descendants_contained,false);
    assert.match(result.message??'',/not confirmed|uncertain/i);
    assert.equal(existsSync(files.receipt),true);
    assert.equal((await readFile(files.stdout,'utf8')),'known stdout bytes');
    const denied=await state.handle('cancel_job',{job_id:files.id},context) as {cancelled:boolean;outcome:string};
    assert.equal(denied.cancelled,false,'unconfirmed tree must not be targeted via a stale marker');
    assert.equal(denied.outcome,'uncertain');
    assert.deepEqual(await readdir(path.join(root,'receipts')).then(rows=>rows.filter(x=>x.endsWith('.cancel'))),[]);
  }finally{await state?.close();await rm(root,{recursive:true,force:true})}
});

test('a terminal receipt already on disk wins a racing native cancel request',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-job-race-'));
  let state:StateServices|undefined;
  try{
    const files=await reserved(root,'running');
    await emitReceipt(files,{status:'completed',exitCode:0,descendantsContained:true});
    // No native worker is launched. The receipt is consumed before any
    // cancellation file is written; the executable path is never invoked.
    state=StateServices.create({...options(root),desktopWorkerExecutable:path.join(root,'unused.exe')});
    const cancel=await state.handle('cancel_job',{job_id:files.id},context) as
      {cancelled:boolean;status:string};
    assert.equal(cancel.cancelled,false);
    assert.equal(cancel.status,'succeeded');
    assert.equal(existsSync(files.cancel),false);
    const final=await state.handle('read_job',{job_id:files.id},context) as {status:string};
    assert.equal(final.status,'succeeded');
  }finally{await state?.close();await rm(root,{recursive:true,force:true})}
});

test('artifact failure does not discard private original outputs or pretend they were retained',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-job-artifact-fail-'));
  let state:StateServices|undefined;
  try{
    const files=await reserved(root);
    await emitReceipt(files,{status:'completed',exitCode:0,descendantsContained:true});
    state=StateServices.create(options(root));
    await state.handle('read_events',{after:0,limit:10},context);
    // Destructively affect ONLY this disposable test's empty artifact folder.
    await rm(path.join(root,'artifacts'),{recursive:true,force:true});
    const result=await state.handle('read_job',{job_id:files.id},context) as
      {status:string;message?:string;stdout_artifact_id?:string};
    assert.equal(result.status,'succeeded');
    assert.match(result.message??'',/artifact retention failed/);
    assert.equal(result.stdout_artifact_id,undefined);
    assert.equal(existsSync(files.receipt),true,'original source retained after partial failure');
    assert.equal((await readFile(files.stdout,'utf8')),'known stdout bytes');
    assert.equal((await readFile(files.stderr,'utf8')),'known stderr bytes');
  }finally{await state?.close();await rm(root,{recursive:true,force:true})}
});

test('non-native runner kill acknowledgment remains outcome-uncertain (stub; no OS process)',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-job-legacy-'));
  const state=StateServices.create(options(root));
  try{
    const entry=await state.handle('submit_job',submission,context) as {job_id:string};
    let signals=0;
    const internals=state as unknown as {children:Map<string,{exitCode:number|null;kill:()=>boolean}>};
    internals.children.set(entry.job_id,{exitCode:null,kill:()=>{signals++;return true}});
    const result=await state.handle('cancel_job',{job_id:entry.job_id},context) as
      {cancelled:boolean;status:string;outcome:string;descendants:string};
    assert.equal(signals,1);
    assert.deepEqual(result,{cancelled:true,status:'uncertain',descendants:'unknown',outcome:'uncertain'});
    const events=await state.handle('read_events',{after:0,limit:30},context) as {type:string}[];
    assert.ok(events.some(event=>event.type==='job_cancel_requested'));
    assert.ok(!events.some(event=>event.type==='job_cancelled'));
  }finally{await state.close();await rm(root,{recursive:true,force:true})}
});

test('real Windows native cancel contains its own delayed descendant, not unrelated processes',async t=>{
  if(process.platform!=='win32'||!process.env.SystemRoot){
    t.skip('Windows native worker required');return;
  }
  const exe=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
  if(!existsSync(exe)){t.skip('Native worker has not been built for this fixture');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-job-owned-tree-'));
  const shell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const marker=path.join(root,'owned-descendant-wrote.txt');
  const startMarker=path.join(root,'owned-shell-started.txt');
  const quoted=(s:string)=>s.replace(/'/g,"''");
  const delayed="Start-Sleep -Seconds 3; [IO.File]::WriteAllText('"+quoted(marker)+"','late-output')";
  const encoded=Buffer.from(delayed,'utf16le').toString('base64');
  const command="$ownedChild=Start-Process -FilePath '"+quoted(shell)+
    "' -ArgumentList '-NoLogo -NoProfile -NonInteractive -EncodedCommand "+encoded+
    "' -PassThru -ErrorAction Stop; if($ownedChild.HasExited){throw 'CHILD_FAILED_TO_START'}; "+
    "[IO.File]::WriteAllText('"+quoted(startMarker)+"','ready'); Start-Sleep -Seconds 12";
  const native={...options(root),launchJobs:true,shellExecutable:shell,desktopWorkerExecutable:exe,
    environment:{SystemRoot:process.env.SystemRoot,windir:process.env.windir,
      TEMP:process.env.TEMP,TMP:process.env.TMP}};
  const state=StateServices.create(native);
  let jobId: string | undefined;
  let contained=false;
  try{
    const accepted=await state.handle('submit_job',{command,working_directory:'.',
      idempotency_key:'own-descendant-cancel',timeout_seconds:25},context) as {job_id:string};
    jobId=accepted.job_id;
    let started=false;
    for(let i=0;i<150;i++){
      if(existsSync(startMarker)){started=true;break;}
      await new Promise(resolve=>setTimeout(resolve,60));
    }
    assert.equal(started,true,'fixture started its own descendant before cancellation');
    const requested=await state.handle('cancel_job',{job_id:accepted.job_id},context) as
      {cancelled:boolean;status:string;outcome:string;descendants:string};
    assert.equal(requested.cancelled,true);
    assert.equal(requested.status,'cancelling');
    assert.equal(requested.outcome,'uncertain');
    let final: {status:string;message?:string;descendants_contained?:boolean}|undefined;
    for(let i=0;i<150;i++){
      final=await state.handle('read_job',{job_id:accepted.job_id},context) as typeof final;
      if(final?.status==='cancelled')break;
      await new Promise(resolve=>setTimeout(resolve,80));
    }
    assert.equal(final?.status,'cancelled');
    assert.equal(final?.descendants_contained,true);
    contained=true;
    assert.ok(!final?.message?.includes('until its receipt is reconciled'));
    await new Promise(resolve=>setTimeout(resolve,3400));
    assert.equal(existsSync(marker),false,'cancelled tree cannot produce delayed descendant output');
    const replay=await state.handle('submit_job',{command,working_directory:'.',
      idempotency_key:'own-descendant-cancel',timeout_seconds:25},context) as {job_id:string};
    assert.equal(replay.job_id,accepted.job_id,'resume:never / idempotency unchanged');
  }finally{
    if(jobId&&!contained){
      // Failure cleanup can only ask the SAME owned native job to cancel.
      // If no positive owned-job receipt follows, preserve its private root
      // for Codex inspection rather than erasing recovery evidence.
      try{
        await state.handle('cancel_job',{job_id:jobId},context);
        for(let i=0;i<60;i++){
          const progress=await state.handle('read_job',{job_id:jobId},context) as
            {status:string;descendants_contained?:boolean};
          if(progress.descendants_contained===true &&
              ['succeeded','failed','interrupted','cancelled','timed_out'].includes(progress.status)){
            contained=true;break;
          }
          await new Promise(resolve=>setTimeout(resolve,80));
        }
      }catch{t.diagnostic('Owned-job cleanup request failed; preserve isolated fixture for review.');}
    }
    await state.close();
    if(contained||!jobId)await rm(root,{recursive:true,force:true});
    else t.diagnostic('Owned-job containment unconfirmed; isolated fixture preserved, never clear raw receipt or unrelated processes.');
  }
});
