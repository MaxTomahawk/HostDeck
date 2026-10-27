import {syntheticFullTextAttributes} from './fixtures/fulltext-test-native-attributes.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FullTextPort} from '../src/hostdeck/fulltext/wiring.js';
import type {FullTextConfig,FullTextPrincipal,FullTextAuthorizer,FullTextScanReceipt} from '../src/hostdeck/fulltext/types.js';

const owner:FullTextPrincipal={ownerId:'driver-fixture',deviceId:'driver-device',executorId:'driver-executor',sessionId:1};

async function fixtures(files=25,budget:FullTextConfig['budgets']={}){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-ft-once-')));
  assert.equal(path.dirname(root),await realpath(os.tmpdir()),'cleanup stays inside the canonical temporary directory');
  const corpus=path.join(root,'selected-corpus'),state=path.join(root,'private-state');
  await mkdir(corpus);await mkdir(state);
  for(let i=0;i<files;i++) await writeFile(path.join(corpus,'owned-'+i+'.txt'),
    'flower-'+i+' fixture content with bloom');
  const config:FullTextConfig={
    roots:[corpus],indexFile:path.join(state,'own-index.sqlite'),formats:['.txt'],
    budgets:{maxOperationsPerStep:1,maxStepMilliseconds:4_000,...budget},
  };
  return {root,corpus,config};
}
const allow:FullTextAuthorizer=async request=>request.principal.ownerId===owner.ownerId&&
  request.principal.deviceId===owner.deviceId&&request.principal.executorId===owner.executorId;
function provider(config:FullTextConfig,auth:FullTextAuthorizer=allow,confirmed=()=>true){
  return new FullTextPort({
    loadSelectedConfig:async()=>config,isOwnerConfirmed:async()=>confirmed(),
    authorize:auth,nativeAttributes:syntheticFullTextAttributes,
  });
}
async function confirmed(port:FullTextPort){
  const preview=await port.preview(owner);
  assert.ok('digest' in preview);
  if(!('digest' in preview))throw new Error('FULLTEXT_TEST_EXPECTED_PREVIEW');
  await port.confirm(owner,preview.digest);
}
async function until<T>(get:()=>Promise<T|undefined>,timeout=12_000):Promise<T>{
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const value=await get();
    if(value!==undefined)return value;
    await new Promise(resolve=>setTimeout(resolve,18));
  }
  assert.fail('Disposable one-shot driver did not reach expected state');
}
async function state(port:FullTextPort,target:string){
  return until(async()=>{
    const value=await port.status(owner);
    return value.state===target?value:undefined;
  });
}

test('one explicit start drives its persisted queue to completion with ZERO model step calls',async()=>{
  const own=await fixtures(35);
  const port=provider(own.config);
  try{
    await confirmed(port);
    const result=await port.startDriven(owner);
    assert.equal(result.driver,'scheduled');
    assert.match(result.runId,/^[a-f0-9-]{36}$/i);
    // No client-side fulltext_step loop is issued by this test.
    const done=await state(port,'complete');
    assert.equal(done.run?.runId,result.runId);
    assert.ok((done.run?.processed??0)>=35,'persisted progress did not include own documents');
    assert.equal(done.run?.totalTasks,'unknown','do not manufacture a percentage');
    assert.equal(done.driver.state,'complete');
    assert.ok('steps' in done.driver&&done.driver.steps>1,'driver must call repeated bounded steps');
    assert.equal((await port.query(owner,'bloom')).results.length,10);
    assert.equal(JSON.stringify(done.driver).includes(own.corpus),false,'no private paths in progress');
  }finally{await port.close();await rm(own.root,{recursive:true,force:true});}
});

test('pause and cancel stop a one-time driver; only explicit resume restarts its queue',async()=>{
  const own=await fixtures(80);
  const port=provider(own.config);
  try{
    await confirmed(port);
    const started=await port.startDriven(owner);
    await port.pause(owner,started.runId);
    const paused=await state(port,'paused');
    const count=paused.run?.processed;
    await new Promise(resolve=>setTimeout(resolve,90));
    assert.equal((await port.status(owner)).run?.processed,count,'paused run continued advancing');
    assert.equal((await port.status(owner)).driver.state,'paused');
    await port.resumeDriven(owner,started.runId);
    await state(port,'complete');

    const cancelled=await port.startDriven(owner);
    await port.cancel(owner,cancelled.runId);
    const cancelledState=await state(port,'cancelled');
    const before=cancelledState.run?.processed;
    await new Promise(resolve=>setTimeout(resolve,90));
    assert.equal((await port.status(owner)).run?.processed,before,'cancelled run restarted itself');
    await assert.rejects(port.resumeDriven(owner,cancelled.runId),/FULLTEXT_NOT_RESUMABLE/);
  }finally{await port.close();await rm(own.root,{recursive:true,force:true});}
});

test('fresh per-step authorization loss interrupts the durable run without disclosure or retry',async()=>{
  const own=await fixtures(18);
  let deny=false;
  const auth:FullTextAuthorizer=async req=>{
    if(deny&&req.action==='scan')throw new Error('PRIVATE_PATH_OR_SECRET_NOT_PUBLIC');
    return allow(req);
  };
  const port=provider(own.config,auth);
  try{
    await confirmed(port);
    const started=await port.startDriven(owner);
    deny=true;
    const interrupted=await state(port,'interrupted');
    assert.equal(interrupted.run?.runId,started.runId);
    assert.equal(interrupted.driver.state,'interrupted');
    assert.equal(interrupted.driver.lastCode,'FULLTEXT_DRIVER_AUTHORIZATION_OR_RUNTIME_LOST');
    assert.equal(JSON.stringify(interrupted.driver).includes('PRIVATE_PATH_OR_SECRET'),false);
    deny=false;
    const before=interrupted.run?.processed;
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal((await port.status(owner)).run?.processed,before);
    assert.equal((await port.status(owner)).state,'interrupted');
    await port.resumeDriven(owner,started.runId);
    await state(port,'complete');
  }finally{await port.close();await rm(own.root,{recursive:true,force:true});}
});

test('process restart simulation never resumes an old run on confirmation alone',async()=>{
  const own=await fixtures(22);
  let port=provider(own.config);
  try{
    await confirmed(port);
    const started=await port.startDriven(owner);
    // Close before the next macrotask. This simulates graceful agent stop
    // while an explicit run remains durable; not a real process-kill claim.
    await port.close();
    port=provider(own.config);
    await confirmed(port);
    const restored=await port.status(owner);
    assert.equal(restored.state,'interrupted');
    assert.equal(restored.run?.runId,started.runId);
    assert.equal(restored.driver.state,'inactive');
    const before=restored.run?.processed;
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal((await port.status(owner)).run?.processed,before);
    await port.resumeDriven(owner,started.runId);
    await state(port,'complete');
  }finally{await port.close();await rm(own.root,{recursive:true,force:true});}
});

test('resource pressure stops background progression without polling or implicit recovery',async()=>{
  const own=await fixtures(4,{maxIndexBytes:1});
  const port=provider(own.config);
  try{
    await confirmed(port);
    const started=await port.startDriven(owner);
    const blocked=await state(port,'resource_paused');
    assert.equal(blocked.run?.runId,started.runId);
    assert.equal(blocked.driver.lastCode,'INDEX_QUOTA');
    const count=blocked.run?.processed;
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal((await port.status(owner)).run?.processed,count);
    assert.equal((await port.status(owner)).driver.state,'resource_paused');
  }finally{await port.close();await rm(own.root,{recursive:true,force:true});}
});

test('manual and driver steps share one serialized lane, never overlap the engine',async()=>{
  const own=await fixtures(18);
  const port=provider(own.config);
  try{
    await confirmed(port);
    const engine=(port as unknown as {engine:{
      step:(c:FullTextPrincipal,id:string,max?:number)=>Promise<FullTextScanReceipt>,
    }}).engine;
    const original=engine.step.bind(engine);
    let concurrent=0,peak=0,calls=0;
    let entered!:()=>void,release!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const begun=new Promise<void>(resolve=>{entered=resolve;});
    engine.step=async(c,id,max)=>{
      concurrent++;peak=Math.max(peak,concurrent);
      calls++;
      try{
        if(calls===1){entered();await blocked;}
        return await original(c,id,max);
      }finally{concurrent--;}
    };
    const started=await port.startDriven(owner);
    await begun;
    const manual=port.step(owner,started.runId,1);
    release();
    const receipt=await manual;
    assert.equal(receipt.runId,started.runId);
    await state(port,'complete');
    assert.equal(peak,1,'simultaneous driver/manual engine.step was observed');
    assert.ok(calls>=2);
  }finally{await port.close();await rm(own.root,{recursive:true,force:true});}
});

test('detached continuation preserves request context and rechecks policy per step',async()=>{
  const own=await fixtures(14);
  const context=new AsyncLocalStorage<{token:string}>();
  let visited=0;
  const policy:FullTextAuthorizer=async request=>{
    if(context.getStore()?.token!=='approved-request')throw new Error('FULLTEXT_DENIED');
    if(request.action==='scan'||request.action==='index')visited++;
    return allow(request);
  };
  const port=provider(own.config,policy);
  try{
    await context.run({token:'approved-request'},async()=>{
      await confirmed(port);
      await port.startDriven(owner);
    });
    const completed=await until(()=>context.run({token:'approved-request'},async()=>{
      const progress=await port.status(owner);
      return progress.state==='complete'?progress:undefined;
    }));
    assert.equal(completed.driver.state,'complete');
    assert.ok(visited>14,'driver did not reauthorize its individual steps and source paths');
  }finally{await port.close();await rm(own.root,{recursive:true,force:true});}
});
