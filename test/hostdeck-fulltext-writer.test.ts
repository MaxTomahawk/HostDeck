import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {FullTextEngine} from '../src/hostdeck/fulltext/engine.js';
import type {FullTextConfig,FullTextAuthorizer,FullTextPrincipal} from '../src/hostdeck/fulltext/types.js';

const principal:FullTextPrincipal={ownerId:'writer-fixture',deviceId:'writer-test-device',executorId:'writer-test-executor'};
const authorize:FullTextAuthorizer=async r=>r.principal.ownerId===principal.ownerId
  && r.principal.deviceId===principal.deviceId && r.principal.executorId===principal.executorId;

async function fixture():Promise<{root:string;config:FullTextConfig;file:string}>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-writer-')));
  const corpus=path.join(root,'owner-chosen'),state=path.join(root,'private-state');
  await mkdir(corpus);await mkdir(state);
  const file=path.join(state,'child-settings.json');
  const config:FullTextConfig={indexFile:path.join(state,'index.sqlite'),roots:[corpus],
    formats:['.txt'],budgets:{maxOperationsPerStep:2,maxStepMilliseconds:6_000}};
  await writeFile(path.join(corpus,'fixture.txt'),'owned little writer fixture');
  await writeFile(file,JSON.stringify(config));
  return {root,config,file};
}

function snapshot(indexFile:string):string{
  // Read-only evidence; acquiring a rejected writer must not mutate primary
  // runs, meta or queue. Companion OS-lock state is intentionally separate.
  const db=new DatabaseSync(indexFile,{readOnly:true});
  try {
    const parts=['meta','runs','queue'].map(name=>db.prepare('SELECT * FROM '+name).all());
    return JSON.stringify(parts);
  } finally {db.close();}
}

function worker(configFile:string,mode:'hold'|'probe'):ChildProcessWithoutNullStreams{
  return spawn(process.execPath,['--import','tsx',
    fileURLToPath(new URL('./fixtures/hostdeck-fulltext-writer.ts',import.meta.url)),configFile,mode],
    {stdio:'pipe',windowsHide:true});
}

function receive(child:ChildProcessWithoutNullStreams,pattern:RegExp,ms=12_000):Promise<string>{
  return new Promise((resolve,reject)=>{
    let stdout='';
    const timeout=setTimeout(()=>finish(new Error('FIXTURE_RESPONSE_TIMEOUT')),ms);
    const onData=(chunk:Buffer)=>{
      stdout+=chunk.toString('utf8');
      const line=stdout.split(/\r?\n/).find(value=>pattern.test(value));
      if (line)finish(undefined,line);
      if (stdout.length>8192)finish(new Error('FIXTURE_OUTPUT_LIMIT'));
    };
    // Child 'exit' can precede a final stdout pipe data event. 'close'
    // runs only after the pipe streams have fully closed.
    const onClose=(code:number|null)=>finish(new Error('FIXTURE_CLOSED_BEFORE_EXPECTED_LINE_'+code));
    function finish(error?:Error,result?:string){
      clearTimeout(timeout);
      child.stdout.off('data',onData);
      child.off('close',onClose);
      error?reject(error):resolve(result!);
    }
    child.stdout.on('data',onData);
    child.once('close',onClose);
  });
}
async function awaitExit(child:ChildProcessWithoutNullStreams):Promise<void>{
  if (child.exitCode!==null || child.signalCode!==null) return;
  await once(child,'exit');
}
async function terminateOwn(child:ChildProcessWithoutNullStreams):Promise<void>{
  if(child.exitCode!==null || child.signalCode!==null)return;
  const ended=once(child,'exit');
  child.kill('SIGKILL');
  await ended;
}

test('same process second live writer denied without changing runs, queue or metadata',async()=>{
  const {root,config}=await fixture();
  let first:FullTextEngine|undefined,second:FullTextEngine|undefined;
  try{
    const preview=await FullTextEngine.preview(config,principal,authorize);
    first=await FullTextEngine.openConfirmed(config,principal,authorize,preview.digest);
    const started=await first.start(principal);
    const prior=snapshot(config.indexFile);
    await assert.rejects(FullTextEngine.openConfirmed(config,principal,authorize,preview.digest),
      /FULLTEXT_WRITER_BUSY/);
    assert.equal(snapshot(config.indexFile),prior,'rejected opener mutated index tables');
    assert.equal((await first.status(principal)).state,'running');
    // Ordinary close releases the OS lock; a subsequent opener sees truthful
    // interrupted recovery, never an automatic resume or duplicate writer.
    first.close();first=undefined;
    second=await FullTextEngine.openConfirmed(config,principal,authorize,preview.digest);
    assert.equal((await second.status(principal)).state,'interrupted');
    await second.resume(principal,started.runId);
    assert.equal((await second.status(principal)).state,'running');
  }finally{second?.close();first?.close();await rm(root,{recursive:true,force:true});}
});

test('two real child processes: live contention, normal close, crash, OS lock release',async()=>{
  const graceful=await fixture();
  const crash=await fixture();
  const children:ChildProcessWithoutNullStreams[]=[];
  try{
    const first=worker(graceful.file,'hold');children.push(first);
    assert.equal(await receive(first,/^HELD running$/),'HELD running');
    const snapshotBefore=snapshot(graceful.config.indexFile);
    const competing=worker(graceful.file,'probe');children.push(competing);
    assert.equal(await receive(competing,/^BUSY FULLTEXT_WRITER_BUSY$/),'BUSY FULLTEXT_WRITER_BUSY');
    await awaitExit(competing);
    assert.equal(snapshot(graceful.config.indexFile),snapshotBefore);
    assert.equal((await (async()=>{
      const p=await FullTextEngine.preview(graceful.config,principal,authorize);
      return FullTextEngine.openConfirmed(graceful.config,principal,authorize,p.digest);
    })().then(()=>false,error=>error?.message==='FULLTEXT_WRITER_BUSY')),true);
    const closing=receive(first,/^CLOSED$/);
    first.stdin.write('CLOSE\n');
    assert.equal(await closing,'CLOSED');
    await awaitExit(first);
    const reopened=worker(graceful.file,'probe');children.push(reopened);
    assert.equal(await receive(reopened,/^OPENED interrupted$/),'OPENED interrupted');
    await awaitExit(reopened);

    const holder=worker(crash.file,'hold');children.push(holder);
    assert.equal(await receive(holder,/^HELD running$/),'HELD running');
    const beforeCrash=snapshot(crash.config.indexFile);
    const denied=worker(crash.file,'probe');children.push(denied);
    assert.equal(await receive(denied,/^BUSY FULLTEXT_WRITER_BUSY$/),'BUSY FULLTEXT_WRITER_BUSY');
    await awaitExit(denied);
    assert.equal(snapshot(crash.config.indexFile),beforeCrash);
    // This kills ONLY the new test helper, simulating a real process crash.
    await terminateOwn(holder);
    const recovered=worker(crash.file,'probe');children.push(recovered);
    assert.equal(await receive(recovered,/^OPENED interrupted$/),'OPENED interrupted');
    await awaitExit(recovered);
  }finally{
    for(const child of children)await terminateOwn(child);
    await rm(graceful.root,{recursive:true,force:true});
    await rm(crash.root,{recursive:true,force:true});
  }
});
