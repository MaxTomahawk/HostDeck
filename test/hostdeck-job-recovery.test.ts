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
  // Job metadata records native protocol at reservation, even when the fixture
  // suppresses process launch. No executable is called here.
  const first=StateServices.create({...options(root),desktopWorkerExecutable:path.join(root,'unused-native.exe')});
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

test('real Windows native cancel contains its own delayed descendant, not unrelated processes', {timeout:50_000}, async t=>{
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
    const receiptDeadline=Date.now()+16_000;
    while(Date.now()<receiptDeadline){
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
        const cleanupDeadline=Date.now()+6_000;
        while(Date.now()<cleanupDeadline){
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


test('HD-B007-NATIVE-RECEIPT-SHAPE-001 damaged native receipt cannot downgrade on reopen',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-native-protocol-'));
  let state:StateServices|undefined;
  try{
    // launchJobs:false: only private durable metadata and a simulated receipt.
    const files=await reserved(root,'running');
    const db=new DatabaseSync(path.join(root,'state.sqlite'));
    try{
      const row=db.prepare("SELECT payload FROM records WHERE kind='job' AND id=?").get(files.id) as {payload:string};
      assert.equal(JSON.parse(row.payload).runnerProtocol,'native-job-object-v1',
        'trusted protocol is persisted before any runner is launched');
    }finally{db.close()}
    const damaged={exitCode:0,stdout:'',stderr:''};
    await emitReceipt(files,damaged);
    state=StateServices.create({...options(root),desktopWorkerExecutable:path.join(root,'unused-native.exe')});
    const got=await state.handle('read_job',{job_id:files.id},context) as
      {job_id:string;status:string;message?:string;descendants_contained?:boolean;
        stdout_artifact_id?:string;stderr_artifact_id?:string};
    assert.equal(got.status,'uncertain','damaged native receipt must not be reported succeeded');
    assert.notEqual(got.descendants_contained,true);
    assert.match(got.message??'',/Native runner receipt is missing/);
    assert.equal(got.stdout_artifact_id,undefined);
    assert.equal(got.stderr_artifact_id,undefined);
    assert.deepEqual(JSON.parse(await readFile(files.receipt,'utf8')),damaged,
      'raw untrusted native receipt remains exactly available');
    assert.equal(await readFile(files.stdout,'utf8'),'known stdout bytes');
    assert.equal(await readFile(files.stderr,'utf8'),'known stderr bytes');
    assert.equal(await state.handle('read_job',{job_id:files.id},
      {...context,ownerId:'another_owner'}),null,'owner binding remains strict');
    const repeat=await state.handle('submit_job',submission,context) as {job_id:string;status:string};
    assert.equal(repeat.job_id,files.id,'existing key must not launch a new command');
    assert.equal(repeat.status,'uncertain');
    await state.close();state=undefined;
    // Runtime configuration may have changed; the original job protocol cannot.
    state=StateServices.create(options(root));
    const reopened=await state.handle('read_job',{job_id:files.id},context) as
      {status:string;message?:string};
    assert.equal(reopened.status,'uncertain');
    assert.equal(existsSync(files.receipt),true,'reopen cannot erase ambiguous effect evidence');
  }finally{await state?.close();await rm(root,{recursive:true,force:true})}
});

test('known legacy job keeps exit semantics across reopen without claiming containment',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-known-legacy-'));
  let first:StateServices|undefined,reopened:StateServices|undefined;
  try{
    first=StateServices.create(options(root));
    const job=await first.handle('submit_job',submission,context) as {job_id:string;status:string};
    assert.equal(job.status,'queued');
    await first.close();first=undefined;
    const db=new DatabaseSync(path.join(root,'state.sqlite'));
    try{
      const old=db.prepare("SELECT payload FROM records WHERE kind='job' AND id=?").get(job.job_id) as {payload:string};
      const j=JSON.parse(old.payload);
      assert.equal(j.runnerProtocol,'legacy-powershell-v1');
      j.status='running';
      db.prepare("UPDATE records SET payload=? WHERE kind='job' AND id=?")
        .run(JSON.stringify(j),job.job_id);
    }finally{db.close()}
    const fileRoot=path.join(root,'receipts');
    const receipt=path.join(fileRoot,job.job_id+'.json');
    const stdout=path.join(fileRoot,job.job_id+'.out');
    const stderr=path.join(fileRoot,job.job_id+'.err');
    const raw={exitCode:0,timedOut:false,stdout:'',stderr:''};
    await writeFile(receipt,JSON.stringify(raw),{flag:'wx'});
    await writeFile(stdout,'actual legacy stdout',{flag:'wx'});
    await writeFile(stderr,'',{flag:'wx'});
    // Even a different current runtime selection may not reinterpret legacy
    // metadata as a native receipt or fabricate descendant containment.
    reopened=StateServices.create({...options(root),desktopWorkerExecutable:path.join(root,'unused-native.exe')});
    const result=await reopened.handle('read_job',{job_id:job.job_id},context) as
      {status:string;exit_code?:number;message?:string;descendants_contained?:boolean;stdout_artifact_id?:string};
    assert.equal(result.status,'succeeded');
    assert.equal(result.exit_code,0);
    assert.equal(result.descendants_contained,undefined);
    assert.match(result.message??'',/no verified descendant-containment/);
    assert.ok(result.stdout_artifact_id);
    const artifact=await reopened.handle('read_artifact',{artifact_id:result.stdout_artifact_id},context) as {data_base64:string};
    assert.equal(Buffer.from(artifact.data_base64,'base64').toString(),'actual legacy stdout');
    const repeat=await reopened.handle('submit_job',submission,context) as {job_id:string};
    assert.equal(repeat.job_id,job.job_id);
  }finally{
    await reopened?.close();await first?.close();
    await rm(root,{recursive:true,force:true});
  }
});

test('historic protocol-less job stays uncertain and keeps private receipt bytes',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-unknown-protocol-'));
  let state:StateServices|undefined;
  try{
    const files=await reserved(root,'running');
    const db=new DatabaseSync(path.join(root,'state.sqlite'));
    try{
      const old=db.prepare("SELECT payload FROM records WHERE kind='job' AND id=?").get(files.id) as {payload:string};
      const saved=JSON.parse(old.payload);
      delete saved.runnerProtocol;  // Simulates a pre-metadata persisted job, not an automatic migration.
      db.prepare("UPDATE records SET payload=? WHERE kind='job' AND id=?")
        .run(JSON.stringify(saved),files.id);
    }finally{db.close()}
    const raw={exitCode:0,stdout:'',stderr:''};
    await emitReceipt(files,raw);
    state=StateServices.create({...options(root),desktopWorkerExecutable:path.join(root,'unused-native.exe')});
    const result=await state.handle('read_job',{job_id:files.id},context) as {status:string;message?:string};
    assert.equal(result.status,'uncertain');
    assert.match(result.message??'',/Persisted runner protocol is unavailable/);
    assert.deepEqual(JSON.parse(await readFile(files.receipt,'utf8')),raw);
    assert.equal(await readFile(files.stdout,'utf8'),'known stdout bytes');
    const repeated=await state.handle('submit_job',submission,context) as {job_id:string};
    assert.equal(repeated.job_id,files.id);
  }finally{await state?.close();await rm(root,{recursive:true,force:true})}
});
