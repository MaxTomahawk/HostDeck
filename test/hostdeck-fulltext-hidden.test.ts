import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FullTextEngine} from '../src/hostdeck/fulltext/engine.js';
import type {FullTextAuthorizer,FullTextConfig,FullTextPrincipal} from '../src/hostdeck/fulltext/types.js';

const execFile=promisify(execFileCb);
const principal:FullTextPrincipal={ownerId:'hidden-fixture',deviceId:'own-device',executorId:'own-executor'};
const allowed:FullTextAuthorizer=async()=>true;
const binary=path.win32.join(process.env.SystemRoot??'C:\\Windows','System32','attrib.exe');
async function setHidden(file:string,enabled:boolean):Promise<void>{
  await execFile(binary,[enabled?'+H':'-H',file],{shell:false,windowsHide:true,timeout:3000});
}
async function scan(engine:FullTextEngine):Promise<{coverage:string;removed:number}>{
  const {runId}=await engine.start(principal);
  let receipt;
  let removed=0;
  for(let i=0;i<25;i++){
    receipt=await engine.step(principal,runId,3);
    removed+=receipt.removedAtCompletion;
    if(receipt.state==='complete')return {coverage:receipt.coverage,removed};
    assert.equal(receipt.state,'running',receipt.reason??'unexpected pause');
  }
  throw new Error('HIDDEN_FIXTURE_DID_NOT_COMPLETE');
}
async function raw(index:string):Promise<{docs:number;fts:number}>{
  const db=new DatabaseSync(index,{readOnly:true});
  try{
    return {
      docs:(db.prepare('SELECT COUNT(*) n FROM docs').get() as {n:number}).n,
      fts:(db.prepare('SELECT COUNT(*) n FROM docs_fts').get() as {n:number}).n,
    };
  }finally{db.close();}
}

test('HD-B007-FULLTEXT-HIDDEN-001: real +H TXT is excluded and removed, no dotname heuristic', {
  skip:process.platform!=='win32'?'Needs Windows FILE_ATTRIBUTE_HIDDEN':false,
},async()=>{
  const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hd-hidden-own-')));
  const corpus=path.join(temporary,'selected'),state=path.join(temporary,'private-state');
  await fs.mkdir(corpus);await fs.mkdir(state);
  const file=path.join(corpus,'ordinary-name.txt');
  const config:FullTextConfig={indexFile:path.join(state,'own.sqlite'),roots:[corpus],formats:['.txt'],
    budgets:{maxOperationsPerStep:3,maxStepMilliseconds:8500}};
  let engine:FullTextEngine|undefined;
  try{
    await fs.writeFile(file,'VISIBLE_UNIQUE_MARKER');
    await setHidden(file,true);
    const preview=await FullTextEngine.preview(config,principal,allowed);
    engine=await FullTextEngine.openConfirmed(config,principal,allowed,preview.digest);
    const initial=await scan(engine);
    assert.equal(initial.coverage,'bounded_complete','explicitly excluded hidden content is not unqualified coverage');
    assert.equal((await engine.search(principal,'VISIBLE_UNIQUE_MARKER')).results.length,0);
    assert.deepEqual(await raw(config.indexFile),{docs:0,fts:0});

    await setHidden(file,false);
    assert.equal((await scan(engine)).coverage,'bounded_complete');
    assert.equal((await engine.search(principal,'VISIBLE_UNIQUE_MARKER')).results.length,1);
    assert.deepEqual(await raw(config.indexFile),{docs:1,fts:1});

    await setHidden(file,true);
    const removed=await scan(engine);
    assert.equal(removed.coverage,'bounded_complete');
    assert.equal(removed.removed,1,'new +H attribute must purge old indexed text');
    assert.equal((await engine.search(principal,'VISIBLE_UNIQUE_MARKER')).results.length,0);
    assert.deepEqual(await raw(config.indexFile),{docs:0,fts:0});
  }finally{
    engine?.close();
    await setHidden(file,false).catch(()=>undefined);
    await fs.rm(temporary,{recursive:true,force:true});
  }
});

test('HD-B007-FULLTEXT-HIDDEN-001: +H during extraction prevents committed source content', {
  skip:process.platform!=='win32'?'Needs Windows FILE_ATTRIBUTE_HIDDEN':false,
},async()=>{
  const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hd-hidden-race-')));
  const corpus=path.join(temporary,'selected'),state=path.join(temporary,'private-state');
  await fs.mkdir(corpus);await fs.mkdir(state);
  const file=path.join(corpus,'marker.txt');
  const config:FullTextConfig={indexFile:path.join(state,'own.sqlite'),roots:[corpus],formats:['.txt'],
    budgets:{maxOperationsPerStep:2,maxStepMilliseconds:8500}};
  let engine:FullTextEngine|undefined,checks=0;
  const toggle:FullTextAuthorizer=async req=>{
    if(req.action==='index'&&req.path===file&&++checks===2)await setHidden(file,true);
    return true;
  };
  try{
    await fs.writeFile(file,'RACE_OWNED_UNIQUE_MARKER');
    const preview=await FullTextEngine.preview(config,principal,toggle);
    engine=await FullTextEngine.openConfirmed(config,principal,toggle,preview.digest);
    const {runId}=await engine.start(principal);
    assert.equal((await engine.step(principal,runId,1)).state,'running');
    const result=await engine.step(principal,runId,1);
    assert.equal(checks,2);
    assert.equal(result.state,'paused');
    assert.equal(result.reason,'FULLTEXT_SOURCE_BECAME_HIDDEN');
    assert.deepEqual(await raw(config.indexFile),{docs:0,fts:0});
  }finally{
    engine?.close();
    await setHidden(file,false).catch(()=>undefined);
    await fs.rm(temporary,{recursive:true,force:true});
  }
});
