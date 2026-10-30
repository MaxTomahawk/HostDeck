import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FileAdapter} from '../src/hostdeck/files.js';
import {UserRuntime} from '../src/hostdeck/user-runtime.js';
import {ReadRootAccess} from '../src/hostdeck/read-root-access.js';
import {ReadRootSelectionStore} from '../src/hostdeck/read-root-selection-store.js';


/** Remove only the exact canonical, locally-created tmp child; never follow a junction. */
async function cleanupFixture(root:string, prefix:string):Promise<void>{
  const parent=await fs.realpath(os.tmpdir());
  const canonical=path.resolve(root);
  const actual=await fs.realpath(canonical);
  const equal=(a:string,b:string)=>process.platform==='win32'?
    a.toLowerCase()===b.toLowerCase():a===b;
  if(!path.isAbsolute(canonical) || !equal(path.dirname(actual),parent) ||
      !equal(actual,canonical) ||
      !path.basename(actual).startsWith(prefix) ||
      (await fs.lstat(canonical)).isSymbolicLink())
    throw new Error('FIXTURE_CLEANUP_OUTSIDE_CANONICAL_TMP');
  await fs.rm(canonical,{recursive:true,force:true});
}

const owner={ownerId:'fixture_owner',deviceId:'fixture_device',
  executorId:'fixture_executor',revision:'grant_revision',sessionId:1,sessionIds:[1]};
const sid='S-1-5-21-1000';
type Config={version:1;device_id:string;executor_id:string;
  expected_user_sid:string;workspace:string;read_roots?:{
    owner_id:string;revision:string;roots:string[];excluded_roots:string[];
    fixed_volume_roots:string[]}};
const code=(e:unknown)=>e instanceof Error?e.message:String(e);

async function fixture(){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hostdeck-read-root-recovery-')));
  const workspace=path.join(root,'workspace'),external=path.join(root,'external');
  const separate=path.join(root,'separate'),protectedDir=path.join(root,'protected');
  await Promise.all([workspace,external,separate,protectedDir].map(p=>fs.mkdir(p)));
  const configFile=path.join(protectedDir,'hostdeck.json');
  const source=path.join(external,'owned.txt');
  const excluded=path.join(external,'excluded');
  const futureExcluded=path.join(external,'future-protected');
  await fs.mkdir(excluded);
  await fs.writeFile(path.join(workspace,'local.txt'),'LOCAL_FIXTURE');
  await fs.writeFile(source,'VISIBLE_MARKER');
  await fs.writeFile(path.join(excluded,'private.txt'),'EXCLUDED_MARKER');
  await fs.writeFile(path.join(separate,'other.txt'),'OTHER_MARKER');
  let nativeAttribute:'ok'|'hidden'|'system'|'reparse'='ok';
  let forceHandleMismatch=false;
  let pinHook:(()=>Promise<void>)|undefined;
  const calls:string[]=[];
  const native={
    probeProtectedObjectAcl:async(_file:string)=>({
      verified:true as const,status:'verified' as const,
      code:'FULLTEXT_NATIVE_ACL_VERIFIED' as const,
      componentsChecked:3,scope:'physical_filesystem_snapshot_only' as const,
    }),
    attributes:async(paths:readonly string[],_authorize:unknown)=>{
      return paths.map((_,index)=>({
        index,status:nativeAttribute==='reparse'?'reparse_component' as const:'ok' as const,
        hidden:nativeAttribute==='hidden',system:nativeAttribute==='system',
        reparse:nativeAttribute==='reparse',
        hidden_component:nativeAttribute==='hidden',
        system_component:nativeAttribute==='system',
        hidden_below_volume:nativeAttribute==='hidden',
        system_below_volume:nativeAttribute==='system',
        directory:null,
      }));
    },
    directoryPage:async(target:string, expectedDev:bigint, expected:bigint, offset:number,limit:number,_authorize:unknown)=>{
      const stat=await fs.stat(target,{bigint:true});
      if(forceHandleMismatch||stat.ino!==expected||stat.dev!==expectedDev)throw Error('FULLTEXT_NATIVE_DIRECTORY_CHANGED');
      const names=(await fs.readdir(target)).slice(offset,offset+limit);
      const size=(await fs.readdir(target)).length;
      return {names,more:offset+names.length<size,nextOffset:offset+names.length};
    },
    // A synthetic handle-receipt seam. Real Windows share-lock behavior is an
    // independent root qualification gate, not claimed by this fixture.
    pinFile:async(target:string,root:string,scope:{dev:bigint;ino:bigint})=>{
      const observed=await fs.stat(target,{bigint:true});
      await pinHook?.();
      return {id:'0123456789abcdef0123456789abcdef',dev:observed.dev,
        ino:observed.ino,rootDev:scope.dev,rootIno:scope.ino};
    },
    verifyFilePin:async(_pin:unknown)=>{},
    releaseFilePin:async(_pin:unknown)=>{},
  };
  const config:Config={version:1,device_id:owner.deviceId,
    executor_id:owner.executorId,expected_user_sid:sid,workspace,
    read_roots:{owner_id:owner.ownerId,revision:'read_config_rev_1',roots:[external],
      excluded_roots:[excluded],fixed_volume_roots:[]}};
  const writeConfig=async()=>fs.writeFile(configFile,JSON.stringify(config));
  await writeConfig();
  const store=new ReadRootSelectionStore(configFile,workspace,{
    deviceId:owner.deviceId,executorId:owner.executorId,sid,sessionId:1,
  },native);
  const access=new ReadRootAccess(workspace,[protectedDir,futureExcluded],store,native);
  const adapter=await FileAdapter.create({workspace,readRoots:access,
    reauthorize:async(name)=>{calls.push(name);}});
  const runtime=await UserRuntime.create({deviceId:owner.deviceId,workspace,
    authorize:async()=>true,environment:{},shells:{},readRoots:access});
  return {root,workspace,external,separate,protectedDir,source,excluded,futureExcluded,
    config,configFile,writeConfig,store,access,adapter,runtime,native,calls,
    setNativeAttribute:(v:typeof nativeAttribute)=>{nativeAttribute=v;},
    forceMismatch:(v:boolean)=>{forceHandleMismatch=v;},
    setPinHook:(hook:(()=>Promise<void>)|undefined)=>{pinHook=hook;},
    cleanup:async()=>{await runtime.dispose();await cleanupFixture(root,'hostdeck-read-root-recovery-');}};
}
function args(p:string){return {device_id:owner.deviceId,path:p};}
async function finish(adapter:FileAdapter,id:string,context=owner){
  for(let i=0;i<150;i++){
    const r=await adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:id,offset:0,limit:100,
    },context) as any;
    if(r.complete)return r;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('fixture search did not complete');
}

test('unconfigured or unqualified config remains workspace-only',async()=>{
  const f=await fixture();
  try {
    const before=await f.runtime.invoke('hostdeck_read_file',args('local.txt'),owner);
    assert.equal(before.content,'LOCAL_FIXTURE');
    delete f.config.read_roots;await f.writeConfig();
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(f.source),owner),
      /READ_ROOT_DENIED/);
    await assert.rejects(f.adapter.handle('hostdeck_list_directory',{
      ...args(f.external),depth:1,limit:50},owner),/READ_ROOT_DENIED/);
    f.config.read_roots={owner_id:owner.ownerId,revision:'read_config_rev_2',roots:[f.external],
      excluded_roots:[f.excluded],fixed_volume_roots:[]};
    await f.writeConfig();
    const noNative=new ReadRootAccess(f.workspace,[f.protectedDir],
      new ReadRootSelectionStore(f.configFile,f.workspace,{
        deviceId:owner.deviceId,executorId:owner.executorId,sid,sessionId:1,
      }));
    await assert.rejects(noNative.resolve(f.source,owner,'read_file'),
      /READ_ROOT_DENIED/);
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args('local.txt'),owner)).content,
      'LOCAL_FIXTURE');
  }finally{await f.cleanup();}
});

test('external read/list/direct name/content work only inside the selected root',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args(f.source),owner)).content,
      'VISIBLE_MARKER');
    const info=await f.runtime.invoke('hostdeck_file_info',
      {...args(f.source),hash:'sha256'},owner);
    assert.equal(info.type,'file');
    assert.equal(info.root_scope,f.external);
    assert.match(String(info.sha256),/^[0-9a-f]{64}$/);
    const list=await f.adapter.handle('hostdeck_list_directory',{
      ...args(f.external),depth:2,limit:50},owner) as any;
    assert.equal(list.root_scope,f.external);
    assert.deepEqual(list.entries.map((item:any)=>item.path),[f.source]);
    assert.ok(f.calls.filter(name=>name==='hostdeck_list_directory').length>=2);
    for(const [mode,pattern] of [['files','owned'],['content','VISIBLE_MARKER']] as const){
      const start=await f.adapter.handle('hostdeck_search_files',{
        ...args(f.external),pattern,mode,provider:'direct'},owner) as any;
      const result=await finish(f.adapter,start.search_id);
      assert.equal(result.total_results,1);
      assert.deepEqual(result.items.map((item:any)=>item.path),[f.source]);
      if(mode==='content')assert.match(result.items[0].text,/VISIBLE_MARKER/);
    }
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',
      args(path.join(f.separate,'other.txt')),owner),/READ_ROOT_DENIED/);
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',
      args(path.join(f.excluded,'private.txt')),owner),/READ_ROOT_DENIED/);
    await assert.rejects(f.runtime.invoke('hostdeck_write_file',{
      ...args(f.source),content:'MUTATION_DENIED',mode:'rewrite'},owner),/PATH_DENIED/);
    assert.equal(await fs.readFile(f.source,'utf8'),'VISIBLE_MARKER');
  }finally{await f.cleanup();}
});

test('absent protected exclusion retains protection after creation, while siblings remain readable',async()=>{
  const f=await fixture();
  try {
    await f.access.resolve(f.source,owner,'read_file');
    await fs.mkdir(f.futureExcluded);
    const secret=path.join(f.futureExcluded,'secret.txt');
    await fs.writeFile(secret,'DO_NOT_DISCLOSE');
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(secret),owner),
      /READ_ROOT_DENIED/);
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args(f.source),owner)).content,
      'VISIBLE_MARKER');
  }finally{await f.cleanup();}
});

test('grant/session changes, config revision and revocation invalidate old pages and reads',async()=>{
  const f=await fixture();
  try{
    const started=await f.adapter.handle('hostdeck_search_files',{
      ...args(f.external),pattern:'owned',provider:'direct'},owner) as any;
    assert.equal((await finish(f.adapter,started.search_id)).total_results,1);
    for(const foreign of [{...owner,ownerId:'other'},
      {...owner,sessionIds:[2]}, {...owner,executorId:'other'}]){
      await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(f.source),foreign),
        /READ_ROOT_DENIED/);
      await assert.rejects(f.adapter.handle('hostdeck_search_results',{
        device_id:owner.deviceId,search_id:started.search_id,offset:0,limit:10},foreign));
    }
    // A newly granted revision may authorize a FRESH read through PolicyGate;
    // a retained page from the prior grant revision cannot be replayed.
    const regranted={...owner,revision:'new_grant_rev'};
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args(f.source),regranted)).content,
      'VISIBLE_MARKER');
    await assert.rejects(f.adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:started.search_id,offset:0,limit:10},regranted),
      /READ_ROOT_DENIED/);
    f.config.read_roots!.revision='read_config_rev_2';await f.writeConfig();
    await assert.rejects(f.adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:started.search_id,offset:0,limit:10},owner),
      /READ_ROOT_DENIED/);
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args(f.source),owner)).content,
      'VISIBLE_MARKER');
    delete f.config.read_roots;await f.writeConfig();
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(f.source),owner),
      /READ_ROOT_DENIED/);
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args('local.txt'),owner)).content,
      'LOCAL_FIXTURE');
  }finally{await f.cleanup();}
});

test('native Hidden/System/reparse and mismatched directory handle always refuse',async()=>{
  const f=await fixture();
  try{
    for(const attr of ['hidden','system','reparse'] as const){
      f.setNativeAttribute(attr);
      await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(f.source),owner),
        /READ_ROOT_DENIED/);
      await assert.rejects(f.adapter.handle('hostdeck_list_directory',{
        ...args(f.external),depth:1,limit:10},owner),/READ_ROOT_DENIED/);
    }
    f.setNativeAttribute('ok');
    f.forceMismatch(true);
    await assert.rejects(f.adapter.handle('hostdeck_list_directory',{
      ...args(f.external),depth:1,limit:10},owner),/READ_ROOT_CHANGED/);
    f.forceMismatch(false);
    const result=await f.adapter.handle('hostdeck_list_directory',{
      ...args(f.external),depth:1,limit:10},owner) as any;
    assert.equal(result.entries.length,1);
  }finally{await f.cleanup();}
});

test('replaced retained match suppresses both snippet and stale match count',async()=>{
  const f=await fixture();
  try{
    const start=await f.adapter.handle('hostdeck_search_files',{
      ...args(f.external),pattern:'VISIBLE_MARKER',mode:'content',provider:'direct'},owner) as any;
    const first=await finish(f.adapter,start.search_id);
    assert.equal(first.total_results,1);
    await fs.rename(f.source,path.join(f.external,'old.txt'));
    await fs.writeFile(f.source,'REPLACED_BODY');
    await assert.rejects(f.adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:start.search_id,offset:0,limit:10},owner),
      /READ_ROOT_CHANGED/);
  }finally{await f.cleanup();}
});



test('negative: outside junction swapped after native pin cannot pass opened fd identity',async t=>{
  const f=await fixture();
  const backup=path.join(f.root,'external-previous');
  let renamed=false,junction=false,outsideFdOpened=false,restoredBeforeStat=false;
  const originalOpen=fs.open;
  try{
    // Both files and the junction are owned by this synthetic disposable
    // fixture. No personal data, actual user roots or installed config.
    await fs.writeFile(path.join(f.separate,'owned.txt'),'SYNTHETIC_OUTSIDE_FIXTURE');
    try{
      await fs.rename(f.external,backup);renamed=true;
      await fs.symlink(f.separate,f.external,process.platform==='win32'?'junction':'dir');
      junction=true;
      await fs.unlink(f.external);junction=false;
      await fs.rename(backup,f.external);renamed=false;
    }catch(error){
      if(!['EPERM','EACCES','ENOTSUP'].includes(
        String((error as NodeJS.ErrnoException).code)))throw error;
      t.skip('Controlled junction creation unavailable to this test token');
      return;
    }
    // After initial live approval, the (synthetic) native pin records the
    // admitted leaf then temporarily substitutes the root BEFORE Node fs.open.
    // Real native pin keeps ancestor/leaf handles non-deletable instead.
    f.setPinHook(async()=>{
      await fs.rename(f.external,backup);renamed=true;
      await fs.symlink(f.separate,f.external,process.platform==='win32'?'junction':'dir');
      junction=true;
    });
    // Capture the real fd opened THROUGH the temporary junction, then restore
    // the original path before ReadRootAccess can perform its linked stat.
    // Both path-only stat checks would see the legitimate restored target.
    (fs as unknown as {open:typeof fs.open}).open=(async(
      file:Parameters<typeof fs.open>[0],
      flags:Parameters<typeof fs.open>[1],
      mode?:number,
    )=>{
      const fd=await originalOpen(file,flags,mode);
      if(file===f.source&&junction){
        const observed=await fd.stat({bigint:true});
        const outside=await fs.stat(path.join(f.separate,'owned.txt'),{bigint:true});
        assert.equal(observed.ino,outside.ino,'the actual fd was outside scope');
        assert.equal(observed.dev,outside.dev);
        outsideFdOpened=true;
        await fs.unlink(f.external);junction=false;
        await fs.rename(backup,f.external);renamed=false;
        restoredBeforeStat=true;
      }
      return fd;
    }) as typeof fs.open;
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(f.source),owner),
      /READ_ROOT_(?:DENIED|CHANGED)/,
      'Restored path stats cannot override actual pinned-vs-opened FileID');
    assert.equal(outsideFdOpened,true,'test must really open the outside fixture');
    assert.equal(restoredBeforeStat,true,'test must restore the path before later stats');
  }finally{
    (fs as unknown as {open:typeof fs.open}).open=originalOpen;
    f.setPinHook(undefined);
    if(junction){await fs.unlink(f.external);junction=false;}
    if(renamed){await fs.rename(backup,f.external);renamed=false;}
    await f.cleanup();
  }
});

test('changed native root enumeration cannot become a successful empty search',async()=>{
  const f=await fixture();
  try{
    const original=f.native.directoryPage;
    let calls=0;
    f.native.directoryPage=async(...input:Parameters<typeof original>)=>{
      // The initial search-root check succeeds; its traversal check changes.
      if(++calls===2)throw Error('FULLTEXT_NATIVE_DIRECTORY_CHANGED');
      return original(...input);
    };
    const started=await f.adapter.handle('hostdeck_search_files',{
      ...args(f.external),pattern:'owned',provider:'direct'},owner) as any;
    await assert.rejects(finish(f.adapter,started.search_id),/READ_ROOT_REVOKED/);
    assert.equal(calls,2);
  }finally{await f.cleanup();}
});

test('a query finishing during external page checks cannot seal an earlier empty page',async()=>{
  const f=await fixture();
  try{
    let startQuery!:()=>void,releaseQuery!:()=>void,finishQuery!:()=>void;
    const started=new Promise<void>(resolve=>{startQuery=resolve;});
    const released=new Promise<void>(resolve=>{releaseQuery=resolve;});
    const finished=new Promise<void>(resolve=>{finishQuery=resolve;});
    let resultChecks=0,finalChecks=0,queryReleased=false;
    const adapter=await FileAdapter.create({workspace:f.workspace,readRoots:f.access,
      reauthorize:async(name)=>{
        if(name==='hostdeck_search_files'&&queryReleased&&++finalChecks===2)finishQuery();
        if(name==='hostdeck_search_results'&&++resultChecks===2){
          queryReleased=true;releaseQuery();await finished;
          await new Promise<void>(resolve=>setImmediate(resolve));
        }
      },
      everything:{sessionId:1,
        status:async()=>({installed:true,enabled:true,running:true,compatible:true,
          healthy:true,reason:'FIXTURE',version:'fixture',instance:'fixture',
          session_id:1,qualified:'not_independently_accepted' as const}),
        query:async()=>{startQuery();await released;return {paths:[f.source],
          truncated:false,version:'fixture',instance:'fixture',session_id:1,runtime_id:'fixture'};},
      }});
    const search=await adapter.handle('hostdeck_search_files',{
      ...args(f.external),pattern:'owned',provider:'everything'},owner) as any;
    await started;
    const page=await adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:search.search_id,offset:0,limit:10},owner) as any;
    assert.equal(page.complete,false);
    assert.equal(page.state,'running');
    assert.deepEqual(page.items,[]);
    const sealed=await finish(adapter,search.search_id);
    assert.equal(sealed.complete,true);
    assert.deepEqual(sealed.items.map((item:any)=>item.path),[f.source]);
  }finally{await f.cleanup();}
});

test('external retained pages never rebase offsets when an earlier match disappears',async()=>{
  for(const provider of ['direct','everything'] as const){
    const f=await fixture();
    try{
      const files=['page-a.txt','page-b.txt','page-c.txt'].map(name=>path.join(f.external,name));
      for(const file of files)await fs.writeFile(file,'OWNED_PAGE_FIXTURE');
      const adapter=provider==='direct'?f.adapter:await FileAdapter.create({
        workspace:f.workspace,readRoots:f.access,reauthorize:async()=>{},
        everything:{sessionId:1,
          status:async()=>({installed:true,enabled:true,running:true,compatible:true,
            healthy:true,reason:'FIXTURE',version:'fixture',instance:'fixture',
            session_id:1,qualified:'not_independently_accepted' as const}),
          query:async()=>({paths:files,truncated:false,version:'fixture',
            instance:'fixture',session_id:1,runtime_id:'fixture'})},
      });
      const start=await adapter.handle('hostdeck_search_files',{
        ...args(f.external),pattern:'page-',provider,sort:'path'},owner) as any;
      await finish(adapter,start.search_id);
      const page=(offset:number)=>adapter.handle('hostdeck_search_results',{
        device_id:owner.deviceId,search_id:start.search_id,offset,limit:1},owner) as Promise<any>;
      const first=await page(0);
      assert.deepEqual(first.items.map((item:any)=>item.path),[files[0]]);
      assert.equal(first.next_offset,1);
      await fs.unlink(files[0]);
      // Returning page-c here would silently skip the still-valid page-b.
      // A changed external snapshot must withhold items AND counts/cursors.
      await assert.rejects(page(first.next_offset),/READ_ROOT_CHANGED/,provider);
      await assert.rejects(page(0),/READ_ROOT_CHANGED/,provider);
      assert.equal((await f.runtime.invoke('hostdeck_file_info',args(files[1]),owner)).type,'file');
    }finally{await f.cleanup();}
  }
});

test('Everything stays selected and enabled, but emits only authorized external hits',async()=>{
  const f=await fixture();
  try{
    const fakeEverything={
      sessionId:1,
      status:async()=>({installed:true,enabled:true,running:true,compatible:true,
        healthy:true,reason:'FIXTURE',version:'fixture',
        instance:'fixture',session_id:1,qualified:'not_independently_accepted' as const}),
      query:async()=>({paths:[f.source,path.join(f.separate,'other.txt'),
        path.join(f.excluded,'private.txt')],truncated:false,version:'fixture',
        instance:'fixture',session_id:1,runtime_id:'fixture'}),
    };
    const adapter=await FileAdapter.create({workspace:f.workspace,readRoots:f.access,
      everything:fakeEverything,reauthorize:async name=>{f.calls.push(name);}});
    const started=await adapter.handle('hostdeck_search_files',{
      ...args(f.external),pattern:'owned',mode:'files',provider:'everything'},owner) as any;
    const result=await finish(adapter,started.search_id);
    assert.equal(result.provider,'everything');
    assert.equal(result.root_scope,f.external);
    assert.deepEqual(result.items.map((match:any)=>match.path),[f.source]);
    assert.equal(result.total_results,1);
    assert.ok(f.calls.includes('hostdeck_search_files'));
    assert.ok(f.calls.includes('hostdeck_search_results'));
  }finally{await f.cleanup();}
});
