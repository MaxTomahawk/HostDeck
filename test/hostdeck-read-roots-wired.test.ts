import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileAdapter } from '../src/hostdeck/files.js';
import { UserRuntime } from '../src/hostdeck/user-runtime.js';
import { ReadRootAccess } from '../src/hostdeck/read-root-access.js';
import { ReadRootSelectionStore, readRootContentDigest } from '../src/hostdeck/read-root-selection-store.js';

const owner = {ownerId:'owner_fixture',deviceId:'device_fixture',executorId:'executor_fixture'};
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function fixture(){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hostdeck-two-read-roots-')));
  const workspace=path.join(root,'workspace'),readRoot=path.join(root,'read-root');
  const otherRoot=path.join(root,'other-root'),protectedDirectory=path.join(root,'protected');
  await Promise.all([workspace,readRoot,otherRoot,protectedDirectory].map(p=>fs.mkdir(p)));
  const source=path.join(readRoot,'external.txt'),other=path.join(otherRoot,'not-selected.txt');
  await fs.writeFile(path.join(workspace,'local.txt'),'LOCAL_WORKSPACE');
  await fs.writeFile(source,'READ_ROOT_CONTENT_MARKER');
  await fs.writeFile(other,'OUTSIDE_SELECTED_ROOT');
  const excluded=path.join(readRoot,'excluded');
  await fs.mkdir(excluded);
  await fs.writeFile(path.join(excluded,'secret.txt'),'PROTECTED_MARKER');
  const selected={version:1 as const,owner,revision:'rev_fixture_001',
    selection:{roots:[readRoot],excludedRoots:[excluded],fixedVolumeRoots:[]}};
  const approval={version:1 as const,owner,revision:selected.revision,
    contentDigest:readRootContentDigest(selected),
    approvedAt:new Date(Date.now()-1000).toISOString(),
    source:'protected-local-owner-approval'};
  await fs.writeFile(path.join(protectedDirectory,'read-roots-selection.json'),JSON.stringify(selected));
  await fs.writeFile(path.join(protectedDirectory,'read-roots-approval.json'),JSON.stringify(approval));
  // This deliberately fake ACL proof tests the source wiring ONLY.
  // Production binds the pinned private native effective-ACL object probe.
  const fakeNativeAcl={probeProtectedObjectAcl:async(_file:string)=>({
    verified:true as const,status:'verified' as const,
    code:'FULLTEXT_NATIVE_ACL_VERIFIED' as const,
    componentsChecked:4,scope:'physical_filesystem_snapshot_only' as const,
  })};
  const store=new ReadRootSelectionStore(protectedDirectory,workspace,fakeNativeAcl);
  const access=new ReadRootAccess(workspace,[protectedDirectory,excluded],store);
  const runtime=await UserRuntime.create({deviceId:owner.deviceId,workspace,
    authorize:async()=>true,environment:{},shells:{},readRoots:access});
  const adapter=await FileAdapter.create({workspace,readRoots:access});
  return {root,workspace,readRoot,otherRoot,protectedDirectory,source,other,excluded,
    store,access,runtime,adapter,selected,approval,
    cleanup:async()=>{await runtime.dispose();await fs.rm(root,{recursive:true,force:true});}};
}
const local=(pathValue:string)=>({device_id:owner.deviceId,path:pathValue});
const code=(error:unknown)=>error instanceof Error ? error.message : String(error);
async function finishes(adapter:FileAdapter,id:string, context=owner){
  let last:any;
  for(let i=0;i<150;i++){
    last=await adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:id,offset:0,limit:100,
    },context);
    if(last.complete)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(last?.complete,true);
  return last;
}

test('default workspace-only even with records but without a qualified native ACL source',async()=>{
  const f=await fixture();
  try{
    const noAcl=new ReadRootSelectionStore(f.protectedDirectory,f.workspace);
    const dormant=new ReadRootAccess(f.workspace,[f.protectedDirectory,f.excluded],noAcl);
    const adapter=await FileAdapter.create({workspace:f.workspace,readRoots:dormant});
    const runtime=await UserRuntime.create({deviceId:owner.deviceId,workspace:f.workspace,
      authorize:async()=>true,environment:{},shells:{},readRoots:dormant});
    try{
      await assert.rejects(adapter.handle('hostdeck_list_directory',{
        ...local(f.readRoot),depth:1,limit:20},owner),/READ_ROOT_DENIED/);
      await assert.rejects(runtime.invoke('hostdeck_read_file',local(f.source),owner),/READ_ROOT_DENIED/);
      const ok=await runtime.invoke('hostdeck_read_file',local('local.txt'),owner);
      assert.equal(ok.content,'LOCAL_WORKSPACE');
      await assert.rejects(runtime.invoke('hostdeck_write_file',{
        ...local(f.source),content:'DO_NOT_WRITE',mode:'overwrite'},owner),/PATH_DENIED/);
      assert.equal(await fs.readFile(f.source,'utf8'),'READ_ROOT_CONTENT_MARKER');
    }finally{await runtime.dispose();}
  }finally{await f.cleanup();}
});

test('protected exact owner selection permits sibling root list/name/content and matching readback/metadata only',async()=>{
  const f=await fixture();
  try{
    const list=await f.adapter.handle('hostdeck_list_directory',{
      ...local(f.readRoot),depth:1,limit:30},owner) as any;
    assert.equal(list.root_scope,f.readRoot);
    assert.ok(list.entries.some((item:any)=>item.path===f.source));
    assert.ok(!list.entries.some((item:any)=>item.path.includes('excluded')));
    const file=await f.runtime.invoke('hostdeck_read_file',local(f.source),owner);
    assert.equal(file.content,'READ_ROOT_CONTENT_MARKER');
    assert.equal(file.source_path,f.source);
    assert.equal(file.root_scope,f.readRoot);
    const info=await f.runtime.invoke('hostdeck_file_info',{
      ...local(f.source),hash:'sha256'},owner);
    assert.equal(info.type,'file');
    assert.equal(info.root_scope,f.readRoot);
    assert.match(String(info.sha256),/^[a-f0-9]{64}$/);
    const query=await f.adapter.handle('hostdeck_search_files',{
      ...local(f.readRoot),pattern:'external',mode:'files',provider:'direct'},owner) as any;
    const results=await finishes(f.adapter,query.search_id);
    assert.deepEqual(results.items.map((r:any)=>r.path),[f.source]);
    assert.equal(results.root_scope,f.readRoot);
    const content=await f.adapter.handle('hostdeck_search_files',{
      ...local(f.readRoot),pattern:'READ_ROOT_CONTENT',mode:'content',provider:'direct'},owner) as any;
    const snippets=await finishes(f.adapter,content.search_id);
    assert.equal(snippets.items[0].path,f.source);
    assert.match(snippets.items[0].text,/READ_ROOT_CONTENT/);
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',local(f.other),owner),/READ_ROOT_DENIED/);
    await assert.rejects(f.adapter.handle('hostdeck_list_directory',{
      ...local(f.otherRoot),depth:1,limit:10},owner),/READ_ROOT_DENIED/);
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',
      local(path.join(f.excluded,'secret.txt')),owner),/READ_ROOT_DENIED/);
    for(const other of [
      {...owner,ownerId:'other'}, {...owner,deviceId:'other'}, {...owner,executorId:'other'},
    ]){
      await assert.rejects(f.runtime.invoke('hostdeck_read_file',local(f.source),other),/READ_ROOT_DENIED/);
    }
    await assert.rejects(f.runtime.invoke('hostdeck_write_file',{
      ...local(f.source),content:'DENIED_WRITE',mode:'overwrite'},owner),/PATH_DENIED/);
    await assert.rejects(f.runtime.invoke('hostdeck_edit_text',{
      ...local(f.source),old_text:'READ',new_text:'WRITE',expected_replacements:1},owner),/PATH_DENIED/);
    assert.equal(await fs.readFile(f.source,'utf8'),'READ_ROOT_CONTENT_MARKER');
  }finally{await f.cleanup();}
});

test('revoking approval before the next result page withholds all paths, counts and readback',async()=>{
  const f=await fixture();
  try{
    const started=await f.adapter.handle('hostdeck_search_files',{
      ...local(f.readRoot),pattern:'external',provider:'direct'},owner) as any;
    const first=await finishes(f.adapter,started.search_id);
    assert.equal(first.items[0].path,f.source);
    await fs.rm(path.join(f.protectedDirectory,'read-roots-approval.json'));
    await assert.rejects(f.adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:started.search_id,offset:0,limit:10},owner),
      /READ_ROOT_(?:EFFECTIVE_ACL_UNQUALIFIED|DENIED)/);
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',local(f.source),owner),
      /READ_ROOT_(?:EFFECTIVE_ACL_UNQUALIFIED|DENIED)/);
    const localRead=await f.runtime.invoke('hostdeck_read_file',local('local.txt'),owner);
    assert.equal(localRead.content,'LOCAL_WORKSPACE','revocation cannot disable workspace reads');
    assert.equal(await fs.readFile(f.source,'utf8'),'READ_ROOT_CONTENT_MARKER');
  }finally{await f.cleanup();}
});

test('actual opened file object swap while reading is denied, not disclosed',async()=>{
  const f=await fixture();
  try{
    const scope=await f.access.resolve(f.source,owner,'read_file');
    assert.equal(scope.external,true);
    const moved=path.join(f.readRoot,'old-opened.txt');
    await assert.rejects(f.access.withFile(scope as any,owner,'read_file',1024,async fd=>{
      const bytes=await fd.readFile();
      await fs.rename(f.source,moved);
      // The descriptor remains bound to the old object. Where permitted, use
      // a real symlink (reparse point) to a different sibling file.
      try{await fs.symlink(f.other,f.source,'file');}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='EPERM')throw error;
        await fs.writeFile(f.source,'SWAPPED_NEW_FILE');
      }
      return bytes;
    }),/READ_ROOT_(?:DENIED|CHANGED)/);
    const latest=await fs.lstat(f.source);
    assert.ok(latest.isSymbolicLink()||
      (await fs.readFile(f.source,'utf8'))==='SWAPPED_NEW_FILE');
  }finally{await f.cleanup();}
});

test('actual root replacement/reparse while descriptor is open is denied',async t=>{
  const f=await fixture();
  try{
    const scope=await f.access.resolve(f.source,owner,'read_file');
    const renamed=path.join(f.root,'read-root-original');
    await assert.rejects(f.access.withFile(scope as any,owner,'read_file',1024,async fd=>{
      const data=await fd.readFile();
      await fs.rename(f.readRoot,renamed);
      try{
        await fs.symlink(f.otherRoot,f.readRoot,process.platform==='win32'?'junction':'dir');
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=='EPERM')throw error;
        // The root identity swap is still real. The reparse-specific
        // variant cannot be claimed if this Windows token denies junctions.
        t.diagnostic('Reparse branch SKIP: junction permission denied; root swap still tested');
        await fs.mkdir(f.readRoot);
      }
      return data;
    }),/READ_ROOT_(?:DENIED|CHANGED)/);
  }finally{await f.cleanup();}
});

test('fake Everything candidates are filtered through selected root, then page and readback',async()=>{
  const f=await fixture();
  const fakeEverything={
    sessionId:1,
    status:async()=>({installed:true,enabled:true,running:true,compatible:true,
      healthy:true,reason:'FAKE_PROVIDER_TEST_ONLY',version:'fixture',
      instance:'fake-provider',session_id:1,qualified:'not_independently_accepted' as const}),
    query:async()=>({paths:[f.source,f.other],truncated:false,version:'fixture',
      instance:'fake-provider',session_id:1,runtime_id:'fixture'}),
  };
  const context={...owner,sessionId:1,sessionIds:[1]};
  try{
    const adapter=await FileAdapter.create({workspace:f.workspace,readRoots:f.access,
      everything:fakeEverything});
    const query=await adapter.handle('hostdeck_search_files',{
      ...local(f.readRoot),pattern:'external',provider:'everything'},context) as any;
    const result=await finishes(adapter,query.search_id,context);
    assert.deepEqual(result.items.map((item:any)=>item.path),[f.source]);
    assert.equal(result.root_scope,f.readRoot);
    assert.equal(result.provider,'everything');
    assert.equal((await f.runtime.invoke('hostdeck_read_file',local(result.items[0].path),owner)).content,
      'READ_ROOT_CONTENT_MARKER');
    await fs.rm(path.join(f.protectedDirectory,'read-roots-approval.json'));
    await assert.rejects(adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:query.search_id,offset:0,limit:10},context),
      /READ_ROOT_(?:EFFECTIVE_ACL_UNQUALIFIED|DENIED)/);
  }finally{await f.cleanup();}
});
