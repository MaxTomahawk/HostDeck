import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FullTextEngine} from '../src/hostdeck/fulltext/engine.js';
import {normalizeConfig,resolveBudgets,isExcludedSource} from '../src/hostdeck/fulltext/policy.js';
import type {FullTextConfig,FullTextPrincipal,FullTextAuthorizer} from '../src/hostdeck/fulltext/types.js';

const principal:FullTextPrincipal={ownerId:'broad-fixture',deviceId:'own-device',executorId:'own-executor'};
const authorized:FullTextAuthorizer=async()=>true;

test('broad budgets are hardware-dependent, not fixed at 5000 documents/256 MiB',()=>{
  const config:FullTextConfig={indexFile:path.resolve('fixture-index.sqlite'),roots:[],formats:['.txt']};
  const budgets=resolveBudgets(config);
  assert.ok(budgets.maxDocuments>5000);
  assert.ok(budgets.maxTotalSourceBytes>256*1024*1024);
  assert.ok(budgets.maxOperationsPerStep<256,'each manual step remains bounded');
});

test('fixed C:/D:/G: selection requires exact opt-in and protected index subtree', {
  skip:process.platform!=='win32'?'Windows-specific volume syntax':false,
},()=>{
  const system='C:\\';
  const data='D:\\';
  const archive='G:\\';
  const index=String.raw`C:\ProgramData\HostDeck\Index\own.sqlite`;
  const exclusion=String.raw`C:\ProgramData\HostDeck\Index`;
  const config:FullTextConfig={indexFile:index,roots:[system,data,archive],
    fixedVolumeRoots:[system,data,archive],
    excludedRoots:[exclusion,String.raw`D:\Excluded`],formats:['.txt']};
  assert.throws(()=>normalizeConfig({...config,fixedVolumeRoots:[]}),/FULLTEXT_VOLUME_ROOT_DENIED/);
  assert.throws(()=>normalizeConfig({...config,excludedRoots:[]}),/FULLTEXT_INDEX_INSIDE_CORPUS/);
  assert.throws(()=>normalizeConfig({...config,fixedVolumeRoots:[system,data]}),/FULLTEXT_VOLUME_ROOT_DENIED/);
  const selected=normalizeConfig(config);
  assert.deepEqual(selected.fixedVolumeRoots,[system,data,archive]);
  assert.ok(isExcludedSource(selected,String.raw`C:\Windows\System32\anything.txt`));
  assert.ok(isExcludedSource(selected,String.raw`C:\ProgramData\HostDeck\Index\own.sqlite`));
  assert.ok(isExcludedSource(selected,String.raw`C:\Users\Example\AppData\Local\file.txt`));
  assert.ok(isExcludedSource(selected,String.raw`D:\Excluded\private.txt`));
  assert.equal(isExcludedSource(selected,String.raw`G:\OwnedWork\public.txt`),false);
  // Pure config only: NEVER open/index/list personal C:, D:, G: here.
});

test('explicit protected excluded subtree never reaches SQLite or FTS',async()=>{
  const tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hd-fulltext-exclude-')));
  const corpus=path.join(tmp,'owner-selected'),state=path.join(tmp,'private-index'),
    protectedSource=path.join(corpus,'private-exclude');
  await Promise.all([fs.mkdir(corpus),fs.mkdir(state)]);
  await fs.mkdir(protectedSource);
  const keep=path.join(corpus,'visible.txt');
  await fs.writeFile(keep,'SAMPLE_ALLOWED_TOKEN');
  await fs.writeFile(path.join(protectedSource,'hidden-private.txt'),'SECRET_EXCLUDED_TOKEN');
  const config:FullTextConfig={indexFile:path.join(state,'own.sqlite'),roots:[corpus],
    excludedRoots:[protectedSource],formats:['.txt'],budgets:{maxOperationsPerStep:4}};
  let engine:FullTextEngine|undefined;
  try{
    const preview=await FullTextEngine.preview(config,principal,authorized);
    assert.deepEqual(preview.excludedRoots,[protectedSource]);
    assert.equal(preview.activated,false);
    engine=await FullTextEngine.openConfirmed(config,principal,authorized,preview.digest);
    const {runId}=await engine.start(principal);
    let coverage='';
    for(let i=0;i<16;i++){
      const state=await engine.step(principal,runId,4);
      if(state.state==='complete'){coverage=state.coverage;break;}
      assert.equal(state.state,'running',state.reason??'unexpected pause');
    }
    assert.equal(coverage,'bounded_complete','bounded within the OWNER-SELECTED eligible subtree');
    assert.equal((await engine.search(principal,'SAMPLE_ALLOWED_TOKEN')).results.length,1);
    assert.equal((await engine.search(principal,'SECRET_EXCLUDED_TOKEN')).results.length,0);
    const status=await engine.status(principal);
    assert.equal(status.visibleDocuments,1);
  }finally{engine?.close();await fs.rm(tmp,{recursive:true,force:true});}
});
