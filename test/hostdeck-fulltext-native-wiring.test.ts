import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {eligibleNativeLeaf,qualifiedBatch,selectedComponents} from '../src/hostdeck/fulltext/native-attributes.js';
import {FullTextEngine} from '../src/hostdeck/fulltext/engine.js';
import type {FullTextNativeAttribute} from '../src/hostdeck/fulltext-native-bridge.js';
import type {FullTextConfig,FullTextPrincipal,FullTextAuthorizer} from '../src/hostdeck/fulltext/types.js';

const metadata=(flags:Partial<FullTextNativeAttribute>={}):FullTextNativeAttribute=>({
  index:0,status:'ok',hidden:false,system:false,reparse:false,
  hidden_component:false,system_component:false,directory:false,...flags,
});

test('PR22 native metadata: inherited C-drive Hidden/System must not exclude an ordinary leaf',()=>{
  const ordinary=metadata({hidden_component:true,system_component:true});
  assert.equal(eligibleNativeLeaf(ordinary,false),true);
  assert.equal(eligibleNativeLeaf(ordinary,true),true);
  assert.equal(eligibleNativeLeaf(metadata({hidden:true,hidden_component:true}),false),false);
  assert.equal(eligibleNativeLeaf(metadata({hidden:true}),true),true);
  assert.equal(eligibleNativeLeaf(metadata({system:true}),true),false);
  assert.throws(()=>eligibleNativeLeaf(metadata({status:'reparse_component',reparse:true}),true),/FULLTEXT_REPARSE_DENIED/);
  assert.throws(()=>eligibleNativeLeaf(metadata({status:'unavailable',hidden:null}),false),/FULLTEXT_NATIVE_METADATA_UNAVAILABLE/);
  assert.throws(()=>eligibleNativeLeaf(metadata({directory:null}),false),/FULLTEXT_NATIVE_METADATA_UNAVAILABLE/);
});

test('scope starts at exact selected root, never ancestors outside it',()=>{
  const root=path.join(os.tmpdir(),'explicit-selected');
  const child=path.join(root,'inside','België_日本語_中文.txt');
  assert.deepEqual(selectedComponents(root,child),
    [root,path.join(root,'inside'),child]);
  assert.throws(()=>selectedComponents(root,path.dirname(root)),/FULLTEXT_OUTSIDE_ROOT/);
  assert.throws(()=>selectedComponents(root,path.join(root,'..','outside.txt')),/FULLTEXT_OUTSIDE_ROOT/);
  const children=[child,path.join(root,'ordinary.txt')];
  const allowed=qualifiedBatch(children,[
    metadata({index:0,hidden_component:true,system_component:true}),
    metadata({index:1,hidden:true}),
  ],root,false,[]);
  assert.deepEqual(allowed,[true,false]);
  assert.throws(()=>qualifiedBatch(children,[metadata({index:0})],root,false,[]),/FULLTEXT_NATIVE_PROTOCOL_INVALID/);
  assert.throws(()=>qualifiedBatch(children,[
    metadata({index:1}),metadata({index:0}),
  ],root,false,[]),/FULLTEXT_NATIVE_PROTOCOL_INVALID/);
});

test('explicit fixed-volume root can be traversed despite its own C: Hidden/System flags',{
  skip:process.platform!=='win32'?'Windows fixed-volume path semantics':false,
},()=>{
  const volume='C:\\';
  assert.deepEqual(qualifiedBatch([volume],[metadata({hidden:true,system:true})],volume,false,[volume]),[true]);
  const child=path.join(volume,'owner-selected','normal.txt');
  assert.deepEqual(qualifiedBatch([child],[metadata({hidden_component:true,system_component:true})],volume,false,[volume]),[true]);
  assert.deepEqual(qualifiedBatch([child],[metadata({system:true})],volume,true,[volume]),[false]);
});

test('without qualified native metadata, Windows cannot create a fulltext index',{
  skip:process.platform!=='win32'?'Windows-only runtime gate':false,
},async()=>{
  const tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hd-ft-native-missing-')));
  const corpus=path.join(tmp,'selected'),index=path.join(tmp,'private.sqlite');
  await fs.mkdir(corpus);
  const config:FullTextConfig={indexFile:index,roots:[corpus],formats:['.txt']};
  const principal:FullTextPrincipal={ownerId:'owned-test',deviceId:'fixture-device',executorId:'fixture-executor'};
  const authorized:FullTextAuthorizer=async()=>true;
  try{
    const preview=await FullTextEngine.preview(config,principal,authorized);
    await assert.rejects(FullTextEngine.openConfirmed(config,principal,authorized,preview.digest),
      /FULLTEXT_NATIVE_METADATA_REQUIRED/);
    await assert.rejects(fs.stat(index),{code:'ENOENT'});
  }finally{await fs.rm(tmp,{recursive:true,force:true});}
});


test('bounded metadata batching indexes an owned Unicode TXT without inheriting outside-root flags',async()=>{
  const tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hd-ft-native-batch-')));
  const root=path.join(tmp,'selected'),state=path.join(tmp,'index-state');
  await Promise.all([fs.mkdir(root),fs.mkdir(state)]);
  const unicode=path.join(root,'België_日本語_中文.txt');
  const config:FullTextConfig={indexFile:path.join(state,'index.sqlite'),roots:[root],formats:['.txt'],
    budgets:{maxOperationsPerStep:32,maxStepMilliseconds:8000}};
  const principal:FullTextPrincipal={ownerId:'unicode-fixture',deviceId:'test-device',executorId:'test-executor'};
  const authorized:FullTextAuthorizer=async()=>true;
  const batchSizes:number[]=[];
  const mockProbe:import('../src/hostdeck/fulltext/native-attributes.js').FullTextAttributeProbe=
    async paths=>{
      batchSizes.push(paths.length);
      return paths.map((_,index)=>metadata({index,hidden_component:true,system_component:true}));
    };
  let engine:FullTextEngine|undefined;
  try{
    for(let i=0;i<64;i++)await fs.writeFile(path.join(root,'ordinary-'+i+'.txt'),'ordinary fixture content');
    await fs.writeFile(unicode,'UniqueUnicodeStem België 日本語 中文');
    const preview=await FullTextEngine.preview(config,principal,authorized);
    engine=await FullTextEngine.openConfirmed(config,principal,authorized,preview.digest,mockProbe);
    const scan=(await engine.start(principal)).runId;
    let finished=false;
    for(let i=0;i<15;i++){
      const receipt=await engine.step(principal,scan,32);
      if(receipt.state==='complete'){finished=true;break;}
      assert.equal(receipt.state,'running',receipt.reason??'scan blocked');
    }
    assert.equal(finished,true);
    assert.equal((await engine.status(principal)).visibleDocuments,65);
    assert.deepEqual((await engine.search(principal,'UniqueUnicodeStem')).results.map(r=>r.path),[unicode]);
    assert.ok(batchSizes.every(length=>length>0&&length<=64));
    assert.ok(batchSizes.some(length=>length===64),'enumeration must use real 64-item batches');
  }finally{engine?.close();await fs.rm(tmp,{recursive:true,force:true});}
});
