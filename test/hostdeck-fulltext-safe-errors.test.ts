import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FullTextAdapter} from '../src/hostdeck/fulltext/adapter.js';
import {publicError} from '../src/hostdeck/gateway.js';
import {RuntimeError} from '../src/hostdeck/runtime-error.js';
import type {ExecutionContext} from '../src/hostdeck/security.js';
import type {FullTextConfig,FullTextPrincipal} from '../src/hostdeck/fulltext/types.js';

const principal:FullTextPrincipal={
  ownerId:'fulltext-errors-fixture',deviceId:'fixture-device',executorId:'fixture-executor',sessionId:1,
};
const context={
  ownerId:principal.ownerId,deviceId:principal.deviceId,executorId:principal.executorId,
  sessionIds:[1],revision:'fixture-revision',
} as unknown as ExecutionContext;

async function caught(call:()=>Promise<unknown>):Promise<unknown>{
  try{await call();assert.fail('expected bounded fulltext refusal');}
  catch(error){return error;}
}
function expected(error:unknown,code:string):void{
  assert.ok(error instanceof RuntimeError,'expected a trusted typed RuntimeError, not raw Error');
  assert.equal(error.code,code);
  assert.equal(publicError(error),code);
}

test('only trusted typed fulltext errors are public; arbitrary Error and private strings are IO_ERROR',()=>{
  assert.equal(publicError(new Error('FULLTEXT_NOT_CONFIGURED')),'IO_ERROR');
  assert.equal(publicError(new Error('FULLTEXT_PROTECTED_CONFIG_INVALID')),'IO_ERROR');
  assert.equal(publicError(new Error('FULLTEXT_PRIVATE_BACKEND_DETAIL')),'IO_ERROR');
  assert.equal(publicError(new Error('FULLTEXT_NOT_CONFIGURED: PRIVATE_FIXTURE_PATH')),'IO_ERROR');
  assert.equal(publicError(new RuntimeError('DENIED')),'DENIED');
});

test('read-only query remains safely unconfigured; pending owner approval, invalid root binding, malformed protected profile and raw backend errors are separated',async()=>{
  // Disposable configuration only. No native ACL claim, index, grants or owner
  // approval is created. Tests deliberately stub protected config reads.
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-safe-errors-')));
  const workspace=path.join(base,'workspace'),stateDir=path.join(base,'state');
  const protectedDir=path.join(base,'protected'),root=path.join(base,'selected');
  await Promise.all([mkdir(workspace),mkdir(stateDir),mkdir(protectedDir),mkdir(root)]);
  let gateDenied=false;
  const adapter=new FullTextAdapter({
    workspace,stateDirectory:stateDir,protectedOwnerDirectory:protectedDir,
    reauthorize:async()=>{
      if(gateDenied)throw new RuntimeError('DENIED');
    },
  });
  try{
    // Even if fulltext_query is advertised under fulltext:read, indexing is
    // impossible without a protected selection and trusted approval.
    expected(await caught(()=>adapter.handle('hostdeck_fulltext_query',{
      query:'sunflower',limit:10,
    },context)),'FULLTEXT_NOT_CONFIGURED');

    const config:FullTextConfig={
      indexFile:adapter.store.expectedIndexFile(principal),roots:[root],formats:['.txt'],
    };
    adapter.store.selected=async()=>config;
    adapter.store.confirmed=async()=>false; // deliberately not approved
    const preview=await adapter.handle('hostdeck_fulltext_preview',{},context) as {digest:string};
    assert.match(preview.digest,/^[a-f0-9]{64}$/);
    expected(await caught(()=>adapter.handle('hostdeck_fulltext_confirm',{
      digest:preview.digest,
    },context)),'FULLTEXT_OWNER_CONFIRMATION_REQUIRED');
    expected(await caught(()=>adapter.handle('hostdeck_fulltext_confirm',{
      digest:'0'.repeat(64),
    },context)),'FULLTEXT_OWNER_CONFIRMATION_REQUIRED');

    // Invalid root binding is a finite code; do not reveal the selected path.
    adapter.store.selected=async()=>({...config,roots:[stateDir]});
    expected(await caught(()=>adapter.handle('hostdeck_fulltext_preview',{},context)),
      'FULLTEXT_INDEX_INSIDE_CORPUS');

    // Protected file could be malformed; keep exact stable error only.
    adapter.store.selected=async()=>{throw new Error('FULLTEXT_PROTECTED_CONFIG_INVALID');};
    expected(await caught(()=>adapter.handle('hostdeck_fulltext_preview',{},context)),
      'FULLTEXT_PROTECTED_CONFIG_INVALID');

    // PolicyGate DENIED must remain DENIED, never translated or overridden.
    gateDenied=true;
    adapter.store.selected=async()=>config;
    expected(await caught(()=>adapter.handle('hostdeck_fulltext_preview',{},context)),'DENIED');
    gateDenied=false;

    adapter.store.selected=async()=>{
      throw new Error('SQLITE failure at PRIVATE_FIXTURE_SOURCE_PATH');
    };
    const unexpected=await caught(()=>adapter.handle('hostdeck_fulltext_preview',{},context));
    assert.ok(unexpected instanceof Error);
    assert.equal(publicError(unexpected),'IO_ERROR');
    assert.equal(unexpected instanceof RuntimeError,false);
  }finally{
    await adapter.close();
    await rm(base,{recursive:true,force:true});
  }
});
