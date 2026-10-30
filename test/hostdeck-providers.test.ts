import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ProviderRegistry} from '../src/hostdeck/providers.js';

test('preferences persist by owner/device/function and explicit overrides never rewrite them',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-preferences-'));
 const context={ownerId:'owner-a',deviceId:'device-a',executorId:'executor-a'};
 try{
  const registry=await ProviderRegistry.open(path.join(root,'preferences.json'));
  assert.equal(await registry.select(context,'files.name'),'direct');
  await registry.set(context,'files.name','everything');
  assert.equal(await registry.select(context,'files.name','direct'),'direct');
  const reopened=await ProviderRegistry.open(path.join(root,'preferences.json'));
  assert.equal(await reopened.select(context,'files.name'),'everything');
  assert.equal(await reopened.select({...context,ownerId:'owner-b'},'files.name'),'direct');
  assert.equal(await reopened.select({...context,deviceId:'device-b'},'files.name'),'direct');
  assert.equal(await reopened.select(context,'files.content'),'direct');
  // Registering/detecting another provider cannot promote it over saved selection.
  assert.equal(await reopened.select(context,'files.name'),'everything');
  await assert.rejects(reopened.set(context,'files.content','everything'),/PROVIDER_CAPABILITY_UNSUPPORTED/);
  await reopened.set(context,'files.name',null);
  assert.equal(await registry.select(context,'files.name'),'direct');
 }finally{await rm(root,{recursive:true,force:true});}
});
